/**
 * 동기화 루프 (webmail-architecture.md 3.5).
 *
 * 지켜야 할 네 가지:
 *  1. 변경 반영과 커서 전진은 같은 Dexie 트랜잭션에서.
 *  2. 커서는 "서버 최고 MODSEQ" 이 아니라 "내가 적용한 마지막 행".
 *  3. modseq(추가·플래그)와 tombstoneSeq(삭제)를 각각 추적.
 *  4. 410 이면 편지함을 비우고 백필.
 */
import { db, type StoredMessage } from './schema';
import { api, ApiError } from '../api/client';
import type { MessageSummary, SyncResponse } from '../api/types';

/**
 * 로컬 미확정 변경(낙관적 플래그)을 지킬지. **서버가 그보다 뒤의 상태를 보내 줄 때까지만** 지킨다.
 * 무조건 지키면 dirty 행이 영영 서버와 어긋난 채 남는다. 플래그 변경은 James 를 거쳐 MODSEQ 을
 * 올리므로, 내 변경을 확인해 주는 행은 저장된 modseq 보다 크게 돌아온다.
 */
function keepsLocal(local: StoredMessage | undefined, incomingModseq: number): boolean {
  if (!local?.dirty) return false;
  return incomingModseq <= local.modseq;
}

/**
 * 서버 목록 조회로 받은 행을 미러에 남긴다 (8-5).
 * 전체 메일 보기처럼 동기화 루프가 돌지 않는 경로에서도 훑어 본 메일은 오프라인에서 다시 열린다.
 * 미러를 "완전" 으로 표시하지는 않는다 — 걸러진 한 페이지일 뿐이다.
 */
export async function mirrorMessages(rows: MessageSummary[]): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction('rw', db.messages, async () => {
    for (const row of rows) {
      const local = await db.messages.get([row.mailboxId, row.uid]);
      if (keepsLocal(local, row.modseq)) continue;
      await db.messages.put({ ...row });
    }
  });
}

/**
 * 미러를 "끝까지 받았다" 로 표시한다. 목록을 로컬에서 그려도 되는지의 판단 기준이다 (8-5).
 * 빈 편지함은 받을 것이 없어도 완전한 미러다 — 커서 행이 없으면 0 으로 만들어 둔다.
 */
async function markBackfilled(mailboxId: string): Promise<void> {
  const state = await db.syncState.get(mailboxId);
  if (state?.backfilled) return;
  await db.syncState.put({
    mailboxId,
    modseq: state?.modseq ?? 0,
    tombstoneSeq: state?.tombstoneSeq ?? 0,
    backfilled: true,
  });
}

/** 이 편지함들의 미러가 모두 완전한가. 목록 읽기 경로를 고르는 데 쓴다 (useMessageList) */
export async function isMirrored(mailboxIds: string[]): Promise<boolean> {
  if (mailboxIds.length === 0) return false;
  const states = await db.syncState.bulkGet(mailboxIds);
  return states.every((state) => state?.backfilled === true);
}

/**
 * 이 동기화에서 **새로 도착한 안 읽은 메일**. 데스크톱 알림이 이 목록을 받는다 (8-2).
 * 플래그만 바뀐 행, 이미 읽은 행, 첫 백필로 쏟아진 행은 "도착" 이 아니다.
 */
export async function syncMailbox(mailboxId: string): Promise<StoredMessage[]> {
  const arrived: StoredMessage[] = [];
  for (;;) {
    const state = await db.syncState.get(mailboxId);
    const since = state?.modseq ?? 0;
    const tsince = state?.tombstoneSeq ?? 0;
    /**
     * 첫 백필은 도착이 아니다. 로그인 직후에는 커서가 0 이라 편지함의 안 읽은 메일 전부가
     * "새 행" 으로 들어오는데, 그것까지 알리면 알림이 수백 개 쏟아진다.
     */
    const settled = state?.backfilled === true;

    let res: SyncResponse;
    try {
      res = await api.get<SyncResponse>(
        `/api/sync?mailbox=${encodeURIComponent(mailboxId)}&since=${since}&tsince=${tsince}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        // 미러를 버리고 다시 채우는 길이다 — 받은 행은 전부 "처음 보는 행" 이라 알리지 않는다
        await fullResync(mailboxId);
        return [];
      }
      throw error;
    }

    if (res.changes.length === 0 && res.tombstones.length === 0) {
      await markBackfilled(mailboxId);
      return arrived;
    }

    await db.transaction('rw', db.messages, db.syncState, async () => {
      for (const change of res.changes) {
        const local = await db.messages.get([mailboxId, change.uid]);
        if (keepsLocal(local, change.modseq)) continue; // 로컬 미확정 변경 보호
        const row: StoredMessage = { ...change, mailboxId };
        if (settled && !local && !row.flags.includes('\\Seen')) arrived.push(row);
        await db.messages.put(row);
      }
      for (const tomb of res.tombstones) {
        await db.messages.delete([mailboxId, tomb.uid]);
      }
      await db.syncState.put({
        mailboxId,
        modseq: res.changes.at(-1)?.modseq ?? since,
        tombstoneSeq: res.tombstones.at(-1)?.seq ?? tsince,
        // 커서를 밀 때 백필 표시를 함께 옮긴다. 빠뜨리면 델타 한 번에 미러가 다시
        // "불완전" 으로 내려앉아 목록이 서버 조회로 되돌아간다
        backfilled: state?.backfilled,
      });
    });

    if (!res.hasMore) {
      await markBackfilled(mailboxId);
      return arrived;
    }
  }
}

/** 410 이후 전체 재동기화. 서버 목록을 받아 채우고 현재 커서를 잡는다 */
export async function fullResync(mailboxId: string): Promise<void> {
  // 미러를 비우는 동안은 "불완전" 으로 내려 둔다. 백필이 끝나기 전에 로컬 목록이 그려지면
  // 메일이 사라진 것처럼 보인다 — 그 사이는 서버 조회로 보여 준다
  await db.transaction('rw', db.messages, db.syncState, async () => {
    await db.messages.where('mailboxId').equals(mailboxId).delete();
    const state = await db.syncState.get(mailboxId);
    if (state?.backfilled) await db.syncState.put({ ...state, backfilled: false });
  });

  // 정렬은 서버 기본값(날짜 내림차순)으로 둔다. 화면에서 고른 정렬과 무관하게 한 번에 다 받는다
  type Cursor = { value: string | number | null; uid: number; mailboxId: string };
  let cursor: Cursor | null = null;
  for (;;) {
    const qs = new URLSearchParams({ mailbox: mailboxId, limit: '200' });
    if (cursor && cursor.value !== null) {
      qs.set('cursorValue', String(cursor.value));
      qs.set('cursorUid', String(cursor.uid));
      qs.set('cursorMailbox', cursor.mailboxId);
    }
    const page = await api.get<{
      messages: SyncResponse['changes'];
      nextCursor: Cursor | null;
      hasMore: boolean;
    }>(`/api/messages?${qs.toString()}`);

    await db.transaction('rw', db.messages, async () => {
      for (const message of page.messages) await db.messages.put({ ...message, mailboxId });
    });

    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const head = await api.get<{ modseq: number; tombstoneSeq: number }>(
    `/api/sync/head?mailbox=${encodeURIComponent(mailboxId)}`,
  );
  await db.syncState.put({
    mailboxId,
    modseq: head.modseq,
    tombstoneSeq: head.tombstoneSeq,
    backfilled: true,
  });
}

/** 보고 있는 탭의 폴링 주기 (architecture 2.5) */
const FOREGROUND_MS = 30_000;
/** 숨은 탭의 폴링 주기. 알림이 늦는 상한도 이 값이다 (feature-gap 8-1) */
const BACKGROUND_MS = 5 * 60_000;
/**
 * 창을 다시 보게 됐을 때 델타를 다시 부르지 않는 최소 간격.
 * visibilitychange · focus 가 잇달아 오거나(탭 전환은 둘 다 온다) 창을 오락가락할 때
 * 같은 질의를 연달아 던지지 않게 한다.
 */
const WAKE_MIN_GAP_MS = 5_000;

export interface SyncLoop {
  /** 폴링을 멈춘다 (언마운트) */
  stop: () => void;
  /** 지금 한 번 훑고 다음 tick 을 다시 잡는다. 다음 주기를 기다릴 수 없는 순간에 부른다 */
  syncNow: () => void;
}

/**
 * 폴링 제어 (architecture 2.5: 포커스 30초, 백그라운드 5분, 창을 다시 볼 때 즉시).
 *
 * getMailboxes 는 **한 번에 훑을 편지함들** 을 준다. 보고 있는 편지함 하나만 돌리면 보낸 편지함이나
 * 설정 화면에 있는 동안 받은편지함 델타가 들어오지 않아 새 메일 알림이 뜨지 않는다 (8-2).
 *
 * 깨어날 때는 델타만 부르지 않고 **타이머도 다시 잡는다**. 숨은 동안 잡아 둔 5분 타이머를 그대로
 * 두면 탭으로 돌아온 뒤에도 다음 갱신이 최대 5분 뒤라, 보고 있는 화면인데 새 메일이 30초 안에
 * 올라오지 않는다.
 *
 * 깨어남은 visibilitychange 만으로 모자라다 — **가려져 있을 뿐 '보이는' 탭** 은 앞으로 끌어내도
 * visibilitychange 가 오지 않는다. 데스크톱 알림이 뜨는 상황이 바로 그 상태이고(포커스가 없다),
 * 알림을 눌러 window.focus() 로 돌아오는 길도 focus 로만 잡힌다.
 */
export function startPolling(
  getMailboxes: () => (string | null)[],
  onSynced?: (arrived: StoredMessage[]) => void,
): SyncLoop {
  let timer: number | undefined;
  /** 타이머와 깨어남이 겹쳐 같은 델타를 두 번 적용(=두 번 알림)하지 않게 한다 */
  let running = false;
  /**
   * 돌고 있는 동안 들어온 요청. 그냥 버리면 편지함을 옮긴 직후의 요청이 마침 겹친 폴링에
   * 먹혀 사라져, 방금 고른 편지함이 다음 주기까지 옛 상태로 남는다.
   */
  let queued = false;
  /** 마지막으로 훑은 시각 (WAKE_MIN_GAP_MS 판단용) */
  let lastSync = 0;

  const syncAll = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const arrived: StoredMessage[] = [];
    let synced = false;
    try {
      const ids = [...new Set(getMailboxes().filter((id): id is string => Boolean(id)))];
      for (const id of ids) {
        try {
          arrived.push(...(await syncMailbox(id)));
          synced = true;
        } catch {
          // 네트워크 오류는 다음 tick 에서 재시도. 한 편지함이 실패해도 나머지는 계속 돌린다
        }
      }
    } finally {
      running = false;
      lastSync = Date.now();
    }
    if (synced) onSynced?.(arrived);
    if (queued) {
      queued = false;
      await syncAll();
    }
  };

  /** 다음 tick 을 지금 상태에 맞춰 잡는다. 앞서 잡아 둔 타이머는 버린다 */
  const schedule = () => {
    if (timer) window.clearTimeout(timer);
    const interval = document.visibilityState === 'visible' ? FOREGROUND_MS : BACKGROUND_MS;
    timer = window.setTimeout(tick, interval);
  };

  const tick = async () => {
    await syncAll();
    schedule();
  };

  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastSync >= WAKE_MIN_GAP_MS) void syncAll();
    schedule();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  // 끊겼다 돌아온 순간도 깨어남이다 — 그동안 쌓인 델타를 다음 주기까지 묵힐 일이 아니다
  window.addEventListener('online', wake);
  void tick();

  return {
    stop: () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    },
    syncNow: () => {
      void syncAll();
      schedule();
    },
  };
}
