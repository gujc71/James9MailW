/**
 * api 계층 픽스처 (브라우저 없이 실서버를 두드린다).
 *
 * 이 계층은 **MariaDB 가 떠 있어야** 하고, 쓰기 스펙은 **James WebAdmin·SMTP 까지** 필요하다.
 * 그래서 스펙마다 무엇이 필요한지 앞에서 확인하고, 없으면 실패가 아니라 건너뛴다 —
 * "환경이 없어서 빨간 것" 과 "코드가 틀려서 빨간 것" 을 섞지 않는다.
 *
 * 세션은 쿠키다. Playwright 의 request 픽스처는 테스트마다 자기 쿠키 항아리를 갖기 때문에
 * 로그인 한 번으로 그 테스트 안에서는 계속 인증된 상태가 된다.
 */
import { test as base, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

export const SEED = {
  admin: process.env.J9_ADMIN_USER ?? 'admin@example.com',
  adminPassword: process.env.J9_ADMIN_PW ?? 'TEST1234',
  user1: 'user1@example.com',
  user2: 'user2@example.com',
  password: 'TEST1234',
} as const;

export interface Health {
  db: boolean;
  smtp: boolean;
  webadmin: boolean;
}

export async function readHealth(api: APIRequestContext): Promise<Health | null> {
  try {
    const response = await api.get('/api/health');
    if (!response.ok()) return null;
    return (await response.json()) as Health;
  } catch {
    return null;
  }
}

export async function login(
  api: APIRequestContext,
  userName: string,
  password: string = SEED.password,
  locale: 'ko' | 'en' = 'en',
): Promise<void> {
  const response = await api.post('/api/auth/login', { data: { userName, password, locale } });
  expect(response.ok(), `로그인 실패: ${userName} → ${response.status()} ${await response.text()}`).toBe(true);
}

/**
 * 서버는 상태를 바꾸는 /api 요청에 이 헤더를 요구한다 (server/src/app.ts CSRF 방어).
 * 브라우저 화면은 client/src/api/client.ts 가 붙이고, 요청 컨텍스트는 여기서 붙인다.
 */
export const CSRF_HEADERS = { 'x-requested-with': 'james9mail' };

export interface ApiFixtures {
  /** user1 로 로그인된 요청 컨텍스트 */
  asUser: APIRequestContext;
  /** 관리자로 로그인된 요청 컨텍스트 */
  asAdmin: APIRequestContext;
  /** 로그인하지 않은 요청 컨텍스트 */
  anonymous: APIRequestContext;
}

export const test = base.extend<ApiFixtures>({
  asUser: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
    await login(context, SEED.user1);
    await use(context);
    await context.dispose();
  },

  asAdmin: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
    await login(context, SEED.admin, SEED.adminPassword);
    await use(context);
    await context.dispose();
  },

  anonymous: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
    await use(context);
    await context.dispose();
  },
});

export { expect };

/** 헬스체크는 한 워커에서 한 번만 한다 */
let cachedHealth: Health | null | undefined;

async function healthOnce(baseURL: string | undefined): Promise<Health | null> {
  if (cachedHealth !== undefined) return cachedHealth;
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
  try {
    cachedHealth = await readHealth(api);
  } finally {
    await api.dispose();
  }
  return cachedHealth;
}

/**
 * 필요한 것이 떠 있지 않으면 그 스펙을 건너뛴다. **beforeEach 안에서** 부른다.
 *
 *   test.beforeEach(async ({ baseURL }) => { await requireBackend(baseURL); });
 *   test.beforeEach(async ({ baseURL }) => { await requireBackend(baseURL, { james: true }); });
 */
export async function requireBackend(
  baseURL: string | undefined,
  options: { james?: boolean } = {},
): Promise<void> {
  const health = await healthOnce(baseURL);
  base.skip(
    health === null,
    `웹서버(${baseURL})에 닿지 못했다. J9_BACKEND=1 로 서버를 함께 띄우거나 직접 실행한 뒤 다시 돌린다`,
  );
  base.skip(!health!.db, 'MariaDB 연결이 없다 (server/.env 의 DB_* 를 확인한다)');
  if (options.james) {
    base.skip(!health!.webadmin, 'James WebAdmin(8000)이 떠 있지 않다. 쓰기는 James 를 경유한다');
  }
}
