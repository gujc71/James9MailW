/**
 * 관리자 6탭 (settings/Admin.tsx).
 *
 * 관리자 화면은 사이드 편지함 없이 상단바 + 좌측 LNB(.settings-nav) 로 그려진다.
 * 비관리자가 #/admin 으로 들어오면 App 이 주소를 조용히 #/mail 로 고친다 (App.tsx).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { formRowInput, formRowInputLoose, pickFromMenu } from './helpers';
// formRowInputLoose 는 "* 이름" 처럼 별표가 붙은 라벨을 집을 때 쓴다

export type AdminTab = 'overview' | 'site' | 'users' | 'aliases' | 'mails' | 'droplist';

export const ADMIN_TAB_LABEL: Record<AdminTab, string> = {
  overview: 'Overview',
  site: 'Site settings',
  users: 'Users',
  aliases: 'Aliases',
  mails: 'Mail log',
  droplist: 'Blocklist',
};

export const ADMIN_TAB_ORDER: AdminTab[] = ['overview', 'site', 'users', 'aliases', 'mails', 'droplist'];

export class AdminPage {
  constructor(readonly page: Page) {}

  get nav(): Locator {
    return this.page.locator('nav.settings-nav');
  }

  tabButton(tab: AdminTab): Locator {
    return this.nav.getByRole('button', { name: ADMIN_TAB_LABEL[tab], exact: true });
  }

  get content(): Locator {
    return this.page.locator('.settings-content .tab');
  }

  get heading(): Locator {
    return this.content.locator('h2');
  }

  get grid(): Locator {
    return this.content.locator('table.grid');
  }

  gridRow(text: string): Locator {
    return this.grid.locator('tbody tr', { hasText: text }).first();
  }

  get modal(): Locator {
    return this.page.locator('.modal-backdrop .modal');
  }

  get errorMessage(): Locator {
    return this.content.locator('.error');
  }

  get infoMessage(): Locator {
    return this.content.locator('.info');
  }

  async goto(tab: AdminTab): Promise<void> {
    await this.page.goto(`/#/admin/${tab}`);
    await expect(this.heading).toHaveText(ADMIN_TAB_LABEL[tab]);
  }

  async clickTab(tab: AdminTab): Promise<void> {
    await this.tabButton(tab).click();
    await expect(this.heading).toHaveText(ADMIN_TAB_LABEL[tab]);
  }

  // ---------------------------------------------------------------- 현황
  get statCards(): Locator {
    return this.content.locator('.stat-cards .stat .stat-num');
  }

  get hourlyDateInput(): Locator {
    return this.content.locator('input.inline-date');
  }

  // ---------------------------------------------------------------- 기본 설정
  get siteNameInput(): Locator {
    return formRowInput(this.content, 'Site name');
  }

  get defaultQuotaInput(): Locator {
    return formRowInputLoose(this.content, 'Default quota per user');
  }

  // ---------------------------------------------------------------- 기본 설정 > 강조색
  /** 기준 강조색 줄의 색 선택기 (<input type=color>) */
  get accentPicker(): Locator {
    return formRowInput(this.content, 'Base accent', 0);
  }

  /** 기준 강조색 줄의 hex 칸 */
  get accentHex(): Locator {
    return formRowInput(this.content, 'Base accent', 1);
  }

  /** 파생 여덟 항목 격자에서 이름으로 hex 칸을 집는다 */
  themeHex(label: string): Locator {
    return this.content
      .locator(`.theme-item:has(.theme-item-name:text-is("${label}"))`)
      .locator('input.hex');
  }

  get deriveButton(): Locator {
    return this.content.getByRole('button', { name: 'Fill the rest' });
  }

  get resetThemeButton(): Locator {
    return this.content.getByRole('button', { name: 'Reset palette' });
  }

  /** 미리보기의 기본 버튼 — 실제로 --accent 가 칠해졌는지 본다 */
  get themeSampleButton(): Locator {
    return this.content.getByRole('button', { name: 'Primary button' });
  }

  // ---------------------------------------------------------------- 사용자
  get searchInput(): Locator {
    return this.content.locator('.search input');
  }

  get searchButton(): Locator {
    return this.content.locator('.search').getByRole('button', { name: 'Search' });
  }

  get addUserButton(): Locator {
    return this.content.getByRole('button', { name: '+ Add user' });
  }

  userField(label: string): Locator {
    return formRowInputLoose(this.modal, label);
  }

  get displayNameField(): Locator {
    return formRowInput(this.modal, 'User name');
  }

  /** 계정 칸은 @ 앞부분만 받고, 도메인은 옆 선택칸에서 고른다 */
  get accountLocalField(): Locator {
    return formRowInput(this.modal, 'Account');
  }

  get accountDomainSelect(): Locator {
    return this.modal.locator('.form-row').filter({ hasText: 'Account' }).locator('select');
  }

  get passwordField(): Locator {
    return this.modal.locator('input[type="password"]').first();
  }

  get passwordConfirmField(): Locator {
    return this.modal.locator('input[type="password"]').last();
  }

  get newQuotaInput(): Locator {
    return formRowInput(this.modal, 'New quota');
  }

  get modalError(): Locator {
    return this.modal.locator('.error');
  }

  get registerButton(): Locator {
    return this.modal.getByRole('button', { name: 'Register' });
  }

  get checkDuplicateButton(): Locator {
    return this.modal.getByRole('button', { name: 'Check' });
  }

  // ---------------------------------------------------------------- 알리아스 팝업
  get aliasNameField(): Locator {
    return formRowInput(this.modal, 'Alias name');
  }

  get aliasLocalField(): Locator {
    return formRowInput(this.modal, 'Alias address');
  }

  /**
   * 새 알리아스의 등록 버튼. 중복확인을 통과할 때까지 잠겨 있다 (Admin.tsx AliasModal).
   * 수정일 때는 라벨이 [Save] 로 바뀐다.
   */
  get aliasRegisterButton(): Locator {
    return this.modal.getByRole('button', { name: 'Register' });
  }

  /** 행 오른쪽 "▼" 메뉴 (중지/사용 · 용량 변경 · 삭제) */
  async rowAction(rowText: string, item: string): Promise<void> {
    await pickFromMenu(this.page, this.gridRow(rowText).locator('button.tb'), item);
  }

  // ---------------------------------------------------------------- 알리아스
  get addAliasButton(): Locator {
    return this.content.getByRole('button', { name: '+ Add alias' });
  }

  // ---------------------------------------------------------------- 차단 목록
  /** 툴바의 [Add] → 팝업이 열린다 */
  get dropAddButton(): Locator {
    return this.content.locator('.toolbar').getByRole('button', { name: 'Add' });
  }

  /** 팝업 안의 입력칸 (라벨 없이 placeholder 만 있다) */
  get dropEntityInput(): Locator {
    return this.modal.locator('input.wide');
  }

  get dropSaveButton(): Locator {
    return this.modal.getByRole('button', { name: 'Save' });
  }

  get dropTypeSelect(): Locator {
    return this.content.locator('.toolbar .search select');
  }
}
