/**
 * 메일 목록 화면 (목록 머리줄 · 검색 · 정렬 · 필터 · 행).
 *
 * 목록은 가상 스크롤(@tanstack/react-virtual)이라 화면에 보이는 만큼만 DOM 에 있다.
 * 그래서 "n번째 행" 보다 제목으로 행을 집는 편이 안전하고, 통수 단정은 보이는 행이 아니라
 * 스크롤해 가며 확인해야 한다 — 그 점을 rowCount 주석에 적어 둔다.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { pickFromMenu } from './helpers';

export type SearchField = 'All' | 'From' | 'To' | 'Subject' | 'File name';

export class MailboxPage {
  constructor(readonly page: Page) {}

  get header(): Locator {
    return this.page.locator('.mailbox-header');
  }

  /** 지금 보고 있는 편지함 이름 */
  get title(): Locator {
    return this.header.locator('strong');
  }

  get unseenBadge(): Locator {
    return this.header.locator('.unseen');
  }

  get list(): Locator {
    return this.page.locator('.list-pane .list');
  }

  get rows(): Locator {
    return this.list.locator('.row');
  }

  /**
   * 화면에 그려진 행 수. 가상 스크롤이므로 "편지함의 총 통수" 가 아니다.
   * 총 통수를 봐야 할 때는 편지함 헤더나 설정 > 편지함 관리 표를 본다.
   */
  async visibleRowCount(): Promise<number> {
    return this.rows.count();
  }

  row(subject: string): Locator {
    return this.rows.filter({ hasText: subject }).first();
  }

  rowCheckbox(subject: string): Locator {
    return this.row(subject).locator('input[type="checkbox"]');
  }

  rowStar(subject: string): Locator {
    return this.row(subject).locator('button.star');
  }

  get emptyNotice(): Locator {
    return this.list.locator('.list-status', { hasText: 'No messages.' });
  }

  get offlineNotice(): Locator {
    return this.list.locator('.offline-note');
  }

  get moreButton(): Locator {
    return this.page.locator('.list-pane button.more');
  }

  get selectAllCheckbox(): Locator {
    return this.page.locator('.list-header > label.checkbox input[type="checkbox"]');
  }

  get composeFab(): Locator {
    return this.page.locator('button.fab');
  }

  async open(subject: string): Promise<void> {
    await this.row(subject).click();
  }

  async select(...subjects: string[]): Promise<void> {
    for (const subject of subjects) await this.rowCheckbox(subject).check();
  }

  // ---------------------------------------------------------------- 검색
  /**
   * 검색바는 두 벌 있다 — 넓은 화면에서는 읽기 패널 위쪽(.read-search)이 보이고,
   * 좁은 화면에서는 목록 머리줄의 것(.search-narrow)이 보인다 (styles.css 710행).
   * 어느 쪽이 켜져 있든 보이는 것을 집는다.
   */
  get searchBox(): Locator {
    return this.page.locator('.search:visible').first();
  }

  async search(keyword: string, field: SearchField = 'All'): Promise<void> {
    await this.searchBox.locator('select').selectOption({ label: field });
    await this.searchBox.locator('input').fill(keyword);
    await this.searchBox.getByRole('button', { name: 'Search' }).click();
  }

  // ---------------------------------------------------------------- 필터
  get filterButton(): Locator {
    return this.page.locator('.filter-wrap > button.tb');
  }

  get filterPanel(): Locator {
    return this.page.locator('.filters');
  }

  async toggleFilter(label: 'All' | 'Unread' | 'Starred' | 'High importance' | 'Attachment'): Promise<void> {
    if (!(await this.filterPanel.isVisible())) await this.filterButton.click();
    await this.filterPanel.locator('label.checkbox', { hasText: label }).locator('input').click();
  }

  // ---------------------------------------------------------------- 정렬 · 기타 메뉴
  /** 머리줄의 정렬 메뉴 버튼. 라벨이 "⇅ Date ↓" 처럼 현재 기준을 담고 있다 */
  get sortButton(): Locator {
    return this.page.locator('.list-header button.tb[title="Sort"]');
  }

  async sortBy(label: string): Promise<void> {
    await pickFromMenu(this.page, this.sortButton, new RegExp(label));
  }

  // ---------------------------------------------------------------- 대화로 묶기 (2-2)
  /** 정렬 메뉴 안에 같이 들어 있는 토글이다 — 둘 다 "목록을 어떻게 세울지" 라서 */
  async toggleThreadView(): Promise<void> {
    await pickFromMenu(this.page, this.sortButton, /Group by conversation/);
  }

  /** 접힌 대화의 통수 배지. "3" 또는 안 읽음이 남았으면 "3 (2)" 꼴이다 */
  threadCount(subject: string): Locator {
    return this.row(subject).locator('.thread-count');
  }

  /** 통수 배지를 누른다 — 읽기 영역에 대화 내용이 펼쳐진다 (ConversationPage) */
  async openConversation(subject: string): Promise<void> {
    await this.threadCount(subject).click();
  }

  threadToggle(subject: string): Locator {
    return this.row(subject).locator('button.thread-toggle');
  }

  /** 대표행의 삼각형을 눌러 대화를 펼친다 */
  async expandThread(subject: string): Promise<void> {
    await this.threadToggle(subject).click();
  }

  /** 펼쳐진 대화의 아래쪽 줄들 */
  get threadChildren(): Locator {
    return this.list.locator('.row.thread-child');
  }

  /** "More ▾ (n)" — 체크한 메일에 대한 조작 메뉴 */
  get bulkMenuButton(): Locator {
    return this.page.locator('.list-header .menu > button.tb').filter({ hasText: 'More' });
  }

  async bulkAction(item: string): Promise<void> {
    await pickFromMenu(this.page, this.bulkMenuButton, item);
  }

  /** "This sender ▾" — 받은 편지함에서만 나온다 */
  get senderMenuButton(): Locator {
    return this.page.locator('.list-header .menu > button.tb').filter({ hasText: 'This sender' });
  }

  async senderAction(item: string): Promise<void> {
    await pickFromMenu(this.page, this.senderMenuButton, item);
  }

  // ---------------------------------------------------------------- 편지함 선택 팝업
  get pickerModal(): Locator {
    return this.page.locator('.modal-backdrop .modal');
  }

  /**
   * 편지함을 고르고 [Select] 를 누른다 (common/MailboxPicker.tsx).
   * 한 번 클릭은 선택일 뿐이고 확정은 아래 버튼이다 — 더블클릭도 확정이지만
   * 스펙에서는 사람이 하는 순서 그대로 두 단계로 둔다.
   */
  async pickMailbox(displayName: string): Promise<void> {
    await this.pickerModal.locator('ul.picker-list button', { hasText: displayName }).first().click();
    await this.pickerModal.getByRole('button', { name: 'Select' }).click();
  }

  async expectRow(subject: string): Promise<void> {
    await expect(this.row(subject)).toBeVisible();
  }

  async expectNoRow(subject: string): Promise<void> {
    await expect(this.rows.filter({ hasText: subject })).toHaveCount(0);
  }
}
