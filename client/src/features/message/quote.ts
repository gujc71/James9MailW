/**
 * 답장 · 전달 본문 만들기 (feature-gap.md 1-1 · 1-2).
 *
 * 썬더버드 · 아웃룩처럼 **원문을 그대로 인용한다**. 답장은 한 줄 머리말 + 인용 블록,
 * 전달은 "원본 메일" 헤더 블록 뒤에 원문을 붙인다.
 *
 * 원문 HTML 은 남이 보낸 것이라 그대로 에디터에 넣을 수 없다 — 한 번 정화한다.
 * 인라인 이미지(`cid:`)는 `data:` URI 로 바꿔 넣는다. 서버가 발송할 때
 * `inlineDataUrisToCid`(server/src/mime/build.ts) 가 다시 `cid:` 파트로 되돌린다.
 * 너무 큰 인라인 이미지는 본문에서 빼고 첨부로만 남긴다 — 폼 필드로 수십 MB 를
 * 실어 보내지 않기 위해서다.
 *
 * 전달(첨부 포함)은 파싱한 첨부를 File 로 되살려 메일쓰기 첨부칸에 그대로 올린다.
 * 서버에는 MIME 파서가 없고(원문은 파일로만 서빙한다) 파트를 가리키는 오프셋도
 * 아직 없으므로(webmail-issues.md 2-7), 첨부를 다시 조립할 수 있는 곳은 여기뿐이다.
 */
import DOMPurify from 'dompurify';
import type { ParsedAttachment, ParsedMail } from '../../mime/parser';
import { toDataUri } from '../../mime/dataUri';
import { displayAddress, formatFullDate } from '../../lib/format';
import { t } from '../../i18n';

export type ReplyMode = 'reply' | 'replyAll' | 'forward' | 'forwardEml';

/** 본문에 data: 로 심을 인라인 이미지의 한도. 넘으면 첨부로만 간다 */
const MAX_INLINE_BYTES = 1024 * 1024;

export interface Quote {
  /** 에디터에 넣을 본문 HTML. 맨 위는 쓸 자리로 비워 둔다 */
  html: string;
  /** 전달(첨부 포함)일 때 첨부칸에 올릴 파일 */
  attachments: File[];
  /**
   * 원본 eml 로 전달할 때 서버가 붙일 첨부의 이름과 크기.
   * 파일을 다시 올리지는 않는다 — 서버가 원문 파일을 그대로 스트림으로 붙인다.
   * 메일쓰기 첨부칸에 "원본 메일" 로 보여 주기 위한 정보다.
   */
  eml?: { filename: string; size: number };
}

/**
 * 서버가 원본 eml 첨부에 붙이는 파일 이름과 같은 규칙.
 * server/src/services/compose.ts 의 withForwardedEml 과 맞춰 둔다 — 화면에 보여준 이름과
 * 실제로 나가는 이름이 다르면 안 된다.
 */
function emlFileName(subject: string): string {
  const safe = (subject || 'original').replace(/[\/:*?"<>|]/g, '_').slice(0, 80);
  return `${safe}.eml`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addressList(list: { name: string; address: string }[]): string {
  return list.map((entry) => displayAddress(entry.name || null, entry.address)).join(', ');
}

/**
 * 정화한 원문 본문. cid: 인라인 이미지는 data: 로 바꾸고, 못 바꾼 것은 지운다.
 * 인용문뿐 아니라 초안 이어쓰기(ReadingPane 의 editDraft)도 이 길로 본문을 받는다 —
 * cid: 를 그대로 에디터에 넣으면 참조할 파트가 없어 깨진 액자만 남고, 다시 보낼 때
 * 서버가 되돌릴 data: 도 없다.
 */
export function bodyWithInlineImages(mail: ParsedMail): string {
  const source =
    mail.html ??
    (mail.text ? `<pre style="white-space:pre-wrap">${escapeHtml(mail.text)}</pre>` : '');
  if (!source) return '';

  const clean = DOMPurify.sanitize(source, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcdoc'],
  });

  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');

  const inline = new Map<string, ParsedAttachment>();
  for (const attachment of mail.attachments) {
    if (attachment.contentId) inline.set(attachment.contentId, attachment);
  }

  for (const img of Array.from(doc.body.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src.toLowerCase().startsWith('cid:')) continue;
    const found = inline.get(src.slice(4).replace(/[<>]/g, ''));
    if (found && found.size <= MAX_INLINE_BYTES) {
      img.setAttribute('src', toDataUri(found.mimeType, found.content));
    } else {
      // 원본을 못 찾거나 너무 크면 깨진 이미지를 남기지 않는다. 파일은 첨부로 간다
      img.remove();
    }
  }

  return doc.body.innerHTML;
}

/** 답장: "{날짜}, {보낸사람} 님이 작성:" + 인용 블록 */
function replyHtml(mail: ParsedMail, body: string): string {
  const head = t('quote.replyHead', {
    date: formatFullDate(mail.date),
    who: displayAddress(mail.from?.name || null, mail.from?.address ?? null),
  });
  return [
    '<p><br></p>',
    `<p>${escapeHtml(head)}</p>`,
    `<blockquote style="border-left:2px solid #ccc;margin:0 0 0 8px;padding-left:8px;color:#555">${body}</blockquote>`,
  ].join('');
}

/** 전달: 원본 메일 헤더 블록 + 원문 */
function forwardHtml(mail: ParsedMail, body: string): string {
  const cc = addressList(mail.cc);
  const lines = [
    t('quote.forwardHead'),
    `${t('common.subject')}: ${mail.subject}`,
    `${t('common.date')}: ${formatFullDate(mail.date)}`,
    `${t('common.from')}: ${displayAddress(mail.from?.name || null, mail.from?.address ?? null)}`,
    `${t('common.to')}: ${addressList(mail.to)}`,
    ...(cc ? [`${t('common.cc')}: ${cc}`] : []),
  ];
  return [
    '<p><br></p>',
    ...lines.map((line) => `<div>${escapeHtml(line)}</div>`),
    '<p><br></p>',
    body,
  ].join('');
}

/**
 * 전달로 같이 보낼 첨부.
 * 인라인 이미지는 본문에 data: 로 심었으니 빼고, 한도를 넘어 본문에서 지운 것만 남긴다.
 */
function forwardAttachments(mail: ParsedMail): File[] {
  return mail.attachments
    .filter((attachment) => !attachment.inline || attachment.size > MAX_INLINE_BYTES)
    .map(
      (attachment, index) =>
        new File([attachment.content], attachment.filename || `attachment-${index + 1}`, {
          type: attachment.mimeType,
        }),
    );
}

/** rawSize 는 원문 파일 크기(MessageSummary.size). 원본 eml 첨부의 크기로 보여 준다 */
export function buildQuote(mode: ReplyMode, mail: ParsedMail, rawSize: number): Quote {
  // 원본 eml 로 전달할 때는 원문이 첨부로 통째로 가므로 인용하지 않는다
  if (mode === 'forwardEml') {
    return {
      html: '',
      attachments: [],
      eml: { filename: emlFileName(mail.subject), size: rawSize },
    };
  }

  const body = bodyWithInlineImages(mail);
  if (mode === 'forward') {
    return { html: forwardHtml(mail, body), attachments: forwardAttachments(mail) };
  }
  return { html: replyHtml(mail, body), attachments: [] };
}
