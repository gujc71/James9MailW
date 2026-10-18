/**
 * 사용자 설정 9탭 (settings/Settings.tsx).
 *
 * 탭 이름은 주소 해시에 그대로 실린다 (#/settings/filter) — 클릭으로도 가고 주소로도 간다.
 * 탭 본문은 모두 `.settings-content .tab` 안에 있고 h2 가 탭 이름이다.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { formRowInput, formRowInputLoose, pickFromMenu } from './helpers';

export type SettingsTab =
  | 'profile'
  | 'mailbox'
  | 'signature'
  | 'filter'
  | 'vacation'
  | 'reject'
  | 'forward'
  | 'external'
  | 'upload';

/** 탭 키 → 화면에 보이는 영어 라벨 (client/src/i18n.ts 의 settings.* 와 같아야 한다) */
export const TAB_LABEL: Record<SettingsTab, string> = {
  profile: 'Profile',
  signature: 'Signatures',
  mailbox: 'Mailboxes',
  filter: 'Filters',
  vacation: 'Vacation reply',
  reject: 'Blocked senders',
  forward: 'Forwarding',
  external: 'External mail',
  upload: 'Mail upload',
};

/** 화면에 그려지는 순서 (Settings.tsx 의 TABS) */
export const TAB_ORDER: SettingsTab[] = [
  'profile',
  'signature',
  'mailbox',
  'filter',
  'vacation',
  'reject',
  'forward',
  'external',
  'upload',
];

export class SettingsPage {
  constructor(readonly page: Page) {}

  get nav(): Locator {
    return this.page.locator('nav.settings-tabs');
  }

  tabButton(tab: SettingsTab): Locator {
    return this.nav.getByRole('button', { name: TAB_LABEL[tab], exact: true });
  }

  get content(): Locator {
    return this.page.locator('.settings-content .tab');
  }

  get heading(): Locator {
    return this.content.locator('h2');
  }

  get infoMessage(): Locator {
    return this.content.locator('.info');
  }

  get errorMessage(): Locator {
    return this.content.locator('.error');
  }

  get saveButton(): Locator {
    return this.content.locator('.modal-actions').getByRole('button', { name: 'Save' });
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

  async goto(tab: SettingsTab): Promise<void> {
    await this.page.goto(`/#/settings/${tab}`);
    await expect(this.heading).toHaveText(TAB_LABEL[tab]);
  }

  async clickTab(tab: SettingsTab): Promise<void> {
    await this.tabButton(tab).click();
    await expect(this.heading).toHaveText(TAB_LABEL[tab]);
  }

  // ---------------------------------------------------------------- 개인정보
  get userIdInput(): Locator {
    return formRowInput(this.content, 'User ID');
  }

  get displayNameInput(): Locator {
    return formRowInput(this.content, 'Name');
  }

  get changePasswordLink(): Locator {
    return this.content.getByRole('button', { name: /Change password/ });
  }

  passwordField(label: 'Current password' | 'New password' | 'Confirm new password'): Locator {
    return formRowInput(this.modal, label);
  }

  get passwordModalError(): Locator {
    return this.modal.locator('.error');
  }

  // ---------------------------------------------------------------- 편지함 관리
  get addMailboxButton(): Locator {
    return this.content.getByRole('button', { name: '+ Add' });
  }

  get newMailboxNameInput(): Locator {
    return formRowInput(this.modal, 'Mailbox name');
  }

  get newMailboxParentSelect(): Locator {
    return formRowInput(this.modal, 'Parent mailbox');
  }

  mailboxRowCheckbox(displayName: string): Locator {
    return this.gridRow(displayName).locator('input[type="checkbox"]');
  }

  /** 편지함 행의 "Options ▾" 메뉴 */
  async mailboxRowAction(displayName: string, item: string): Promise<void> {
    await pickFromMenu(this.page, this.gridRow(displayName).locator('button.tb'), item);
  }

  // ---------------------------------------------------------------- 서명
  get addSignatureButton(): Locator {
    return this.content.getByRole('button', { name: 'Add signature' });
  }

  get signatureNameInput(): Locator {
    return formRowInputLoose(this.modal, 'Name');
  }

  get signatureBodyEditor(): Locator {
    return this.modal.locator('.lx-input[contenteditable="true"]');
  }

  get defaultSignatureSelect(): Locator {
    return formRowInput(this.content, 'Default signature');
  }

  // ---------------------------------------------------------------- 규칙 (자동분류 · 수신거부 · 포워딩)
  get ruleTotal(): Locator {
    return this.content.locator('.toolbar .hint');
  }

  get addRuleButton(): Locator {
    return this.content.locator('.toolbar button.primary');
  }

  get ruleGrid(): Locator {
    return this.content.locator('table.rule-grid');
  }

  ruleRow(name: string): Locator {
    return this.ruleGrid.locator('tbody tr', { hasText: name }).first();
  }

  get ruleEmptyText(): Locator {
    return this.content.locator('p.hint').last();
  }

  // ---------------------------------------------------------------- 부재중
  get vacationUseCheckbox(): Locator {
    return this.content.locator('label.checkbox', { hasText: 'Use' }).locator('input[type="checkbox"]');
  }

  get vacationSubjectInput(): Locator {
    return formRowInput(this.content, 'Subject');
  }

  // ---------------------------------------------------------------- 외부메일
  get addExternalButton(): Locator {
    return this.content.locator('.toolbar button.primary');
  }

  externalField(label: string): Locator {
    return formRowInputLoose(this.modal, label);
  }

  // ---------------------------------------------------------------- 메일 업로드
  get uploadAddButton(): Locator {
    return this.content.getByRole('button', { name: 'Add' });
  }

  get uploadFileInput(): Locator {
    return this.modal.locator('input[type="file"]');
  }

  get uploadRunButton(): Locator {
    return this.modal.getByRole('button', { name: 'Run' });
  }
}
