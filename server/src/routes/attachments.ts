/**
 * 대용량 첨부 (USR-1.4.1).
 *
 * 일반 첨부는 MIME 안에 들어가므로 별도 엔드포인트가 없다. 브라우저가 원문에서
 * 파트를 꺼낸다 (webmail-architecture.md 2.5 "첨부 추출 엔드포인트는 없다").
 * 대용량 첨부만 본문에 넣지 않고 여기에 보관해 링크로 내려준다.
 */
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, notFound, payloadTooLarge } from '../errors.js';
import { moveToLargeStore, parseMultipart, resolveLargePath } from '../store/uploads.js';
import * as gu from '../repositories/gu.js';
import { isUuid, uuidv7 } from '../util/uuidv7.js';
import { HttpError } from '../errors.js';
import { largeDownloads } from '../util/rateLimit.js';

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  /** 발송 전에 먼저 올려 ATTACH_ID 를 받는다. MAIL_ID 는 발송 시점에 채워진다 (3-7) */
  app.post('/api/attachments/large', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const site = await gu.getSiteConfig();
    const tooLarge = () =>
      payloadTooLarge('err.largeLimit', { mb: Math.round(site.largeMaxSize / 1024 / 1024) });
    // 사이트 한도를 받는 도중에 적용한다. 다 받은 뒤에 검사하면 임시 폴더가 먼저 찬다
    const parsed = await parseMultipart(request, {
      fileSize: site.largeMaxSize + 1,
      totalFileSize: site.largeMaxSize,
    }).catch((cause: { statusCode?: number }) => {
      throw cause?.statusCode === 413 ? tooLarge() : cause;
    });

    try {
      const total = parsed.files.reduce((sum, f) => sum + f.size, 0);
      if (total > site.largeMaxSize) throw tooLarge();

      const saved = [];
      for (const file of parsed.files) {
        const attachId = uuidv7();
        const relativePath = await moveToLargeStore(file.path, attachId);
        await gu.createLargeAttach({
          attachId,
          userName: session.userName,
          fileName: file.filename,
          fileSize: file.size,
          filePath: relativePath,
          contentType: file.contentType,
          keepDays: site.largeKeepDays,
        });
        saved.push({ attachId, fileName: file.filename, fileSize: file.size });
      }
      return { attachments: saved };
    } finally {
      await parsed.cleanup();
    }
  });

  app.delete('/api/attachments/large/:attachId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { attachId } = z.object({ attachId: z.string() }).parse(request.params);
    const [found] = await gu.findLargeAttachments(session.userName, [attachId]);
    if (!found) throw notFound('err.attachNotFound');
    if (found.mailId) throw badRequest('err.attachSent');
    await gu.deleteLargeAttach(attachId);
    return { ok: true };
  });

  /**
   * 다운로드 링크. 외부 수신자가 여는 주소라 세션이 없다.
   * ATTACH_ID(UUID) 자체가 토큰이고 EXPIRE_DATE 가 지나면 404 다.
   */
  app.get('/large/:attachId', async (request, reply) => {
    // 세션이 없는 공개 링크라 IP 단위로 속도를 제한한다 (ID 추측·대역폭 소모 방지)
    const wait = largeDownloads.hit(request.ip);
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, 'err.tooManyAttempts', 'TOO_MANY_ATTEMPTS', undefined, {
        min: Math.max(1, Math.ceil(wait / 60_000)),
      });
    }
    const { attachId } = z.object({ attachId: z.string() }).parse(request.params);
    // UUID 가 아니면 DB 를 부르지 않는다
    if (!isUuid(attachId)) throw notFound('err.attachGone');
    const row = await gu.getDownloadableAttach(attachId);
    if (!row) throw notFound('err.attachGone');

    await gu.bumpDownloadCount(attachId);
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      )
      .header('Content-Length', String(row.fileSize));
    return reply.send(createReadStream(resolveLargePath(row.filePath)));
  });
}
