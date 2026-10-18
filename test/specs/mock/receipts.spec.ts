/**
 * 수신확인 · 회수 (receipts/Receipts.tsx).
 *
 * 내가 보낸 메일(detail.fromMe)을 읽으면 보낸 사람 옆에 "수신 확인" 버튼이 붙고, 누르면
 * 그 메일의 수신자별 현황 팝업이 뜬다. 핵심은 "외부 도메인 수신자는 확인도 회수도 안 된다" 가
 * 화면에 드러나는가다. 조용히 빼 버리면 0/0 이 "아무도 안 읽음" 으로 읽힌다 (feature-gap 4-4).
 */
import { acceptDialogs, dismissDialogs, expect, test } from '../../fixtures';
import { BOX, makeMessage, type ReceiptDetailRow } from '../../fixtures/factories';
import { calendarEml } from '../../fixtures/eml';
import { MailboxPage } from '../../pages/MailboxPage';
import { ReadingPage } from '../../pages/ReadingPage';
import { ReceiptsPage } from '../../pages/ReceiptsPage';

const MINE = makeMessage({ uid: 41, subject: '분기 보고 공유', mailId: 'sent-1' });
const THEIRS = makeMessage({ uid: 42, subject: '받은 메일' });

const detail: ReceiptDetailRow[] = [
  { recipient: 'user2@example.com', readDate: '2026-09-26T03:00:00.000Z', tracked: true, recallable: false },
  { recipient: 'boss@example.com', name: '김부장', readDate: null, tracked: true, recallable: true },
  { recipient: 'outside@other.com', readDate: null, tracked: false, recallable: false },
];

test.beforeEach(async ({ state }) => {
  state.messages = [MINE, THEIRS];
  state.details.set(`${BOX.inbox}:${MINE.uid}`, { fromMe: true });
  state.receiptDetail = detail;
});

async function openMine(shell: { open(): Promise<void> }, page: import('@playwright/test').Page) {
  const receipts = new ReceiptsPage(page);
  await shell.open();
  await new MailboxPage(page).open('분기 보고 공유');
  await new ReadingPage(page).receiptsButton.click();
  await expect(receipts.modal).toBeVisible();
  return receipts;
}

test('사이드바에는 수신확인 항목이 없다', async ({ shell }) => {
  await shell.open();
  await expect(shell.sidebar.getByRole('button', { name: 'Read receipts' })).toHaveCount(0);
});

test('남이 보낸 메일에는 수신 확인 버튼이 없다', async ({ shell, page }) => {
  const reading = new ReadingPage(page);
  await shell.open();
  await new MailboxPage(page).open('받은 메일');

  await expect(reading.subject).toHaveText('받은 메일');
  await expect(reading.receiptsButton).toHaveCount(0);
});

test('읽은 사람 · 안 읽은 사람 · 확인 불가를 구분해 보여 준다', async ({ shell, page, state }) => {
  const receipts = await openMine(shell, page);

  await expect(receipts.detailRow('user2@example.com')).toContainText('2026');
  await expect(receipts.detailRow('outside@other.com')).toContainText('Not trackable');
  // 연 메일의 MAIL_ID 로 묻는다
  expect(state.calls.some((call) => call.path === '/api/receipts/sent-1')).toBe(true);
});

test('메일에 이름이 적혀 있으면 이름과 계정을 같이 보여 준다', async ({ shell, page }) => {
  const receipts = await openMine(shell, page);

  await expect(receipts.detailRow('boss@example.com')).toContainText('김부장 <boss@example.com>');
  // 이름이 없으면 계정만
  await expect(receipts.detailRow('user2@example.com').locator('td').nth(1)).toHaveText('user2@example.com');
});

test('약속메일이 아니면 응답 칸이 없다', async ({ shell, page, state }) => {
  const receipts = await openMine(shell, page);

  await expect(receipts.detailGrid.locator('thead th')).toHaveCount(3);
  expect(state.calls.some((call) => call.path.endsWith('/calendar-attendance'))).toBe(false);
});

test('약속메일이면 수신자별 응답을 같이 보여 준다', async ({ shell, page, state }) => {
  state.raw.set(`${BOX.inbox}:${MINE.uid}`, calendarEml());
  state.attendance = [
    { recipient: 'user2@example.com', response: 'ACCEPT', respondedAt: '2026-09-26T04:00:00.000Z' },
    { recipient: 'boss@example.com', response: null, respondedAt: null },
    { recipient: 'outside@other.com', response: 'DECLINE', respondedAt: '2026-09-26T05:00:00.000Z' },
  ];
  await shell.open();
  await new MailboxPage(page).open('분기 보고 공유');
  const reading = new ReadingPage(page);
  await reading.waitForBody();
  // 따로 있던 [약속 응답 확인] 버튼은 없어졌다
  await expect(reading.root.getByRole('button', { name: 'Check responses' })).toHaveCount(0);
  await reading.receiptsButton.click();
  const receipts = new ReceiptsPage(page);

  await expect(receipts.detailRow('user2@example.com')).toContainText('Accept');
  await expect(receipts.detailRow('boss@example.com')).toContainText('No response');
  await expect(receipts.detailRow('outside@other.com')).toContainText('Decline');
  await expect(receipts.modal).toContainText('Accepted 1 · Tentative 0 · Declined 1 · No response 1');
});

test('이미 읽은 사람과 외부 수신자는 회수 대상에서 잠긴다', async ({ shell, page }) => {
  const receipts = await openMine(shell, page);

  await expect(receipts.detailCheckbox('user2@example.com')).toBeDisabled();
  await expect(receipts.detailCheckbox('outside@other.com')).toBeDisabled();
  // 안 읽은 내부 수신자만 고를 수 있다
  await expect(receipts.detailCheckbox('boss@example.com')).toBeEnabled();
});

test('고른 수신자에게서 회수한다', async ({ shell, page, state }) => {
  await acceptDialogs(page);
  const receipts = await openMine(shell, page);

  await receipts.detailCheckbox('boss@example.com').check();
  await receipts.recallButton.click();

  await expect
    .poll(() => state.calls.some((call) => call.path === '/api/receipts/sent-1/recall'))
    .toBe(true);
  expect(state.calls.findLast((call) => call.path.endsWith('/recall'))?.body).toMatchObject({
    all: false,
    recipients: ['boss@example.com'],
  });
});

test('전체 회수는 안 읽은 사람 전부를 대상으로 한다', async ({ shell, page, state }) => {
  await acceptDialogs(page);
  const receipts = await openMine(shell, page);

  await receipts.recallAllButton.click();

  await expect
    .poll(() => state.calls.findLast((call) => call.path.endsWith('/recall'))?.body)
    .toMatchObject({ all: true });
});

test('묻는 말에 취소하면 회수하지 않는다', async ({ shell, page, state }) => {
  await dismissDialogs(page);
  const receipts = await openMine(shell, page);

  await receipts.recallAllButton.click();

  await page.waitForTimeout(300);
  expect(state.calls.some((call) => call.path.endsWith('/recall'))).toBe(false);
});

test('회수할 수 있는 사람이 없으면 전체 회수가 잠긴다', async ({ shell, page, state }) => {
  state.receiptDetail = [
    { recipient: 'user2@example.com', readDate: '2026-09-26T03:00:00.000Z', tracked: true, recallable: false },
  ];
  const receipts = await openMine(shell, page);

  await expect(receipts.recallAllButton).toBeDisabled();
});
