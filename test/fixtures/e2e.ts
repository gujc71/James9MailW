/**
 * e2e 계층 픽스처 (모킹 없음. 실제 웹서버 · MariaDB · James 를 통과한다).
 *
 * 여기 있는 스펙은 되돌릴 수 없는 일을 실제로 한다 — 메일이 나가고 편지함이 바뀐다.
 * 그래서 수는 적게 유지하고, 시드 계정(02-seed.sql)만 쓰고, 만든 것은 되도록 치운다.
 *
 * 폴링 동기화는 30초 간격이다 (db/sync.ts). 새 메일을 기다리는 대신 화면을 다시 열어
 * 확인한다 — 테스트가 30초씩 서 있을 이유가 없다.
 */
import { test as base, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { ShellPage } from '../pages/ShellPage';

export const E2E = {
  user1: 'user1@example.com',
  user2: 'user2@example.com',
  admin: process.env.J9_ADMIN_USER ?? 'admin@example.com',
  password: process.env.J9_PW ?? 'TEST1234',
} as const;

interface Health {
  db: boolean;
  smtp: boolean;
  webadmin: boolean;
}

let cachedHealth: Health | null | undefined;

const CSRF_HEADERS = { 'x-requested-with': 'james9mail' };

async function healthOnce(baseURL: string | undefined): Promise<Health | null> {
  if (cachedHealth !== undefined) return cachedHealth;
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: CSRF_HEADERS });
  try {
    const response = await api.get('/api/health');
    cachedHealth = response.ok() ? ((await response.json()) as Health) : null;
  } catch {
    cachedHealth = null;
  } finally {
    await api.dispose();
  }
  return cachedHealth;
}

/**
 * 풀스택이 준비되지 않았으면 건너뛴다. **beforeEach 안에서** 부른다.
 * 무엇이 없어서 못 돌렸는지 리포트에 남는다.
 */
export async function requireFullStack(
  baseURL: string | undefined,
  options: { smtp?: boolean } = {},
): Promise<void> {
  const health = await healthOnce(baseURL);
  base.skip(health === null, `웹서버에 닿지 못했다 (${baseURL}). J9_BACKEND=1 로 함께 띄운다`);
  base.skip(!health!.db, 'MariaDB 연결이 없다');
  base.skip(!health!.webadmin, 'James WebAdmin(8000)이 떠 있지 않다');
  if (options.smtp) base.skip(!health!.smtp, 'James SMTP(25)가 떠 있지 않다');
}

export interface E2EFixtures {
  shell: ShellPage;
  /** 시드 계정으로 UI 로그인한다 */
  signIn: (userName: string, password?: string) => Promise<void>;
}

export const test = base.extend<E2EFixtures>({
  shell: async ({ page }, use) => {
    await use(new ShellPage(page));
  },

  signIn: async ({ page }, use) => {
    await use(async (userName: string, password = E2E.password) => {
      await setEnglish(page);
      const shell = new ShellPage(page);
      await shell.login(userName, password);
    });
  },
});

/** 화면 문구를 영어로 고정한다. 텍스트 셀렉터가 언어에 따라 흔들리지 않게 */
export async function setEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('j9-locale', 'en');
    } catch {
      // 비공개 창 등
    }
  });
}

/** 제목에 붙일, 이 실행에서만 쓰는 꼬리표. 같은 편지함에 남은 옛 메일과 섞이지 않게 한다 */
export function runTag(): string {
  return `e2e-${Date.now().toString(36)}`;
}

/**
 * [보내기] 를 누른 뒤 창이 정리될 때까지 기다린다.
 *
 * 발송은 MIME 조립 → SMTP 제출 → Sent APPEND 까지 도는 동안 몇 초 걸린다. 그리고 결과창은
 * 사용자 설정(sendConfirmYn)과 거부된 주소 유무에 따라 뜨기도 하고 안 뜨기도 한다.
 * 그래서 "결과창이 떴으면 닫고, 어느 쪽이든 덮개가 사라질 때까지" 를 한 곳에 모은다 —
 * 남아 있는 덮개가 다음 클릭을 가로채는 것이 이 계층에서 가장 흔한 실패다.
 *
 * 결과창이 떴다면 그 안의 글자를 돌려준다 (거부된 주소 확인용).
 */
export async function finishSend(page: Page, timeout = 60_000): Promise<string | null> {
  const result = page.locator('.modal.send-confirm');
  const composing = page.locator('.compose-body');

  await expect(async () => {
    const done = (await result.isVisible()) || (await composing.count()) === 0;
    expect(done, '발송이 아직 끝나지 않았다').toBe(true);
  }).toPass({ timeout });

  let text: string | null = null;
  if (await result.isVisible()) {
    text = await result.innerText();
    await result.getByRole('button', { name: 'OK' }).click();
  }
  await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 10_000 });
  return text;
}

export { expect };
