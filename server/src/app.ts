import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { localeOf, t } from './i18n.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { authRoutes } from './routes/auth.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { messageRoutes } from './routes/messages.js';
import { mutationRoutes } from './routes/mutations.js';
import { syncRoutes } from './routes/sync.js';
import { composeRoutes } from './routes/compose.js';
import { attachmentRoutes } from './routes/attachments.js';
import { appendRoutes } from './routes/append.js';
import { receiptRoutes } from './routes/receipts.js';
import { ruleRoutes } from './routes/rules.js';
import { personalRoutes } from './routes/personal.js';
import { externalMailRoutes } from './routes/externalMail.js';
import { adminRoutes } from './routes/admin.js';
import { calendarRoutes } from './routes/calendar.js';
import { caldavRoutes, DAV_METHODS } from './routes/caldav.js';
import { ensureStagingDir } from './store/staging.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { forbidden } from './errors.js';
import { schemaHint } from './db/schemaCheck.js';

/** 상태를 바꾸는 메서드. CSRF 헤더 검사 대상이다 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF 방어용 헤더. 브라우저는 다른 사이트의 폼·이미지 요청에 이 헤더를 붙일 수 없고,
 * fetch 로 붙이려 하면 CORS preflight 에서 막힌다. SameSite=Lax 쿠키와 함께 두 겹이 된다.
 * client/src/api/client.ts 가 모든 요청에 붙인다.
 */
export const CSRF_HEADER = 'x-requested-with';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
    // 프록시를 거치지 않는데 X-Forwarded-* 를 믿으면 IP(감사 로그·요청 제한)와 Host 를 꾸밀 수 있다
    trustProxy: config.trustProxy,
  });
  // CalDAV(routes/caldav.ts) 메서드. 라우트를 등록하기 전에 알려 둬야 한다
  for (const method of DAV_METHODS) app.addHttpMethod(method, { hasBody: true });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(multipart, {
    limits: {
      // 일반 첨부 30MB * 10 + 여유. 실제 상한은 GU_SITE_CONFIG 로 다시 검사한다.
      fileSize: 200 * 1024 * 1024,
      // 본문(html)도 multipart 필드다. busboy 기본값 1MB 로는 인라인 이미지가 붙은
      // 본문이 말없이 잘려 나간다 (필드는 파일과 달리 넘쳐도 예외가 아니라 절단이다).
      // 에디터 상한(lexicalEditor.js IMG_TOTAL_MAX 6MB)이 base64 로 부푼 크기에 여유를 얹는다.
      fieldSize: 12 * 1024 * 1024,
      files: 50,
      fields: 60,
    },
  });

  // 개발 중 Vite dev 서버에서 호출할 때만 CORS 를 연다
  if (config.corsOrigin) {
    app.addHook('onRequest', async (request, reply) => {
      // CalDAV 는 브라우저가 아니라 캘린더 프로그램이 부른다. OPTIONS 응답(DAV 헤더)을 가로채지 않는다
      if (request.url.startsWith('/dav') || request.url.startsWith('/.well-known/')) return;
      reply.header('Access-Control-Allow-Origin', config.corsOrigin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', `content-type, x-locale, ${CSRF_HEADER}`);
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      if (request.method === 'OPTIONS') reply.code(204).send();
    });
  }

  app.addHook('onRequest', async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (!request.url.startsWith('/api/')) return;
    if (!request.headers[CSRF_HEADER]) throw forbidden('err.csrf');
  });

  await app.register(securityPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((error, request, reply) => {
    // 문구는 여기서 한 번만 번역한다. 라우트·서비스는 i18n 키만 던진다
    const locale = localeOf(request);
    if (error instanceof HttpError) {
      // 사용자에게는 번역된 일반 문구만 간다. James 응답 본문 같은 원인은 로그에만 남긴다
      if (error.statusCode >= 500 || error.details !== undefined) {
        request.log.warn({ err: error, details: error.details }, 'request failed');
      }
      reply
        .code(error.statusCode)
        .send({ error: t(locale, error.message, error.params), code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      reply
        .code(400)
        .send({ error: t(locale, error.issues[0]?.message ?? 'err.badInput'), code: 'BAD_REQUEST' });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      reply.code(413).send({ error: t(locale, 'err.fileTooLarge'), code: 'TOO_LARGE' });
      return;
    }
    // server/sql 의 새 스크립트를 아직 안 돌린 DB. "서버 오류" 대신 돌릴 파일을 알려 준다
    const script = schemaHint(error);
    if (script) {
      request.log.error({ err: error, script }, 'database schema is out of date');
      reply.code(503).send({ error: t(locale, 'err.schemaOutdated', { script }), code: 'SCHEMA_OUTDATED' });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({ error: t(locale, 'err.internal'), code: 'INTERNAL' });
  });

  await ensureStagingDir();

  // 빌드한 클라이언트가 있으면 같이 서빙한다 (배포 시 Vite 프록시가 없다)
  if (existsSync(path.join(config.clientDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: '/',
      wildcard: false,
      setHeaders(res, filePath) {
        // 파일 이름에 해시가 붙은 번들은 오래 캐시하고, 진입점은 매번 확인한다
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  await app.register(authRoutes);
  await app.register(mailboxRoutes);
  await app.register(messageRoutes);
  await app.register(mutationRoutes);
  await app.register(syncRoutes);
  await app.register(composeRoutes);
  await app.register(attachmentRoutes);
  await app.register(appendRoutes);
  await app.register(receiptRoutes);
  await app.register(ruleRoutes);
  await app.register(personalRoutes);
  await app.register(externalMailRoutes);
  await app.register(adminRoutes);
  await app.register(calendarRoutes);
  await app.register(caldavRoutes);

  app.get('/api/health', async () => {
    const { db } = await import('./db/kysely.js');
    const { sql } = await import('kysely');
    const { verifySmtp } = await import('./james/smtp.js');
    const { james } = await import('./james/webadmin.js');

    const [dbOk, smtpOk, webadminOk] = await Promise.all([
      sql`SELECT 1`
        .execute(db)
        .then(() => true)
        .catch(() => false),
      verifySmtp(),
      james
        .health()
        .then(() => true)
        .catch(() => false),
    ]);
    return { db: dbOk, smtp: smtpOk, webadmin: webadminOk };
  });

  return app;
}
