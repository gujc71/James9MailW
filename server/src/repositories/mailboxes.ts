/**
 * JAMES_MAILBOX 조회.
 *
 * 편지함 트리는 JAMES_MAILBOX 단독 조회로 완성된다 (web.md 3 절).
 * 소유자(USER_NAME) · 표시 순서(MAILBOX_ORDER) · 기본/개인 구분(MAILBOX_TYPE)이 같은 행에 있다.
 */
import { db, dbWrite } from '../db/kysely.js';
import { t, DEFAULT_LOCALE, type Locale } from '../i18n.js';

/**
 * 계정 생성 시 함께 만들어지는 기본 편지함의 DB 이름.
 *
 * 화면 설계서(슬라이드 34)는 INBOX/Sent/Trash/Spam/Draft, web.md 는 Drafts/Junk 로 적었는데
 * 실제 DB 에 만들어진 이름은 INBOX, Outbox, Sent, Trash, Drafts, Archive, Spam 이다.
 * 실제 이름을 정본으로 삼고, 화면 표시 이름만 아래 표에서 붙인다.
 * MAILBOX_TYPE 은 나중에 추가된 컬럼이라 기존 행이 NULL 이므로 이름으로도 판별한다.
 */
export const SYSTEM_MAILBOXES = [
  'INBOX',
  'Sent',
  'Drafts',
  'Trash',
  'Spam',
  'Outbox',
  'Archive',
] as const;

export type SystemMailboxName = (typeof SYSTEM_MAILBOXES)[number];

/**
 * 계정을 만들 때 함께 만들어 두는 기본 편지함. 배열 순서가 곧 MAILBOX_ORDER 라서
 * sql/02-seed.sql 의 시드 계정과 같은 구성·같은 순서가 된다.
 * Outbox / Archive 는 예전 계정에 남아 있어 SYSTEM_MAILBOXES 에는 두지만 새로 만들지는 않는다.
 */
export const DEFAULT_MAILBOXES = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam'] as const;

/** 편지함 역할. Sent 사본 저장, 스팸 이동, 삭제함 이동에서 이 값으로 대상 편지함을 찾는다 */
export type MailboxRole = SystemMailboxName | 'personal';



export interface MailboxRow {
  id: string;
  /** DB 에 저장된 전체 이름. 하위 편지함은 INBOX.ddd 처럼 . 로 구분된다 */
  name: string;
  /** 화면에 보여 줄 이름. 기본 편지함만 로케일 이름으로 바꾼다 */
  displayName: string;
  /** 부모 편지함의 전체 이름. 최상위면 null */
  parentName: string | null;
  role: MailboxRole;
  isSystem: boolean;
  order: number;
  messageCount: number;
  unseenCount: number;
  size: number;
}

function roleOf(name: string, type: string | null): MailboxRole {
  const system = (SYSTEM_MAILBOXES as readonly string[]).includes(name);
  if (system && type !== 'p') return name as SystemMailboxName;
  return 'personal';
}

function displayNameOf(name: string, role: MailboxRole, locale: Locale): string {
  // 기본 편지함만 언어별 이름으로 바꾼다. 개인 편지함은 사용자가 지은 이름 그대로
  if (role !== 'personal') return t(locale, `mailbox.${name}`);
  // 하위 편지함은 마지막 마디만 보여 준다
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

/** 사용자의 편지함 전부 + 안 읽은 메일 수. 화면 설계서 USR-3 */
export async function listMailboxes(
  userName: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<MailboxRow[]> {
  const boxes = await db
    .selectFrom('JAMES_MAILBOX')
    .select([
      'MAILBOX_ID',
      'MAILBOX_NAME',
      'MAILBOX_TYPE',
      'MAILBOX_ORDER',
      'MAILBOX_MESSAGE_COUNT',
      'MAILBOX_SIZE',
    ])
    .where('USER_NAME', '=', userName)
    .orderBy('MAILBOX_ORDER', 'asc')
    .orderBy('MAILBOX_NAME', 'asc')
    .execute();

  if (boxes.length === 0) return [];

  const unseen = await db
    .selectFrom('JAMES_MAIL_OWNER')
    .select(({ fn }) => ['MAILBOX_ID', fn.countAll<number>().as('cnt')])
    .where(
      'MAILBOX_ID',
      'in',
      boxes.map((b) => b.MAILBOX_ID),
    )
    .where('MAIL_IS_SEEN', '=', 0)
    .where('MAIL_IS_DELETED', '=', 0)
    .groupBy('MAILBOX_ID')
    .execute();

  const unseenByBox = new Map(unseen.map((u) => [u.MAILBOX_ID, Number(u.cnt)]));
  const names = new Set(boxes.map((b) => b.MAILBOX_NAME));

  return boxes.map((box) => {
    const role = roleOf(box.MAILBOX_NAME, box.MAILBOX_TYPE);
    const dot = box.MAILBOX_NAME.lastIndexOf('.');
    const parentName = dot < 0 ? null : box.MAILBOX_NAME.slice(0, dot);
    return {
      id: box.MAILBOX_ID,
      name: box.MAILBOX_NAME,
      displayName: displayNameOf(box.MAILBOX_NAME, role, locale),
      // 부모가 실제로 존재할 때만 트리로 잇는다
      parentName: parentName && names.has(parentName) ? parentName : null,
      role,
      isSystem: role !== 'personal',
      order: box.MAILBOX_ORDER ?? 0,
      messageCount: Number(box.MAILBOX_MESSAGE_COUNT ?? 0),
      unseenCount: unseenByBox.get(box.MAILBOX_ID) ?? 0,
      size: Number(box.MAILBOX_SIZE ?? 0),
    };
  });
}

/** 편지함 하나. 소유자 확인을 겸한다 */
export async function findMailbox(
  userName: string,
  mailboxId: string,
): Promise<{ id: string; name: string; role: MailboxRole } | null> {
  const row = await db
    .selectFrom('JAMES_MAILBOX')
    .select(['MAILBOX_ID', 'MAILBOX_NAME', 'MAILBOX_TYPE'])
    .where('MAILBOX_ID', '=', mailboxId)
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.MAILBOX_ID,
    name: row.MAILBOX_NAME,
    role: roleOf(row.MAILBOX_NAME, row.MAILBOX_TYPE),
  };
}

/**
 * 역할로 편지함을 찾는다. 발송 후 Sent 사본을 넣을 MAILBOX_ID 를 여기서 얻는다
 * (webmail-architecture.md 발송 흐름 5단계).
 */
export async function findSystemMailbox(
  userName: string,
  name: SystemMailboxName,
): Promise<{ id: string; name: string } | null> {
  const row = await db
    .selectFrom('JAMES_MAILBOX')
    .select(['MAILBOX_ID', 'MAILBOX_NAME'])
    .where('USER_NAME', '=', userName)
    .where('MAILBOX_NAME', '=', name)
    .executeTakeFirst();
  return row ? { id: row.MAILBOX_ID, name: row.MAILBOX_NAME } : null;
}

/** 사용자의 모든 편지함 ID. "전체 메일" 화면과 소유권 검사에 쓴다 */
export async function listMailboxIds(userName: string): Promise<string[]> {
  const rows = await db
    .selectFrom('JAMES_MAILBOX')
    .select('MAILBOX_ID')
    .where('USER_NAME', '=', userName)
    .execute();
  return rows.map((r) => r.MAILBOX_ID);
}

/** 사용자가 이미 가진 편지함 이름. 기본 편지함이 빠졌는지 볼 때 쓴다 */
export async function listMailboxNames(userName: string): Promise<string[]> {
  const rows = await db
    .selectFrom('JAMES_MAILBOX')
    .select('MAILBOX_NAME')
    .where('USER_NAME', '=', userName)
    .execute();
  return rows.map((r) => r.MAILBOX_NAME);
}

/**
 * 기본 편지함의 표시 순서·구분을 채운다. MAILBOX_ORDER / MAILBOX_TYPE 은 James 엔진이
 * 읽지 않는 웹 전용 컬럼이라 직접 UPDATE 해도 MODSEQ·리스너 정합성 문제가 없다
 * (users.updateProfile 과 같은 이유). 편지함 자체는 반드시 James 가 만든다.
 */
export async function markDefaultMailbox(
  userName: string,
  name: string,
  order: number,
): Promise<void> {
  await dbWrite
    .updateTable('JAMES_MAILBOX')
    .set({ MAILBOX_ORDER: order, MAILBOX_TYPE: 'b' })
    .where('USER_NAME', '=', userName)
    .where('MAILBOX_NAME', '=', name)
    .execute();
}

/** 편지함 목록(ID·이름)만. 계정 삭제처럼 안 읽은 수가 필요 없는 곳에서 쓴다 */
export async function listMailboxRefs(userName: string): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .selectFrom('JAMES_MAILBOX')
    .select(['MAILBOX_ID', 'MAILBOX_NAME'])
    .where('USER_NAME', '=', userName)
    .execute();
  return rows.map((r) => ({ id: r.MAILBOX_ID, name: r.MAILBOX_NAME }));
}

/** 편지함에 든 메일 UID 전부. expunge 대상 목록이다 */
export async function listMailboxUids(mailboxId: string): Promise<number[]> {
  const rows = await db
    .selectFrom('JAMES_MAIL_OWNER')
    .select('MAIL_UID')
    .where('MAILBOX_ID', '=', mailboxId)
    .execute();
  return rows.map((r) => Number(r.MAIL_UID));
}
