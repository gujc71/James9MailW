/**
 * 메일 목록 로딩 (USR-4).
 *
 * 읽기 경로가 둘이다 (feature-gap 8-5, 오프라인 읽기 완성):
 *
 *  1. **Dexie live-query** — 동기화 루프가 이 편지함을 끝까지 받아 둔 상태(syncState.backfilled)
 *     라면 목록은 로컬 미러에서 그린다. 네트워크 없이도 열리고, 폴링이 미러를 고치는 순간
 *     화면이 저절로 다시 그려진다 — 플래그 변경·새 메일에 목록을 다시 조회할 일이 없다.
 *  2. **서버 조회** — 전체 메일 보기, 파일이름 검색, 아직 백필이 안 끝난 편지함처럼 미러가
 *     제대로 답할 수 없는 질의는 예전처럼 `/api/messages` 를 커서로 이어 받는다. 받은 페이지는
 *     미러에도 남겨 두어 다음에 오프라인이 되어도 그만큼은 열린다.
 *
 * 서버 경로에서 네트워크가 끊기면(브라우저 offline 이거나 fetch 자체가 실패) 미러로 넘어간다.
 * 반쯤 채운 미러일 수 있으므로 이때는 목록에 오프라인 표시를 띄워 "여기 없는 메일도 있다" 를
 * 알린다. 서버가 돌려준 오류(권한·잘못된 커서)는 미러로 감추지 않고 그대로 보여 준다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { api, ApiError } from '../../api/client';
import type { MessageSummary } from '../../api/types';
import { db } from '../../db/schema';
import {
  canQueryLocally,
  patchLocalFlags,
  queryLocalPage,
  signatureOf,
  type LocalQuery,
} from '../../db/localList';
import { isMirrored, mirrorMessages, syncMailbox } from '../../db/sync';
import { t } from '../../i18n';
import type { ListSort } from './listSort';
import { groupThreads } from './thread';

/** 한 번에 받아 보여 주는 통수. 로컬 경로는 이 값을 늘려 이어 받는다 */
const PAGE = 50;

/** 메일 한 통을 가리키는 값. uid 는 편지함 안에서만 유일하다 */
export interface MessageRef {
  mailboxId: string;
  uid: number;
}

/** 전체 메일 보기에서는 편지함이 섞이므로 (편지함, uid) 를 합쳐 식별한다 */
export function msgKey(ref: MessageRef): string {
  return `${ref.mailboxId}:${ref.uid}`;
}

/** msgKey 를 되돌린다. 편지함 아이디에 ':' 가 섞여도 되도록 마지막 ':' 로 가른다 */
export function parseMsgKey(key: string): MessageRef | null {
  const at = key.lastIndexOf(':');
  if (at <= 0) return null;
  const uid = Number(key.slice(at + 1));
  return Number.isFinite(uid) ? { mailboxId: key.slice(0, at), uid } : null;
}

export interface ListFilters {
  unseen?: boolean;
  /** 별표(\Flagged) — 내가 찍은 표시 */
  flagged?: boolean;
  /** 중요도 높음 — 보낸 사람이 헤더로 선언한 값 */
  important?: boolean;
  attachment?: boolean;
  searchField?: 'all' | 'from' | 'to' | 'subject' | 'filename';
  keyword?: string;
}

/**
 * 서버가 돌려준 커서를 그대로 돌려보낸다. 값이 무엇인지(날짜·이름·제목·크기)는 서버가 안다.
 * 빈 제목처럼 value 가 '' 인 커서도 멀쩡한 커서다 — 참·거짓으로 판단하지 않는다.
 */
interface Cursor {
  value: string | number | null;
  uid: number;
  mailboxId: string;
}

/** 브라우저가 말하는 온라인 여부. 목록의 오프라인 표시와 읽기 경로 선택에 쓴다 */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function useMessageList(
  mailboxId: string | null,
  all: boolean,
  filters: ListFilters,
  sort: ListSort,
  /** 보낸 편지함 계열인가 (listSort.showsRecipient). 로컬 정렬도 서버와 같은 열을 봐야 한다 */
  sentView: boolean,
) {
  const online = useOnline();
  /** 서버 경로에서 받아 이어 붙인 페이지 */
  const [serverMessages, setServerMessages] = useState<MessageSummary[]>([]);
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 서버 조회가 네트워크 때문에 실패했다. 다시 온라인이 될 때까지 미러로 보여 준다 */
  const [unreachable, setUnreachable] = useState(false);
  /** 로컬 경로가 보여 줄 통수. 커서 대신 이 값을 늘린다 */
  const [limit, setLimit] = useState(PAGE);
  /** 낙관적으로 목록에서 걷어낸 메일. 서버 확인(툼스톤)이 오기 전까지만 가린다 */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const cursorRef = useRef<Cursor | null>(null);
  const reqRef = useRef(0);

  // 전체 메일 보기에서는 미러에 들어와 있는 편지함을 다 훑는다. 오프라인 대비용이라
  // "완전한 미러" 로는 보지 않는다 — 한 번도 열지 않은 편지함은 미러에 아예 없다
  const mirroredBoxIds = useLiveQuery<string[], string[]>(
    async () =>
      all ? ((await db.messages.orderBy('mailboxId').uniqueKeys()) as string[]) : [],
    [all],
    [],
  );
  const localTargets = useMemo(
    () => (all || !mailboxId ? mirroredBoxIds : [mailboxId]),
    [all, mailboxId, mirroredBoxIds],
  );

  // 파일이름 검색은 MIME 파트 행이 미러에 없어 로컬에서 풀 수 없다 (db/localList.ts)
  const expressible = localTargets.length > 0 && canQueryLocally(filters);
  // 백필 완료 여부도 live-query 로 본다. 첫 동기화가 끝나는 순간 서버 경로에서 로컬로 넘어간다
  const complete = useLiveQuery(
    () => (!all && mailboxId ? isMirrored([mailboxId]) : Promise.resolve(false)),
    [all, mailboxId],
    false,
  );
  const offline = !online || unreachable;
  const useLocal = expressible && (complete || offline);
  // load() 안에서만 보는 값이라 ref 로 읽는다. 의존성에 넣으면 미러가 채워지는 순간
  // load 가 새 함수가 되어 목록이 첫 페이지로 되감긴다
  const expressibleRef = useRef(expressible);
  expressibleRef.current = expressible;

  const localQuery: LocalQuery = { mailboxIds: localTargets, sentView, sort, filters, limit };
  const wanted = signatureOf(localQuery);
  const emitted = useLiveQuery(
    () => (useLocal ? queryLocalPage(localQuery) : Promise.resolve(undefined)),
    [useLocal, wanted],
  );
  // 앞 질의의 답이 남아 있는 프레임에서는 아직 답이 없는 것으로 본다 (localList.signatureOf)
  const localPage = emitted?.signature === wanted ? emitted : undefined;

  const buildQuery = useCallback(
    (cursor: Cursor | null) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (all || !mailboxId) qs.set('all', 'true');
      else qs.set('mailbox', mailboxId);
      if (filters.unseen) qs.set('unseen', 'true');
      if (filters.flagged) qs.set('flagged', 'true');
      if (filters.important) qs.set('important', 'true');
      if (filters.attachment) qs.set('attachment', 'true');
      if (filters.keyword) {
        qs.set('keyword', filters.keyword);
        qs.set('searchField', filters.searchField ?? 'all');
      }
      qs.set('sort', sort.key);
      qs.set('dir', sort.desc ? 'desc' : 'asc');
      if (cursor && cursor.value !== null) {
        qs.set('cursorValue', String(cursor.value));
        qs.set('cursorUid', String(cursor.uid));
        qs.set('cursorMailbox', cursor.mailboxId);
      }
      return qs.toString();
    },
    [all, mailboxId, filters, sort],
  );

  const load = useCallback(
    async (reset: boolean) => {
      const req = ++reqRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api.get<{
          messages: MessageSummary[];
          nextCursor: Cursor | null;
          hasMore: boolean;
        }>(`/api/messages?${buildQuery(reset ? null : cursorRef.current)}`);
        if (req !== reqRef.current) return;
        cursorRef.current = page.nextCursor;
        setServerHasMore(page.hasMore);
        setUnreachable(false);
        setServerMessages((prev) => (reset ? page.messages : [...prev, ...page.messages]));
        // 훑어 본 메일은 미러에도 남긴다. 화면을 막을 일이 아니라 기다리지 않는다
        void mirrorMessages(page.messages).catch(() => undefined);
      } catch (cause) {
        if (req !== reqRef.current) return;
        if (cause instanceof ApiError) {
          setError(cause.message);
          // 조회 오류 시 자동 로드를 멈추고 [더보기] 버튼으로 수동 재시도한다 (USR-4)
          setServerHasMore(true);
        } else {
          // 네트워크가 끊겼다. 미러 경로로 넘어간다 (오프라인 표시가 함께 뜬다).
          // 미러가 풀 수 없는 질의(파일이름 검색)면 넘어갈 곳이 없으니 그대로 알린다
          setUnreachable(true);
          setServerMessages([]);
          setServerHasMore(false);
          if (!expressibleRef.current) setError(t('list.offlineUnavailable'));
        }
      } finally {
        if (req === reqRef.current) setLoading(false);
      }
    },
    [buildQuery],
  );

  // 편지함·필터·정렬이 바뀌면 처음부터 다시 본다. 로컬 경로는 서버를 부르지 않는다
  useEffect(() => {
    setLimit(PAGE);
    setHidden(new Set());
    cursorRef.current = null;
    if (useLocal) {
      setServerMessages([]);
      setServerHasMore(false);
      setError(null);
      setLoading(false);
      return;
    }
    void load(true);
  }, [useLocal, load]);

  /**
   * 미러로 그리는 편지함에 들어서면 **델타를 곧바로 한 번** 돌린다.
   *
   * 미러는 마지막 폴링 시점의 사진이다. 사이드바의 안 읽은 수는 `GET /api/mailboxes` 가 모든
   * 편지함을 함께 주므로 폴링마다 올라가지만, 델타는 **보고 있던 편지함과 받은편지함** 만 훑는다
   * (db/sync.ts startPolling). 그래서 수가 올라간 편지함을 눌러 들어가면 그 편지함 미러에는
   * 아직 그 메일이 없고, 목록은 다음 주기(최대 30초·5분)까지 옛 상태로 남는다 — "수는 +1 인데
   * 목록에는 없다" 가 이 틈이다. 서버 경로는 들어설 때마다 새로 조회하므로 해당되지 않는다.
   *
   * 받은 행은 알림으로 올리지 않는다. 사용자가 방금 눌러 들어온 화면이라 탭에 포커스가 있고,
   * 그 상태에서는 알림을 띄우지 않는 것이 원래 규칙이다 (lib/notify.ts notifyNewMail).
   */
  useEffect(() => {
    if (!useLocal || !mailboxId) return;
    void syncMailbox(mailboxId).catch(() => undefined);
  }, [useLocal, mailboxId]);

  // 다시 온라인이 되면 서버 경로를 한 번 더 두드려 본다
  useEffect(() => {
    if (online) setUnreachable(false);
  }, [online]);

  const visible = useMemo(() => {
    const rows = useLocal ? localPage?.messages ?? [] : serverMessages;
    return hidden.size === 0 ? rows : rows.filter((m) => !hidden.has(msgKey(m)));
  }, [useLocal, localPage, serverMessages, hidden]);

  /**
   * 대화 묶음 (2-2). 묶어 보든 말든 늘 만들어 둔다 — 한 번 훑는 값이라 싸고, 화면이
   * 토글을 켜는 순간 다시 조회하지 않고 바로 묶인 목록으로 바뀐다.
   *
   * 한 페이지(PAGE)는 여전히 **메일** 50통이다. 묶으면 줄 수는 그보다 적어지는데, 페이지를
   * 대화 수로 끊으려면 서버가 대화 단위로 커서를 밀어야 한다 — 지금 구조에서는 [더보기] 를
   * 한 번 더 누르는 쪽이 맞교환으로 싸다.
   */
  const threads = useMemo(() => groupThreads(visible), [visible]);

  return {
    messages: visible,
    threads,
    /** 로컬 경로는 첫 질의가 풀리기 전까지만 로딩이다 */
    loading: useLocal ? localPage === undefined : loading,
    hasMore: useLocal ? Boolean(localPage?.hasMore) : serverHasMore,
    error: useLocal ? null : error,
    /** 미러에 있는 만큼만 보여 주는 중인가 (목록에 오프라인 표시를 띄운다) */
    offline: offline && useLocal,
    /** 그 미러가 이 편지함 전체인가. 아니면 "일부만 보인다" 로 알려야 한다 */
    partial: offline && useLocal && !complete,
    /**
     * 폴링이 동기화를 마쳤을 때. 동기화가 돌았다는 것은 서버에 닿았다는 뜻이므로 미러로
     * 물러나 있던 상태를 먼저 푼다 — 서버 경로가 필요한 화면이면 그 다음 렌더에서 되돌아간다.
     * 완전한 미러로 그리는 중이라면 live-query 가 스스로 최신이라 할 일이 없다.
     */
    reload: () => {
      setUnreachable(false);
      if (useLocal) return;
      cursorRef.current = null;
      void load(true);
    },
    /**
     * 목록을 바꾸는 조작(삭제·이동·스팸) 뒤. 로컬 경로에서는 동기화를 한 번 돌려
     * 툼스톤을 받아 오고, 그것으로 낙관적 가림을 푼다 — 실패한 조작이면 메일이 되돌아온다.
     */
    refresh: async () => {
      if (useLocal) {
        if (mailboxId) await syncMailbox(mailboxId).catch(() => undefined);
        setHidden(new Set());
        return;
      }
      cursorRef.current = null;
      await load(true);
    },
    loadMore: () => {
      if (useLocal) setLimit((n) => n + PAGE);
      else void load(false);
    },
    /** 낙관적 플래그 반영. 미러에도 남겨 두어야 live-query 가 되돌려 놓지 않는다 */
    patch: (key: string, flags: string[]) => {
      setServerMessages((prev) => prev.map((m) => (msgKey(m) === key ? { ...m, flags } : m)));
      const ref = parseMsgKey(key);
      if (ref) void patchLocalFlags(ref.mailboxId, ref.uid, flags).catch(() => undefined);
    },
    /**
     * 낙관적으로 목록에서 걷어낸다. 미러를 지우지는 않는다 — 조작이 실패했을 때 미러에서
     * 지운 메일은 서버가 다시 보내 주지 않아(MODSEQ 가 그대로다) 전체 재동기화 전까지 사라진다.
     */
    remove: (keys: string[]) => {
      setHidden((prev) => new Set([...prev, ...keys]));
    },
  };
}
