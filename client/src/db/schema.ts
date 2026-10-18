/**
 * Dexie 로컬 미러 (webmail-architecture.md 3.3).
 *
 * UID·MODSEQ 은 편지함 단위로만 유일하므로 주키를 [mailboxId+uid] 로, 커서도
 * 편지함마다 하나씩 둔다. 편지함을 넘어 같은 메일을 찾을 때는 mailId 를 쓴다.
 */
import Dexie, { type Table } from 'dexie';
import type { Mailbox, Me, MessageSummary } from '../api/types';

export interface StoredMessage extends MessageSummary {
  /** 낙관적 업데이트가 아직 서버 확인 전이면 true. 동기화 루프가 건너뛴다 */
  dirty?: boolean;
}

export interface StoredBody {
  key: string; // `${mailboxId}:${uid}`
  mailboxId: string;
  uid: number;
  mailId: string;
  raw: ArrayBuffer;
  lastAccessed: number;
}

export interface SyncState {
  mailboxId: string;
  modseq: number;
  tombstoneSeq: number;
  /**
   * 미러가 이 편지함을 한 번이라도 끝까지 받아 놓았는가 (8-5).
   * 델타 루프는 한 페이지만 받고도 커서를 전진시키므로 커서가 있다는 것만으로는
   * "목록을 로컬에서 그려도 된다" 를 말하지 못한다. 반쯤 채운 미러로 정렬·필터를 걸면
   * 있는 메일이 없는 것처럼 보인다.
   */
  backfilled?: boolean;
}

/**
 * 오프라인에서도 사이드바와 사용량을 그려야 하므로 편지함 목록도 남긴다 (8-5).
 * 한 행짜리 캐시라 키는 고정값 하나다.
 */
export interface CachedMailboxes {
  key: 'mailboxes';
  mailboxes: Mailbox[];
  usage: Me['usage'];
  savedAt: number;
}

export interface PendingOp {
  id?: number;
  kind: string;
  payload: unknown;
  status: 'pending' | 'done';
  createdAt: number;
}

/** 계정마다 따로 여는 DB 이름의 앞부분. 뒤에 소문자 계정 주소가 붙는다 */
const DB_PREFIX = 'james9mail:';
/** 계정 구분 없이 쓰던 예전 DB. 앞사람의 메일이 남아 있을 수 있어 처음 열 때 지운다 */
const LEGACY_DB = 'james9mail';

class MailDb extends Dexie {
  messages!: Table<StoredMessage, [string, number]>;
  bodies!: Table<StoredBody, string>;
  syncState!: Table<SyncState, string>;
  pendingOps!: Table<PendingOp, number>;
  cache!: Table<CachedMailboxes, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      messages: '[mailboxId+uid], mailboxId, mailId, [mailboxId+receivedAt], modseq',
      bodies: 'key, mailId, lastAccessed',
      syncState: 'mailboxId',
      pendingOps: '++id, status',
    });
    // v2: 편지함 목록 캐시. 기존 테이블은 그대로 물려받는다
    this.version(2).stores({ cache: 'key' });
    /**
     * v3: 대화 묶기 (threadId).
     *
     * 이전 버전이 받아 둔 행에는 threadId 가 아예 없다. 그대로 두면 미러로 그리는 목록만
     * 메일 한 통씩 흩어져 보이고 — 서버 경로로 그릴 때와 묶음이 달라진다 — 사용자는 어느
     * 쪽이 맞는지 알 수 없다. 그래서 미러와 커서를 비워 다음 동기화가 처음부터 다시 받게
     * 한다. 원문 캐시(bodies)는 메일 내용이라 버릴 이유가 없어 남긴다.
     */
    this.version(3)
      .stores({ messages: '[mailboxId+uid], mailboxId, mailId, [mailboxId+receivedAt], modseq, threadId' })
      .upgrade(async (tx) => {
        await tx.table('messages').clear();
        await tx.table('syncState').clear();
      });
  }
}

/**
 * 로그인한 계정의 로컬 미러.
 *
 * **계정마다 DB 를 따로 연다.** 하나를 같이 쓰면 같은 PC 에서 다음 사람이 로그인했을 때 앞사람의
 * 목록·원문 캐시가 같은 저장소에 섞여 있다. 화면은 편지함 ID 로 걸러 보여 주더라도 개발자 도구로는
 * 그대로 보인다.
 *
 * `export let` 이라 다른 모듈의 `import { db }` 는 언제나 지금 열린 DB 를 가리킨다(ESM live binding).
 * 로그인 전에는 열려 있지 않다 — 메일 화면(Shell)은 openUserDb 가 끝난 뒤에만 그려진다.
 */
export let db: MailDb = null as unknown as MailDb;
let openedFor: string | null = null;

/** 이 계정의 DB 를 연다. 이미 그 계정이면 아무것도 하지 않는다 */
export function openUserDb(userName: string): void {
  const key = userName.trim().toLowerCase();
  if (openedFor === key && db) return;
  if (db) db.close();
  db = new MailDb(DB_PREFIX + key);
  openedFor = key;
  // 예전 공용 DB 정리. 없으면 조용히 끝난다
  void Dexie.delete(LEGACY_DB).catch(() => undefined);
}

/**
 * 로그아웃할 때 부른다. purge 면 이 계정의 로컬 캐시(목록·원문·편지함)를 지우고, 아니면 닫기만 한다 —
 * 닫기만 하면 다음 로그인 때 받아 둔 목록·원문을 다시 쓰므로 빨리 열린다.
 */
export async function closeUserDb(options: { purge: boolean }): Promise<void> {
  const current = db;
  db = null as unknown as MailDb;
  openedFor = null;
  if (!current) return;
  if (options.purge) {
    await current.delete().catch(() => undefined);
  } else {
    current.close();
  }
}

/** bodies LRU. IndexedDB 할당량은 브라우저가 회수할 수 있으므로 상한을 둔다 */
const MAX_BODIES = 300;

export async function putBody(entry: Omit<StoredBody, 'lastAccessed'>): Promise<void> {
  await db.bodies.put({ ...entry, lastAccessed: Date.now() });
  const count = await db.bodies.count();
  if (count > MAX_BODIES) {
    const stale = await db.bodies.orderBy('lastAccessed').limit(count - MAX_BODIES).toArray();
    await db.bodies.bulkDelete(stale.map((b) => b.key));
  }
}

/** 원문은 불변이라 mailId 가 같으면 편지함이 달라도 재사용한다 */
export async function findBodyByMailId(mailId: string): Promise<StoredBody | undefined> {
  return db.bodies.where('mailId').equals(mailId).first();
}

/** 편지함 목록 캐시. 조회가 성공할 때마다 덮어쓴다 */
export async function putMailboxCache(mailboxes: Mailbox[], usage: Me['usage']): Promise<void> {
  await db.cache.put({ key: 'mailboxes', mailboxes, usage, savedAt: Date.now() });
}

export async function getMailboxCache(): Promise<CachedMailboxes | undefined> {
  return db.cache.get('mailboxes');
}
