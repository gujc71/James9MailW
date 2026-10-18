/**
 * 자동분류 · 부재중 · 수신거부 · 포워딩 (USR-16 / 19 / 20 / 21, POPUP-2).
 *
 * 네 화면의 규칙이 사용자당 활성 Sieve 스크립트 하나에 모여 저장된다.
 * 화면은 마커 주석으로 역파싱해 조건 행 단위로 다시 편집한다 (web.md 8.2).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { readActiveScript, readModel, saveModel } from '../services/sieve.js';
import type { Rule, SieveModel } from '../sieve/model.js';
import * as gu from '../repositories/gu.js';
import { sanitizeOutgoingHtml } from '../mime/sanitize.js';

const conditionSchema = z.object({
  field: z.enum([
    'SUBJECT',
    'SUBJECT_IS',
    'TO',
    'TO_DOMAIN',
    'FROM_NAME',
    'FROM',
    'FROM_DOMAIN',
    'HAS_ATTACH',
  ]),
  values: z.array(z.string()).max(20),
});

const actionSchema = z.union([
  z.object({ type: z.literal('FILEINTO'), mailboxName: z.string().min(1) }),
  z.object({ type: z.literal('SPAM'), mailboxName: z.string().min(1) }),
  z.object({ type: z.literal('DELETE') }),
  z.object({
    type: z.literal('FORWARD'),
    address: z.string().email(),
    keepCopy: z.boolean().default(true),
  }),
]);

const ruleSchema = z.object({
  screen: z.enum(['FILTER', 'REJECT', 'FORWARD']),
  order: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  name: z.string().min(1).max(80),
  // POPUP-2: 조건 행은 최대 5개, 행끼리 AND
  conditions: z.array(conditionSchema).max(5),
  action: actionSchema,
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
});

const vacationSchema = z
  .object({
    enabled: z.boolean(),
    name: z.string().max(80).default('부재중'),
    order: z.number().int().default(99),
    subject: z.string().max(200).default('부재중 자동 회신'),
    // 에디터가 만든 HTML 이라 평문 때보다 넉넉히 받는다 (스크립트 전체 한계는 5-1)
    body: z.string().max(20000),
    days: z.number().int().min(1).max(30).default(3),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
  })
  .nullable();

const modelSchema = z.object({
  filters: z.array(ruleSchema).default([]),
  rejects: z.array(ruleSchema).default([]),
  forwards: z.array(ruleSchema).default([]),
  vacation: vacationSchema.default(null),
  /** 낙관적 잠금: 화면이 읽었던 시점의 활성화 시각 */
  expectedActivatedAt: z.string().nullable().optional(),
});

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rules', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const [model, stored, setting] = await Promise.all([
      readModel(session.userName),
      readActiveScript(session.userName),
      gu.getUserSetting(session.userName),
    ]);
    return {
      ...model,
      activatedAt: stored?.activatedAt ?? null,
      script: stored?.content ?? '',
      setting,
      // 제약 안내 문구는 화면이 자기 언어로 보여 준다 (client/src/i18n.ts 의 rules.note*)
    };
  });

  app.put('/api/rules', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = modelSchema.parse(request.body);

    const model: SieveModel = {
      filters: input.filters as Rule[],
      rejects: input.rejects as Rule[],
      forwards: input.forwards as Rule[],
      // 부재중 본문 HTML 도 언젠가 바깥으로 나가는 글이다. 발송 본문과 같은 잣대로 정화한다
      vacation: input.vacation
        ? { ...input.vacation, body: sanitizeOutgoingHtml(input.vacation.body) }
        : null,
    };

    const result = await saveModel(session.userName, model, {
      expectedActivatedAt: input.expectedActivatedAt ?? undefined,
    });

    // USR-19/20/21 의 사용여부 스위치는 GU_USER_SETTING 에도 남긴다
    await gu.saveUserSetting(session.userName, {
      vacationUseYn: Boolean(model.vacation?.enabled),
      rejectUseYn: model.rejects.some((r) => r.enabled),
      forwardUseYn: model.forwards.some((r) => r.enabled),
    });

    return result;
  });
}
