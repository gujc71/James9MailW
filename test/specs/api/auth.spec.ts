/**
 * 인증 · 권한 · 세션 (routes/auth.ts, plugins/auth.ts, auth/password.ts).
 *
 * 브라우저 없이 실서버를 두드린다. MariaDB 가 필요하고, 계정은 02-seed.sql 의 세 개를 쓴다
 * (admin@ / user1@ / user2@example.com, 비밀번호 TEST1234).
 *
 * 비밀번호 해시는 James 와 같은 PBKDF2-SHA512 규칙이고 salt 가 계정 이름이다. 이 스펙이
 * 통과한다는 것은 웹서버가 James 가 만든 해시를 그대로 검증한다는 뜻이다.
 */
import { SEED, expect, requireBackend, test } from '../../fixtures/api';

test.beforeEach(async ({ baseURL }) => {
  await requireBackend(baseURL);
});

test('헬스체크가 세 가지 상태를 돌려준다', async ({ anonymous }) => {
  const response = await anonymous.get('/api/health');

  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    db: expect.any(Boolean),
    smtp: expect.any(Boolean),
    webadmin: expect.any(Boolean),
  });
});

test('시드 계정으로 로그인된다', async ({ anonymous }) => {
  const response = await anonymous.post('/api/auth/login', {
    data: { userName: SEED.user1, password: SEED.password, locale: 'en' },
  });

  expect(response.ok()).toBe(true);
  // 세션 쿠키는 httpOnly + SameSite=Lax 로만 내려간다 (auth/session.ts)
  const cookie = response.headers()['set-cookie'] ?? '';
  expect(cookie).toContain('j9sid=');
  expect(cookie.toLowerCase()).toContain('httponly');
});

test('비밀번호가 틀리면 401 이다', async ({ anonymous }) => {
  const response = await anonymous.post('/api/auth/login', {
    data: { userName: SEED.user1, password: 'definitely-wrong', locale: 'en' },
  });

  expect(response.status()).toBe(401);
});

test('없는 계정도 401 로 똑같이 답한다 (계정 존재를 알려 주지 않는다)', async ({ anonymous }) => {
  const response = await anonymous.post('/api/auth/login', {
    data: { userName: 'nobody@example.com', password: 'whatever', locale: 'en' },
  });

  expect(response.status()).toBe(401);
});

test('세션 없이 /api/me 를 부르면 401 이다', async ({ anonymous }) => {
  const response = await anonymous.get('/api/me');

  expect(response.status()).toBe(401);
});

test('/api/me 가 화면이 쓰는 값들을 모두 담아 준다', async ({ asUser }) => {
  const response = await asUser.get('/api/me');

  expect(response.ok()).toBe(true);
  const me = await response.json();
  // client/src/api/types.ts 의 Me 와 같은 모양이어야 한다
  expect(me).toMatchObject({
    userName: SEED.user1,
    isAdmin: false,
    locale: expect.any(String),
    setting: expect.objectContaining({ listPageSize: expect.any(Number) }),
    site: expect.objectContaining({ siteName: expect.any(String) }),
    usage: expect.objectContaining({ used: expect.any(Number) }),
  });
  expect(Array.isArray(me.aliases)).toBe(true);
});

test('로그아웃하면 세션이 끊긴다', async ({ asUser }) => {
  expect((await asUser.get('/api/me')).ok()).toBe(true);

  await asUser.post('/api/auth/logout');

  expect((await asUser.get('/api/me')).status()).toBe(401);
});

test('오류 문구는 x-locale 헤더의 언어로 온다', async ({ anonymous }) => {
  const korean = await anonymous.post('/api/auth/login', {
    headers: { 'x-locale': 'ko' },
    data: { userName: SEED.user1, password: 'wrong', locale: 'ko' },
  });
  const english = await anonymous.post('/api/auth/login', {
    headers: { 'x-locale': 'en' },
    data: { userName: SEED.user1, password: 'wrong', locale: 'en' },
  });

  const ko = (await korean.json()) as { error: string };
  const en = (await english.json()) as { error: string };
  expect(ko.error).not.toBe(en.error);
  expect(ko.error).toMatch(/[가-힣]/);
});

test.describe('관리자 전용 경로', () => {
  test('일반 사용자는 관리자 API 에 닿지 못한다', async ({ asUser }) => {
    for (const path of [
      '/api/admin/overview',
      '/api/admin/users',
      '/api/admin/aliases',
      '/api/admin/site',
      '/api/admin/droplist',
    ]) {
      const response = await asUser.get(path);
      expect(response.status(), `${path} 는 일반 사용자에게 막혀 있어야 한다`).toBe(403);
    }
  });

  test('세션이 없으면 401 이다', async ({ anonymous }) => {
    expect((await anonymous.get('/api/admin/users')).status()).toBe(401);
  });

  test('관리자는 통과한다', async ({ asAdmin }) => {
    const response = await asAdmin.get('/api/admin/overview');

    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({
      totals: expect.objectContaining({ users: expect.any(Number) }),
    });
  });
});

test.describe('보안 헤더 (plugins/security.ts)', () => {
  test('앱 응답에 CSP·nosniff 가 붙는다', async ({ asUser }) => {
    const response = await asUser.get('/api/mailboxes');
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    // 본문은 sandbox iframe 안에서만 그리므로 frame-src 는 blob: 뿐이다
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain('frame-src blob:');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});

test.describe('CSRF 방어 (app.ts)', () => {
  test('상태를 바꾸는 요청에 x-requested-with 가 없으면 403 이다', async ({ playwright, baseURL }) => {
    // 픽스처 컨텍스트는 헤더를 자동으로 붙이므로 맨 컨텍스트로 보낸다
    const bare = await playwright.request.newContext({ baseURL });
    try {
      const response = await bare.post('/api/auth/login', {
        data: { userName: SEED.user1, password: SEED.password, locale: 'en' },
      });
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await bare.dispose();
    }
  });

  test('조회(GET)는 헤더 없이도 된다', async ({ playwright, baseURL }) => {
    const bare = await playwright.request.newContext({ baseURL });
    try {
      expect((await bare.get('/api/site/theme')).ok()).toBe(true);
    } finally {
      await bare.dispose();
    }
  });
});
