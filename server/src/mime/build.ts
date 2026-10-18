/**
 * Server side MIME assembly (webmail-architecture.md 2.3 발송, webmail-issues.md 3-6).
 *
 * 브라우저는 입력값만 보내고 헤더는 전부 서버가 만든다. From 을 서버가 세팅하므로
 * 위조 검증이 필요 없다. nodemailer 의 MailComposer 가 CRLF, 998자 줄 제한,
 * 한글 제목·표시이름 RFC 2047, 파일명 RFC 2231, quoted-printable/base64 선택,
 * multipart/alternative + related + mixed 중첩을 처리한다.
 *
 * 첨부는 경로(스트림)로 넘긴다. 40MB 급 MIME 을 메모리 문자열로 만들지 않는다 (3-5).
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { sanitizeOutgoingHtml, htmlToText } from './sanitize.js';
import { t, DEFAULT_LOCALE, type Locale } from '../i18n.js';

export interface ComposeAddress {
  name?: string | null;
  address: string;
}

export interface ComposeAttachment {
  filename: string;
  /** 임시 파일 경로. 스트림으로 읽힌다. content 를 주면 비워 둘 수 있다 */
  path?: string;
  /** 작은 첨부(vCard 등)를 파일 없이 바로 넣을 때 */
  content?: string | Buffer;
  size?: number;
  contentType?: string | null;
  /** 인라인 이미지면 cid */
  cid?: string;
}

export interface BuildMailInput {
  senderMailId: string;
  from: ComposeAddress;
  to: ComposeAddress[];
  cc: ComposeAddress[];
  bcc: ComposeAddress[];
  subject: string;
  html: string;
  text?: string | null;
  attachments: ComposeAttachment[];
  /** 답장 헤더 */
  inReplyToMessageId?: string | null;
  references?: string[];
  /** USR-1.4.2 중요 표시 */
  important?: boolean;
  /**
   * 수신확인 요청(MDN). 회신받을 주소 — 서버가 From 에서 꺼낸 값이어야 한다 (feature-gap.md 4-4).
   * 브라우저가 정한 주소를 그대로 실으면 남의 주소로 읽음 회신을 끌어올 수 있다.
   */
  readReceiptTo?: string | null;
  /** iCalendar 약속메일 (USR-1.4.2) */
  icalendar?: string | null;
  /** iTIP 메서드 (RFC 5546). 초대 REQUEST · 취소 CANCEL · 응답 REPLY. 비우면 REQUEST */
  icalMethod?: 'REQUEST' | 'CANCEL' | 'REPLY' | null;
  /** 인라인 data: URI 를 cid: 파트로 바꾼 결과가 여기에 담긴다 */
  extraHeaders?: Record<string, string>;
}

export interface BuiltMail {
  /** 조립된 raw. Bcc 헤더를 포함한다 (Sent 사본용) */
  stream: Readable;
  messageId: string;
}

/** 표시 이름 + 주소 문자열 */
function fmt(address: ComposeAddress): { name: string; address: string } {
  return { name: address.name ?? '', address: address.address };
}

/**
 * 에디터가 넣은 data: URI 이미지를 cid: 참조 + 인라인 첨부로 바꾼다.
 * 그대로 두면 수신 클라이언트 상당수가 data: 이미지를 차단한다 (3-6).
 */
export function inlineDataUrisToCid(
  html: string,
): { html: string; attachments: { cid: string; content: Buffer; contentType: string }[] } {
  const attachments: { cid: string; content: Buffer; contentType: string }[] = [];
  const replaced = html.replace(
    /src\s*=\s*(["'])data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\1/gi,
    (_match, quote: string, contentType: string, base64: string) => {
      const cid = `${randomUUID()}@james9mail`;
      attachments.push({
        cid,
        content: Buffer.from(base64.replace(/\s+/g, ''), 'base64'),
        contentType,
      });
      return `src=${quote}cid:${cid}${quote}`;
    },
  );
  return { html: replaced, attachments };
}

export function messageIdFor(senderMailId: string, fromAddress: string): string {
  const domain =
    config.policy.messageIdDomain ||
    (fromAddress.includes('@') ? fromAddress.slice(fromAddress.lastIndexOf('@') + 1) : 'localhost');
  // MAIL_ID(수신확인 연결 키)와 Message-ID 헤더는 별개지만, 같은 값으로 맞춰 두면
  // 로그 추적이 쉽다 (webmail-architecture.md 2.3).
  return `<${senderMailId}@${domain}>`;
}

/** 조립된 원문을 스트림으로 돌려준다. 호출자가 스테이징 파일로 흘려 쓴다 */
export function buildMail(input: BuildMailInput): BuiltMail {
  // 인라인 이미지(data: base64)를 먼저 cid: 파트로 떼어 낸 뒤 정화한다. 본문 필드는 최대
  // 수 MB 인데 대부분이 base64 라, 그대로 jsdom 에 넣으면 파싱이 이벤트 루프를 오래 붙잡는다.
  // 정규식이 떼어 내지 못한 data: 는 정화 단계에서 그대로 검사를 받는다.
  const { html: withCids, attachments: inlineAttachments } = inlineDataUrisToCid(input.html);
  const html = sanitizeOutgoingHtml(withCids);

  const messageId = messageIdFor(input.senderMailId, input.from.address);

  const headers: Record<string, string> = {
    // MailRecorder 가 이 값을 JAMES_MAIL_RECEIPT.SENDER_MAIL_ID 로 기록하고,
    // 발신자 Sent 사본의 MAIL_ID 를 같은 값으로 지정해 수신확인을 잇는다 (1-1).
    'X-Sender-Mail-ID': input.senderMailId,
    ...(input.extraHeaders ?? {}),
  };
  if (input.readReceiptTo) {
    // 표준은 Disposition-Notification-To 다. Return-Receipt-To 는 옛 아웃룩 계열만 보는
    // 헤더인데 함께 붙여도 해가 없어 같이 넣는다 — 둘 중 하나만 읽는 클라이언트가 있다.
    headers['Disposition-Notification-To'] = input.readReceiptTo;
    headers['Return-Receipt-To'] = input.readReceiptTo;
  }
  if (input.important) {
    // 세 헤더를 함께 붙인다 — 받는 쪽이 어느 것을 보는지 클라이언트마다 다르다.
    // 우리 목록이 읽는 쪽은 mime/importance.ts 다.
    headers['X-Priority'] = '1';
    headers['X-MSMail-Priority'] = 'High';
    headers.Importance = 'high';
  }

  const composer = new MailComposer({
    from: fmt(input.from),
    to: input.to.map(fmt),
    cc: input.cc.length ? input.cc.map(fmt) : undefined,
    // Bcc 헤더는 조립 결과에 남긴다. SMTP 제출분에서만 제거한다 (2-6, 3-2).
    bcc: input.bcc.length ? input.bcc.map(fmt) : undefined,
    subject: input.subject,
    html,
    text: input.text || htmlToText(html) || ' ',
    messageId,
    date: new Date(),
    inReplyTo: input.inReplyToMessageId ?? undefined,
    references: input.references?.length ? input.references : undefined,
    headers,
    attachments: [
      ...inlineAttachments.map((a) => ({
        cid: a.cid,
        content: a.content,
        contentType: a.contentType,
        contentDisposition: 'inline' as const,
        // 확장자가 없으면 인라인 이미지를 첨부 목록에 함께 보여 주는 클라이언트에서
        // 정체를 알 수 없는 파일로 뜬다
        filename: `inline-${a.cid.split('@')[0]}.${(a.contentType.split('/')[1] || 'png').replace(/\+.*$/, '')}`,
      })),
      ...input.attachments.map((a) => ({
        filename: a.filename,
        ...(a.content !== undefined ? { content: a.content } : { path: a.path! }),
        contentType: a.contentType ?? undefined,
        cid: a.cid,
        contentDisposition: a.cid ? ('inline' as const) : ('attachment' as const),
      })),
    ],
    ...(input.icalendar
      ? {
          icalEvent: {
            method: input.icalMethod ?? 'REQUEST',
            content: input.icalendar,
            filename: 'invite.ics',
          },
        }
      : {}),
    // 7bit 보장 + 긴 줄 접기는 MailComposer 가 처리한다
    textEncoding: 'quoted-printable' as const,
  });

  return { stream: composer.compile().createReadStream(), messageId };
}

/**
 * 대용량 첨부 다운로드 링크 블록 (USR-1.4.1).
 * 메일 본문에는 링크만 담고 파일은 GU_LARGE_ATTACH 에 남는다.
 */
export function largeAttachmentBlock(
  baseUrl: string,
  items: { attachId: string; fileName: string; fileSize: number }[],
  expireDate: string | null,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (item) =>
        `<li style="margin:4px 0"><a href="${baseUrl}/large/${item.attachId}">${escapeHtml(item.fileName)}</a>` +
        ` <span style="color:#888">(${formatBytes(item.fileSize)})</span></li>`,
    )
    .join('');
  const expiry = expireDate
    ? `<div style="color:#888;font-size:12px;margin-top:6px">${t(locale, 'mail.large.expire', {
        date: escapeHtml(expireDate.slice(0, 10)),
      })}</div>`
    : '';
  return (
    `<div style="margin-top:16px;padding:12px;border:1px solid #ddd;border-radius:6px">` +
    `<div style="font-weight:600;margin-bottom:6px">${t(locale, 'mail.large.title')}</div>` +
    `<ul style="margin:0;padding-left:18px">${rows}</ul>${expiry}</div>`
  );
}

/** USR-1.4 v-Card 첨부 */
export function buildVCard(displayName: string | null, address: string): string {
  const name = displayName || address.split('@')[0] || address;
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${name};;;;`,
    `FN:${name}`,
    `EMAIL;TYPE=INTERNET:${address}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

/** USR-1.4.2 약속메일 */
export function buildICalendar(params: {
  organizer: string;
  attendees: string[];
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  uid: string;
}): string {
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (value: string) => value.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//james9Mail//KO',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${params.uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(params.start)}`,
    `DTEND:${stamp(params.end)}`,
    `SUMMARY:${escape(params.summary)}`,
    `DESCRIPTION:${escape(params.description)}`,
    `LOCATION:${escape(params.location)}`,
    `ORGANIZER:mailto:${params.organizer}`,
    ...params.attendees.map(
      (a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`,
    ),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
