/**
 * 로그인 · 로그아웃 · 언어 선택 (features/auth/Login.tsx).
 *
 * 로그인 화면이 뜨는 조건은 "/api/me 가 401" 이다 (App.tsx). state.me 를 null 로 두면
 * 실제 서버 없이도 같은 화면이 나온다.
 */
import { expect, test } from '../../fixtures';
import { ACCOUNT } from '../../fixtures/factories';

test.describe('로그인', () => {
  test.beforeEach(async ({ state }) => {
    state.me = null;
  });

  test('세션이 없으면 로그인 화면이 뜬다', async ({ page, shell }) => {
    await page.goto('/');
    await expect(shell.loginCard).toBeVisible();
    await expect(page.getByRole('heading', { name: 'James9Mail' })).toBeVisible();
    await expect(shell.topbar).toBeHidden();
  });

  test('아이디·비밀번호를 넣으면 메일 화면으로 들어간다', async ({ page, shell, state }) => {
    await page.goto('/');
    await shell.userInput.fill(ACCOUNT);
    await shell.passwordInput.fill('TEST1234');
    await shell.signInButton.click();

    await expect(shell.topbar).toBeVisible();
    await expect(shell.whoAmI).toHaveText('User One');
    // 로그인 요청에 화면에서 고른 언어가 함께 실린다
    const login = state.calls.find((call) => call.path === '/api/auth/login');
    expect(login?.body).toMatchObject({ userName: ACCOUNT, locale: 'en' });
  });

  test('서버가 거부하면 사유를 화면에 보여 주고 머문다', async ({ page, shell, state }) => {
    state.loginFails = 'Sign-in failed';

    await page.goto('/');
    await shell.userInput.fill(ACCOUNT);
    await shell.passwordInput.fill('wrong');
    await shell.signInButton.click();

    await expect(shell.loginError).toHaveText('Sign-in failed');
    await expect(shell.loginCard).toBeVisible();
  });

  test('[한글] 을 고르면 그 자리에서 화면 문구가 바뀐다', async ({ page, shell }) => {
    await page.goto('/');
    await expect(shell.signInButton).toBeVisible();

    await page.getByRole('button', { name: '한글' }).click();

    await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
    await expect(page.getByText('아이디 저장')).toBeVisible();
    // 고른 언어는 기기에 남는다 (localStorage j9-locale)
    expect(await page.evaluate(() => localStorage.getItem('j9-locale'))).toBe('ko');
  });

  test('아이디 저장을 켜면 다음에 열 때 채워져 있다', async ({ page, shell, state }) => {
    await page.goto('/');
    await shell.userInput.fill(ACCOUNT);
    await shell.passwordInput.fill('TEST1234');
    await shell.page.getByLabel('Remember me').check();
    await shell.signInButton.click();
    await expect(shell.topbar).toBeVisible();

    // 다시 세션 없는 상태로 열면 아이디가 남아 있다
    state.me = null;
    await page.goto('/');
    await expect(shell.userInput).toHaveValue(ACCOUNT);
    await expect(page.getByLabel('Remember me')).toBeChecked();
  });
});

test.describe('로그아웃 · 세션', () => {
  test('로그아웃하면 로그인 화면으로 돌아간다', async ({ page, shell, state }) => {
    await shell.open();
    await shell.logoutButton.click();

    await expect(shell.loginCard).toBeVisible();
    expect(state.calls.some((call) => call.path === '/api/auth/logout')).toBe(true);
  });

  test('세션이 끊긴 뒤 새로 열면 로그인 화면이다', async ({ page, shell, state }) => {
    await shell.open();
    await expect(shell.topbar).toBeVisible();

    // 서버 재시작 등으로 세션이 사라진 상황 (auth/session.ts 는 프로세스 메모리에 둔다)
    state.me = null;
    await page.reload();

    await expect(shell.loginCard).toBeVisible();
  });
});
