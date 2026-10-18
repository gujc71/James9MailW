/** 편지함 트리 (USR-3, USR-16, POPUP-1) */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, notFound } from '../errors.js';
import * as mailboxes from '../repositories/mailboxes.js';
import * as quota from '../repositories/quota.js';
import { james } from '../james/webadmin.js';
import { renameMailboxInRules } from '../services/sieve.js';
import { localeOf } from '../i18n.js';

export async function mailboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mailboxes', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const [list, usage] = await Promise.all([
      // 기본 편지함 이름은 화면이 지금 쓰는 언어로 준다 (x-locale > 세션)
      mailboxes.listMailboxes(session.userName, localeOf(request)),
      quota.usageOf(session.userName),
    ]);
    return { mailboxes: list, usage };
  });

  /** USR-16 편지함 추가. 기본 편지함 하위에도 만들 수 있다 */
  app.post('/api/mailboxes', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({ name: z.string().min(1).max(100), parentId: z.string().nullable().optional() })
      .parse(request.body);

    if (input.name.includes('.')) {
      throw badRequest('err.dotInName');
    }

    let fullName = input.name;
    if (input.parentId) {
      const parent = await mailboxes.findMailbox(session.userName, input.parentId);
      if (!parent) throw notFound('err.parentNotFound');
      fullName = `${parent.name}.${input.name}`;
    }
    return james.createMailbox({ user: session.userName, name: fullName });
  });

  /** USR-16 이름 변경. 기본 편지함은 막는다 */
  app.put('/api/mailboxes/:mailboxId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const input = z.object({ name: z.string().min(1).max(100) }).parse(request.body);

    const box = await mailboxes.findMailbox(session.userName, mailboxId);
    if (!box) throw notFound('err.mailboxNotFound');
    if (box.role !== 'personal') throw badRequest('err.systemBoxRename');

    const dot = box.name.lastIndexOf('.');
    const newFullName = dot < 0 ? input.name : `${box.name.slice(0, dot)}.${input.name}`;

    await james.renameMailbox({ mailboxId, name: newFullName });
    // fileinto 대상은 편지함 이름이라 스크립트를 함께 고쳐야 한다 (web.md 8.3, 5-7)
    await renameMailboxInRules(session.userName, box.name, newFullName).catch(() => undefined);
    return { ok: true, name: newFullName };
  });

  app.delete('/api/mailboxes/:mailboxId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const box = await mailboxes.findMailbox(session.userName, mailboxId);
    if (!box) throw notFound('err.mailboxNotFound');
    if (box.role !== 'personal') throw badRequest('err.systemBoxDelete');
    await james.deleteMailbox({ mailboxId });
    return { ok: true };
  });
}
