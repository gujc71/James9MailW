/**
 * 껍데기 · 해시 라우팅 (App.tsx, lib/hashRoute.ts).
 *
 * 화면·탭을 컴포넌트 상태가 아니라 주소 해시에 두었기 때문에 얻는 것들을 확인한다.
 *  - F5 를 눌러도 보던 화면이 그대로 돌아온다
 *  - 브라우저 뒤로가기가 화면 이동으로 동작한다
 *  - 손으로 고친 주소(#/nope)나 권한 없는 화면은 조용히 바로잡힌다 (히스토리에 쌓지 않는다)
 */
import { expect, test } from '../../fixtures';
import { makeMe } from '../../fixtures/factories';
import { SettingsPage } from '../../pages/SettingsPage';

test('상단바·사이드바·목록·읽기 자리가 한 화면에 모두 있다', async ({ shell, page }) => {
  await shell.open();

  await expect(shell.brandButton).toHaveText('James9Mail');
  await expect(shell.sidebar).toBeVisible();
  await expect(shell.allMailButton).toHaveText('All mail');
  await expect(shell.mailbox('Inbox')).toBeVisible();
  await expect(page.locator('.read-empty')).toContainText('Select a message to read it here.');
});

test('설정 탭을 고른 뒤 새로고침해도 그 탭이 그대로 열린다', async ({ shell, page }) => {
  const settings = new SettingsPage(page);

  await shell.open();
  await shell.settingsLink.click();
  await settings.clickTab('filter');
  expect(await shell.hash()).toBe('#/settings/filter');

  await page.reload();

  await expect(settings.heading).toHaveText('Filters');
});

test('뒤로가기가 직전 화면으로 되돌린다', async ({ shell, page }) => {
  const settings = new SettingsPage(page);

  await shell.open();
  await shell.settingsLink.click();
  await expect(settings.heading).toHaveText('Profile');
  await settings.clickTab('signature');

  await page.goBack();
  await expect(settings.heading).toHaveText('Profile');

  await page.goBack();
  await expect(page.locator('.list-pane')).toBeVisible();
});

test('없는 주소로 들어오면 메일 화면으로 조용히 고쳐진다', async ({ shell, page }) => {
  // 손으로 고친 주소나 남이 보내 준 낡은 링크로 처음 들어오는 상황
  await page.goto('/#/nope');
  await expect(shell.topbar).toBeVisible();

  await expect(page.locator('.list-pane')).toBeVisible();
  expect(await shell.hash()).toBe('#/mail');
  // 히스토리에 쌓지 않는다 — 쌓으면 뒤로가기가 그 주소로 되돌아가 무한히 튕긴다
  await page.goBack();
  expect(await shell.hash()).not.toBe('#/nope');
});

test('없는 설정 탭은 개인정보 탭으로 고쳐진다', async ({ shell, page }) => {
  const settings = new SettingsPage(page);
  await page.goto('/#/settings/없는탭');

  await expect(settings.heading).toHaveText('Profile');
  expect(await shell.hash()).toBe('#/settings/profile');
});

test.describe('관리자 권한', () => {
  test('일반 사용자에게는 관리자 메뉴가 없고 주소로도 못 들어간다', async ({ shell, page }) => {
    await shell.open();
    await expect(shell.adminLink).toHaveCount(0);

    await page.goto('/#/admin/users');

    await expect(page.locator('.list-pane')).toBeVisible();
    expect(await shell.hash()).toBe('#/mail');
  });

  test('관리자에게는 관리자 메뉴가 보이고 메일 화면으로 되돌아올 수 있다', async ({ shell, state, page }) => {
    state.me = makeMe({ isAdmin: true, displayName: 'Administrator' });

    await shell.open();
    await shell.adminLink.click();

    await expect(page.locator('nav.settings-nav')).toBeVisible();
    expect(await shell.hash()).toBe('#/admin/overview');

    await shell.backToMailLink.click();
    await expect(page.locator('.list-pane')).toBeVisible();
  });
});

test('사용량이 사이드바에 표시된다', async ({ shell }) => {
  await shell.open();
  // 128MB / 1GB — lib/format.ts 가 사람이 읽는 단위로 바꾼다
  await expect(shell.usageText).toContainText('/');
  await expect(shell.usageText).not.toContainText('NaN');
});

test('무제한 계정은 UNLIMIT 로 표시된다', async ({ shell, state }) => {
  state.usage = { used: 1024, limit: null, unlimited: true, scope: null };
  await shell.open();
  await expect(shell.usageText).toContainText('UNLIMIT');
});
