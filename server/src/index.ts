import { buildApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './services/scheduler.js';
import { regenerateScripts } from './services/sieve.js';
import { closeDb } from './db/kysely.js';
import { checkSchema } from './db/schemaCheck.js';
import { closeSmtp } from './james/smtp.js';

const app = await buildApp();
const stopScheduler = startScheduler(app.log);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  stopScheduler();
  closeSmtp();
  await app.close();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  {
    mailStore: config.paths.mailStore,
    staging: config.paths.staging,
    webadmin: config.james.webadminUrl,
    smtp: `${config.james.smtpHost}:${config.james.smtpPort}`,
  },
  'james9Mail web server ready',
);

// server/sql 의 새 스크립트를 안 돌린 DB 면 시작할 때 알려 둔다 (요청은 503 + 안내로 끝난다)
void checkSchema().then((missing) => {
  if (missing.length) app.log.warn({ run: missing }, 'database schema is out of date — run these SQL scripts');
});

// 기간을 마커에만 담고 있던 예전 스크립트를 currentdate 형태로 한 번 올려 둔다
void regenerateScripts()
  .then(({ updated, failed }) => {
    if (updated || failed) app.log.info({ updated, failed }, 'sieve scripts regenerated');
  })
  .catch((cause) => app.log.error({ err: cause }, 'sieve script regeneration failed'));
