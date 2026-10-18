/**
 * MODSEQ 델타 동기화 + 툼스톤 스트림.
 *
 * webmail-architecture.md 2.4 / 2.5:
 *  - 변경(추가·플래그)은 JAMES_MAIL_OWNER.MAIL_MODSEQ 커서로 따라간다.
 *  - 삭제는 James 가 하드 삭제하므로 james9Mail 의 JPAMessageMapper 가 삭제와 같은
 *    트랜잭션으로 남기는 GU_MESSAGE_TOMBSTONE 을 별도 커서(SEQ)로 따라간다.
 *    이동도 원본 편지함 기준으로는 삭제와 같으므로 툼스톤이 남는다.
 *  - 보관기간(30일)이 지난 커서로 요청이 오면 410 을 돌려 전체 재동기화시킨다.
 */
import { db, dbWrite } from '../db/kysely.js';
import { config } from '../config.js';
import { toFlags, toIso } from '../util/mysql.js';
import { attachImportance, type Importance } from '../mime/importance.js';

const PRUNED_MARKER = 'tombstone_pruned_seq';

export interface SyncChange {
  uid: number;
  modseq: number;
  mailId: string;
  receivedAt: string | null;
  sentAt: string | null;
  subject: string | null;
  from: string | null;
  fromDisplay: string | null;
  to: string | null;
  toDisplay: string | null;
  fromPhoto: string | null;
  toPhoto: string | null;
  size: number;
  hasAttachment: boolean;
  messageId: string;
  inReplyTo: string | null;
  /** 이 메일이 속한 대화의 뿌리 Message-ID. 미러가 목록을 대화로 묶는 데 쓴다 */
  threadId: string | null;
  mailType: string | null;
  flags: string[];
  importance: Importance;
}

export interface SyncTombstone {
  seq: number;
  uid: number;
  mailId: string;
}

export async function fetchChanges(
  mailboxId: string,
  sinceModseq: number,
  limit = config.policy.syncPageSize,
): Promise<SyncChange[]> {
  const rows = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    // 목록 아바타 사진 (messages.ts 와 같은 조인)
    .leftJoin('JAMES_USER as uf', 'uf.USER_NAME', 'm.MAIL_FROM')
    .leftJoin('JAMES_USER as ut', 'ut.USER_NAME', 'm.MAIL_TO')
    .select([
      'o.MAIL_UID as MAIL_UID',
      'o.MAIL_MODSEQ as MAIL_MODSEQ',
      'o.MAIL_ID as MAIL_ID',
      'o.MAIL_DATE as OWNER_DATE',
      'o.MAIL_IS_SEEN as MAIL_IS_SEEN',
      'o.MAIL_IS_ANSWERED as MAIL_IS_ANSWERED',
      'o.MAIL_IS_FLAGGED as MAIL_IS_FLAGGED',
      'o.MAIL_IS_DRAFT as MAIL_IS_DRAFT',
      'o.MAIL_IS_DELETED as MAIL_IS_DELETED',
      'o.MAIL_IS_RECENT as MAIL_IS_RECENT',
      'm.MAIL_SUBJECT as MAIL_SUBJECT',
      'm.MAIL_FROM as MAIL_FROM',
      'm.MAIL_FROM_DISP as MAIL_FROM_DISP',
      'm.MAIL_TO as MAIL_TO',
      'm.MAIL_TO_DISP as MAIL_TO_DISP',
      'm.MAIL_DATE as HEADER_DATE',
      'm.MAIL_SIZE as MAIL_SIZE',
      'm.MAIL_HAS_ATTACHMENT as MAIL_HAS_ATTACHMENT',
      'm.MESSAGE_ID as MESSAGE_ID',
      'm.MAIL_IN_REPLY_TO as MAIL_IN_REPLY_TO',
      'm.MAIL_THREAD_ID as MAIL_THREAD_ID',
      'm.MAIL_TYPE as MAIL_TYPE',
      'm.MAIL_FILE_PATH as MAIL_FILE_PATH',
      'm.MAIL_BODY_START_OCTET as MAIL_BODY_START_OCTET',
      'uf.USER_PHOTO as FROM_PHOTO',
      'ut.USER_PHOTO as TO_PHOTO',
    ])
    .where('o.MAILBOX_ID', '=', mailboxId)
    .where('o.MAIL_MODSEQ', '>', sinceModseq)
    .orderBy('o.MAIL_MODSEQ', 'asc')
    .limit(limit)
    .execute();

  const changes = rows.map((row) => ({
    uid: Number(row.MAIL_UID),
    modseq: Number(row.MAIL_MODSEQ ?? 0),
    mailId: row.MAIL_ID,
    receivedAt: toIso(row.OWNER_DATE),
    sentAt: toIso(row.HEADER_DATE),
    subject: row.MAIL_SUBJECT,
    from: row.MAIL_FROM,
    fromDisplay: row.MAIL_FROM_DISP,
    to: row.MAIL_TO,
    toDisplay: row.MAIL_TO_DISP,
    fromPhoto: row.FROM_PHOTO || null,
    toPhoto: row.TO_PHOTO || null,
    size: Number(row.MAIL_SIZE ?? 0),
    hasAttachment: Number(row.MAIL_HAS_ATTACHMENT ?? 0) > 0,
    messageId: row.MESSAGE_ID,
    inReplyTo: row.MAIL_IN_REPLY_TO,
    threadId: row.MAIL_THREAD_ID,
    mailType: row.MAIL_TYPE,
    flags: toFlags(row),
    importance: null as Importance,
  }));
  return attachImportance(rows, changes);
}

export async function fetchTombstones(
  mailboxId: string,
  sinceSeq: number,
  limit = config.policy.syncPageSize,
): Promise<SyncTombstone[]> {
  const rows = await db
    .selectFrom('GU_MESSAGE_TOMBSTONE')
    .select(['SEQ', 'MAIL_UID', 'MAIL_ID'])
    .where('MAILBOX_ID', '=', mailboxId)
    .where('SEQ', '>', sinceSeq)
    .orderBy('SEQ', 'asc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ seq: Number(r.SEQ), uid: Number(r.MAIL_UID), mailId: r.MAIL_ID }));
}

/** 커서가 보관기간을 넘겼는지. 넘겼으면 라우트가 410 을 돌려준다 */
export async function isCursorExpired(sinceTombstoneSeq: number): Promise<boolean> {
  if (sinceTombstoneSeq <= 0) return false;
  const row = await db
    .selectFrom('GU_SYNC_MARKER')
    .select('MARKER_VAL')
    .where('MARKER_KEY', '=', PRUNED_MARKER)
    .executeTakeFirst();
  const pruned = Number(row?.MARKER_VAL ?? 0);
  return sinceTombstoneSeq < pruned;
}

/** 스케줄러가 하루 한 번 호출한다. 잘라낸 마지막 SEQ 를 마커에 남긴다 */
export async function pruneTombstones(): Promise<number> {
  const cutoff = new Date(Date.now() - config.policy.tombstoneKeepDays * 24 * 60 * 60 * 1000);
  const last = await db
    .selectFrom('GU_MESSAGE_TOMBSTONE')
    .select('SEQ')
    .where('DELETED_AT', '<', cutoff)
    .orderBy('SEQ', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!last) return 0;

  const lastSeq = Number(last.SEQ);
  const result = await dbWrite
    .deleteFrom('GU_MESSAGE_TOMBSTONE')
    .where('SEQ', '<=', lastSeq)
    .executeTakeFirst();

  await dbWrite
    .insertInto('GU_SYNC_MARKER')
    .values({ MARKER_KEY: PRUNED_MARKER, MARKER_VAL: lastSeq })
    .onDuplicateKeyUpdate({ MARKER_VAL: lastSeq })
    .execute();

  return Number(result.numDeletedRows ?? 0);
}

/** 410 이후 전체 재동기화. 백필 완료 시점의 최고 MODSEQ 을 커서로 준다 */
export async function currentHighestModseq(mailboxId: string): Promise<number> {
  const row = await db
    .selectFrom('JAMES_MAILBOX')
    .select('MAILBOX_HIGHEST_MODSEQ')
    .where('MAILBOX_ID', '=', mailboxId)
    .executeTakeFirst();
  return Number(row?.MAILBOX_HIGHEST_MODSEQ ?? 0);
}

export async function currentTombstoneSeq(mailboxId: string): Promise<number> {
  const row = await db
    .selectFrom('GU_MESSAGE_TOMBSTONE')
    .select('SEQ')
    .where('MAILBOX_ID', '=', mailboxId)
    .orderBy('SEQ', 'desc')
    .limit(1)
    .executeTakeFirst();
  return Number(row?.SEQ ?? 0);
}
