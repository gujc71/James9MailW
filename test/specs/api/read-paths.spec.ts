/**
 * 읽기 경로 계약 (routes/mailboxes.ts · messages.ts · sync.ts · personal.ts · receipts.ts).
 *
 * 읽기는 MariaDB 직접 조회라 James 가 없어도 검증할 수 있다. 여기서 보는 것은 응답 모양과
 * 입력 검증 · 소유권이다 — 화면 모킹(specs/mock)이 이 모양을 전제로 쓰였으므로, 이 스펙이
 * 깨지면 모킹도 낡았다는 신호다.
 */
import { SEED, expect, requireBackend, test } from '../../fixtures/api';

test.beforeEach(async ({ baseURL }) => {
  await requireBackend(baseURL);
});

test('편지함 목록에 기본 편지함 다섯 개와 사용량이 온다', async ({ asUser }) => {
  const response = await asUser.get('/api/mailboxes');

  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    mailboxes: { name: string; role: string; displayName: string; isSystem: boolean }[];
    usage: { used: number };
  };
  const roles = body.mailboxes.map((box) => box.role);
  for (const role of ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam']) {
    expect(roles, `${role} 편지함이 있어야 한다`).toContain(role);
  }
  // 역할은 이름으로 판별한다 (repositories/mailboxes.ts SYSTEM_MAILBOXES)
  expect(body.mailboxes.find((box) => box.role === 'INBOX')?.isSystem).toBe(true);
  expect(body.usage.used).toBeGreaterThanOrEqual(0);
});

test('메일 목록은 messages · nextCursor · hasMore 로 온다', async ({ asUser }) => {
  const boxes = (await (await asUser.get('/api/mailboxes')).json()) as {
    mailboxes: { id: string; role: string }[];
  };
  const inbox = boxes.mailboxes.find((box) => box.role === 'INBOX')!;

  const response = await asUser.get(`/api/messages?mailbox=${inbox.id}&limit=10`);

  expect(response.ok()).toBe(true);
  const page = await response.json();
  expect(page).toMatchObject({ messages: expect.any(Array), hasMore: expect.any(Boolean) });
  expect(page).toHaveProperty('nextCursor');
});

test('정렬·필터 조건이 받아들여진다', async ({ asUser }) => {
  for (const query of [
    'sort=date&dir=desc',
    'sort=subject&dir=asc',
    'sort=size&dir=desc',
    'sort=from&dir=asc',
    'unseen=true',
    'flagged=true',
    'important=true',
    'attachment=true',
    'searchField=subject&keyword=test',
    'searchField=filename&keyword=pdf',
    'all=true',
  ]) {
    const response = await asUser.get(`/api/messages?${query}&limit=5`);
    expect(response.status(), `?${query} 는 받아들여져야 한다`).toBe(200);
  }
});

test('알 수 없는 정렬 기준은 400 이다', async ({ asUser }) => {
  const response = await asUser.get('/api/messages?sort=nonsense');

  expect(response.status()).toBe(400);
});

test('한도를 넘는 limit 은 400 이다', async ({ asUser }) => {
  // listQuery 는 1..200 만 받는다 (routes/messages.ts)
  expect((await asUser.get('/api/messages?limit=500')).status()).toBe(400);
  expect((await asUser.get('/api/messages?limit=0')).status()).toBe(400);
});

test('없는 편지함을 지정하면 404 다', async ({ asUser }) => {
  const response = await asUser.get('/api/messages?mailbox=00000000-0000-0000-0000-000000000000');

  expect(response.status()).toBe(404);
});

test('남의 편지함 원문은 열 수 없다', async ({ asUser, asAdmin }) => {
  // 관리자 계정의 편지함 id 를 알아도 user1 세션으로는 못 읽는다 (webmail-issues 2-1)
  const adminBoxes = (await (await asAdmin.get('/api/mailboxes')).json()) as {
    mailboxes: { id: string; role: string }[];
  };
  const adminInbox = adminBoxes.mailboxes.find((box) => box.role === 'INBOX')!;

  const response = await asUser.get(`/api/messages?mailbox=${adminInbox.id}`);

  expect([403, 404]).toContain(response.status());
});

test('동기화는 편지함을 반드시 받는다', async ({ asUser }) => {
  expect((await asUser.get('/api/sync')).status()).toBe(400);
});

test('동기화가 변경·툼스톤·hasMore 를 돌려준다', async ({ asUser }) => {
  const boxes = (await (await asUser.get('/api/mailboxes')).json()) as {
    mailboxes: { id: string; role: string }[];
  };
  const inbox = boxes.mailboxes.find((box) => box.role === 'INBOX')!;

  const response = await asUser.get(`/api/sync?mailbox=${inbox.id}&since=0&tsince=0`);

  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    changes: expect.any(Array),
    tombstones: expect.any(Array),
    hasMore: expect.any(Boolean),
  });
});

test('메일쓰기 화면이 쓰는 값이 한 번에 온다', async ({ asUser }) => {
  const response = await asUser.get('/api/compose/context');

  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    signatures: expect.any(Array),
    recent: expect.any(Array),
    site: expect.objectContaining({ attachMaxSize: expect.any(Number) }),
    setting: expect.any(Object),
    aliases: expect.any(Array),
  });
});

test('규칙 모델이 네 화면 몫을 한 번에 담아 온다', async ({ asUser }) => {
  const response = await asUser.get('/api/rules');

  expect(response.ok()).toBe(true);
  const model = await response.json();
  // 네 화면이 한 Sieve 스크립트를 공유한다 (services/sieve.ts)
  expect(model).toMatchObject({
    filters: expect.any(Array),
    rejects: expect.any(Array),
    forwards: expect.any(Array),
  });
  expect(model).toHaveProperty('vacation');
  expect(model).toHaveProperty('activatedAt');
});

test('수신확인 목록은 배열로 온다', async ({ asUser }) => {
  const response = await asUser.get('/api/receipts?limit=10&offset=0');

  expect(response.ok()).toBe(true);
  expect(Array.isArray(await response.json())).toBe(true);
});

test('주소 자동완성은 items·complete 로 온다', async ({ asUser }) => {
  // 자동완성만 파라미터 이름이 q 다 (다른 목록 조회는 keyword)
  const response = await asUser.get('/api/addresses/suggest?q=user&limit=20');

  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    items: expect.any(Array),
    complete: expect.any(Boolean),
  });
});

test('자동완성은 검색어가 없으면 400 이다', async ({ asUser }) => {
  expect((await asUser.get('/api/addresses/suggest')).status()).toBe(400);
});

test.describe('입력 검증', () => {
  test('편지함 이름 없이 만들 수 없다', async ({ asUser }) => {
    const response = await asUser.post('/api/mailboxes', { data: {} });

    expect(response.status()).toBe(400);
  });

  test('플래그 변경은 편지함과 uid 를 반드시 받는다', async ({ asUser }) => {
    expect((await asUser.post('/api/messages/flags', { data: {} })).status()).toBe(400);
    expect(
      (await asUser.post('/api/messages/flags', { data: { mailboxId: 'x', uids: 'not-an-array' } })).status(),
    ).toBe(400);
  });

  /**
   * 수신확인 요청 회신 (feature-gap 4-4). 몸통이 없는 라우트라 검증할 것은 소유·존재뿐이다 —
   * 회신받을 주소는 서버가 원문 헤더에서 꺼내므로 브라우저가 넣을 자리가 아예 없다.
   */
  test('수신확인 회신은 남의 편지함에 대해 나가지 않는다', async ({ asUser, asAdmin }) => {
    const adminBoxes = (await (await asAdmin.get('/api/mailboxes')).json()) as {
      mailboxes: { id: string; role: string }[];
    };
    const adminInbox = adminBoxes.mailboxes.find((box) => box.role === 'INBOX')!;

    const response = await asUser.post(
      `/api/messages/${adminInbox.id}/1/read-receipt`,
      { data: {} },
    );

    // 소유가 아니면 상세를 못 찾아 404, 찾더라도 요청 헤더가 없어 400 이다. 200 은 안 된다
    expect([400, 403, 404]).toContain(response.status());
  });

  test('수신확인 요청이 없는 메일에 회신하려 하면 400 이다', async ({ asUser }) => {
    const boxes = (await (await asUser.get('/api/mailboxes')).json()) as {
      mailboxes: { id: string; role: string }[];
    };
    const inbox = boxes.mailboxes.find((box) => box.role === 'INBOX')!;
    const page = (await (await asUser.get(`/api/messages?mailbox=${inbox.id}&limit=1`)).json()) as {
      messages: { uid: number }[];
    };
    test.skip(page.messages.length === 0, '받은 편지함에 메일이 없어 확인할 수 없다');

    const response = await asUser.post(
      `/api/messages/${inbox.id}/${page.messages[0]!.uid}/read-receipt`,
      { data: {} },
    );

    // 시드 메일에는 Disposition-Notification-To 가 없다
    expect([400, 404]).toContain(response.status());
  });
  test('비밀번호 변경은 정책을 서버에서도 본다', async ({ asUser }) => {
    const response = await asUser.put('/api/me/password', {
      data: { currentPassword: SEED.password, newPassword: 'short' },
    });

    expect(response.status()).toBe(400);
  });
});
