/**
 * 수신확인 요청(MDN)에 회신하기 (feature-gap.md 4-4).
 *
 * 받은 메일에 `Disposition-Notification-To` 가 있으면 읽기 화면이 "읽었다고 알릴까요" 를
 * 묻고, 사용자가 [발송] 을 누르면 여기서 회신을 만들어 SMTP 로 제출한다.
 *
 * **자동으로는 한 통도 나가지 않는다.** 메일을 열었다는 사실은 사용자가 알리기로 한
 * 때에만 나가야 한다 — 그래서 \Seen 세팅(routes/mutations.ts)과 이 경로는 완전히 별개다.
 *
 * 판정은 전부 서버가 다시 한다. 브라우저가 "이 주소로 보내 달라" 고 해도 믿지 않고,
 * 원문 헤더를 직접 읽어 회신받을 주소를 꺼낸다 — 안 그러면 아무 주소로나 "그 사람이
 * 메일을 읽었다" 를 흘려보낼 수 있다 (webmail-issues.md 1-2 와 같은 사정).
 *
 * 내가 보낸 메일(보낸 편지함 사본·내게도 발송)에는 묻지 않는다. 내가 붙인 요청 헤더가
 * 그대로 실려 있어 그냥 두면 나에게 내가 회신하게 된다.
 */
import { writeFile } from 'node:fs/promises';
import { uuidv7 } from '../util/uuidv7.js';
import { buildMdn, notifyToOf } from '../mime/mdn.js';
import { submit, AllRecipientsRejectedError } from '../james/smtp.js';
import { ensureStagingDir, stagingPartPath, removeStaging } from '../store/staging.js';
import * as messages from '../repositories/messages.js';
import * as aliases from '../repositories/aliases.js';
import * as users from '../repositories/users.js';
import * as gu from '../repositories/gu.js';
import { badRequest, notFound } from '../errors.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n.js';

/** 읽기 화면이 상자를 띄울지 정하는 데 필요한 것 전부. 요청이 없으면 null 이다 */
export interface ReadReceiptState {
  /** 회신받을 주소. 화면에 그대로 보여 준다 — 누구에게 알리는지 알고 눌러야 한다 */
  requestedTo: string;
  /** 이미 회신했으면 그 시각(ISO). null 이면 아직 묻는 중 */
  sentAt: string | null;
}

/** 내가 From 으로 쓸 수 있는 주소 전부 (계정 + 살아 있는 알리아스), 소문자로 */
export async function myAddresses(userName: string): Promise<Set<string>> {
  const sendable = await aliases.listSendableAliases(userName);
  return new Set([userName.toLowerCase(), ...sendable.map((a) => a.address.toLowerCase())]);
}

/**
 * 이 메일이 수신확인 요청을 담고 있는가. 담고 있으면 회신받을 주소와 회신 여부를 돌려준다.
 *
 * 원문 앞머리를 한 번 읽는다. 목록이 아니라 한 통을 열 때만 부르므로 중요도 판정
 * (mime/importance.ts)과 달리 캐시를 두지 않는다 — 회신 여부는 바뀌는 값이다.
 */
export async function readReceiptState(
  userName: string,
  mailboxId: string,
  uid: number,
  detail: { mailId: string; from: string | null },
): Promise<ReadReceiptState | null> {
  const mine = await myAddresses(userName);
  // 내가 보낸 메일이면 묻지 않는다. 내가 붙인 요청 헤더에 내가 답할 일은 없다
  if (detail.from && mine.has(detail.from.toLowerCase())) return null;

  const owned = await messages.findOwnedMessage(userName, mailboxId, uid);
  if (!owned) return null;

  const requestedTo = await notifyToOf(owned.filePath);
  if (!requestedTo) return null;
  // 회신받을 주소가 나 자신이면 보낼 것이 없다 (전달받은 메일 등)
  if (mine.has(requestedTo.toLowerCase())) return null;

  const sentAt = await gu.getMdnSentAt(detail.mailId, userName);
  return { requestedTo, sentAt: sentAt ? sentAt.toISOString() : null };
}

/**
 * 회신 한 통을 보낸다. 이미 보냈으면 다시 보내지 않고 그때의 시각을 돌려준다.
 *
 * 기록을 **먼저** 남긴다. 버튼을 연달아 누르거나 두 탭에서 같은 메일을 열어도 회신은
 * 한 통이어야 하기 때문이다. 제출이 실패하면 기록을 되돌려 다시 시도할 수 있게 한다.
 */
export async function sendReadReceipt(
  userName: string,
  mailboxId: string,
  uid: number,
  locale: Locale = DEFAULT_LOCALE,
): Promise<ReadReceiptState> {
  const detail = await messages.getMessageDetail(userName, mailboxId, uid);
  if (!detail) throw notFound('err.mailNotFound');

  const state = await readReceiptState(userName, mailboxId, uid, detail);
  if (!state) throw badRequest('err.noReadReceiptRequest');
  if (state.sentAt) return state;

  if (!(await gu.markMdnSent(detail.mailId, userName, state.requestedTo))) {
    // 그 사이 다른 요청이 먼저 보냈다. 새로 보내지 않고 그 결과를 그대로 돌려준다
    const sentAt = await gu.getMdnSentAt(detail.mailId, userName);
    return { requestedTo: state.requestedTo, sentAt: sentAt ? sentAt.toISOString() : null };
  }

  const user = await users.findUser(userName);
  const raw = buildMdn({
    from: { name: user?.displayName ?? null, address: userName },
    to: state.requestedTo,
    originalSubject: detail.subject,
    originalMessageId: detail.messageId,
    locale,
  });

  // 발송 경로는 평소와 같다 — 스테이징 .part 에 쓰고 봉투를 지정해 제출한다.
  // 사본은 남기지 않는다. 사용자가 쓴 메일이 아니라 시스템 회신이라 보낸 편지함에
  // 끼면 목록이 지저분해진다 (services/deliveryNotice.ts 와 같은 판단).
  const stagingId = uuidv7();
  try {
    await ensureStagingDir();
    await writeFile(stagingPartPath(stagingId), raw, 'utf8');
    await submit({
      rawPath: stagingPartPath(stagingId),
      envelopeFrom: userName,
      envelopeTo: [state.requestedTo],
    });
  } catch (cause) {
    await gu.clearMdnSent(detail.mailId, userName);
    if (cause instanceof AllRecipientsRejectedError) {
      throw badRequest('err.readReceiptRejected', { address: state.requestedTo });
    }
    throw cause;
  } finally {
    await removeStaging(stagingId);
  }

  const sentAt = await gu.getMdnSentAt(detail.mailId, userName);
  return { requestedTo: state.requestedTo, sentAt: (sentAt ?? new Date()).toISOString() };
}
