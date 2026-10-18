/**
 * 로그인 화면 + 상단바 + 사이드바 = 모든 화면이 공유하는 껍데기.
 *
 * 화면 이동은 해시 라우팅이므로(lib/hashRoute.ts) 주소로 바로 들어갈 수 있다.
 * 클릭으로 가는 경로와 주소로 바로 가는 경로 둘 다 쓴다 — 전자는 메뉴가 붙어 있는지,
 * 후자는 F5·링크 공유가 되는지를 본다.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { pickFromMenu } from './helpers';

export type View = 'mail' | 'settings' | 'admin';

export class ShellPage {
  constructor(readonly page: Page) {}

  // ---------------------------------------------------------------- 로그인
  get loginCard(): Locator {
    return this.page.locator('form.login-card');
  }

  get userInput(): Locator {
    // 로그인 화면은 label 이 input 을 감싸므로 getByLabel 이 통한다
    return this.page.getByLabel('User', { exact: true });
  }

  get passwordInput(): Locator {
    return this.page.getByLabel('Password', { exact: true });
  }

  get signInButton(): Locator {
    return this.page.getByRole('button', { name: 'Sign in' });
  }

  get loginError(): Locator {
    return this.loginCard.locator('.error');
  }

  /** 로그인 화면을 열고 계정을 넣어 들어간다 */
  async login(userName = 'user1@example.com', password = 'TEST1234'): Promise<void> {
    await this.page.goto('/');
    await this.userInput.waitFor();
    await this.userInput.fill(userName);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
    await expect(this.topbar).toBeVisible();
  }

  /**
   * 이미 로그인된 상태로 바로 시작한다. state.me 가 채워져 있으면 /api/me 가 200 이라
   * 로그인 화면을 거치지 않는다 — 대부분의 화면 스펙은 이쪽을 쓴다.
   */
  async open(view: View | '' = '', tab?: string): Promise<void> {
    const hash = view ? (tab ? `#/${view}/${tab}` : `#/${view}`) : '';
    await this.page.goto(`/${hash}`);
    await expect(this.topbar).toBeVisible();
  }

  // ---------------------------------------------------------------- 상단바
  get topbar(): Locator {
    return this.page.locator('header.topbar');
  }

  get brandButton(): Locator {
    return this.topbar.locator('button.brand');
  }

  get settingsLink(): Locator {
    return this.topbar.getByRole('button', { name: 'Preferences' });
  }

  get adminLink(): Locator {
    return this.topbar.getByRole('button', { name: 'Admin', exact: true });
  }

  /**
   * 관리자 화면에서 메일로 돌아가는 버튼.
   * exact 를 켜지 않으면 사이트 이름("James9Mail")까지 걸린다 — 이름 일치는 기본이 부분 일치다.
   */
  get backToMailLink(): Locator {
    return this.topbar.getByRole('button', { name: 'Mail', exact: true });
  }

  get logoutButton(): Locator {
    return this.topbar.getByRole('button', { name: 'Sign out' });
  }

  get whoAmI(): Locator {
    return this.topbar.locator('span.who');
  }

  get burger(): Locator {
    return this.topbar.locator('button.burger');
  }

  // ---------------------------------------------------------------- 사이드바
  get sidebar(): Locator {
    return this.page.locator('aside.sidebar');
  }

  get allMailButton(): Locator {
    return this.sidebar.locator('button.mbox.all');
  }

  get usageText(): Locator {
    return this.sidebar.locator('.usage-text');
  }

  /** 편지함 이름으로 사이드바 버튼을 집는다 */
  mailbox(displayName: string): Locator {
    return this.sidebar.locator('button.mbox', { hasText: displayName }).first();
  }

  /** 편지함 행 */
  mailboxRow(displayName: string): Locator {
    return this.sidebar.locator(`.mbox-row:has(button.mbox:has-text("${displayName}"))`).first();
  }

  /** 편지함 행 오른쪽의 "⋯" 옵션 메뉴 버튼. 마우스를 올려야 나타난다 */
  mailboxMenuButton(displayName: string): Locator {
    return this.mailboxRow(displayName).locator('button.mbox-more');
  }

  /**
   * 편지함 옵션 메뉴를 열고 항목을 누른다.
   * "⋯" 는 행에 마우스를 올렸을 때만 보이므로 hover 가 먼저다.
   */
  async mailboxAction(displayName: string, item: string): Promise<void> {
    await this.mailboxRow(displayName).hover();
    await pickFromMenu(this.page, this.mailboxMenuButton(displayName), item);
  }

  /** 편지함 옵션 메뉴를 열기만 한다 (항목이 잠겼는지 보고 싶을 때) */
  async openMailboxMenu(displayName: string): Promise<Locator> {
    await this.mailboxRow(displayName).hover();
    await this.mailboxMenuButton(displayName).click();
    const list = this.page.locator('ul.menu-list');
    await list.waitFor({ state: 'visible' });
    return list;
  }

  async selectMailbox(displayName: string): Promise<void> {
    await this.mailbox(displayName).click();
  }

  /** 지금 주소 해시 (#/settings/filter 형태) */
  async hash(): Promise<string> {
    return this.page.evaluate(() => window.location.hash);
  }

  get toast(): Locator {
    return this.page.locator('.toast-top');
  }
}
