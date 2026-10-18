/**
 * 플래그 · 이동 · 복사 · 삭제 (USR-11 선택메일을).
 *
 * 전부 James 커스텀 라우트를 거친다. 직접 UPDATE 하면 MODSEQ 이 오르지 않고
 * 수신확인(READ_DATE)도 영영 안 찍힌다 (webmail-issues.md 2-15).
 *
 * 조회당 HTTP 왕복이 늘지 않도록 여러 UID 를 한 번에 보낸다.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, notFound } from '../errors.js';
import * as mailboxes from '../repositories/mailboxes.js';
import { james } from '../james/webadmin.js';
import { addDropEntry, normalizeDropEntity } from '../repositories/dropList.js';

const targetSchema = z.object({
  mailboxId: z.string(),
  uids: z.array(z.number().int()).min(1).max(500),
});

async function assertOwnMailbox(userName: string, mailboxId: string) {
  const box = await mailboxes.findMailbox(userName, mailboxId);
  if (!box) throw notFound('err.mailboxNotFound');
  return box;
}

export async function mutationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 읽음 처리. 원문을 내려받은 뒤 클라이언트가 부른다.
   * 이 호출이 있어야 JAMES_MAIL_RECEIPT.READ_DATE 가 찍힌다.
   */
  app.post('/api/messages/flags', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = targetSchema
      .extend({
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      })
      .parse(request.body);
    await assertOwnMailbox(session.userName, input.mailboxId);
    await james.setFlags(input);
    return { ok: true };
  });

  app.post('/api/messages/move', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = targetSchema.extend({ targetMailboxId: z.string() }).parse(request.body);
    await assertOwnMailbox(session.userName, input.mailboxId);
    const target = await assertOwnMailbox(session.userName, input.targetMailboxId);
    // 임시 편지함(상위 폴더)으로는 이동·복사 불가 (설계서 공통 정책)
    if (target.role === 'Drafts') throw badRequest('err.noMoveToDrafts');
    await james.move(input);
    return { ok: true };
  });

  app.post('/api/messages/copy', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = targetSchema.extend({ targetMailboxId: z.string() }).parse(request.body);
    await assertOwnMailbox(session.userName, input.mailboxId);
    const target = await assertOwnMailbox(session.userName, input.targetMailboxId);
    if (target.role === 'Drafts') throw badRequest('err.noCopyToDrafts');
    await james.copy(input);
    return { ok: true };
  });

  /** 삭제 = 삭제함으로 이동. 삭제함에서 지우면 완전삭제 */
  app.post('/api/messages/delete', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = targetSchema.extend({ permanent: z.boolean().default(false) }).parse(request.body);
    const box = await assertOwnMailbox(session.userName, input.mailboxId);

    if (input.permanent || box.role === 'Trash') {
      await james.expunge({ mailboxId: input.mailboxId, uids: input.uids });
      return { ok: true, permanent: true };
    }

    const trash = await mailboxes.findSystemMailbox(session.userName, 'Trash');
    if (!trash) throw notFound('err.trashNotFound');
    await james.move({
      mailboxId: input.mailboxId,
      uids: input.uids,
      targetMailboxId: trash.id,
    });
    return { ok: true, permanent: false };
  });

  /** USR-11 스팸차단: 스팸함으로 옮기고 발신자를 수신거부 목록에 넣는다 */
  app.post('/api/messages/spam', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = targetSchema.extend({ unmark: z.boolean().default(false) }).parse(request.body);
    await assertOwnMailbox(session.userName, input.mailboxId);

    const targetName = input.unmark ? 'INBOX' : 'Spam';
    const target = await mailboxes.findSystemMailbox(session.userName, targetName);
    if (!target) throw notFound('err.namedBoxNotFound', { name: targetName });
    await james.move({
      mailboxId: input.mailboxId,
      uids: input.uids,
      targetMailboxId: target.id,
    });
    return { ok: true };
  });

  /** USR-3 편지함 옵션 "모두 읽은 상태로 표시" */
  app.post('/api/mailboxes/:mailboxId/read-all', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    await assertOwnMailbox(session.userName, mailboxId);

    const { db } = await import('../db/kysely.js');
    const rows = await db
      .selectFrom('JAMES_MAIL_OWNER')
      .select('MAIL_UID')
      .where('MAILBOX_ID', '=', mailboxId)
      .where('MAIL_IS_SEEN', '=', 0)
      .execute();
    const uids = rows.map((r) => Number(r.MAIL_UID));
    // 한 번에 다 보내면 요청이 커지므로 잘라서 보낸다
    for (let i = 0; i < uids.length; i += 500) {
      await james.setFlags({ mailboxId, uids: uids.slice(i, i + 500), add: ['\\Seen'] });
    }
    return { ok: true, updated: uids.length };
  });

  /** USR-3 편지함 옵션 "비우기" */
  app.post('/api/mailboxes/:mailboxId/empty', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const box = await assertOwnMailbox(session.userName, mailboxId);

    const { db } = await import('../db/kysely.js');
    const rows = await db
      .selectFrom('JAMES_MAIL_OWNER')
      .select('MAIL_UID')
      .where('MAILBOX_ID', '=', mailboxId)
      .execute();
    const uids = rows.map((r) => Number(r.MAIL_UID));
    if (uids.length === 0) return { ok: true, removed: 0 };

    if (box.role === 'Trash' || box.role === 'Spam') {
      for (let i = 0; i < uids.length; i += 500) {
        await james.expunge({ mailboxId, uids: uids.slice(i, i + 500) });
      }
    } else {
      const trash = await mailboxes.findSystemMailbox(session.userName, 'Trash');
      if (!trash) throw notFound('err.trashNotFound');
      for (let i = 0; i < uids.length; i += 500) {
        await james.move({
          mailboxId,
          uids: uids.slice(i, i + 500),
          targetMailboxId: trash.id,
        });
      }
    }
    return { ok: true, removed: uids.length };
  });

  /** ADM-6 수신거부 목록에 발신자 추가 (JAMES_DROP_LIST). 내부 사용자는 제외 */
  app.post('/api/dropped-senders', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z.object({ entity: z.string().min(3).max(320) }).parse(request.body);
    const { userExists, listDomains } = await import('../repositories/users.js');

    const { entity, type } = normalizeDropEntity(input.entity);
    if (type === 'ADDRESS' && (await userExists(entity))) {
      throw badRequest('err.internalUserNotBlockable');
    }
    const domain = type === 'ADDRESS' ? entity.slice(entity.lastIndexOf('@') + 1) : entity;
    if (type === 'DOMAIN' && (await listDomains()).includes(domain)) {
      throw badRequest('err.internalDomainNotBlockable');
    }

    await addDropEntry({ scope: 'USER', owner: session.userName, entity, type });
    return { ok: true };
  });
}
