/**
 * JAMES_MAIL_OWNER JOIN JAMES_MAIL 조회.
 *
 * 목록에 필요한 제목·발신자·날짜·크기·첨부 여부가 이미 컬럼이므로 목록을 위해 원문을 열 일이 없다.
 * 본문 미리보기(preview)는 넣지 않는다 — 브라우저 파싱 구조에서는 모든 메일을
 * 내려받아야 채울 수 있다 (webmail-issues.md 2-8).
 * 예외는 발신자 중요도 하나다. 컬럼이 없어 원문 앞머리를 읽어야 한다 — mime/importance.ts.
 */
import { sql } from 'kysely';
import { db } from '../db/kysely.js';
import { escapeLike, toFlags, toIso } from '../util/mysql.js';
import { attachImportance, type Importance } from '../mime/importance.js';

export interface MessageSummary {
  mailboxId: string;
  uid: number;
  modseq: number;
  mailId: string;
  /** internalDate (JAMES_MAIL_OWNER.MAIL_DATE) */
  receivedAt: string | null;
  /** Date 헤더 (JAMES_MAIL.MAIL_DATE) */
  sentAt: string | null;
  subject: string | null;
  from: string | null;
  fromDisplay: string | null;
  to: string | null;
  toDisplay: string | null;
  /** 보낸 사람이 사내 계정이면 그 프로필 사진 URL (목록 아바타용) */
  fromPhoto: string | null;
  /** 받는 사람이 사내 계정이면 그 프로필 사진 URL (보낸 편지함 아바타용) */
  toPhoto: string | null;
  size: number;
  hasAttachment: boolean;
  messageId: string;
  inReplyTo: string | null;
  /**
   * 이 메일이 속한 대화의 뿌리 Message-ID (JAMES_MAIL.MAIL_THREAD_ID).
   * 같은 값을 가진 메일이 한 대화다. 스레드 컬럼이 생기기 전 메일은 null 이라
   * 화면은 그런 메일을 한 통짜리 대화로 본다.
   */
  threadId: string | null;
  mailType: string | null;
  flags: string[];
  /** 보낸 사람이 헤더로 선언한 중요도. 별표(\Flagged)와 별개다 */
  importance: Importance;
}

/**
 * uf / ut 는 보낸 사람·받는 사람의 사내 계정 행이다. 아바타 사진만 쓰려고 LEFT JOIN 한다.
 * 외부 주소면 맞는 행이 없어 NULL 이고, 화면은 이름 첫 글자로 되돌아간다.
 */
const SUMMARY_COLUMNS = [
  'o.MAILBOX_ID as MAILBOX_ID',
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
  // 중요도 헤더를 읽을 원문 위치 (mime/importance.ts)
  'm.MAIL_FILE_PATH as MAIL_FILE_PATH',
  'm.MAIL_BODY_START_OCTET as MAIL_BODY_START_OCTET',
  'uf.USER_PHOTO as FROM_PHOTO',
  'ut.USER_PHOTO as TO_PHOTO',
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toSummary(row: any): MessageSummary {
  return {
    mailboxId: row.MAILBOX_ID,
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
    // 실제 값은 attachImportance() 가 채운다
    importance: null,
  };
}

/**
 * 정렬 기준 (feature-gap 2-1). 'from' 은 목록이 보여 주는 주소 열이다 — 보낸 편지함 계열은
 * 받는 사람, 그 외는 보낸 사람. 화면에 없는 열로 줄 세우면 사용자가 순서를 읽을 수 없다.
 */
export type SortKey = 'date' | 'from' | 'subject' | 'size';

export interface ListSort {
  key: SortKey;
  desc: boolean;
}

/**
 * 무한 스크롤 커서. (정렬 키 값, uid, 편지함) 세 쌍이다.
 * 제목·크기로 정렬하면 같은 값이 흔하고, 전체 메일 보기에서는 uid 도 편지함마다 따로
 * 매겨져 겹친다 — 세 값을 함께 봐야 한 통을 건너뛰거나 두 번 받지 않는다.
 */
export interface ListCursor {
  value: string | number | null;
  uid: number;
  mailboxId: string;
}

export interface ListOptions {
  mailboxIds: string[];
  limit: number;
  cursor?: ListCursor | null;
  /**
   * 보낸 편지함 계열(보낸·임시보관·발송대기)인가. 날짜는 발송일시, 주소는 받는 사람을 본다 —
   * 목록 화면이 보여 주는 값과 같아야 순서가 화면과 어긋나지 않는다 (설계서 공통 정책).
   */
  sentView: boolean;
  sort: ListSort;
  unseenOnly?: boolean;
  flaggedOnly?: boolean;
  /** 보낸 사람이 중요도 높음으로 보낸 메일만. 컬럼이 아니라 헤더라 listPage() 가 훑어 고른다 */
  importantOnly?: boolean;
  withAttachmentOnly?: boolean;
  search?: { field: 'all' | 'from' | 'to' | 'subject' | 'filename'; keyword: string } | null;
}

/**
 * 정렬 키 → 줄 세우는 SQL 식. 커서 비교와 ORDER BY 가 **같은 식**을 써야 페이지가 이어진다.
 * NULL 은 빈 문자열·0·수신일시로 메워 둔다. NULL 이 섞이면 커서 비교(`= NULL`)가
 * 참이 되지 못해 다음 페이지가 끊긴다.
 * 날짜 외에는 인덱스를 타지 못하고 filesort 가 된다 — 한 편지함 규모에서는 감당할 수준이고,
 * 메일 수가 크게 늘면 색인을 따로 잡아야 한다 (3-7 과 같은 숙제).
 */
function sortExpr(options: ListOptions): string {
  switch (options.sort.key) {
    case 'from':
      // 화면은 '이름 <주소>' 로 이름을 앞세우므로 이름이 있으면 이름으로 줄 세운다
      return options.sentView
        ? "COALESCE(NULLIF(m.MAIL_TO_DISP, ''), m.MAIL_TO, '')"
        : "COALESCE(NULLIF(m.MAIL_FROM_DISP, ''), m.MAIL_FROM, '')";
    case 'subject':
      return "COALESCE(m.MAIL_SUBJECT, '')";
    case 'size':
      return 'COALESCE(m.MAIL_SIZE, 0)';
    default:
      // Date 헤더가 없는 메일은 수신일시로 되돌린다. 두 컬럼 다 DATETIME 이라 타입도 그대로다
      return options.sentView ? 'COALESCE(m.MAIL_DATE, o.MAIL_DATE)' : 'o.MAIL_DATE';
  }
}

/** 마지막 행 → 다음 페이지 커서. sortExpr() 가 고른 컬럼과 같은 값을 집어야 한다 */
export function cursorOf(row: MessageSummary, options: ListOptions): ListCursor {
  return { value: sortValueOf(row, options), uid: row.uid, mailboxId: row.mailboxId };
}

function sortValueOf(row: MessageSummary, options: ListOptions): string | number | null {
  switch (options.sort.key) {
    case 'from':
      return options.sentView ? row.toDisplay || row.to || '' : row.fromDisplay || row.from || '';
    case 'subject':
      return row.subject ?? '';
    case 'size':
      return row.size;
    default:
      return options.sentView ? (row.sentAt ?? row.receivedAt) : row.receivedAt;
  }
}

/** 커서 값을 SQL 바인딩 값으로. 날짜는 Date 로 넘겨 mysql2 가 DATETIME 으로 맞추게 한다 */
function bindValue(options: ListOptions, raw: string | number): Date | string | number | null {
  if (options.sort.key === 'size') {
    const size = Number(raw);
    return Number.isFinite(size) ? size : null;
  }
  if (options.sort.key !== 'date') return String(raw);
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 편지함 목록. 넘버링 없는 무한 스크롤이라 offset 이 아니라 (정렬 값, uid, 편지함) 커서를 쓴다.
 * 정렬 기준은 화면에서 고른다 (날짜·보낸사람·제목·크기 × 오름/내림, feature-gap 2-1).
 */
export async function listMessages(options: ListOptions): Promise<MessageSummary[]> {
  if (options.mailboxIds.length === 0) return [];

  const order = sortExpr(options);
  const direction = options.sort.desc ? 'desc' : 'asc';

  let query = db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .leftJoin('JAMES_USER as uf', 'uf.USER_NAME', 'm.MAIL_FROM')
    .leftJoin('JAMES_USER as ut', 'ut.USER_NAME', 'm.MAIL_TO')
    .select(SUMMARY_COLUMNS)
    .where('o.MAILBOX_ID', 'in', options.mailboxIds)
    .where('o.MAIL_IS_DELETED', '=', 0);

  if (options.unseenOnly) query = query.where('o.MAIL_IS_SEEN', '=', 0);
  if (options.flaggedOnly) query = query.where('o.MAIL_IS_FLAGGED', '=', 1);
  if (options.withAttachmentOnly) query = query.where('m.MAIL_HAS_ATTACHMENT', '>', 0);

  const search = options.search;
  if (search && search.keyword.trim()) {
    const like = `%${escapeLike(search.keyword.trim())}%`;
    if (search.field === 'subject') {
      query = query.where('m.MAIL_SUBJECT', 'like', like);
    } else if (search.field === 'from') {
      query = query.where((eb) =>
        eb.or([eb('m.MAIL_FROM', 'like', like), eb('m.MAIL_FROM_DISP', 'like', like)]),
      );
    } else if (search.field === 'to') {
      query = query.where((eb) =>
        eb.or([eb('m.MAIL_TO', 'like', like), eb('m.MAIL_TO_DISP', 'like', like)]),
      );
    } else if (search.field === 'filename') {
      // 파일 이름은 James 가 추출해 둔 MIME 파트 행에서 찾는다. 원문을 열지 않는다.
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('JAMES_MAIL_MIME_PART as p')
            .select('p.PART_ID')
            .whereRef('p.MAIL_ID', '=', 'o.MAIL_ID')
            .where('p.FILE_NAME', 'like', like),
        ),
      );
    } else {
      query = query.where((eb) =>
        eb.or([
          eb('m.MAIL_SUBJECT', 'like', like),
          eb('m.MAIL_FROM', 'like', like),
          eb('m.MAIL_FROM_DISP', 'like', like),
          eb('m.MAIL_TO', 'like', like),
          eb('m.MAIL_TO_DISP', 'like', like),
        ]),
      );
    }
  }

  // 커서 이어받기. 내림차순이면 "이 값보다 작은 것", 오름차순이면 "큰 것" 을 집는다.
  // 정렬 값이 같은 행은 uid, 그것도 같으면 편지함으로 갈라 순서를 하나로 못박는다.
  const cursor = options.cursor;
  const cursorValue = cursor && cursor.value !== null ? bindValue(options, cursor.value) : null;
  if (cursor && cursorValue !== null) {
    const op = sql.raw(options.sort.desc ? '<' : '>');
    const expr = sql.raw(order);
    query = query.where(
      sql<boolean>`(${expr} ${op} ${cursorValue} OR (${expr} = ${cursorValue} AND (o.MAIL_UID ${op} ${cursor.uid} OR (o.MAIL_UID = ${cursor.uid} AND o.MAILBOX_ID ${op} ${cursor.mailboxId}))))`,
    );
  }

  const rows = await query
    .orderBy(sql.raw(order), direction)
    .orderBy('o.MAIL_UID', direction)
    .orderBy('o.MAILBOX_ID', direction)
    .limit(options.limit)
    .execute();

  return attachImportance(rows, rows.map(toSummary));
}

export interface ListPage {
  messages: MessageSummary[];
  nextCursor: ListCursor | null;
  hasMore: boolean;
}

/** 중요도 필터가 켜졌을 때 한 요청에서 훑을 행 수 상한. 넘으면 짧은 페이지로 끊고 [더보기] 로 넘긴다 */
const IMPORTANCE_SCAN_MAX = 1000;
/**
 * 훑기 한 덩이의 SQL 행 수. 거르고 남는 행이 대부분이므로 목록 한 페이지보다 크게 잡아
 * 왕복을 줄인다 (상한 1000 행이면 다섯 번). 덩이를 크게 잡으면 목록을 다 채운 뒤에도
 * 그 덩이의 헤더를 읽게 되지만, 읽은 값은 MAIL_ID 로 캐시되므로 한 번만 든다.
 */
const IMPORTANCE_SCAN_CHUNK = 200;

/**
 * 목록 한 페이지 + 다음 커서. 라우트가 쓰는 입구다.
 *
 * 중요도 필터만 SQL 로 거를 수 없다 — 값이 컬럼이 아니라 원문 헤더에 있다
 * (mime/importance.ts). 그래서 SQL 페이지를 훑어가며 골라 담는데, 커서는
 * **담은 행이 아니라 마지막으로 살펴본 행** 으로 밀어야 한다. 담은 행 기준으로 밀면
 * 그 뒤에 살펴본(그러나 걸러낸) 구간을 다음 페이지가 다시 훑는다.
 */
export async function listPage(options: ListOptions): Promise<ListPage> {
  if (!options.importantOnly) {
    const rows = await listMessages(options);
    const last = rows.at(-1);
    const nextCursor = last ? cursorOf(last, options) : null;
    return {
      messages: rows,
      nextCursor,
      // 커서를 만들 수 없으면(정렬 값이 NULL) 더 받을 방법이 없다 —
      // [더보기] 를 열어 두면 같은 첫 페이지를 다시 붙이게 된다
      hasMore: rows.length === options.limit && nextCursor?.value !== null,
    };
  }

  return scanImportant(options, (cursor, pageSize) =>
    listMessages({ ...options, cursor, limit: pageSize }),
  );
}

/**
 * listPage() 의 훑기 부분. DB 조회를 fetchPage 로 받아 두어 커서가 제대로 밀리는지를
 * DB 없이 시험할 수 있게 갈라 두었다.
 */
export async function scanImportant(
  options: ListOptions,
  fetchPage: (cursor: ListCursor | null, pageSize: number) => Promise<MessageSummary[]>,
): Promise<ListPage> {
  // 덩이 크기를 fetchPage 에 넘기고 "짧은 덩이 = 끝" 판정에도 같은 값을 쓴다.
  // 두 값이 어긋나면 아직 뒤가 남았는데도 끝났다고 보게 된다.
  const chunk = Math.max(options.limit, IMPORTANCE_SCAN_CHUNK);
  const kept: MessageSummary[] = [];
  let nextCursor = options.cursor ?? null;
  let scanned = 0;
  let exhausted = false;
  let full = false;

  while (!exhausted && !full && scanned < IMPORTANCE_SCAN_MAX) {
    const rows = await fetchPage(nextCursor, chunk);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of rows) {
      scanned += 1;
      nextCursor = cursorOf(row, options);
      if (row.importance !== 'high') continue;
      kept.push(row);
      if (kept.length >= options.limit) {
        full = true;
        break;
      }
    }
    // 마지막 덩이였거나 커서를 더 밀 수 없으면 뒤에 남은 것이 없다
    if (!full && (rows.length < chunk || nextCursor?.value === null)) exhausted = true;
  }

  return { messages: kept, nextCursor, hasMore: !exhausted };
}

/** 원문 서빙 전에 소유자를 확인한다. MAIL_ID 만으로 서빙하면 타인 메일이 열린다 (2-1) */
export async function findOwnedMessage(
  userName: string,
  mailboxId: string,
  uid: number,
): Promise<{ mailId: string; filePath: string; size: number; seen: boolean; subject: string | null } | null> {
  const row = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .select([
      'o.MAIL_ID as MAIL_ID',
      'o.MAIL_IS_SEEN as MAIL_IS_SEEN',
      'm.MAIL_FILE_PATH as MAIL_FILE_PATH',
      'm.MAIL_SIZE as MAIL_SIZE',
      'm.MAIL_SUBJECT as MAIL_SUBJECT',
    ])
    .where('o.MAILBOX_ID', '=', mailboxId)
    .where('o.MAIL_UID', '=', uid)
    .where('b.USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return null;
  return {
    mailId: row.MAIL_ID,
    filePath: row.MAIL_FILE_PATH,
    size: Number(row.MAIL_SIZE ?? 0),
    subject: row.MAIL_SUBJECT ?? null,
    seen: Buffer.isBuffer(row.MAIL_IS_SEEN)
      ? row.MAIL_IS_SEEN[0] !== 0
      : Boolean(row.MAIL_IS_SEEN),
  };
}

/** 관리자 조회(ADM-5) 전용. 소유자 확인 없이 MAIL_ID 로 찾는다 — 감사 로그를 반드시 남긴다 */
export async function findMessageByMailId(
  mailId: string,
): Promise<{ mailId: string; filePath: string; size: number } | null> {
  const row = await db
    .selectFrom('JAMES_MAIL')
    .select(['MAIL_ID', 'MAIL_FILE_PATH', 'MAIL_SIZE'])
    .where('MAIL_ID', '=', mailId)
    .executeTakeFirst();
  return row
    ? { mailId: row.MAIL_ID, filePath: row.MAIL_FILE_PATH, size: Number(row.MAIL_SIZE) }
    : null;
}

export async function getMessageDetail(
  userName: string,
  mailboxId: string,
  uid: number,
): Promise<
  | (MessageSummary & {
      recipients: { address: string; type: string }[];
      largeAttachments: { attachId: string; fileName: string; fileSize: number }[];
    })
  | null
> {
  const row = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .leftJoin('JAMES_USER as uf', 'uf.USER_NAME', 'm.MAIL_FROM')
    .leftJoin('JAMES_USER as ut', 'ut.USER_NAME', 'm.MAIL_TO')
    .select(SUMMARY_COLUMNS)
    .where('o.MAILBOX_ID', '=', mailboxId)
    .where('o.MAIL_UID', '=', uid)
    .where('b.USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return null;

  const [summary] = await attachImportance([row], [toSummary(row)]);
  if (!summary) return null;

  const recipientRows = await db
    .selectFrom('JAMES_MAIL_RECIPIENTS')
    .select(['MAIL_ADDRESS', 'MAIL_ADDRESS_TYPE'])
    .where('MAIL_ID', '=', summary.mailId)
    .execute();

  // 수신자가 읽는 파일에는 Bcc 헤더가 없다(mailetcontainer 의 RemoveMimeHeader bcc 가
  // MailRecorder 앞에 있다). 다만 발신자 Sent 사본에는 bcc 행이 있으므로,
  // 내가 보낸 메일이 아니면 bcc 를 내려주지 않는다 (webmail-issues.md 2-6).
  const isOwnSentCopy = summary.mailType === 'IO' || summary.mailType === 'II';
  const recipients = recipientRows
    .filter((r) => isOwnSentCopy || (r.MAIL_ADDRESS_TYPE ?? '').toLowerCase() !== 'bcc')
    .map((r) => ({ address: r.MAIL_ADDRESS ?? '', type: (r.MAIL_ADDRESS_TYPE ?? 'to').toLowerCase() }));

  const largeAttachments = await db
    .selectFrom('GU_LARGE_ATTACH')
    .select(['ATTACH_ID', 'FILE_NAME', 'FILE_SIZE'])
    .where('MAIL_ID', '=', summary.mailId)
    .execute();

  return {
    ...summary,
    recipients,
    largeAttachments: largeAttachments.map((a) => ({
      attachId: a.ATTACH_ID,
      fileName: a.FILE_NAME,
      fileSize: Number(a.FILE_SIZE),
    })),
  };
}

/** 답장·전달에서 원본이 세션 사용자 소유인지 확인한다 (webmail-issues.md 3-1) */
export async function ownsMailId(userName: string, mailId: string): Promise<boolean> {
  const row = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .select('o.MAIL_ID')
    .where('o.MAIL_ID', '=', mailId)
    .where('b.USER_NAME', '=', userName)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * MAIL_ID 로 원문 경로 찾기 (답장/전달 시 서버가 원본 파트를 꺼낼 때).
 *
 * references 는 이 메일이 이미 들고 있던 조상 사슬이다 (JAMES_MAIL_REFERENCE, 뿌리부터).
 * 답장의 References 헤더는 "원본의 References + 원본 Message-ID" 여야 하므로
 * (RFC 5322 3.6.4) 답장을 조립하는 쪽이 이 값을 받아 이어 붙인다 — 원본 Message-ID 만
 * 넣으면 받는 쪽에서 대화가 끊긴다.
 */
export async function findOwnedFileByMailId(
  userName: string,
  mailId: string,
): Promise<{
  filePath: string;
  subject: string | null;
  from: string | null;
  messageId: string;
  references: string[];
} | null> {
  const row = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .select(['m.MAIL_FILE_PATH as p', 'm.MAIL_SUBJECT as s', 'm.MAIL_FROM as f', 'm.MESSAGE_ID as mid'])
    .where('o.MAIL_ID', '=', mailId)
    .where('b.USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return null;

  const refs = await db
    .selectFrom('JAMES_MAIL_REFERENCE')
    .select('REF_MESSAGE_ID')
    .where('MAIL_ID', '=', mailId)
    .orderBy('REF_ORDINAL', 'asc')
    .execute();

  return {
    filePath: row.p,
    subject: row.s,
    from: row.f,
    messageId: row.mid,
    references: refs.map((r) => r.REF_MESSAGE_ID),
  };
}
