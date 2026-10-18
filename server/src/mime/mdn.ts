/**
 * 수신확인 요청(MDN) — RFC 8098 · RFC 3798 (feature-gap.md 4-4).
 *
 * 두 방향이 있다.
 *  - **요청 붙이기**: 메일쓰기에서 "수신확인 요청" 을 켜면 `Disposition-Notification-To`
 *    가 실려 나간다. 그쪽은 mime/build.ts 가 맡는다.
 *  - **회신 만들기**: 받은 메일에 그 헤더가 있으면 읽기 화면이 "읽었다고 알릴까요" 를 묻고,
 *    사용자가 누르면 여기서 만든 회신을 발신자에게 보낸다.
 *
 * 회신은 `multipart/report; report-type=disposition-notification` 이고 파트가 둘이다 —
 * 사람이 읽는 text/plain 과 기계가 읽는 message/disposition-notification. MailComposer 로는
 * 이 최상위 타입과 report-type 파라미터를 만들 수 없어 여기서 손으로 조립한다. 파트가
 * 작고 전부 고정 모양이라 스트림으로 흘릴 필요도 없다.
 *
 * **자동으로 보내지 않는다.** 사용자가 버튼을 눌렀을 때만 나가고, 그래서 Disposition 은
 * `manual-action/MDN-sent-manually` 다. 읽었다는 사실을 발신자에게 알리는 것은 프라이버시
 * 문제라 썬더버드·아웃룩도 묻고 나서 보낸다.
 */
import { randomUUID } from 'node:crypto';
import { readMailHead } from '../store/mailStore.js';
import { config } from '../config.js';
import { t, DEFAULT_LOCALE, type Locale } from '../i18n.js';

/** 헤더 블록이 이보다 길면 잘라 읽는다. MDN 요청 헤더는 앞머리에 있다 (mime/importance.ts 와 같다) */
const HEAD_READ_CAP = 32 * 1024;

/**
 * 헤더 블록 → 회신받을 주소. 첫 빈 줄에서 멈추고 접힌 줄을 편다.
 *
 * `Disposition-Notification-To` 가 표준이고, 아웃룩 이전 세대가 쓰던
 * `Return-Receipt-To` 도 같은 뜻으로 받아 준다 — 후자는 원래 배달확인(DSN)용이지만
 * 실제로 읽음 확인 요청으로 쓰여 왔다.
 *
 * 주소 여러 개를 적어 보낼 수 있지만 **첫 번째 하나에만 보낸다.** 목록 전체에 보내면
 * 관계없는 주소로 "이 사람이 메일을 읽었다" 를 흘릴 수 있다.
 */
export function parseNotifyTo(headerBlock: string): string | null {
  const head = headerBlock.split(/\r?\n\r?\n/, 1)[0] ?? '';
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== 'disposition-notification-to' && name !== 'return-receipt-to') continue;
    const first = line.slice(colon + 1).split(',')[0] ?? '';
    const address = (/<([^>]+)>/.exec(first)?.[1] ?? first).trim();
    // 표시이름만 있고 주소가 없는 값(또는 빈 헤더)은 요청이 없는 것으로 본다
    if (/^[^\s@<>",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(address)) return address;
    return null;
  }
  return null;
}

/** 원문 앞머리를 읽어 회신받을 주소를 찾는다. 파일이 없거나 요청이 없으면 null */
export async function notifyToOf(filePath: string): Promise<string | null> {
  const head = await readMailHead(filePath, HEAD_READ_CAP);
  return head === null ? null : parseNotifyTo(head);
}

/** RFC 2047 encoded-word. 제목에 한글이 들어가므로 통째로 base64 로 감싼다 */
function encodeWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** 76자로 접은 base64. 긴 줄 금지(RFC 5322 998자)와 가독성을 함께 지킨다 */
function base64Lines(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');
}

/** 헤더 값에 CR·LF 가 섞여 들어오면 헤더 주입이 된다. 주소·Message-ID 는 반드시 통과시킨다 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface MdnInput {
  /** 회신을 보내는 사람 = 메일을 읽은 사람 */
  from: { name?: string | null; address: string };
  /** 회신받을 주소 (요청 헤더의 값) */
  to: string;
  /** 원본 메일의 제목 · Message-ID */
  originalSubject: string | null;
  originalMessageId: string | null;
  locale?: Locale;
}

/** 표시이름 + 주소. 이름이 없으면 주소만 */
function addressHeader(value: { name?: string | null; address: string }): string {
  const name = value.name?.trim();
  return name ? `${encodeWord(name)} <${oneLine(value.address)}>` : oneLine(value.address);
}

/** `<id@domain>` 모양으로 맞춘다. 꺾쇠가 없는 값이 DB 에 그대로 들어 있다 */
function angled(messageId: string): string {
  const trimmed = oneLine(messageId);
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

/**
 * 회신 한 통을 완성된 RFC 5322 원문으로 만든다.
 *
 * `Auto-Submitted: auto-replied` 를 반드시 붙인다 (RFC 3834). 이것이 없으면 상대 쪽
 * 부재중 자동응답이 이 회신에 또 답해 고리가 생길 수 있다.
 */
export function buildMdn(input: MdnInput): string {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const boundary = `----mdn-${randomUUID()}`;
  const domain =
    config.policy.messageIdDomain ||
    (input.from.address.includes('@')
      ? input.from.address.slice(input.from.address.lastIndexOf('@') + 1)
      : 'localhost');
  const subject = input.originalSubject || t(locale, 'mail.noSubject');

  const human = t(locale, 'mail.mdn.body', {
    reader: input.from.address,
    subject,
    when: new Date().toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US'),
  });

  // 기계가 읽는 파트. 전부 ASCII 이고 값마다 정해진 낱말이 있다 (RFC 8098 3.1)
  const report = [
    `Reporting-UA: ${domain}; james9Mail`,
    `Final-Recipient: rfc822; ${oneLine(input.from.address)}`,
    ...(input.originalMessageId ? [`Original-Message-ID: ${angled(input.originalMessageId)}`] : []),
    'Disposition: manual-action/MDN-sent-manually; displayed',
  ].join('\r\n');

  return [
    `From: ${addressHeader(input.from)}`,
    `To: ${oneLine(input.to)}`,
    `Subject: ${encodeWord(t(locale, 'mail.mdn.subject', { subject }))}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    ...(input.originalMessageId
      ? [
          `In-Reply-To: ${angled(input.originalMessageId)}`,
          `References: ${angled(input.originalMessageId)}`,
        ]
      : []),
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(human),
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    'Content-Transfer-Encoding: 7bit',
    '',
    report,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
