/**
 * 수신확인 (USR-2).
 *
 * 회수는 수신자 편지함의 JAMES_MAIL_OWNER 행을 지우는 것이고, James expunge 를 거친다.
 * 읽은 메일은 회수할 수 없다 (설계서 공통 정책).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, notFound } from '../errors.js';
import * as receipts from '../repositories/receipts.js';
import * as mailboxes from '../repositories/mailboxes.js';
import { james } from '../james/webadmin.js';

/**
 * 연 메일의 MAIL_ID 를 수신확인 행의 SENDER_MAIL_ID (Sent 사본) 로 바꾼다.
 * "내게도 발송" 사본을 열었어도 같은 발송을 가리키게 한다. 결과 메일도 내 것이어야 한다 —
 * 남이 보낸 메일의 사본 id 로 그 발송의 수신 현황을 볼 수 없게 막는다.
 */
async function ownedSenderMailId(userName: string, mailId: string): Promise<string> {
  const { ownsMailId } = await import('../repositories/messages.js');
  if (!(await ownsMailId(userName, mailId))) throw notFound('err.mailNotFound');
  const senderMailId = await receipts.senderMailIdOf(mailId);
  if (senderMailId !== mailId && !(await ownsMailId(userName, senderMailId))) throw notFound('err.mailNotFound');
  return senderMailId;
}

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/receipts', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const query = z
      .object({
        keyword: z.string().optional(),
        searchField: z.enum(['subject', 'recipient']).optional(),
        limit: z.coerce.number().int().max(200).default(50),
        offset: z.coerce.number().int().default(0),
      })
      .parse(request.query);

    const sent = await mailboxes.findSystemMailbox(session.userName, 'Sent');
    if (!sent) return [];

    return receipts.listSentWithReceipts({
      userName: session.userName,
      sentMailboxId: sent.id,
      keyword: query.keyword,
      searchField: query.searchField,
      limit: query.limit,
      offset: query.offset,
    });
  });

  /** [+] 상세: 수신자별 읽은 날짜 */
  app.get('/api/receipts/:mailId', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailId } = z.object({ mailId: z.string() }).parse(request.params);

    const senderMailId = await ownedSenderMailId(session.userName, mailId);
    const details = await receipts.receiptDetail(senderMailId);
    return details.map((d) => ({
      recipient: d.recipient,
      name: d.name,
      readDate: d.readDate,
      // 외부 도메인 수신자는 읽음 여부를 알 수 없다. 화면이 그 사실을 밝혀 준다 (feature-gap.md 4-4)
      tracked: d.tracked,
      recallable: d.recallTarget !== null,
      recallTarget: d.recallTarget,
    }));
  });

  /** 회수. 안 읽은 수신자만 대상이다 */
  app.post('/api/receipts/:mailId/recall', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { mailId } = z.object({ mailId: z.string() }).parse(request.params);
    const input = z
      .object({ recipients: z.array(z.string()).optional(), all: z.boolean().default(false) })
      .parse(request.body);

    const senderMailId = await ownedSenderMailId(session.userName, mailId);
    const details = await receipts.receiptDetail(senderMailId);
    const targets = details.filter((d) => {
      // 지울 편지함 행이 없으면 회수할 수 없다 — 이미 읽은 수신자, 그리고 외부 도메인 수신자
      if (!d.recallTarget) return false;
      if (input.all) return true;
      return input.recipients?.includes(d.recipient) ?? false;
    });
    if (targets.length === 0) throw badRequest('err.nothingToRecall');

    // 수신자별로 편지함이 다르므로 편지함 단위로 묶어 expunge 한다
    const byMailbox = new Map<string, number[]>();
    for (const target of targets) {
      if (!target.recallTarget) continue;
      const list = byMailbox.get(target.recallTarget.mailboxId) ?? [];
      list.push(target.recallTarget.uid);
      byMailbox.set(target.recallTarget.mailboxId, list);
    }

    let recalled = 0;
    for (const [mailboxId, uids] of byMailbox) {
      await james.expunge({ mailboxId, uids });
      recalled += uids.length;
    }
    return { ok: true, recalled };
  });
}
