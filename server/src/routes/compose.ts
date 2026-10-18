/**
 * 메일쓰기 (USR-1.4).
 *
 * 브라우저는 입력값만 보낸다. MIME 조립·발송·Sent 사본 저장은 서버가 한다.
 * 첨부는 multipart 스트림 -> 임시 파일 -> nodemailer 스트림 첨부로 흐른다 (3-5).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { parseMultipart, field, jsonField, boolField } from '../store/uploads.js';
import { parseAddressList, saveDraft, sendMail, type ComposeInput } from '../services/compose.js';
import { localeOf } from '../i18n.js';
import { buildICalendar } from '../mime/build.js';
import * as gu from '../repositories/gu.js';
import * as aliases from '../repositories/aliases.js';
import { uuidv7 } from '../util/uuidv7.js';
import { config } from '../config.js';
import { badRequest, HttpError, payloadTooLarge } from '../errors.js';
import { sendPerUser } from '../util/rateLimit.js';

/**
 * 메일 본문에 넣을 링크의 기준 주소. 설정(PUBLIC_BASE_URL)을 우선한다 — Host 헤더는 요청자가
 * 정하는 값이라, 그대로 쓰면 발송 메일에 공격자 도메인의 다운로드 링크가 실린다.
 * 설정이 없으면 Fastify 가 해석한 값(trustProxy 를 켰을 때만 X-Forwarded-* 를 본다)을 쓴다.
 */
function publicBaseUrl(request: FastifyRequest): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return `${request.protocol}://${request.host}`;
}

const appointmentSchema = z.object({
  start: z.string(),
  end: z.string(),
  location: z.string().default(''),
  description: z.string().default(''),
});

/** multipart 폼을 ComposeInput 으로. 검증은 services/compose 가 한다 */
async function readComposeForm(
  request: FastifyRequest,
  userName: string,
): Promise<{ input: ComposeInput; cleanup: () => Promise<void> }> {
  // 사이트 첨부 한도를 받는 도중에 적용한다. 받은 뒤 검사(services/compose validate)는 그대로 둔다
  const site = await gu.getSiteConfig();
  const tooLarge = () =>
    payloadTooLarge('err.attachSizeLimit', { mb: Math.round(site.attachMaxSize / 1024 / 1024) });
  const parsed = await parseMultipart(request, {
    files: site.attachMaxCount + 1,
    fileSize: site.attachMaxSize + 1,
    totalFileSize: site.attachMaxSize,
  }).catch((cause: { statusCode?: number }) => {
    throw cause?.statusCode === 413 ? tooLarge() : cause;
  });
  try {
    return { input: toComposeInput(parsed.fields, parsed.files, userName), cleanup: parsed.cleanup };
  } catch (cause) {
    await parsed.cleanup();
    throw cause;
  }
}

function toComposeInput(
  fields: Awaited<ReturnType<typeof parseMultipart>>['fields'],
  files: Awaited<ReturnType<typeof parseMultipart>>['files'],
  userName: string,
): ComposeInput {
  const to = parseAddressList(jsonField(fields, 'to', field(fields, 'to') ?? []));
  const cc = parseAddressList(jsonField(fields, 'cc', field(fields, 'cc') ?? []));
  const bcc = parseAddressList(jsonField(fields, 'bcc', field(fields, 'bcc') ?? []));

  const appointmentRaw = field(fields, 'appointment');
  let icalendar: string | null = null;
  if (appointmentRaw) {
    let raw: unknown;
    try {
      raw = JSON.parse(appointmentRaw);
    } catch {
      throw badRequest('err.badAppointment');
    }
    const appointment = appointmentSchema.parse(raw);
    const start = new Date(appointment.start);
    const end = new Date(appointment.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw badRequest('err.badAppointment');
    }
    icalendar = buildICalendar({
      organizer: userName,
      attendees: [...to, ...cc].map((a) => a.address),
      summary: field(fields, 'subject') ?? '',
      description: appointment.description,
      location: appointment.location,
      start,
      end,
      uid: uuidv7(),
    });
  }

  const input: ComposeInput = {
    // 소유 확인은 services/compose 의 resolveFrom 이 한다. 여기서는 받기만 한다 (4-3)
    fromAlias: field(fields, 'fromAlias') ?? null,
    to,
    cc,
    bcc,
    subject: field(fields, 'subject') ?? '',
    html: field(fields, 'html') ?? '',
    text: field(fields, 'text') ?? null,
    attachments: files
      .filter((f) => f.field === 'attachments')
      .map((f) => ({
        filename: f.filename,
        path: f.path,
        contentType: f.contentType,
        size: f.size,
      })),
    largeAttachIds: jsonField<string[]>(fields, 'largeAttachIds', []),
    signatureId: field(fields, 'signatureId') ? Number(field(fields, 'signatureId')) : null,
    vcardYn: boolField(fields, 'vcardYn'),
    inReplyTo: field(fields, 'inReplyTo') ?? null,
    forwardOf: field(fields, 'forwardOf') ?? null,
    forwardAsEml: boolField(fields, 'forwardAsEml'),
    important: boolField(fields, 'important'),
    sendToSelf: boolField(fields, 'sendToSelf'),
    individual: boolField(fields, 'individual'),
    readReceipt: boolField(fields, 'readReceipt'),
    icalendar,
    draftMailboxId: field(fields, 'draftMailboxId') ?? null,
    draftUid: field(fields, 'draftUid') ? Number(field(fields, 'draftUid')) : null,
  };

  return input;
}

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  /** 발송. 성공은 "James 에 접수됨" 이지 배달 성공이 아니다 (3-4) */
  app.post('/api/compose/send', { onRequest: [app.requireUser] }, async (request, reply) => {
    const session = sessionOf(request);
    // 탈취된 세션으로 스팸을 쏟아 내는 것을 늦춘다 (25 번 무인증 릴레이라 SMTP 가 막아 주지 않는다)
    const wait = sendPerUser.hit(session.userName.toLowerCase());
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, 'err.tooManyAttempts', 'TOO_MANY_ATTEMPTS', undefined, {
        min: Math.max(1, Math.ceil(wait / 60_000)),
      });
    }
    const { input, cleanup } = await readComposeForm(request, session.userName);
    try {
      return await sendMail(session.userName, input, publicBaseUrl(request), localeOf(request));
    } finally {
      await cleanup();
    }
  });

  /** 임시저장. 저장할 때마다 새 mailId 로 APPEND 하고 이전 draft 를 지운다 (4-2) */
  app.post('/api/compose/draft', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { input, cleanup } = await readComposeForm(request, session.userName);
    try {
      return await saveDraft(session.userName, input, publicBaseUrl(request), localeOf(request));
    } finally {
      await cleanup();
    }
  });

  /**
   * 메일쓰기 화면이 필요한 값들 (서명 목록 · 최근 주소 · 사이트 제한 · 발신 가능 알리아스).
   *
   * 알리아스는 /api/me 에도 실리지만 그쪽은 로그인 시점의 값이다. 관리자가 알리아스를
   * 중지하거나 대상에서 빼도 탭을 열어 둔 사용자에게는 그대로 남아 있으므로, **메일쓰기를
   * 열 때마다** 여기서 다시 받아 보내는사람 목록을 맞춘다 (4-3).
   */
  app.get('/api/compose/context', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const [signatures, recent, site, setting, sendableAliases] = await Promise.all([
      gu.listSignatures(session.userName),
      gu.recentRecipients(session.userName, 10),
      gu.getSiteConfig(),
      gu.getUserSetting(session.userName),
      aliases.listSendableAliases(session.userName),
    ]);
    return { signatures, recent, site, setting, aliases: sendableAliases };
  });
}
