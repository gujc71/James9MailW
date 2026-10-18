/** 외부메일 계정 관리와 실행 (USR-18.1 / 18.2) */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { db, dbWrite } from '../db/kysely.js';
import { toIso } from '../util/mysql.js';
import * as mailboxes from '../repositories/mailboxes.js';
import {
  decryptSecret,
  encryptSecret,
  fetchExternal,
  isFetchRunning,
  resolveAllowedHost,
} from '../services/externalMail.js';

/** POP3 는 줄 단위 명령이라 아이디·비밀번호의 CR/LF 가 다른 명령을 덧붙이는 통로가 된다 */
const NO_LINE_BREAK = /^[^\r\n]*$/;

const accountSchema = z.object({
  externalName: z.string().min(1).max(100),
  serverHost: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9.-]+$/, 'err.badDomain'),
  serverPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['POP3', 'IMAP']),
  securityType: z.enum(['PLAIN', 'SSL']),
  loginId: z.string().min(1).max(255).regex(NO_LINE_BREAK, 'err.badLoginId'),
  loginPasswd: z.string().min(1).max(1024).regex(NO_LINE_BREAK, 'err.badLoginId').optional(),
  targetMailboxId: z.string().min(1),
});

export async function externalMailRoutes(app: FastifyInstance): Promise<void> {
  /** 비밀번호는 목록에 내려주지 않는다 (설계서 표시 규칙) */
  app.get('/api/external-mail', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const rows = await db
      .selectFrom('GU_EXTERNAL_EMAIL')
      .selectAll()
      .where('USER_NAME', '=', session.userName)
      .orderBy('REG_DATE', 'desc')
      .execute();
    return rows.map((r) => ({
      externalId: Number(r.EXTERNAL_ID),
      externalName: r.EXTERNAL_NAME,
      serverHost: r.SERVER_HOST,
      serverPort: r.SERVER_PORT,
      protocol: r.PROTOCOL,
      securityType: r.SECURITY_TYPE,
      loginId: r.LOGIN_ID,
      targetMailboxId: r.TARGET_MAILBOX_ID,
      lastRunAt: toIso(r.LAST_RUN_AT),
      regDate: toIso(r.REG_DATE),
    }));
  });

  app.post('/api/external-mail', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = accountSchema.parse(request.body);
    if (!input.loginPasswd) throw notFound('err.needPassword');

    const box = await mailboxes.findMailbox(session.userName, input.targetMailboxId);
    if (!box) throw notFound('err.targetBoxNotFound');
    // 내부망(WebAdmin·DB·메타데이터)을 가리키는 주소는 저장 단계에서 막는다. 실행 때 다시 본다
    await resolveAllowedHost(input.serverHost).catch((cause: unknown) => {
      if ((cause as { statusCode?: number }).statusCode) throw cause;
      throw badRequest('err.badDomain');
    });

    const result = await dbWrite
      .insertInto('GU_EXTERNAL_EMAIL')
      .values({
        USER_NAME: session.userName,
        EXTERNAL_NAME: input.externalName,
        SERVER_HOST: input.serverHost,
        SERVER_PORT: input.serverPort,
        PROTOCOL: input.protocol,
        SECURITY_TYPE: input.securityType,
        LOGIN_ID: input.loginId,
        LOGIN_PASSWD: encryptSecret(input.loginPasswd),
        TARGET_MAILBOX_ID: box.id,
        REG_DATE: new Date(),
        UPDATE_DATE: new Date(),
      })
      .executeTakeFirst();
    return { externalId: Number(result.insertId ?? 0) };
  });

  app.put('/api/external-mail/:externalId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { externalId } = z.object({ externalId: z.coerce.number().int() }).parse(request.params);
    const input = accountSchema.parse(request.body);

    // 등록과 같은 검사를 수정에도 한다. 빠지면 남의 MAILBOX_ID 로 바꿔 그 편지함에 메일을 넣을 수 있다
    const owned = await db
      .selectFrom('GU_EXTERNAL_EMAIL')
      .select('EXTERNAL_ID')
      .where('EXTERNAL_ID', '=', externalId)
      .where('USER_NAME', '=', session.userName)
      .executeTakeFirst();
    if (!owned) throw notFound('err.externalNotFound');
    const box = await mailboxes.findMailbox(session.userName, input.targetMailboxId);
    if (!box) throw notFound('err.targetBoxNotFound');
    await resolveAllowedHost(input.serverHost).catch((cause: unknown) => {
      if ((cause as { statusCode?: number }).statusCode) throw cause;
      throw badRequest('err.badDomain');
    });

    const values: Record<string, unknown> = {
      EXTERNAL_NAME: input.externalName,
      SERVER_HOST: input.serverHost,
      SERVER_PORT: input.serverPort,
      PROTOCOL: input.protocol,
      SECURITY_TYPE: input.securityType,
      LOGIN_ID: input.loginId,
      TARGET_MAILBOX_ID: box.id,
      UPDATE_DATE: new Date(),
    };
    // 비밀번호는 입력했을 때만 바꾼다
    if (input.loginPasswd) values.LOGIN_PASSWD = encryptSecret(input.loginPasswd);

    await dbWrite
      .updateTable('GU_EXTERNAL_EMAIL')
      .set(values as never)
      .where('EXTERNAL_ID', '=', externalId)
      .where('USER_NAME', '=', session.userName)
      .execute();
    return { ok: true };
  });

  app.delete('/api/external-mail/:externalId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { externalId } = z.object({ externalId: z.coerce.number().int() }).parse(request.params);
    await dbWrite
      .deleteFrom('GU_EXTERNAL_EMAIL')
      .where('EXTERNAL_ID', '=', externalId)
      .where('USER_NAME', '=', session.userName)
      .execute();
    return { ok: true };
  });

  /** 즉시 실행. 수백 통을 순차로 가져오므로 실행 이력에 진행 상태를 남긴다 */
  app.post('/api/external-mail/:externalId/run', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { externalId } = z.object({ externalId: z.coerce.number().int() }).parse(request.params);

    const row = await db
      .selectFrom('GU_EXTERNAL_EMAIL')
      .selectAll()
      .where('EXTERNAL_ID', '=', externalId)
      .where('USER_NAME', '=', session.userName)
      .executeTakeFirst();
    if (!row) throw notFound('err.externalNotFound');
    if (isFetchRunning(externalId)) throw conflict('err.externalRunning');
    // 저장 뒤에 편지함이 지워졌거나(또는 예전 버전이 검사 없이 저장한 값이면) 넣지 않는다
    const target = await mailboxes.findMailbox(session.userName, row.TARGET_MAILBOX_ID);
    if (!target) throw notFound('err.targetBoxNotFound');

    const log = await dbWrite
      .insertInto('GU_EXTERNAL_EMAIL_LOG')
      .values({
        EXTERNAL_ID: externalId,
        START_TIME: new Date(),
        END_TIME: null,
        MAIL_COUNT: 0,
        RUN_STATUS: 'RUNNING',
        ERROR_MSG: null,
      })
      .executeTakeFirst();
    const logId = Number(log.insertId ?? 0);

    try {
      const result = await fetchExternal({
        externalId,
        userName: session.userName,
        host: row.SERVER_HOST,
        port: row.SERVER_PORT,
        protocol: row.PROTOCOL === 'IMAP' ? 'IMAP' : 'POP3',
        security: row.SECURITY_TYPE === 'SSL' ? 'SSL' : 'PLAIN',
        loginId: row.LOGIN_ID,
        password: decryptSecret(row.LOGIN_PASSWD),
        targetMailboxId: target.id,
      });

      await dbWrite
        .updateTable('GU_EXTERNAL_EMAIL_LOG')
        .set({
          END_TIME: new Date(),
          MAIL_COUNT: result.stored,
          RUN_STATUS: result.errors.length ? 'FAIL' : 'DONE',
          ERROR_MSG: result.errors.join('; ').slice(0, 500) || null,
        })
        .where('LOG_ID', '=', logId)
        .execute();

      await dbWrite
        .updateTable('GU_EXTERNAL_EMAIL')
        .set({ LAST_RUN_AT: new Date() })
        .where('EXTERNAL_ID', '=', externalId)
        .execute();

      return result;
    } catch (cause) {
      await dbWrite
        .updateTable('GU_EXTERNAL_EMAIL_LOG')
        .set({
          END_TIME: new Date(),
          RUN_STATUS: 'FAIL',
          ERROR_MSG: String((cause as Error).message).slice(0, 500),
        })
        .where('LOG_ID', '=', logId)
        .execute();
      throw cause;
    }
  });

  /** USR-18.2 실행 이력 팝업 */
  app.get('/api/external-mail/:externalId/logs', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { externalId } = z.object({ externalId: z.coerce.number().int() }).parse(request.params);

    const owned = await db
      .selectFrom('GU_EXTERNAL_EMAIL')
      .select('EXTERNAL_ID')
      .where('EXTERNAL_ID', '=', externalId)
      .where('USER_NAME', '=', session.userName)
      .executeTakeFirst();
    if (!owned) throw notFound('err.externalNotFound');

    const rows = await db
      .selectFrom('GU_EXTERNAL_EMAIL_LOG')
      .selectAll()
      .where('EXTERNAL_ID', '=', externalId)
      .orderBy('START_TIME', 'desc')
      .limit(100)
      .execute();
    return rows.map((r) => ({
      logId: Number(r.LOG_ID),
      startTime: toIso(r.START_TIME),
      endTime: toIso(r.END_TIME),
      mailCount: r.MAIL_COUNT,
      runStatus: r.RUN_STATUS,
      errorMsg: r.ERROR_MSG,
    }));
  });
}
