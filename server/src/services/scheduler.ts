/**
 * 주기 작업.
 *
 *  - 스테이징 잔여 파일 정리 (4-1b)
 *  - 툼스톤 보관기간 초과분 정리 + 마커 갱신 (2.4)
 *  - 대용량 첨부 만료 정리 (3-7)
 *  - 만료 세션 청소
 */
import { rm } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { sweepStaging } from '../store/staging.js';
import { pruneTombstones } from '../repositories/sync.js';
import { listExpiredAttachments, deleteLargeAttach } from '../repositories/gu.js';
import { resolveLargePath } from '../store/uploads.js';
import { sweepSessions } from '../auth/session.js';
import { limiters } from '../util/rateLimit.js';

const MINUTE = 60_000;

export function startScheduler(log: FastifyBaseLogger): () => void {
  const timers: NodeJS.Timeout[] = [];

  const every = (ms: number, name: string, task: () => Promise<unknown>) => {
    const timer = setInterval(() => {
      task().catch((cause) => log.error({ err: cause }, `scheduled task failed: ${name}`));
    }, ms);
    timer.unref();
    timers.push(timer);
  };

  every(30 * MINUTE, 'sessions', async () => sweepSessions());

  every(10 * MINUTE, 'rate-limit-sweep', async () => {
    for (const limiter of limiters) limiter.sweep();
  });

  every(60 * MINUTE, 'staging-sweep', async () => {
    const removed = await sweepStaging();
    if (removed) log.info({ removed }, 'stale staging files removed');
  });

  every(6 * 60 * MINUTE, 'tombstone-prune', async () => {
    const removed = await pruneTombstones();
    if (removed) log.info({ removed }, 'tombstones pruned');
  });

  every(6 * 60 * MINUTE, 'large-attach-expiry', async () => {
    for (const attach of await listExpiredAttachments()) {
      await rm(resolveLargePath(attach.filePath), { force: true }).catch(() => undefined);
      await deleteLargeAttach(attach.attachId);
    }
  });

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
