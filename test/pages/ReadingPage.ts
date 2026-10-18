/**
 * 읽기 화면 (message/ReadingPane.tsx).
 *
 * 본문은 Web Worker 가 원문을 파싱한 뒤 sandbox iframe(srcdoc) 안에 그려진다.
 * 그래서 본문 글자는 frameLocator 로 들어가야 보이고, 첨부 링크는 blob: 다.
 * 툴바 버튼은 본문이 오기 전까지 disabled 이므로(reply/forward) 기다림이 필요하다.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { mailBody, pickFromMenu } from './helpers';

export class ReadingPage {
  constructor(readonly page: Page) {}

  get root(): Locator {
    return this.page.locator('.reading');
  }

  get emptyHint(): Locator {
    return this.page.locator('.read-empty');
  }

  get subject(): Locator {
    return this.page.locator('h2.reading-subject');
  }

  get meta(): Locator {
    return this.page.locator('.reading-meta');
  }

  get backToList(): Locator {
    return this.page.locator('button.back-to-list');
  }

  get parsingNotice(): Locator {
    return this.page.locator('.reading-status');
  }

  get warnings(): Locator {
    return this.root.locator('.warn');
  }

  /** 본문 iframe 안쪽. 본문 글자를 볼 때는 반드시 이쪽으로 들어간다 */
  get body() {
    return mailBody(this.page);
  }

  /** 본문이 그려질 때까지 기다린다 (답장·전달 버튼이 살아나는 시점과 같다) */
  async waitForBody(): Promise<void> {
    await expect(this.page.locator('iframe[title="mail-body"]')).toBeVisible();
  }

  get replyButton(): Locator {
    return this.root.getByRole('button', { name: 'Reply', exact: true });
  }

  get replyAllButton(): Locator {
    return this.root.getByRole('button', { name: 'Reply all' });
  }

  get forwardMenuButton(): Locator {
    return this.root.locator('.reading-toolbar .menu > button.tb').filter({ hasText: 'Forward' });
  }

  get deleteButton(): Locator {
    return this.root.getByRole('button', { name: 'Delete', exact: true });
  }

  get purgeButton(): Locator {
    return this.root.getByRole('button', { name: 'Delete permanently' });
  }

  get spamButton(): Locator {
    return this.root.getByRole('button', { name: /^(Block as spam|Not spam)$/ });
  }

  get continueDraftButton(): Locator {
    return this.root.getByRole('button', { name: 'Continue writing' });
  }

  /** "More ▾" — 이동 · 복사 · PC 저장 · 원문 보기 · 스팸 */
  get etcMenuButton(): Locator {
    return this.root.locator('.reading-toolbar .menu > button.tb').filter({ hasText: 'More' });
  }

  async etcAction(item: string): Promise<void> {
    await pickFromMenu(this.page, this.etcMenuButton, item);
  }

  async forward(kind: 'with attachments' | 'as eml' = 'with attachments'): Promise<void> {
    await pickFromMenu(
      this.page,
      this.forwardMenuButton,
      kind === 'with attachments' ? 'Forward (with attachments)' : /\.eml attachment/,
    );
  }

  // ---------------------------------------------------------------- 첨부
  get attachmentList(): Locator {
    return this.root.locator('.attachments');
  }

  attachment(filename: string): Locator {
    return this.attachmentList.locator('li', { hasText: filename }).first();
  }

  // ---------------------------------------------------------------- 원격 이미지
  get remoteBanner(): Locator {
    return this.root.locator('.remote-banner');
  }

  get showImagesButton(): Locator {
    return this.remoteBanner.getByRole('button', { name: 'Show images' });
  }

  // ---------------------------------------------------------------- 약속메일
  get calendarBox(): Locator {
    return this.root.locator('.calendar-box');
  }

  async answerAppointment(answer: 'Accept' | 'Tentative' | 'Decline'): Promise<void> {
    await this.calendarBox.getByRole('button', { name: answer }).click();
  }

  /** 약속 상자의 한 항목 값 (라벨은 en 로케일 기준 — When · Where · Details) */
  appointmentField(label: 'When' | 'Where' | 'Details'): Locator {
    return this.calendarBox.locator('.cal-fields > div', { hasText: label }).locator('dd');
  }

  // ---------------------------------------------------------------- 수신확인 요청 (MDN)
  get readReceiptBox(): Locator {
    return this.root.locator('.mdn-box');
  }

  get readReceiptSendButton(): Locator {
    return this.readReceiptBox.getByRole('button', { name: 'Send' });
  }

  /** 내가 보낸 메일의 보낸 사람 옆 "수신 확인" — 수신자별 현황 팝업을 연다 */
  get receiptsButton(): Locator {
    return this.root.locator('.reading-meta').getByRole('button', { name: 'Read receipts' });
  }

  // ---------------------------------------------------------------- v-Card 연락처
  get vcardBox(): Locator {
    return this.root.locator('.vcard-box').first();
  }

  /** 연락처 상자의 한 항목 값 (라벨은 en 로케일 기준 — Title · Organization · Mobile …) */
  vcardField(label: string): Locator {
    return this.vcardBox.locator('.vcard-fields > div', { hasText: label }).locator('dd');
  }

  // ---------------------------------------------------------------- 원문 보기 팝업
  get sourceDialog(): Locator {
    return this.page.locator('.modal-backdrop .modal');
  }
}
