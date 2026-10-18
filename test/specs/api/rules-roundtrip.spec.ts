/**
 * Sieve 생성 ↔ 파싱 왕복 (sieve/generate.ts · parse.ts, services/sieve.ts).
 *
 * 네 화면(자동분류 · 부재중 · 수신거부 · 포워딩)의 규칙이 Sieve 스크립트 한 장으로 저장되고,
 * 다시 읽을 때 같은 모델로 돌아와야 한다. 한 번이라도 어긋나면 사용자 규칙이 조용히 사라진다.
 * 이걸 화면으로 검증하면 비싸고 불안정해서 여기서 본다.
 *
 * 저장은 James WebAdmin 을 경유하므로(1-5) James 가 떠 있어야 한다.
 * 스펙 사이의 순서 의존을 피하려고 매 테스트가 모델 전체를 덮어쓰고, 끝에서 비워 둔다.
 */
import { expect, requireBackend, test, CSRF_HEADERS } from '../../fixtures/api';

const EMPTY = { filters: [], rejects: [], forwards: [], vacation: null };

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ baseURL }) => {
  await requireBackend(baseURL, { james: true });
});

test.afterAll(async ({ playwright, baseURL }) => {
  // 남겨 두면 다음 실행의 시작 상태가 달라진다
  const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
  await context.post('/api/auth/login', {
    data: { userName: 'user1@example.com', password: 'TEST1234', locale: 'en' },
  });
  await context.put('/api/rules', { data: EMPTY });
  await context.dispose();
});

/** 저장한 뒤 다시 읽어 온 모델 */
async function saveAndRead(api: import('@playwright/test').APIRequestContext, model: unknown) {
  const current = (await (await api.get('/api/rules')).json()) as { activatedAt: string | null };
  const saved = await api.put('/api/rules', {
    data: { ...(model as object), expectedActivatedAt: current.activatedAt },
  });
  expect(saved.ok(), `저장 실패: ${saved.status()} ${await saved.text()}`).toBe(true);
  return (await (await api.get('/api/rules')).json()) as {
    filters: any[];
    rejects: any[];
    forwards: any[];
    vacation: any;
    script: string;
  };
}

test('자동분류 규칙이 그대로 돌아온다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    filters: [
      {
        screen: 'FILTER',
        order: 1,
        enabled: true,
        name: 'receipts',
        conditions: [{ field: 'SUBJECT', values: ['receipt', 'invoice'] }],
        action: { type: 'FILEINTO', mailboxName: 'INBOX' },
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  expect(read.filters).toHaveLength(1);
  expect(read.filters[0]).toMatchObject({
    name: 'receipts',
    enabled: true,
    action: { type: 'FILEINTO', mailboxName: 'INBOX' },
  });
  expect(read.filters[0].conditions[0].values).toEqual(['receipt', 'invoice']);
});

test('조건 여러 줄(AND)과 값 여러 개(OR)가 유지된다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    filters: [
      {
        screen: 'FILTER',
        order: 1,
        enabled: true,
        name: 'multi',
        conditions: [
          { field: 'FROM_DOMAIN', values: ['vendor.com', 'partner.com'] },
          { field: 'SUBJECT', values: ['quote'] },
          { field: 'HAS_ATTACH', values: [] },
        ],
        action: { type: 'FILEINTO', mailboxName: 'INBOX' },
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  const conditions = read.filters[0].conditions as { field: string; values: string[] }[];
  expect(conditions.map((condition) => condition.field)).toEqual(['FROM_DOMAIN', 'SUBJECT', 'HAS_ATTACH']);
  expect(conditions[0]!.values).toEqual(['vendor.com', 'partner.com']);
});

test('수신거부의 세 가지 처리가 구분되어 돌아온다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    rejects: [
      {
        screen: 'REJECT',
        order: 1,
        enabled: true,
        name: 'purge',
        conditions: [{ field: 'FROM', values: ['spam@bad.com'] }],
        action: { type: 'DELETE' },
      },
      {
        screen: 'REJECT',
        order: 2,
        enabled: true,
        name: 'to-spam',
        conditions: [{ field: 'FROM_DOMAIN', values: ['ads.example.com'] }],
        action: { type: 'SPAM', mailboxName: 'Spam' },
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  /**
   * "스팸함에 저장" 과 "휴지통으로 이동" 은 Sieve 로는 똑같이 fileinto 라 스크립트만으로는
   * 구분되지 않는다. 수신거부 화면에 한해 대상 편지함이 Spam 이면 SPAM 으로 되살린다
   * (sieve/parse.ts). 이게 무너지면 규칙을 다시 열 때 처리 선택이 휴지통으로 바뀐다.
   */
  const actions = read.rejects.map((rule) => rule.action);
  expect(actions.map((action) => action.type).sort()).toEqual(['DELETE', 'SPAM']);
  expect(actions.find((action) => action.type === 'SPAM')?.mailboxName).toBe('Spam');
});

test('휴지통으로 이동 규칙은 스팸으로 바뀌지 않는다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    rejects: [
      {
        screen: 'REJECT',
        order: 1,
        enabled: true,
        name: 'to-trash',
        conditions: [{ field: 'FROM', values: ['noise@bad.com'] }],
        action: { type: 'FILEINTO', mailboxName: 'Trash' },
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  expect(read.rejects[0].action).toMatchObject({ type: 'FILEINTO', mailboxName: 'Trash' });
});

test('자동분류로 스팸함에 넣는 규칙은 FILEINTO 그대로다', async ({ asUser }) => {
  // 구분이 있는 곳은 수신거부 화면뿐이다. 자동분류는 편지함만 고르므로 종류가 바뀌면 안 된다
  const model = {
    ...EMPTY,
    filters: [
      {
        screen: 'FILTER',
        order: 1,
        enabled: true,
        name: 'to-spam-box',
        conditions: [{ field: 'SUBJECT', values: ['ad'] }],
        action: { type: 'FILEINTO', mailboxName: 'Spam' },
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  expect(read.filters[0].action).toMatchObject({ type: 'FILEINTO', mailboxName: 'Spam' });
});

test('포워딩의 사본 보관 여부와 기간이 유지된다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    forwards: [
      {
        screen: 'FORWARD',
        order: 1,
        enabled: true,
        name: 'holiday',
        conditions: [],
        action: { type: 'FORWARD', address: 'me@other.com', keepCopy: true },
        startDate: '2026-10-01',
        endDate: '2026-10-15',
      },
    ],
  };

  const read = await saveAndRead(asUser, model);

  expect(read.forwards[0]).toMatchObject({
    action: { type: 'FORWARD', address: 'me@other.com', keepCopy: true },
    startDate: '2026-10-01',
    endDate: '2026-10-15',
  });
});

test('부재중 응답이 유지된다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    vacation: {
      enabled: true,
      name: 'Vacation',
      order: 99,
      subject: 'Out of office',
      body: '<p>Back on Monday</p>',
      days: 3,
      startDate: '2026-10-01',
      endDate: '2026-10-07',
    },
  };

  const read = await saveAndRead(asUser, model);

  expect(read.vacation).toMatchObject({
    enabled: true,
    subject: 'Out of office',
    days: 3,
    startDate: '2026-10-01',
    endDate: '2026-10-07',
  });
});

test('부재중 본문의 스크립트는 정화된다', async ({ asUser }) => {
  const model = {
    ...EMPTY,
    vacation: {
      enabled: true,
      name: 'Vacation',
      order: 99,
      subject: 'Out of office',
      body: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(2)>',
      days: 3,
      startDate: null,
      endDate: null,
    },
  };

  const read = await saveAndRead(asUser, model);

  // 부재중 회신도 바깥으로 나가는 글이라 발송 본문과 같은 잣대로 정화한다 (routes/rules.ts)
  expect(read.vacation.body).not.toContain('<script');
  expect(read.vacation.body).not.toContain('onerror');
});

test('네 화면의 규칙이 한 스크립트에 함께 담긴다', async ({ asUser }) => {
  const model = {
    filters: [
      {
        screen: 'FILTER',
        order: 1,
        enabled: true,
        name: 'f1',
        conditions: [{ field: 'SUBJECT', values: ['a'] }],
        action: { type: 'FILEINTO', mailboxName: 'INBOX' },
      },
    ],
    rejects: [
      {
        screen: 'REJECT',
        order: 1,
        enabled: true,
        name: 'r1',
        conditions: [{ field: 'FROM', values: ['x@bad.com'] }],
        action: { type: 'DELETE' },
      },
    ],
    forwards: [
      {
        screen: 'FORWARD',
        order: 1,
        enabled: true,
        name: 'w1',
        conditions: [],
        action: { type: 'FORWARD', address: 'me@other.com', keepCopy: false },
      },
    ],
    vacation: {
      enabled: true,
      name: 'Vacation',
      order: 99,
      subject: 'away',
      body: '<p>away</p>',
      days: 1,
      startDate: null,
      endDate: null,
    },
  };

  const read = await saveAndRead(asUser, model);

  expect(read.filters).toHaveLength(1);
  expect(read.rejects).toHaveLength(1);
  expect(read.forwards).toHaveLength(1);
  expect(read.vacation?.enabled).toBe(true);
  expect(read.script).not.toBe('');
});

test('낙관적 잠금: 낡은 기준 시각으로 저장하면 409 다', async ({ asUser }) => {
  await saveAndRead(asUser, {
    ...EMPTY,
    filters: [
      {
        screen: 'FILTER',
        order: 1,
        enabled: true,
        name: 'first',
        conditions: [{ field: 'SUBJECT', values: ['a'] }],
        action: { type: 'FILEINTO', mailboxName: 'INBOX' },
      },
    ],
  });

  // 다른 탭이 먼저 저장한 뒤라 화면이 들고 있던 시각은 이미 낡았다 (5-4)
  const stale = await asUser.put('/api/rules', {
    data: { ...EMPTY, expectedActivatedAt: '2020-01-01T00:00:00.000Z' },
  });

  expect(stale.status()).toBe(409);
});
