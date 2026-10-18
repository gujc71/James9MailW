/**
 * 발송 실패 안내메일.
 *
 * 메일 서버가 RCPT TO 단계에서 거부한 수신자가 있으면(550 5.1.1 Unknown user 등)
 * 발신자의 받은 편지함에 안내메일을 넣는다. 화면의 오류 표시는 창을 닫으면 사라지지만
 * 안내메일은 남아서, 누구에게 못 갔는지 나중에도 확인할 수 있다.
 *
 * SMTP 로 다시 제출하지 않고 APPEND 로 바로 넣는다. 안내메일이 또 거부돼 안내메일을
 * 낳는 고리를 원천적으로 막고, 발신자 편지함에 들어가는 것을 보장하기 위해서다.
 * 그래서 이 메일은 James 의 Sieve 규칙·스팸 판정을 타지 않는다.
 *
 * 알리는 것은 "못 간 주소와 그 사유" 뿐이다. 원문은 붙이지 않고, 정상 발송된 수신자도
 * 적지 않는다 — 전자는 보낸 편지함에 있고 후자는 안내의 대상이 아니다.
 *
 * 다룰 수 있는 범위는 "제출 때 즉시 거부된 수신자"뿐이다. 외부 도메인 수신자는
 * James 가 일단 접수(250)하므로 실패를 여기서 알 수 없고 상대 서버의 반송 메일로만 온다
 * (services/compose.ts precheckRecipients 주석 참고).
 */
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { uuidv7 } from '../util/uuidv7.js';
import { buildMail, escapeHtml } from '../mime/build.js';
import { commitStaging, removeStaging, stagingPartPath } from '../store/staging.js';
import { findSystemMailbox } from '../repositories/mailboxes.js';
import { appendStagedFile } from './append.js';
import { config } from '../config.js';
import type { RejectedRecipient } from '../james/smtp.js';
import { t, DEFAULT_LOCALE, type Locale } from '../i18n.js';

export interface UndeliveredNotice {
  /** 발신자 = 안내메일을 받을 사람 */
  userName: string;
  displayName: string | null;
  /** 원본 메일 제목 */
  subject: string;
  rejected: RejectedRecipient[];
  /** 발신자가 쓰는 언어. 안내메일 문구를 이 언어로 만든다 */
  locale?: Locale;
}

/** 안내메일 발신 주소. 지정이 없으면 발신자 도메인의 postmaster 를 쓴다 */
function postmasterFor(userName: string): string {
  if (config.policy.postmaster) return config.policy.postmaster;
  const at = userName.lastIndexOf('@');
  return at > 0 ? `postmaster@${userName.slice(at + 1)}` : 'postmaster@localhost';
}

/** 550 응답 줄에서 사람이 읽을 사유만 남긴다. 형식이 다르면 응답을 그대로 쓴다 */
function reasonOf(response: string): string {
  const match = /^\d{3}[ -](?:\d\.\d\.\d\s+)?(.*)$/.exec(response.trim());
  return (match?.[1] ?? response).trim();
}

function noticeHtml(notice: UndeliveredNotice): string {
  const locale = notice.locale ?? DEFAULT_LOCALE;
  const rows = notice.rejected
    .map((item) => {
      const reason = reasonOf(item.response);
      return (
        `<tr>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(item.address)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">${escapeHtml(
          reason || t(locale, 'mail.notice.reason'),
        )}</td>` +
        `</tr>`
      );
    })
    .join('');

  return (
    `<div style="font-family:'Malgun Gothic',sans-serif;font-size:14px;color:#333">` +
    `<p style="margin:0 0 12px">${t(locale, 'mail.notice.intro', {
      subject: escapeHtml(notice.subject || t(locale, 'mail.noSubject')),
    })}</p>` +
    `<table style="border-collapse:collapse;min-width:320px">` +
    `<thead><tr>` +
    `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd">${t(locale, 'mail.notice.to')}</th>` +
    `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd">${t(locale, 'mail.notice.why')}</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="margin:12px 0 0;color:#888;font-size:12px">` +
    `${t(locale, 'mail.notice.hint')}<br>` +
    `${t(locale, 'mail.notice.auto')}</p>` +
    `</div>`
  );
}

/**
 * 안내메일을 발신자 INBOX 에 넣는다. 성공 여부를 돌려줄 뿐 예외를 올리지 않는다 —
 * 안내에 실패했다고 발송 처리 전체를 실패로 되돌릴 수는 없기 때문이다.
 */
export async function sendUndeliveredNotice(notice: UndeliveredNotice): Promise<boolean> {
  if (notice.rejected.length === 0) return false;

  const locale = notice.locale ?? DEFAULT_LOCALE;
  const mailId = uuidv7();
  try {
    const inbox = await findSystemMailbox(notice.userName, 'INBOX');
    if (!inbox) return false;

    const built = buildMail({
      senderMailId: mailId,
      from: { name: t(locale, 'mail.notice.from'), address: postmasterFor(notice.userName) },
      to: [{ name: notice.displayName, address: notice.userName }],
      cc: [],
      bcc: [],
      subject: t(locale, 'mail.notice.subject', {
        subject: notice.subject || t(locale, 'mail.noSubject'),
      }),
      html: noticeHtml(notice),
      attachments: [],
      important: true,
    });

    await pipeline(built.stream, createWriteStream(stagingPartPath(mailId)));
    await commitStaging(mailId);

    // 안 읽음으로 넣어야 목록에서 눈에 띈다
    const outcome = await appendStagedFile({ mailboxId: inbox.id, mailId, flags: [] });
    return outcome.ok;
  } catch {
    await removeStaging(mailId);
    return false;
  }
}
