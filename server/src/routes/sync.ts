/**
 * 델타 동기화 (webmail-architecture.md 2.5, 3.5).
 *
 * 커서 두 개를 각각 따라간다: modseq(추가·플래그 변경)와 tombstoneSeq(삭제).
 * 보관기간이 지난 커서면 410 을 돌려 클라이언트가 전체 재동기화하게 한다.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { gone, notFound } from '../errors.js';
import * as sync from '../repositories/sync.js';
import * as mailboxes from '../repositories/mailboxes.js';
import { config } from '../config.js';

const query = z.object({
  mailbox: z.string(),
  since: z.coerce.number().int().min(0).default(0),
  tsince: z.coerce.number().int().min(0).default(0),
});

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sync', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = query.parse(request.query);

    const box = await mailboxes.findMailbox(session.userName, input.mailbox);
    if (!box) throw notFound('err.mailboxNotFound');

    if (await sync.isCursorExpired(input.tsince)) {
      throw gone('err.cursorExpiredFull');
    }

    const [changes, tombstones] = await Promise.all([
      sync.fetchChanges(box.id, input.since),
      sync.fetchTombstones(box.id, input.tsince),
    ]);

    return {
      changes,
      tombstones,
      hasMore:
        changes.length === config.policy.syncPageSize ||
        tombstones.length === config.policy.syncPageSize,
    };
  });

  /** 410 이후 백필 완료 시 커서를 잡기 위한 현재값 */
  app.get('/api/sync/head', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z.object({ mailbox: z.string() }).parse(request.query);
    const box = await mailboxes.findMailbox(session.userName, input.mailbox);
    if (!box) throw notFound('err.mailboxNotFound');
    const [modseq, tombstoneSeq] = await Promise.all([
      sync.currentHighestModseq(box.id),
      sync.currentTombstoneSeq(box.id),
    ]);
    return { modseq, tombstoneSeq };
  });
}
