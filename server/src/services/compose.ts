/**
 * 발송 흐름 (webmail-issues.md 1-1, webmail-architecture.md 2.3).
 *
 *  1) 입력값 검증 (3-1)
 *  2) senderMailId = UUID v7 발급 (36자)
 *  3) MIME 조립. X-Sender-Mail-ID 포함, Bcc 헤더 포함 → 스테이징에 {id}.eml.part 로 보관
 *  4) Bcc 헤더만 뺀 raw 를 봉투(to+cc+bcc)와 함께 James 25 로 릴레이
 *  5) 세션 사용자의 Sent MAILBOX_ID 조회
 *  6) .part → .eml 로 rename (Bcc 포함본이 Sent 사본이 된다)
 *  7) James APPEND 라우트 { mailboxId, file, flags:[\Seen], mailId: senderMailId }
 *  8) 성공하면 스테이징 파일 삭제
 *
 * 4) 성공 후 7) 실패는 되돌릴 수 없다. 재시도하지 않고 사용자에게
 * "발송됨 · 보낸편지함 저장 실패" 로 구분해 알린다.
 *
 * 4) 에서 메일 서버가 수신자를 거부하면(550 5.1.1 Unknown user) 오류로 끝내지 않는다.
 * 거부된 주소를 결과에 담아 화면에 보여주고, 같은 내용을 발신자 받은 편지함에
 * 안내메일로 남긴다 (services/deliveryNotice.ts).
 *
 * 개별발송(USR-1.4.2)은 3)~4) 를 수신자 수만큼 반복한다. 나가는 원문은 수신자 한 명짜리라
 * 사본으로 쓸 수 없으므로 6)~7) 을 건너뛰고, 수신자 전원이 담긴 원문을 한 번 더 조립해
 * 그 한 통만 보낸 편지함에 넣는다. senderMailId 는 모든 건이 공유한다 — 수신확인이
 * Sent 사본의 MAIL_ID 와 수신자 쪽 X-Sender-Mail-ID 로 조인하기 때문이다 (USR-2).
 */
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { uuidv7 } from '../util/uuidv7.js';
import { resolveMailPath, statMail } from '../store/mailStore.js';
import { badRequest, notFound, payloadTooLarge, upstreamUnavailable } from '../errors.js';
import {
  buildMail,
  buildVCard,
  largeAttachmentBlock,
  type ComposeAddress,
  type ComposeAttachment,
} from '../mime/build.js';
import { submit, AllRecipientsRejectedError, type RejectedRecipient } from '../james/smtp.js';
import { appendStagedFile } from './append.js';
import { sendUndeliveredNotice } from './deliveryNotice.js';
import { t, DEFAULT_LOCALE, type Locale } from '../i18n.js';
import { commitStaging, removeStaging, stagingPartPath } from '../store/staging.js';
import { findSystemMailbox } from '../repositories/mailboxes.js';
import * as gu from '../repositories/gu.js';
import * as contacts from './contacts.js';
import * as users from '../repositories/users.js';
import * as quota from '../repositories/quota.js';
import * as aliases from '../repositories/aliases.js';
import { ownsMailId, findOwnedFileByMailId } from '../repositories/messages.js';
import { config } from '../config.js';

export interface ComposeInput {
  /** 알리아스로 발신할 때의 From 주소. 비우면 로그인 계정 (4-3) */
  fromAlias?: string | null;
  to: ComposeAddress[];
  cc: ComposeAddress[];
  bcc: ComposeAddress[];
  subject: string;
  html: string;
  text?: string | null;
  /** multipart 로 받아 임시 파일에 둔 일반 첨부 */
  attachments: ComposeAttachment[];
  /** 이미 업로드해 ATTACH_ID 를 받은 대용량 첨부 */
  largeAttachIds: string[];
  signatureId?: number | null;
  vcardYn?: boolean;
  inReplyTo?: string | null;
  forwardOf?: string | null;
  /** 전달 시 원본 메일을 .eml 로 첨부한다 (USR-1.3 전달) */
  forwardAsEml?: boolean;
  /** USR-1.4.2 */
  important?: boolean;
  sendToSelf?: boolean;
  /** 개별발송: 수신자에게 각각 따로 보낸다 (수신자 노출 방지) */
  individual?: boolean;
  /** 수신확인 요청(MDN). 받는 쪽이 읽고 알려 주겠다고 하면 From 주소로 회신이 온다 (4-4) */
  readReceipt?: boolean;
  icalendar?: string | null;
  /** iTIP 메서드. 캘린더가 보내는 초대 · 취소 · 응답 (services/calendarItip.ts) */
  icalMethod?: 'REQUEST' | 'CANCEL' | 'REPLY' | null;
  /** 임시저장에서 이어 보내는 경우, 지울 이전 draft */
  draftMailboxId?: string | null;
  draftUid?: number | null;
}

export interface SendOutcome {
  mailId: string;
  /** Sent 사본의 mailId. 개별발송이어도 한 통이므로 한 개다 */
  mailIds: string[];
  /** 한 명에게라도 나갔는가. false 면 아무것도 발송되지 않았다 */
  delivered: boolean;
  sentCopySaved: boolean;
  accepted: string[];
  /** 메일 서버가 RCPT 단계에서 거부한 주소 */
  rejected: string[];
  /** 거부된 주소가 있어 발신자에게 안내메일을 넣었는가 */
  noticeSent: boolean;
  warnings: string[];
}

const EMAIL_RE = /^[^\s@<>",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function parseAddressList(raw: unknown): ComposeAddress[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const values: string[] = Array.isArray(raw)
    ? raw.map(String)
    : String(raw)
        .split(/[,;]/)
        .map((v) => v.trim())
        .filter(Boolean);
  return values.map((value) => {
    const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
    if (match) return { name: match[1] || null, address: match[2]!.trim() };
    return { name: null, address: value.trim() };
  });
}

function assertAddresses(list: ComposeAddress[], messageKey: string): void {
  for (const item of list) {
    if (!EMAIL_RE.test(item.address)) {
      throw badRequest(messageKey, { address: item.address });
    }
  }
}

/**
 * 발신자 From 은 서버가 세팅한다. 알리아스를 쓰려면 소유 확인을 거친다 (1-2).
 *
 * 브라우저가 보낸 문자열은 **주소 하나만** 식별자로 받고, 헤더에 실제로 들어갈 값은
 * 여기서 DB 목록에서 다시 꺼낸다. 표시이름까지 브라우저가 정하게 두면 "그룹1" 자리에
 * 아무 이름이나 넣어 보낼 수 있다.
 */
async function resolveFrom(userName: string, fromAlias?: string | null): Promise<ComposeAddress> {
  const user = await users.findUser(userName);
  if (!fromAlias || fromAlias.toLowerCase() === userName.toLowerCase()) {
    return { name: user?.displayName ?? null, address: userName };
  }

  const alias = await aliases.findSendableAlias(userName, fromAlias);
  if (!alias) throw badRequest('err.notMyAlias', { address: fromAlias });
  return { name: alias.aliasName || user?.displayName || null, address: alias.address };
}

/**
 * 내부 수신자의 쿼터를 제출 전에 확인한다 (3-4).
 *
 * 계정 존재 여부는 여기서 경고하지 않는다. 메일 서버가 RCPT 단계에서 확정적으로
 * 판정해 주고(없는 계정·중지된 계정·별칭까지), 그 결과가 rejected 로 돌아오기 때문이다.
 * 여기서 또 "반송될 수 있습니다" 를 붙이면 같은 주소가 두 번, 그것도 틀린 문구로 보인다.
 * 쿼터 초과는 James 가 일단 접수한 뒤 배달 때 걸리므로 여전히 경고로만 알린다.
 */
async function precheckRecipients(
  recipients: string[],
  estimatedBytes: number,
  locale: Locale,
): Promise<string[]> {
  const domains = new Set(await users.listDomains());
  // 외부 수신자는 "접수됨" 으로만 다룬다
  const internal = [...new Set(recipients)].filter((address) => {
    const at = address.lastIndexOf('@');
    return at > 0 && domains.has(address.slice(at + 1).toLowerCase());
  });
  if (internal.length === 0) return [];
  // 없는(또는 중지된) 계정은 쿼터를 볼 것도 없다. 거부는 메일 서버가 알려 준다.
  // 수신자마다 따로 묻던 존재 확인을 IN 한 번으로 묶는다
  const live = await users.activeAddresses(internal);
  const targets = internal.filter((address) => live.has(address.toLowerCase()));
  const over = await Promise.all(
    targets.map(async (address) => ((await quota.wouldExceedQuota(address, estimatedBytes)) ? address : null)),
  );
  return over
    .filter((address): address is string => address !== null)
    .map((address) => t(locale, 'warn.quotaLow', { address }));
}

/** 서명 · vCard · 대용량 첨부 링크를 본문에 붙인다 (3-7) */
async function decorateBody(
  userName: string,
  input: ComposeInput,
  senderMailId: string,
  publicBaseUrl: string,
  locale: Locale,
): Promise<{ html: string; extraAttachments: ComposeAttachment[]; vcard: string | null }> {
  const setting = await gu.getUserSetting(userName);
  let html = input.html ?? '';

  if (input.signatureId) {
    const signature = await gu.findUsableSignature(userName, input.signatureId);
    if (!signature) throw badRequest('err.badSignature');
    // 서명 사용을 꺼 뒀으면 골라 보내도 붙이지 않는다 (USR-17)
    if (!setting.personalSignYn) throw badRequest('err.signScopeOff');
    // 서명은 본문 맨 끝에 붙는다. 답장 · 전달의 인용문 앞에 끼우는 선택지가 있었지만,
    // 에디터가 인용문 경계 표시를 지워 버려 늘 맨 끝과 같은 결과였다.
    html += `<div class="j9-signature">${signature.content}</div>`;
  }

  if (input.largeAttachIds.length > 0) {
    const items = await gu.findLargeAttachments(userName, input.largeAttachIds);
    if (items.length !== input.largeAttachIds.length) {
      throw badRequest('err.notMyLargeAttach');
    }
    await gu.linkLargeAttachments(input.largeAttachIds, senderMailId);
    html += largeAttachmentBlock(
      publicBaseUrl,
      items.map((i) => ({ attachId: i.attachId, fileName: i.fileName, fileSize: i.fileSize })),
      items[0]?.expireDate ?? null,
      locale,
    );
  }

  let vcard: string | null = null;
  if (input.vcardYn ?? setting.vcardYn) {
    const user = await users.findUser(userName);
    vcard = buildVCard(user?.displayName ?? null, userName);
  }

  return { html, extraAttachments: [], vcard };
}

async function validate(userName: string, input: ComposeInput): Promise<void> {
  assertAddresses(input.to, 'err.badAddressTo');
  assertAddresses(input.cc, 'err.badAddressCc');
  assertAddresses(input.bcc, 'err.badAddressBcc');
  // "내게도 발송"은 아래 sendMail 에서 내 계정을 To 에 넣으므로 수신자 1명으로 인정한다 (USR-1.4.2)
  if (!input.sendToSelf && input.to.length + input.cc.length + input.bcc.length === 0) {
    throw badRequest('err.needRecipient');
  }

  const site = await gu.getSiteConfig();
  if (input.attachments.length > site.attachMaxCount) {
    throw payloadTooLarge('err.attachCountLimit', { n: site.attachMaxCount });
  }
  const totalAttachBytes = input.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
  if (totalAttachBytes > site.attachMaxSize) {
    throw payloadTooLarge('err.attachSizeLimit', { mb: Math.round(site.attachMaxSize / 1024 / 1024) });
  }

  if (input.inReplyTo && !(await ownsMailId(userName, input.inReplyTo))) {
    throw badRequest('err.replyTargetNotFound');
  }
  if (input.forwardOf && !(await ownsMailId(userName, input.forwardOf))) {
    throw badRequest('err.forwardTargetNotFound');
  }
}

interface MailShape {
  userName: string;
  /**
   * X-Sender-Mail-ID 이자 Sent 사본의 MAIL_ID. 수신확인이 이 값으로 사본과 수신자 쪽
   * 수신 기록을 잇는다 (repositories/receipts.ts). 개별발송이어도 한 통으로 세야 하므로
   * 나가는 모든 건이 같은 값을 쓴다.
   */
  senderMailId: string;
  from: ComposeAddress;
  to: ComposeAddress[];
  cc: ComposeAddress[];
  bcc: ComposeAddress[];
  input: ComposeInput;
  html: string;
  vcard: string | null;
}

interface OneSendParams extends MailShape {
  /**
   * 이 건의 원문을 사본으로 남길 편지함. null 이면 보내기만 한다 — 개별발송은 건마다
   * 수신자가 한 명뿐이라 사본으로 쓸 수 없고, 수신자 전원이 담긴 한 통을 따로 남긴다.
   */
  sentMailboxId: string | null;
}

interface SendOneResult {
  accepted: string[];
  rejectedDetail: RejectedRecipient[];
  /** 이 건으로 사본을 남겼는가. null 이면 사본을 따로 저장한다 (개별발송) */
  sentCopySaved: boolean | null;
  /** 한 통이라도 나갔는가. 수신자가 전부 거부되면 false */
  delivered: boolean;
}

/**
 * 첨부 목록에 원본 eml 을 얹는다 (USR-1.3 전달).
 *
 * 원문 파일을 경로로 넘겨 스트림으로 붙인다 — 브라우저가 다시 올리지 않는다.
 * 발송과 임시저장이 **같은 첨부를 갖게** 하려고 둘이 같이 쓴다. 메일쓰기 화면이 이 첨부를
 * "원본 메일" 로 보여 주므로(features/compose/Compose.tsx), 임시저장에서 조용히 빠지면
 * 화면이 거짓말을 하게 된다.
 *
 * 파일 이름 규칙은 클라이언트 quote.ts 의 emlFileName 과 맞춰 둔다.
 */
async function withForwardedEml(
  userName: string,
  input: ComposeInput,
): Promise<ComposeAttachment[]> {
  const attachments: ComposeAttachment[] = [...input.attachments];
  if (!input.forwardOf || !input.forwardAsEml) return attachments;

  const original = await findOwnedFileByMailId(userName, input.forwardOf);
  if (original) {
    const stat = await statMail(original.filePath);
    attachments.push({
      filename: `${(original.subject ?? 'original').replace(/[\/:*?"<>|]/g, '_').slice(0, 80)}.eml`,
      path: resolveMailPath(original.filePath),
      size: stat.size,
      contentType: 'message/rfc822',
    });
  }
  return attachments;
}

/**
 * 답장 헤더에 쓸 Message-ID 표기. JAMES_MAIL.MESSAGE_ID 는 헤더에 적힌 그대로 들어가
 * 있어 대개 꺾쇠가 붙어 있고, 드물게 없다. 무조건 감싸면 `<<id>>` 가 된다.
 */
function angled(messageId: string): string {
  const trimmed = messageId.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`;
}

/**
 * 답장의 References. 원본 사슬 뒤에 원본 Message-ID 를 붙이고 중복을 거른다.
 *
 * 길이 상한은 James 가 저장하는 조상 수(MAX_REFERENCES=20)와 맞춰 둔다. 상한에 걸리면
 * **뿌리와 최근 조상**을 남긴다 — 뿌리는 대화 전체를 묶는 열쇠이고 최근 조상은 직계
 * 부모라, 가운데를 버리는 것이 양 끝을 버리는 것보다 안전하다.
 */
const MAX_REFERENCES = 20;

function threadChain(originalReferences: string[], originalMessageId: string): string[] {
  const chain = [...originalReferences, originalMessageId].map(angled);
  const unique = [...new Set(chain)];
  if (unique.length <= MAX_REFERENCES) return unique;
  return [unique[0]!, ...unique.slice(unique.length - MAX_REFERENCES + 1)];
}

/** MIME 을 조립해 스테이징 {stagingId}.eml.part 로 흘려 쓴다 (3-5) */
async function stageMail(params: MailShape, stagingId: string): Promise<void> {
  // 답장 헤더. In-Reply-To 는 원본의 Message-ID, References 는 **원본의 References +
  // 원본 Message-ID** 다 (RFC 5322 3.6.4). 원본 Message-ID 하나만 넣으면 사슬이 거기서
  // 끊겨, 중간 한 통이 지워진 상대 메일함에서는 대화가 둘로 갈라진다.
  let inReplyToMessageId: string | null = null;
  let references: string[] = [];
  if (params.input.inReplyTo) {
    const original = await findOwnedFileByMailId(params.userName, params.input.inReplyTo);
    if (original?.messageId) {
      inReplyToMessageId = angled(original.messageId);
      references = threadChain(original.references, inReplyToMessageId);
    }
  }

  const attachments = await withForwardedEml(params.userName, params.input);
  if (params.vcard) {
    // vCard 는 작아서 임시 파일 없이 바로 넣는다 (USR-1.4 v-Card 첨부)
    attachments.push({
      filename: `${params.userName.split('@')[0]}.vcf`,
      content: params.vcard,
      contentType: 'text/vcard; charset=utf-8',
    });
  }

  const built = buildMail({
    senderMailId: params.senderMailId,
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.input.subject,
    html: params.html,
    text: params.input.text ?? null,
    attachments,
    inReplyToMessageId,
    references,
    important: params.input.important,
    // 회신받을 주소는 브라우저가 아니라 **resolveFrom 이 꺼낸 From** 이다 (4-3 와 같은 이유).
    // 알리아스로 보냈으면 그 알리아스로 회신이 와 rewrite 가 계정으로 되돌려 준다.
    readReceiptTo: params.input.readReceipt ? params.from.address : null,
    icalendar: params.input.icalendar ?? null,
    icalMethod: params.input.icalMethod ?? null,
  });

  // 3) raw 를 스테이징의 .part 로 흘려 쓴다. 메모리에 40MB 문자열을 만들지 않는다.
  await pipeline(built.stream, createWriteStream(stagingPartPath(stagingId)));
}

async function sendOne(params: OneSendParams): Promise<SendOneResult> {
  // 사본으로 남길 건만 senderMailId 로 스테이징한다. APPEND 이 파일 이름을 MAIL_ID 로 쓰기
  // 때문에, 보내기만 하는 건은 이름이 겹치지 않게 따로 발급한다.
  const stagingId = params.sentMailboxId ? params.senderMailId : uuidv7();
  await stageMail(params, stagingId);
  const partPath = stagingPartPath(stagingId);

  const envelopeTo = [...params.to, ...params.cc, ...params.bcc].map((a) => a.address);

  // 4) SMTP 제출.
  //    - 수신자가 전부 거부되면 한 통도 나가지 않았으므로 원문을 지우고 6·7단계를 건너뛴다.
  //    - 일부만 거부되면 나머지에게는 이미 나갔다. 사본은 평소대로 남기고 거부 목록만 들고 나온다.
  let accepted: string[] = [];
  let rejectedDetail: RejectedRecipient[] = [];
  try {
    const result = await submit({
      rawPath: partPath,
      envelopeFrom: params.from.address,
      envelopeTo,
    });
    accepted = result.accepted;
    rejectedDetail = result.rejectedDetail;
  } catch (cause) {
    await rm(partPath, { force: true });
    if (cause instanceof AllRecipientsRejectedError) {
      return {
        accepted: [],
        rejectedDetail: cause.rejected,
        sentCopySaved: null,
        delivered: false,
      };
    }
    // 연결 실패·타임아웃은 사용자가 고칠 수 없는 서버 문제다. 500 대신 503 으로 알린다.
    if (typeof (cause as { code?: string }).code === 'string') {
      throw upstreamUnavailable('err.smtpUnavailable');
    }
    throw cause;
  }

  if (!params.sentMailboxId) {
    // 개별발송. 사본은 수신자 전원이 담긴 한 통으로 따로 남긴다 (saveSentCopy).
    await rm(partPath, { force: true });
    return { accepted, rejectedDetail, sentCopySaved: null, delivered: true };
  }

  // 6) .part -> .eml (Bcc 포함본이 Sent 사본이 된다)
  await commitStaging(params.senderMailId);

  // 7) Sent APPEND. 실패해도 메일은 이미 나갔으므로 되돌리지 않고, 사본만 없는 채로 끝난다.
  const outcome = await appendStagedFile({
    mailboxId: params.sentMailboxId,
    mailId: params.senderMailId,
    flags: ['\\Seen'],
  });

  return {
    accepted,
    rejectedDetail,
    sentCopySaved: outcome.ok,
    delivered: true,
  };
}

/**
 * 개별발송의 Sent 사본. 보내지 않고 사본만 남긴다.
 *
 * 개별발송은 수신자마다 따로 나가지만 사용자가 쓴 메일은 한 통이다. 나간 건을 그대로
 * 사본으로 쓰면 보낸 편지함에 수신자가 한 명씩만 적힌 메일이 사람 수만큼 쌓인다.
 * 그래서 수신자 전원이 담긴 원문을 한 번 더 조립해 그것만 넣는다.
 */
async function saveSentCopy(params: MailShape, sentMailboxId: string): Promise<boolean> {
  await stageMail(params, params.senderMailId);
  await commitStaging(params.senderMailId);
  const outcome = await appendStagedFile({
    mailboxId: sentMailboxId,
    mailId: params.senderMailId,
    flags: ['\\Seen'],
  });
  return outcome.ok;
}

/** 개별발송이면 같은 주소가 여러 번 거부될 수 있다. 주소 기준으로 한 번만 남긴다 */
function dedupeRejected(items: RejectedRecipient[]): RejectedRecipient[] {
  const seen = new Map<string, RejectedRecipient>();
  for (const item of items) {
    const key = item.address.toLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

export async function sendMail(
  userName: string,
  input: ComposeInput,
  publicBaseUrl: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<SendOutcome> {
  await validate(userName, input);

  const from = await resolveFrom(userName, input.fromAlias);
  const sent = await findSystemMailbox(userName, 'Sent');
  if (!sent) throw notFound('err.sentBoxNotFound');

  // 개별발송이어도 사용자가 쓴 메일은 한 통이다. 나가는 모든 건과 Sent 사본이 이 한 개의
  // ID 를 쓴다 — 수신확인이 이 ID 로 사본과 수신 기록을 잇는다.
  const senderMailId = uuidv7();
  const { html, vcard } = await decorateBody(userName, input, senderMailId, publicBaseUrl, locale);

  // base64 로 실려 나가므로 첨부 용량에 약 1.37 배를 잡는다 (3-5)
  const attachBytes = input.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
  const estimatedBytes = Math.round(attachBytes * 1.37) + Buffer.byteLength(html, 'utf8');
  const allRecipients = [...input.to, ...input.cc, ...input.bcc].map((a) => a.address);
  const warnings = await precheckRecipients(allRecipients, estimatedBytes, locale);

  // 알리아스로 보내도 "내게도 발송"·반송 안내는 계정으로 간다. 그 자리에 알리아스 이름을
  // 붙이면 "그룹1 <admin@example.com>" 처럼 이름과 주소가 어긋난다 (4-3).
  const accountName =
    from.address.toLowerCase() === userName.toLowerCase()
      ? (from.name ?? null)
      : ((await users.findUser(userName))?.displayName ?? null);

  // "내게도 발송" (USR-1.4.2): 현재 로그인한 사용자를 수신자(To)에 넣는다
  const to = [...input.to];
  if (input.sendToSelf && !allRecipients.some((a) => a.toLowerCase() === userName.toLowerCase())) {
    to.push({ name: accountName, address: userName });
  }

  // 보낸 편지함에 남길 모습: 수신자 전원이 들어간 한 통이다.
  const shape: MailShape = {
    userName,
    senderMailId,
    from,
    to,
    cc: input.cc,
    bcc: input.bcc,
    input,
    html,
    vcard,
  };

  const results: SendOneResult[] = [];

  if (input.individual) {
    // 개별발송: 수신자에게 각각 따로. 서로의 주소가 노출되지 않는다.
    // 나가는 건은 수신자 한 명짜리지만 사본은 아래에서 전원이 담긴 한 통으로 남긴다.
    for (const recipient of [...to, ...input.cc, ...input.bcc]) {
      results.push(
        await sendOne({ ...shape, to: [recipient], cc: [], bcc: [], sentMailboxId: null }),
      );
    }
  } else {
    results.push(await sendOne({ ...shape, sentMailboxId: sent.id }));
  }

  // 메일 서버가 RCPT 단계에서 거부한 수신자. 전부 거부면 예외가 아니라 결과로 온다
  // (james/smtp.ts AllRecipientsRejectedError).
  const rejectedDetail = dedupeRejected(results.flatMap((r) => r.rejectedDetail));
  const rejected = rejectedDetail.map((r) => r.address);
  const delivered = results.some((r) => r.delivered);

  // 개별발송의 사본. 한 통도 나가지 않았으면 사본도 남기지 않는다 (일반 발송과 같다).
  let copySaved = true;
  if (input.individual && delivered) {
    copySaved = await saveSentCopy(shape, sent.id);
  }

  // 거부가 하나라도 있으면 발신자에게 안내메일을 넣는다. 화면의 오류는 창을 닫으면
  // 사라지지만 안내메일은 남아 누구에게 못 갔는지 나중에도 볼 수 있다.
  let noticeSent = false;
  if (rejectedDetail.length > 0) {
    noticeSent = await sendUndeliveredNotice({
      userName,
      displayName: accountName,
      subject: input.subject,
      rejected: rejectedDetail,
      locale,
    });
    warnings.push(
      t(locale, delivered ? 'warn.partialFail' : 'warn.allFail', { list: rejected.join(', ') }) +
        (noticeSent ? t(locale, 'warn.noticeSuffix') : ''),
    );
  }

  // 봉투 기준으로 보낸 주소를 남긴다. 거부된 주소는 없는 주소이므로 어느 쪽에도 남기지 않는다.
  //   · 최근 발송 목록(GU_RECENT_RECIPIENT): 내부·외부 구분 없이 전부
  //   · 주소록(GU_ADDRESS_BOOK): 외부 주소만. 내부 계정은 수신자 자동완성이 JAMES_USER 를
  //     같이 훑으므로(routes/personal.ts) 주소록에 없어도 이름·주소로 찾힌다.
  const rejectedKeys = new Set(rejected.map((a) => a.toLowerCase()));
  const sentTo = allRecipients.filter((address) => !rejectedKeys.has(address.toLowerCase()));
  const domains = await users.listDomains();
  // 이름은 입력칸에 적힌 "홍길동 <a@b>" 의 이름을 먼저 쓰고, 없으면 계정의 표시 이름으로 채운다
  const typedNames = new Map<string, string>();
  for (const entry of [...input.to, ...input.cc, ...input.bcc]) {
    const name = entry.name?.trim();
    if (name) typedNames.set(entry.address.toLowerCase(), name);
  }
  const accountNames = await users.displayNames(sentTo);
  // 주소마다 순서대로 기다릴 이유가 없다. 실패해도 발송 결과는 그대로라 모아서 기다린다
  await Promise.allSettled(
    sentTo.map(async (address) => {
      const key = address.toLowerCase();
      const contactName = typedNames.get(key) ?? accountNames.get(key) ?? null;
      await gu.touchRecentRecipient({ userName, mailAddress: address, contactName });
      const at = address.lastIndexOf('@');
      const isExternal = at > 0 && !domains.includes(address.slice(at + 1).toLowerCase());
      if (isExternal) {
        await contacts.collect(userName, address, contactName);
      }
    }),
  );

  // 이어 보낸 임시저장본은 지운다 (4-2). 한 통도 못 나갔으면 지우지 않는다 — 쓴 내용이 사라진다.
  if (delivered && input.draftMailboxId && input.draftUid) {
    const { james } = await import('../james/webadmin.js');
    await james
      .expunge({ mailboxId: input.draftMailboxId, uids: [input.draftUid] })
      .catch(() => undefined);
  }

  // 나가지도 못한 건은 사본이 없는 게 정상이라 실패로 세지 않는다 (sentCopySaved === null)
  const sentCopySaved = copySaved && !results.some((r) => r.delivered && r.sentCopySaved === false);
  if (!sentCopySaved) {
    warnings.push(t(locale, 'warn.sentCopyFailed'));
  }

  return {
    mailId: delivered ? senderMailId : '',
    mailIds: delivered ? [senderMailId] : [],
    delivered,
    sentCopySaved,
    accepted: results.flatMap((r) => r.accepted),
    rejected,
    noticeSent,
    warnings,
  };
}

/**
 * 임시저장 (USR-1.4.3 / 4-2).
 * 저장할 때마다 새 mailId 를 발급해 APPEND 하고 이전 draft 는 지운다.
 */
export async function saveDraft(
  userName: string,
  input: ComposeInput,
  publicBaseUrl: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<{ mailId: string; mailboxId: string; uid: number | null }> {
  const drafts = await findSystemMailbox(userName, 'Drafts');
  if (!drafts) throw notFound('err.draftBoxNotFound');

  const from = await resolveFrom(userName, input.fromAlias);
  const mailId = uuidv7();
  const { html } = await decorateBody(userName, input, mailId, publicBaseUrl, locale);

  const built = buildMail({
    senderMailId: mailId,
    from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html,
    text: input.text ?? null,
    // 원본 eml 전달을 임시저장해도 원본이 붙어 있어야 한다
    attachments: await withForwardedEml(userName, input),
    important: input.important,
    // 초안도 헤더를 지녀야 이어 보낼 때 체크가 살아 있다
    readReceiptTo: input.readReceipt ? from.address : null,
    icalendar: input.icalendar ?? null,
    icalMethod: input.icalMethod ?? null,
  });

  await pipeline(built.stream, createWriteStream(stagingPartPath(mailId)));
  await commitStaging(mailId);

  const outcome = await appendStagedFile({
    mailboxId: drafts.id,
    mailId,
    flags: ['\\Draft', '\\Seen'],
  });
  if (!outcome.ok) {
    await removeStaging(mailId);
    // James 응답은 로그에만 (app.ts errorHandler 가 details 를 남긴다)
    throw badRequest('err.draftFailed', undefined, { reason: String(outcome.error) });
  }

  // 이전 draft 삭제 (자동 저장마다 새 메일이 되므로 expunge 가 따라야 한다)
  if (input.draftMailboxId && input.draftUid) {
    const { james } = await import('../james/webadmin.js');
    await james
      .expunge({ mailboxId: input.draftMailboxId, uids: [input.draftUid] })
      .catch(() => undefined);
  }

  return { mailId, mailboxId: drafts.id, uid: outcome.result?.uid ?? null };
}

export const publicBaseUrlFallback = `http://localhost:${config.port}`;
