/**
 * 내가 보낸 약속메일의 수신자별 응답 현황 (읽기 화면 [약속 응답 확인]).
 *
 * 두 군데서 모은다.
 *  - 내부 수신자: 그 사람이 읽기 화면에서 고른 응답이 GU_CALENDAR_RESPONSE 에 시각과 함께 남는다.
 *    수신확인 행(JAMES_MAIL_RECEIPT)이 내 Sent 사본과 수신자 사본을 잇는다.
 *  - 외부 수신자: 상대 메일 프로그램이 보낸 응답(METHOD:REPLY) 메일이 내 편지함에 온다.
 *    같은 UID 의 일정을 말하는 것만 골라 참석자 PARTSTAT 을 읽는다. 응답 시각은 그 메일의 날짜.
 * 둘 다 있으면 내부 기록을 믿는다 — 응답 메일은 지웠을 수도 있다.
 */
import * as messages from '../repositories/messages.js';
import * as receipts from '../repositories/receipts.js';
import { replyMailCandidates } from '../repositories/gu.js';
import { parseCalendar } from '../calendar/ical.js';
import { calendarPartOf } from './calendarReplies.js';
import { myAddresses } from './readReceipt.js';
import { notFound, badRequest } from '../errors.js';
import { toIso } from '../util/mysql.js';

export type AttendanceResponse = 'ACCEPT' | 'TENTATIVE' | 'DECLINE';

export interface AttendanceRow {
  recipient: string;
  /** null 이면 아직 응답이 없다 */
  response: AttendanceResponse | null;
  respondedAt: string | null;
}

/** 응답 메일을 열어 보는 상한. 이보다 많으면 오래된 것부터 본다 */
const MAX_REPLY_MAILS = 200;

const FROM_PARTSTAT: Record<string, AttendanceResponse> = {
  ACCEPTED: 'ACCEPT',
  TENTATIVE: 'TENTATIVE',
  DECLINED: 'DECLINE',
};

export async function calendarAttendance(userName: string, mailboxId: string, uid: number): Promise<AttendanceRow[]> {
  const [detail, owned, mine] = await Promise.all([
    messages.getMessageDetail(userName, mailboxId, uid),
    messages.findOwnedMessage(userName, mailboxId, uid),
    myAddresses(userName),
  ]);
  if (!detail || !owned) throw notFound('err.mailNotFound');
  if (!detail.from || !mine.has(detail.from.toLowerCase())) throw badRequest('err.mailNotFound');

  const ics = await calendarPartOf(owned.filePath, 'REQUEST').catch(() => null);
  const eventUid = ics ? parseCalendar(ics, 'UTC').items[0]?.uid ?? null : null;

  // 받는사람 · 참조 · 숨은참조. 내게도 발송한 나 자신은 뺀다
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const r of detail.recipients) {
    const address = receipts.bareAddress(r.address);
    const key = address.toLowerCase();
    if (!address || seen.has(key) || mine.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }

  const internal = await receipts.internalCalendarResponses(await receipts.senderMailIdOf(detail.mailId));

  // 외부(또는 내부 기록이 없는) 수신자는 응답 메일에서 찾는다. 나중 응답이 이긴다
  const fromReplies = new Map<string, { response: AttendanceResponse; respondedAt: string | null }>();
  const missing = recipients.filter((r) => !internal.has(r.toLowerCase()));
  if (eventUid && missing.length) {
    const sentAt = detail.sentAt ?? detail.receivedAt;
    const since = sentAt ? new Date(new Date(sentAt).getTime() - 86_400_000) : new Date(0);
    for (const mail of await replyMailCandidates(userName, since, MAX_REPLY_MAILS)) {
      const reply = await calendarPartOf(mail.filePath, 'REPLY').catch(() => null);
      if (!reply) continue;
      let items;
      try {
        items = parseCalendar(reply, 'UTC').items;
      } catch {
        continue;
      }
      for (const item of items) {
        if (item.uid !== eventUid) continue;
        for (const attendee of item.attendees) {
          const response = FROM_PARTSTAT[attendee.partstat];
          if (response) fromReplies.set(attendee.email.toLowerCase(), { response, respondedAt: toIso(mail.mailDate) });
        }
      }
    }
  }

  return recipients.map((recipient) => {
    const key = recipient.toLowerCase();
    const found = internal.get(key) ?? fromReplies.get(key);
    return {
      recipient,
      response: (found?.response as AttendanceResponse | undefined) ?? null,
      respondedAt: found?.respondedAt ?? null,
    };
  });
}
