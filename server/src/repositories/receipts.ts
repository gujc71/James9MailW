/**
 * 수신확인 (USR-2).
 *
 * MailRecorder 가 수신 메일의 X-Sender-Mail-ID 헤더를 JAMES_MAIL_RECEIPT.SENDER_MAIL_ID 로
 * 기록하고, 수신자가 \Seen 으로 바꾸는 순간 READ_DATE 를 찍는다. 발신자 Sent 사본의
 * MAIL_ID 가 그 헤더 값과 같으므로 SENDER_MAIL_ID = 사본 MAIL_ID 로 조인한다
 * (webmail-issues.md 1-1, 3-3).
 *
 * 외부 도메인 수신자는 수신확인 행이 생기지 않는다. 그 수신자는 읽었는지 알 수 없고 회수도
 * 못 하므로, 빠뜨리지 말고 **추적 불가로 따로 세어 화면에 돌려준다** (feature-gap.md 4-4).
 * 그러지 않으면 외부로만 보낸 메일이 "0/0" 으로 보여 아직 아무도 안 읽은 것처럼 읽힌다.
 */
import { sql } from 'kysely';
import { addressParser, decodeWords } from 'postal-mime';
import { db } from '../db/kysely.js';
import { escapeLike, toIso } from '../util/mysql.js';

/**
 * JAMES_MAIL_RECIPIENTS.MAIL_ADDRESS 에서 주소만 꺼낸다.
 *
 * MailRecorder 는 To/Cc 헤더를 적힌 그대로 넣으므로 표시이름이 붙어 있을 수 있다
 * (`"관리자" <admin@example.com>`). 반면 JAMES_MAIL_RECEIPT.RECIPIENT 은 봉투 주소라
 * 언제나 맨주소다. 그대로 맞대면 한 사람이 두 줄로 갈라지고, 수신확인 행이 없는 쪽이
 * **외부 도메인으로 잘못 찍힌다** — "내게도 발송"은 서버가 계정 표시이름을 붙여 To 에
 * 넣으므로(services/compose.ts sendMail) 늘 이 꼴이 된다.
 */
export function bareAddress(raw: string): string {
  const match = /<([^>]*)>\s*$/.exec(raw);
  return (match ? match[1]! : raw).trim();
}

/** MAIL_ADDRESS 의 표시이름 (`"관리자" <admin@example.com>` → 관리자). 없으면 null */
function displayNameOf(raw: string): string | null {
  if (!raw.includes('<')) return null;
  const name = addressParser(raw)[0]?.name?.trim();
  return name ? decodeWords(name).trim() || null : null;
}

/** bareAddress 의 SQL 판. 세는 일은 DB 가 하므로 한 벌 더 둔다 */
const BARE_ADDRESS_SQL = sql`trim(substring_index(substring_index(rc1.MAIL_ADDRESS, '<', -1), '>', 1))`;

export interface ReceiptSummary {
  mailId: string;
  subject: string | null;
  sentAt: string | null;
  /** 수신확인이 되는 수신자 수 (내부 계정). readCount 의 분모다 */
  recipientCount: number;
  readCount: number;
  /** 수신확인이 안 되는 수신자 수 (외부 도메인). 읽음 여부도 회수도 알 수 없다 */
  untrackedCount: number;
  /** 목록에 "홍길동 외 3" 형태로 보여줄 첫 수신자 */
  firstRecipient: string | null;
}

export async function listSentWithReceipts(params: {
  userName: string;
  sentMailboxId: string;
  keyword?: string;
  searchField?: 'subject' | 'recipient';
  limit: number;
  offset: number;
}): Promise<ReceiptSummary[]> {
  let query = db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .select(({ fn, selectFrom }) => [
      'o.MAIL_ID as MAIL_ID',
      'm.MAIL_SUBJECT as MAIL_SUBJECT',
      'm.MAIL_DATE as MAIL_DATE',
      selectFrom('JAMES_MAIL_RECEIPT as r')
        .select(fn.countAll<number>().as('c'))
        .whereRef('r.SENDER_MAIL_ID', '=', 'o.MAIL_ID')
        .as('RCPT_COUNT'),
      selectFrom('JAMES_MAIL_RECEIPT as r2')
        .select(fn.countAll<number>().as('c'))
        .whereRef('r2.SENDER_MAIL_ID', '=', 'o.MAIL_ID')
        .where('r2.READ_DATE', 'is not', null)
        .as('READ_COUNT'),
      selectFrom('JAMES_MAIL_RECIPIENTS as rc0')
        .select('rc0.MAIL_ADDRESS')
        .whereRef('rc0.MAIL_ID', '=', 'o.MAIL_ID')
        .limit(1)
        .as('FIRST_RCPT'),
      // 실제로 적은 수신자 수. 같은 주소를 받는사람과 참조에 겹쳐 적었으면 한 명으로 센다.
      // 표시이름은 떼고 센다 — `"관리자" <admin@example.com>` 과 `admin@example.com` 은
      // 같은 사람인데 문자열로는 달라, 그대로 세면 없는 수신자가 외부로 잡힌다 (bareAddress).
      selectFrom('JAMES_MAIL_RECIPIENTS as rc1')
        .select(() => sql<number>`count(distinct ${BARE_ADDRESS_SQL})`.as('c'))
        .whereRef('rc1.MAIL_ID', '=', 'o.MAIL_ID')
        .as('RCPT_TOTAL'),
    ])
    .where('o.MAILBOX_ID', '=', params.sentMailboxId)
    .where('o.MAIL_IS_DELETED', '=', 0);

  if (params.keyword?.trim()) {
    const like = `%${escapeLike(params.keyword.trim())}%`;
    if (params.searchField === 'recipient') {
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('JAMES_MAIL_RECIPIENTS as rc')
            .select('rc.RECIPIENT_ID')
            .whereRef('rc.MAIL_ID', '=', 'o.MAIL_ID')
            .where('rc.MAIL_ADDRESS', 'like', like),
        ),
      );
    } else {
      query = query.where('m.MAIL_SUBJECT', 'like', like);
    }
  }

  const rows = await query
    .orderBy('m.MAIL_DATE', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();

  return rows.map((r) => {
    const tracked = Number(r.RCPT_COUNT ?? 0);
    const addressed = Number(r.RCPT_TOTAL ?? 0);
    return {
      mailId: r.MAIL_ID,
      subject: r.MAIL_SUBJECT,
      sentAt: toIso(r.MAIL_DATE),
      recipientCount: tracked,
      readCount: Number(r.READ_COUNT ?? 0),
      // 알리아스로 여러 수신확인 행이 생길 수도 있어 음수로 내려가지 않게 막는다
      untrackedCount: Math.max(0, addressed - tracked),
      firstRecipient: r.FIRST_RCPT ? bareAddress(r.FIRST_RCPT as string) : null,
    };
  });
}

export interface ReceiptDetail {
  recipient: string;
  /** 메일 헤더(To/Cc)에 적힌 표시이름. 없으면 null */
  name: string | null;
  readDate: string | null;
  /** 수신확인이 되는 수신자인가. false 면 외부 도메인이라 읽음 여부를 알 수 없다 */
  tracked: boolean;
  /** 회수 대상 편지함/UID. 아직 안 읽은 내부 수신자만 회수할 수 있다 */
  recallTarget: { mailboxId: string; uid: number } | null;
}

/**
 * [+] 상세 팝업. 수신자별 읽은 날짜와 회수 가능 여부.
 *
 * 수신확인 행이 있는 수신자(내부)와, 적어 보냈지만 행이 없는 수신자(외부)를 함께 돌려준다.
 * 외부는 `tracked: false` 로 표시만 하고 회수 대상에서 뺀다.
 */
export async function receiptDetail(
  senderMailId: string,
): Promise<ReceiptDetail[]> {
  const [receipts, addressed] = await Promise.all([
    db
      .selectFrom('JAMES_MAIL_RECEIPT')
      .select(['MAIL_ID', 'RECIPIENT', 'READ_DATE'])
      .where('SENDER_MAIL_ID', '=', senderMailId)
      .execute(),
    // 발신자 Sent 사본의 MAIL_ID 가 senderMailId 다. 그 사본에 적힌 수신자가 실제로 보낸 대상
    db
      .selectFrom('JAMES_MAIL_RECIPIENTS')
      .select('MAIL_ADDRESS')
      .where('MAIL_ID', '=', senderMailId)
      .execute(),
  ]);

  // 회수는 수신자 편지함의 JAMES_MAIL_OWNER 행을 지우는 것이다.
  // 어느 편지함의 몇 번 UID 인지 찾아 둔다.
  const ownerByUser = new Map<string, { mailboxId: string; uid: number }>();
  if (receipts.length > 0) {
    const owners = await db
      .selectFrom('JAMES_MAIL_OWNER as o')
      .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
      .select([
        'o.MAIL_ID as MAIL_ID',
        'o.MAILBOX_ID as MAILBOX_ID',
        'o.MAIL_UID as MAIL_UID',
        'b.USER_NAME as USER_NAME',
      ])
      .where(
        'o.MAIL_ID',
        'in',
        receipts.map((r) => r.MAIL_ID),
      )
      .execute();

    for (const owner of owners) {
      if (!owner.USER_NAME) continue;
      ownerByUser.set(`${owner.MAIL_ID}|${owner.USER_NAME.toLowerCase()}`, {
        mailboxId: owner.MAILBOX_ID!,
        uid: Number(owner.MAIL_UID),
      });
    }
  }

  const rows: ReceiptDetail[] = receipts.map((r) => {
    const read = toIso(r.READ_DATE);
    return {
      recipient: r.RECIPIENT,
      name: null,
      readDate: read,
      tracked: true,
      recallTarget: read ? null : (ownerByUser.get(`${r.MAIL_ID}|${r.RECIPIENT.toLowerCase()}`) ?? null),
    };
  });

  // 헤더에 적힌 표시이름. 수신확인 행의 RECIPIENT 은 봉투 주소라 이름이 없다
  const nameByAddress = new Map<string, string>();
  for (const row of addressed) {
    const name = displayNameOf(row.MAIL_ADDRESS ?? '');
    if (name) nameByAddress.set(bareAddress(row.MAIL_ADDRESS ?? '').toLowerCase(), name);
  }
  for (const row of rows) row.name = nameByAddress.get(row.recipient.toLowerCase()) ?? null;

  // 수신확인 행이 없는 수신자 = 외부 도메인. 읽었는지 알 수 없고 회수도 못 한다
  const seen = new Set(rows.map((row) => row.recipient.toLowerCase()));
  for (const row of addressed) {
    // 표시이름이 붙어 있으면(`"관리자" <admin@example.com>`) 맨주소만 남긴다. 수신확인 행의
    // RECIPIENT 은 봉투 주소라 늘 맨주소여서, 그대로 견주면 같은 사람이 한 줄 더 생긴다.
    const address = bareAddress(row.MAIL_ADDRESS ?? '');
    if (!address) continue;
    const key = address.toLowerCase();
    // 같은 주소를 받는사람과 참조에 겹쳐 적었으면 한 번만 싣는다
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ recipient: address, name: nameByAddress.get(key) ?? null, readDate: null, tracked: false, recallTarget: null });
  }

  return rows;
}

/**
 * 보낸 메일의 Sent 사본 MAIL_ID (= 수신확인 행의 SENDER_MAIL_ID).
 * 연 메일이 "내게도 발송" 으로 받은 사본이면 그 사본의 수신확인 행에서 거슬러 찾는다.
 */
export async function senderMailIdOf(mailId: string): Promise<string> {
  const asSender = await db
    .selectFrom('JAMES_MAIL_RECEIPT')
    .select('SENDER_MAIL_ID')
    .where('SENDER_MAIL_ID', '=', mailId)
    .executeTakeFirst();
  if (asSender) return mailId;
  const asCopy = await db
    .selectFrom('JAMES_MAIL_RECEIPT')
    .select('SENDER_MAIL_ID')
    .where('MAIL_ID', '=', mailId)
    .executeTakeFirst();
  return asCopy?.SENDER_MAIL_ID ?? mailId;
}

/**
 * 내부 수신자가 약속메일에 단 응답 (GU_CALENDAR_RESPONSE). 수신자 사본 MAIL_ID 로 잇는다.
 * 키는 소문자 수신 주소, 값은 응답과 그 시각.
 */
export async function internalCalendarResponses(
  senderMailId: string,
): Promise<Map<string, { response: string; respondedAt: string | null }>> {
  const rows = await db
    .selectFrom('JAMES_MAIL_RECEIPT as r')
    .innerJoin('GU_CALENDAR_RESPONSE as c', 'c.MAIL_ID', 'r.MAIL_ID')
    .select(['r.MAIL_ID as MAIL_ID', 'r.RECIPIENT as RECIPIENT', 'c.USER_NAME as USER_NAME', 'c.RESPONSE_TYPE as RESPONSE_TYPE', 'c.RESPONSE_DATE as RESPONSE_DATE'])
    .where('r.SENDER_MAIL_ID', '=', senderMailId)
    .where('c.RESPONSE_TYPE', 'in', ['ACCEPT', 'TENTATIVE', 'DECLINE'])
    .execute();
  const result = new Map<string, { response: string; respondedAt: string | null }>();
  for (const row of rows) {
    const recipient = row.RECIPIENT.toLowerCase();
    // 사본을 여럿이 나눠 가진 경우에 대비해 수신 주소와 계정이 같은 응답을 먼저 잡는다.
    // 알리아스로 받았으면 계정 이름이 다르므로, 그 사본에 응답이 하나뿐일 때만 그것으로 본다
    const sameUser = row.USER_NAME.toLowerCase() === recipient;
    const single = rows.filter((other) => other.MAIL_ID === row.MAIL_ID).length === 1;
    if (!sameUser && !single) continue;
    if (result.has(recipient) && !sameUser) continue;
    result.set(recipient, { response: row.RESPONSE_TYPE, respondedAt: toIso(row.RESPONSE_DATE) });
  }
  return result;
}
