/**
 * EML 업로드 (USR-22).
 *
 * 브라우저가 올린 파일을 그대로 스테이징 폴더에 쓰고 James APPEND 라우트를 부른다.
 * MAIL_TYPE 은 gu.mailId 속성이 있을 때만 판정되므로 업로드에도 mailId 를 발급해 넘긴다 (4-1).
 */
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { notFound } from '../errors.js';
import { localeOf, t } from '../i18n.js';
import { parseMultipart, field } from '../store/uploads.js';
import { commitStaging, writeStagingStream } from '../store/staging.js';
import { appendStagedFile } from '../services/append.js';
import { uuidv7 } from '../util/uuidv7.js';
import * as mailboxes from '../repositories/mailboxes.js';
import { db, dbWrite } from '../db/kysely.js';
import { toIso } from '../util/mysql.js';

export async function appendRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/messages/upload', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    // EML 은 메일 한 통이다. 한 번에 100개, 한 통 50MB 를 넘지 않게 받는 도중에 끊는다
    const parsed = await parseMultipart(request, { files: 100, fileSize: 50 * 1024 * 1024 });

    try {
      const mailboxId = field(parsed.fields, 'mailboxId');
      if (!mailboxId) throw notFound('err.pickTargetBox');
      const box = await mailboxes.findMailbox(session.userName, mailboxId);
      if (!box) throw notFound('err.mailboxNotFound');

      const upload = await dbWrite
        .insertInto('GU_MAIL_UPLOAD')
        .values({
          USER_NAME: session.userName,
          MAILBOX_ID: box.id,
          MAILBOX_NAME: box.name,
          FILE_COUNT: parsed.files.length,
          DONE_COUNT: 0,
          RUN_STATUS: 'RUNNING',
          RUN_DATE: new Date(),
        })
        .executeTakeFirst();

      let done = 0;
      const failures: string[] = [];
      for (const file of parsed.files) {
        const mailId = uuidv7();
        await writeStagingStream(mailId, createReadStream(file.path));
        await commitStaging(mailId);
        const outcome = await appendStagedFile({
          mailboxId: box.id,
          mailId,
          flags: [],
        });
        if (outcome.ok) done += 1;
        else {
          // James 응답 원문은 로그에만 남긴다. 사용자에게는 파일 이름과 일반 문구만 보인다
          request.log.warn({ file: file.filename, error: outcome.error }, 'eml upload append failed');
          failures.push(`${file.filename}: ${t(localeOf(request), 'err.appendFailed')}`);
        }
      }

      await dbWrite
        .updateTable('GU_MAIL_UPLOAD')
        .set({ DONE_COUNT: done, RUN_STATUS: failures.length ? 'FAIL' : 'DONE' })
        .where('UPLOAD_ID', '=', Number(upload.insertId ?? 0))
        .execute();

      return { fileCount: parsed.files.length, doneCount: done, failures };
    } finally {
      await parsed.cleanup();
    }
  });

  /** USR-22 실행 이력 */
  app.get('/api/messages/upload/history', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const query = z
      .object({ limit: z.coerce.number().int().max(200).default(50), offset: z.coerce.number().int().default(0) })
      .parse(request.query);
    const rows = await db
      .selectFrom('GU_MAIL_UPLOAD')
      .selectAll()
      .where('USER_NAME', '=', session.userName)
      .orderBy('RUN_DATE', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();
    return rows.map((r) => ({
      uploadId: Number(r.UPLOAD_ID),
      mailboxId: r.MAILBOX_ID,
      mailboxName: r.MAILBOX_NAME,
      fileCount: r.FILE_COUNT,
      doneCount: r.DONE_COUNT,
      runStatus: r.RUN_STATUS,
      runDate: toIso(r.RUN_DATE),
    }));
  });

  app.delete('/api/messages/upload/:uploadId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { uploadId } = z.object({ uploadId: z.coerce.number().int() }).parse(request.params);
    await dbWrite
      .deleteFrom('GU_MAIL_UPLOAD')
      .where('UPLOAD_ID', '=', uploadId)
      .where('USER_NAME', '=', session.userName)
      .execute();
    return { ok: true };
  });
}
