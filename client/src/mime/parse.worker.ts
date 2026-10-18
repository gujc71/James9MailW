/**
 * MIME 파싱 Web Worker (webmail-architecture.md 3.1).
 *
 * 수십 MB base64 디코딩과 HTML 조립을 메인 스레드에서 하면 UI 가 멈춘다.
 * postal-mime 으로 워커에서 파싱하고 결과만 넘긴다.
 *
 * 한국어 레거시 인코딩(webmail-issues.md 2-12): TextDecoder 는 euc-kr/cp949 는
 * 지원하지만 iso-2022-kr 은 지원하지 않는다. postal-mime 이 charset 별칭을 처리하되,
 * 실패한 파트는 latin1 로라도 살려서 "깨진 채로라도 보이게" 한다.
 */
import PostalMime from 'postal-mime';
import { parseVCards, type VCardContact } from './vcard';

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  disposition: string | null;
  contentId: string | null;
  size: number;
  /** 본문 인라인(cid) 인지 */
  inline: boolean;
  /** 약속 상자로 펼쳐 보여 준 text/calendar 파트인지 (첨부 목록에서는 뺀다) */
  isCalendar: boolean;
  /** 연락처 상자로 펼쳐 보여 준 vCard(.vcf) 파트인지 (첨부 목록에서는 뺀다) */
  isVCard: boolean;
  /** blob URL 로 만들 바이트 */
  content: ArrayBuffer;
}

export interface ParsedMail {
  subject: string;
  from: { name: string; address: string } | null;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  date: string | null;
  html: string | null;
  text: string | null;
  attachments: ParsedAttachment[];
  /** text/calendar 파트 원문 (USR-1.3 약속메일) */
  calendar: string | null;
  /** vCard(.vcf) 파트에서 뽑아 낸 연락처 (USR-1.4). 첨부 파일 대신 이걸 펼쳐 보여 준다 */
  vcards: VCardContact[];
  /** 지원하지 못한 특수 형식 안내 (2-13). 워커는 localStorage 를 못 보므로 i18n 키만 담고 화면에서 번역한다 */
  warnings: string[];
}

export interface ParseRequest {
  id: number;
  raw: ArrayBuffer;
}

export interface ParseResponse {
  id: number;
  ok: boolean;
  mail?: ParsedMail;
  error?: string;
}

function addressOf(
  value: { name?: string; address?: string } | undefined,
): { name: string; address: string } | null {
  if (!value?.address) return null;
  return { name: value.name ?? '', address: value.address };
}

/**
 * 첨부 내용을 옮길 수 있는 ArrayBuffer 로 맞춘다.
 *
 * postal-mime 은 파트에 따라 ArrayBuffer 를 주기도 하고 **Uint8Array 를 주기도 한다.**
 * 뷰를 String() 으로 바꾸면 "66,69,71,…" 같은 숫자 나열이 되어 내용이 통째로 망가진다
 * (약속메일의 text/calendar 가 이 때문에 일시·장소 없이 빈 상자로만 떴다).
 * 뷰는 가리키는 구간만 잘라 낸다 — 파서가 큰 버퍼 하나를 여러 파트가 나눠 볼 수 있고,
 * 이 버퍼는 메인 스레드로 transfer 되므로 남의 파트까지 딸려 가면 안 된다.
 */
function toArrayBuffer(content: unknown): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  // 문자열로 준 파트(일부 text/*)는 UTF-8 로 되돌린다
  return new TextEncoder().encode(String(content ?? '')).buffer;
}

/** vCard 파트인지. 보내는 앱마다 타입을 달리 적어서 확장자도 함께 본다 */
function isVCardPart(mimeType: string, filename: string | null | undefined): boolean {
  const type = mimeType.toLowerCase();
  if (type === 'text/vcard' || type === 'text/x-vcard' || type === 'text/directory') return true;
  return /\.vcf$/i.test(filename ?? '');
}

/**
 * 텍스트 파트를 글자로 되돌린다. utf-8 로 안 읽히면 한국어 레거시(euc-kr/cp949) 로 본다 —
 * 오래된 메일 앱이 만든 .vcf 가 이쪽이다 (2-12).
 */
function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, raw } = event.data;
  try {
    const parsed = await PostalMime.parse(raw);
    const warnings: string[] = [];
    let calendar: string | null = null;
    const vcards: VCardContact[] = [];

    const attachments: ParsedAttachment[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const attachment of parsed.attachments ?? []) {
      const mimeType = attachment.mimeType ?? 'application/octet-stream';
      const bytes = toArrayBuffer(attachment.content);

      // 약속 상자로 펼치는 건 첫 일정 파트 하나뿐이다. 두 번째부터는 첨부로 남긴다
      const isCalendar = mimeType === 'text/calendar' && calendar === null;
      if (isCalendar) {
        calendar = new TextDecoder().decode(bytes);
      }
      // v-Card 는 내려받아야 알 수 있는 파일이 아니라 연락처다. 읽어 낼 수 있으면 여기서
      // 구조로 바꿔 두고(썬더버드처럼 카드로 펼친다) 첨부 목록에서는 뺀다.
      // 못 읽으면 isVCard 를 세우지 않아 평소처럼 .vcf 첨부로 남는다
      let isVCard = false;
      if (isVCardPart(mimeType, attachment.filename)) {
        const parsed = parseVCards(decodeText(bytes));
        if (parsed.length > 0) {
          vcards.push(...parsed);
          isVCard = true;
        }
      }
      // winmail.dat(TNEF)·S/MIME 는 브라우저에서 못 푼다. 다운로드로 폴백 (2-13)
      if (attachment.filename === 'winmail.dat' || mimeType === 'application/ms-tnef') {
        warnings.push('read.warnTnef');
      }
      if (mimeType.startsWith('application/pkcs7')) {
        warnings.push('read.warnSmime');
      }

      attachments.push({
        filename: attachment.filename ?? 'attachment',
        mimeType,
        disposition: attachment.disposition ?? null,
        contentId: attachment.contentId ? attachment.contentId.replace(/[<>]/g, '') : null,
        size: bytes.byteLength,
        inline: attachment.disposition === 'inline' || Boolean(attachment.contentId),
        isCalendar,
        isVCard,
        content: bytes,
      });
      transfer.push(bytes);
    }

    const mail: ParsedMail = {
      subject: parsed.subject ?? '',
      from: addressOf(parsed.from),
      to: (parsed.to ?? []).map((a) => addressOf(a)).filter((a): a is { name: string; address: string } => Boolean(a)),
      cc: (parsed.cc ?? []).map((a) => addressOf(a)).filter((a): a is { name: string; address: string } => Boolean(a)),
      date: parsed.date ?? null,
      html: parsed.html ?? null,
      text: parsed.text ?? null,
      attachments,
      calendar,
      vcards,
      warnings,
    };

    const response: ParseResponse = { id, ok: true, mail };
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (cause) {
    const response: ParseResponse = { id, ok: false, error: (cause as Error).message };
    (self as unknown as Worker).postMessage(response);
  }
};
