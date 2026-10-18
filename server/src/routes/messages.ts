/**
 * 메일 목록 · 상세 · **원문 파일 서빙**.
 *
 * 원문은 파싱하지 않고 파일 그대로 내려준다. 브라우저가 MIME 을 파싱한다.
 * 응답 헤더는 고정이다 (webmail-issues.md 2-2):
 *   Content-Type: message/rfc822 · X-Content-Type-Options: nosniff
 *   Content-Disposition: attachment
 * 원문 캐시는 브라우저 IndexedDB 가 맡고(2-9) HTTP 캐시에는 남기지 않는다 (공용 PC).
 *
 * 원문을 내려줘도 읽음 상태는 바뀌지 않는다. \Seen 은 James 플래그 라우트로 세팅해야
 * 수신확인(READ_DATE)이 찍힌다 (2-15). 클라이언트가 /api/messages/flags 를 따로 부른다.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { notFound } from '../errors.js';
import * as messages from '../repositories/messages.js';
import * as mailboxes from '../repositories/mailboxes.js';
import * as gu from '../repositories/gu.js';
import { openMail, statMail } from '../store/mailStore.js';
import { myAddresses, readReceiptState, sendReadReceipt } from '../services/readReceipt.js';
import { localeOf } from '../i18n.js';
import { respondToInvite } from '../services/calendarItip.js';
import { calendarAttendance } from '../services/calendarAttendance.js';
import { config } from '../config.js';

const listQuery = z.object({
  mailbox: z.string().optional(),
  /** 전체 메일 보기 (설계서 USR-3 "전체 메일") */
  all: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** 정렬 (feature-gap 2-1). 기본은 예전과 같은 날짜 내림차순 */
  sort: z.enum(['date', 'from', 'subject', 'size']).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  /**
   * 무한 스크롤 커서. 세 값이 한 벌이라 하나라도 빠지면 첫 페이지로 본다.
   * 제목으로 정렬하면 빈 제목("")도 멀쩡한 커서 값이므로 값의 참·거짓으로 판단하지 않는다.
   */
  cursorValue: z.string().optional(),
  cursorUid: z.coerce.number().int().optional(),
  cursorMailbox: z.string().optional(),
  unseen: z.coerce.boolean().optional(),
  flagged: z.coerce.boolean().optional(),
  /** 보낸 사람이 선언한 중요도(Importance 헤더). 별표(flagged)와 다른 값이다 */
  important: z.coerce.boolean().optional(),
  attachment: z.coerce.boolean().optional(),
  searchField: z.enum(['all', 'from', 'to', 'subject', 'filename']).optional(),
  keyword: z.string().optional(),
});

/**
 * 목록이 "보낸 쪽" 을 보여 주는 편지함. 날짜는 발송일시, 주소 열은 받는 사람이다 —
 * 클라이언트 MessageList 의 showRecipient 와 같은 묶음이어야 한다.
 */
const SENT_VIEW_ROLES = new Set(['Sent', 'Outbox', 'Drafts']);

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  /** USR-4 메일 리스트. 넘버링 없는 무한 스크롤이라 (정렬 값, uid, 편지함) 커서로 이어 받는다 */
  app.get('/api/messages', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const query = listQuery.parse(request.query);

    let mailboxIds: string[];
    let sentView = false;

    if (query.all || !query.mailbox) {
      mailboxIds = await mailboxes.listMailboxIds(session.userName);
    } else {
      const box = await mailboxes.findMailbox(session.userName, query.mailbox);
      if (!box) throw notFound('err.mailboxNotFound');
      mailboxIds = [box.id];
      // 보낸 편지함 계열은 발송일시·받는사람 기준 (설계서 공통 정책). 목록 화면이 보여 주는
      // 열이 그쪽이므로 정렬도 같은 값을 봐야 순서가 화면과 어긋나지 않는다
      sentView = SENT_VIEW_ROLES.has(box.role);
    }

    const options: messages.ListOptions = {
      mailboxIds,
      limit: query.limit,
      cursor:
        query.cursorValue !== undefined &&
        query.cursorUid !== undefined &&
        query.cursorMailbox !== undefined
          ? { value: query.cursorValue, uid: query.cursorUid, mailboxId: query.cursorMailbox }
          : null,
      sentView,
      sort: { key: query.sort, desc: query.dir === 'desc' },
      unseenOnly: query.unseen,
      flaggedOnly: query.flagged,
      importantOnly: query.important,
      withAttachmentOnly: query.attachment,
      search: query.keyword ? { field: query.searchField ?? 'all', keyword: query.keyword } : null,
    };
    // 커서 계산과 중요도 필터의 훑기는 모두 repositories/messages.ts 안에 있다
    return messages.listPage(options);
  });

  /** USR-1.3 메일 조회 헤더 정보. 본문은 원문을 받아 브라우저가 판다 */
  app.get(
    '/api/messages/:mailboxId/:uid',
    { onRequest: [app.requireUser] },
    async (request) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);
      const detail = await messages.getMessageDetail(
        session.userName,
        params.mailboxId,
        params.uid,
      );
      if (!detail) throw notFound('err.mailNotFound');
      const [calendarResponse, readReceipt, mine] = await Promise.all([
        gu.getCalendarResponse(detail.mailId, session.userName),
        // 수신확인 요청(MDN)은 원문 헤더에만 있어 컬럼으로 훑을 수 없다. 한 통을 열 때
        // 앞머리를 한 번 읽는다 (services/readReceipt.ts)
        readReceiptState(session.userName, params.mailboxId, params.uid, detail),
        myAddresses(session.userName),
      ]);
      // 내가 보낸 메일(보낸 편지함 사본·내게도 발송)이면 약속 응답 버튼을 띄우지 않는다
      const fromMe = !!detail.from && mine.has(detail.from.toLowerCase());
      return { ...detail, calendarResponse, readReceipt, fromMe };
    },
  );

  /**
   * 원문 파일 서빙.
   * 서빙 키는 (MAILBOX_ID, MAIL_UID) 이고 소유자를 반드시 확인한다.
   * JAMES_MAIL 은 계정 간 공유 행이라 MAIL_ID 만으로 서빙하면 타인 메일이 열린다 (2-1).
   */
  app.get(
    '/api/messages/:mailboxId/:uid/raw',
    { onRequest: [app.requireUser] },
    async (request, reply) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);

      const row = await messages.findOwnedMessage(
        session.userName,
        params.mailboxId,
        params.uid,
      );
      if (!row) throw notFound('err.mailNotFound');

      const info = await statMail(row.filePath);
      const etag = `"${row.mailId}-${info.size}"`;
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      reply
        .header('Content-Type', 'message/rfc822')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${row.mailId}.eml"`)
        .header('Content-Length', String(info.size))
        // 캐시는 브라우저 IndexedDB(계정별, 로그아웃 때 지울 수 있다)가 맡는다. HTTP 캐시에 두면
        // 로그아웃·캐시 삭제 설정과 무관하게 공용 PC 의 디스크에 원문이 남는다
        .header('Cache-Control', 'private, no-store')
        .header('ETag', etag);

      return reply.send(openMail(row.filePath));
    },
  );

  /** USR-1.3 "이 메일을 > PC 저장". 원문과 같은 파일이지만 파일 이름을 제목으로 준다 */
  app.get(
    '/api/messages/:mailboxId/:uid/download',
    { onRequest: [app.requireUser] },
    async (request, reply) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);
      // 소유 확인 · 파일 경로 · 제목을 한 번에 꺼낸다
      const row = await messages.findOwnedMessage(session.userName, params.mailboxId, params.uid);
      if (!row) throw notFound('err.mailNotFound');

      const safeName = (row.subject ?? 'mail').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      reply
        .header('Content-Type', 'message/rfc822')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.eml`,
        );
      return reply.send(openMail(row.filePath));
    },
  );

  /** USR-1.3 약속메일 응답. 한 번 응답하면 바꿀 수 없다 */
  app.post(
    '/api/messages/:mailboxId/:uid/calendar-response',
    { onRequest: [app.requireUser] },
    async (request) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);
      const input = z
        .object({
          response: z.enum(['ACCEPT', 'TENTATIVE', 'DECLINE']),
          // 읽기 화면이 파싱한 text/calendar 원문. 있으면 내 캘린더에 넣고 주최자에게 응답을 보낸다
          ics: z.string().max(3 * 1024 * 1024).optional(),
        })
        .parse(request.body);

      const detail = await messages.getMessageDetail(
        session.userName,
        params.mailboxId,
        params.uid,
      );
      if (!detail) throw notFound('err.mailNotFound');

      const saved = await gu.saveCalendarResponse(
        detail.mailId,
        session.userName,
        input.response,
      );
      // 처음 응답할 때만 캘린더 · 회신을 처리한다. 응답은 바꿀 수 없으므로 두 번 보내지 않는다
      let warnings: string[] = [];
      if (saved && input.ics) {
        const base = config.publicBaseUrl || `${request.protocol}://${request.headers.host ?? 'localhost'}`;
        try {
          warnings = (await respondToInvite(session.userName, input.ics, input.response, localeOf(request), base)).warnings;
        } catch (cause) {
          request.log.warn({ err: cause }, 'calendar invite handling failed');
          warnings = [(cause as Error).message];
        }
      }
      return {
        ok: saved,
        response: await gu.getCalendarResponse(detail.mailId, session.userName),
        warnings,
      };
    },
  );

  /** 내가 보낸 약속메일의 수신자별 응답 · 응답 시각 (services/calendarAttendance.ts) */
  app.get(
    '/api/messages/:mailboxId/:uid/calendar-attendance',
    { onRequest: [app.requireUser] },
    async (request) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);
      return calendarAttendance(session.userName, params.mailboxId, params.uid);
    },
  );

  /**
   * 수신확인 요청(MDN) 회신 — "읽었다" 를 발신자에게 알린다 (feature-gap.md 4-4).
   *
   * 몸통이 없다. 회신받을 주소도, 보낼 자격이 있는지도 서버가 원문 헤더에서 다시 꺼낸다 —
   * 브라우저가 주소를 정하게 두면 아무 주소로나 "읽음" 회신을 보낼 수 있다.
   */
  app.post(
    '/api/messages/:mailboxId/:uid/read-receipt',
    { onRequest: [app.requireUser] },
    async (request) => {
      const session = sessionOf(request);
      const params = z
        .object({ mailboxId: z.string(), uid: z.coerce.number().int() })
        .parse(request.params);
      return sendReadReceipt(session.userName, params.mailboxId, params.uid, localeOf(request));
    },
  );
}
