/**
 * 메일쓰기 팝업 (compose/Compose.tsx).
 *
 * 두 군데가 평범한 input 이 아니다.
 *  - 수신자 칸: 주소를 "블럭(chip)" 으로 다루는 자체 위젯. 확정은 Enter · 콤마 · 세미콜론
 *    (compose/RecipientInput.tsx)
 *  - 본문: Lexical 기반 contenteditable (.lx-input). fill 이 통하지 않으므로 click 후 type 한다
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { fieldRow } from './helpers';

export class ComposePage {
  constructor(readonly page: Page) {}

  get root(): Locator {
    return this.page.locator('.modal-backdrop .modal').filter({ has: this.page.locator('.compose-body') });
  }

  get title(): Locator {
    return this.root.locator('.modal-head h3');
  }

  get closeX(): Locator {
    return this.root.locator('.modal-head button.x');
  }

  // ---------------------------------------------------------------- 수신자
  recipientInput(field: 'To' | 'Cc' | 'Bcc'): Locator {
    return fieldRow(this.root, field).locator('input.chip-input');
  }

  chips(field: 'To' | 'Cc' | 'Bcc'): Locator {
    return fieldRow(this.root, field).locator('span.chip');
  }

  /** 주소를 넣고 블럭으로 확정한다 */
  async addRecipient(address: string, field: 'To' | 'Cc' | 'Bcc' = 'To'): Promise<void> {
    const input = this.recipientInput(field);
    await input.fill(address);
    await input.press('Enter');
  }

  get addCcBccButton(): Locator {
    return this.root.locator('button.field-add');
  }

  get suggestList(): Locator {
    return this.root.locator('ul.suggest');
  }

  // ---------------------------------------------------------------- 제목 · 본문
  get subjectInput(): Locator {
    return fieldRow(this.root, 'Subject').locator('input').first();
  }

  get fromSelect(): Locator {
    return this.root.locator('select.from-select');
  }

  /** Lexical 편집 영역. 로드가 비동기라 먼저 기다린다 */
  get bodyEditor(): Locator {
    return this.root.locator('.lx-input[contenteditable="true"]');
  }

  async typeBody(text: string): Promise<void> {
    await this.bodyEditor.waitFor();
    await this.bodyEditor.click();
    await this.page.keyboard.type(text);
  }

  async bodyText(): Promise<string> {
    return (await this.bodyEditor.textContent()) ?? '';
  }

  // ---------------------------------------------------------------- 첨부
  get attachBar(): Locator {
    return this.root.locator('.attach-bar');
  }

  get fileInput(): Locator {
    return this.attachBar.locator('input[type="file"]');
  }

  get toggleAttachListButton(): Locator {
    return this.attachBar.locator('button.tb').first();
  }

  get attachPanel(): Locator {
    return this.root.locator('.attach-panel');
  }

  get attachItems(): Locator {
    return this.attachPanel.locator('ul.attach-list > li');
  }

  get convertAllLargeButton(): Locator {
    return this.attachBar.getByRole('button', { name: 'Convert all to large attachments' });
  }

  async attachFile(name: string, mimeType: string, contents: string): Promise<void> {
    await this.fileInput.setInputFiles({ name, mimeType, buffer: Buffer.from(contents) });
  }

  // ---------------------------------------------------------------- 옵션
  option(
    label:
      | 'High importance'
      | 'Send a copy to me'
      | 'Send individually'
      | 'Request read receipt'
      | 'Attach v-Card',
  ): Locator {
    return this.root.locator('label.checkbox', { hasText: label }).locator('input[type="checkbox"]');
  }

  get signatureSelect(): Locator {
    return this.root.locator('.compose-options select');
  }

  // ---------------------------------------------------------------- 버튼
  get sendButton(): Locator {
    return this.root.getByRole('button', { name: 'Send' });
  }

  get saveDraftButton(): Locator {
    return this.root.getByRole('button', { name: 'Save draft' });
  }

  get previewButton(): Locator {
    return this.root.getByRole('button', { name: 'Preview' });
  }

  get cancelButton(): Locator {
    return this.root.getByRole('button', { name: 'Cancel' });
  }

  get appointmentButton(): Locator {
    return this.root.locator('button[title="Appointment mail"]');
  }

  get addressBookButtons(): Locator {
    return this.root.getByRole('button', { name: 'Address book' });
  }

  // ---------------------------------------------------------------- 상태 표시
  /** "Auto-saved at …" · "Too large to auto-save" 등 (compose/draftStore.ts) */
  get autosaveNote(): Locator {
    return this.root.locator('.autosave');
  }

  /** 자동저장한 초안이 있을 때 위쪽에 뜨는 복원 안내 */
  get restoreBar(): Locator {
    return this.root.locator('.restore-bar');
  }

  get restoreButton(): Locator {
    return this.restoreBar.getByRole('button', { name: 'Continue writing' });
  }

  async expectOpen(): Promise<void> {
    await expect(this.title).toHaveText('New mail');
  }
}
