/**
 * 발송 → 수신 → 읽기 → 수신확인 (전 구간).
 *
 * 이 스펙만이 실제로 확인할 수 있는 것들:
 *  - 웹서버가 MIME 을 조립해 SMTP 25 로 제출하고, 같은 원문을 Sent 에 APPEND 하는가
 *  - X-Sender-Mail-ID 로 발송본과 Sent 사본이 이어져 수신확인이 붙는가
 *  - 받는 사람 쪽에서 James 가 배달한 메일이 목록·읽기 화면에 뜨는가
 *  - 읽으면 READ_DATE 가 찍혀 보낸 사람의 수신확인에 반영되는가
 *
 * MariaDB · James(WebAdmin + SMTP 25)가 모두 떠 있어야 한다. 하나라도 없으면 건너뛴다.
 */
import { E2E, expect, finishSend, requireFullStack, runTag, test } from '../../fixtures/e2e';
import { ComposePage } from '../../pages/ComposePage';
import { MailboxPage } from '../../pages/MailboxPage';
import { ReadingPage } from '../../pages/ReadingPage';
import { ReceiptsPage } from '../../pages/ReceiptsPage';
import { ShellPage } from '../../pages/ShellPage';

test.beforeEach(async ({ baseURL }) => {
  await requireFullStack(baseURL, { smtp: true });
});

test('user1 이 보낸 메일이 user2 에게 도착하고, 읽으면 수신확인에 뜬다', async ({ browser, page, signIn }) => {
  const tag = runTag();
  const subject = `${tag} 분기 보고`;
  const bodyText = `${tag} 본문입니다`;

  // ---------------------------------------------------------------- 보낸다
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await signIn(E2E.user1);

  await list.composeFab.click();
  await compose.addRecipient(E2E.user2);
  await compose.subjectInput.fill(subject);
  await compose.typeBody(bodyText);
  await compose.sendButton.click();

  const outcome = await finishSend(page);
  if (outcome !== null) expect(outcome).toContain('Message sent');

  // 보낸 편지함에 같은 원문이 남는다
  const shell = new ShellPage(page);
  await shell.selectMailbox('Sent');
  await expect(list.row(subject)).toBeVisible({ timeout: 20_000 });

  // ---------------------------------------------------------------- 받는다
  const receiverContext = await browser.newContext();
  const receiverPage = await receiverContext.newPage();
  try {
    await receiverPage.addInitScript(() => {
      try {
        localStorage.setItem('j9-locale', 'en');
      } catch {
        /* 비공개 창 */
      }
    });
    const receiverShell = new ShellPage(receiverPage);
    const receiverList = new MailboxPage(receiverPage);
    const receiverReading = new ReadingPage(receiverPage);
    await receiverShell.login(E2E.user2, E2E.password);

    // James 배달과 폴링을 기다리는 대신 목록을 다시 열어 확인한다 (db/sync.ts 는 30초 간격)
    await expect(async () => {
      await receiverPage.reload();
      await expect(receiverList.row(subject)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });

    // 안 읽은 상태로 들어온다
    await expect(receiverList.row(subject)).toHaveClass(/unseen/);

    await receiverList.open(subject);
    await expect(receiverReading.subject).toHaveText(subject);
    await receiverReading.waitForBody();
    await expect(receiverReading.body.locator('body')).toContainText(bodyText);

    // 원문을 받아 연 뒤 \Seen 이 붙는다 → READ_DATE 가 찍힌다 (2-15)
    await expect(receiverList.row(subject)).not.toHaveClass(/unseen/, { timeout: 15_000 });
  } finally {
    await receiverContext.close();
  }

  // ---------------------------------------------------------------- 수신확인에 반영된다
  // 보낸 메일을 열고 보낸 사람 옆 "수신 확인" 으로 수신자별 현황을 연다
  const receipts = new ReceiptsPage(page);
  const senderReading = new ReadingPage(page);
  await list.open(subject);
  await expect(async () => {
    // 아직 안 읽힘으로 떠 있으면 닫고 다시 연다 — 팝업은 열 때 한 번 조회한다
    if (await receipts.modal.isVisible()) await page.keyboard.press('Escape');
    await senderReading.receiptsButton.click();
    await expect(receipts.detailRow(E2E.user2)).toContainText(/d{4}/, { timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  // 읽은 사람은 회수 대상에서 빠진다
  await expect(receipts.detailCheckbox(E2E.user2)).toBeDisabled();
});

test('없는 주소로 보내면 거부된 주소를 돌려주고 안내메일을 넣는다', async ({ page, signIn }) => {
  const tag = runTag();
  const subject = `${tag} 없는 주소로`;

  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await signIn(E2E.user1);

  await list.composeFab.click();
  await compose.addRecipient('nobody-here@example.com');
  await compose.subjectInput.fill(subject);
  await compose.typeBody('이 메일은 나가지 않아야 한다');
  await compose.sendButton.click();

  // 오류로 끝내지 않고, 못 간 주소를 화면에 돌려준다 (README 핵심 원칙)
  const outcome = await finishSend(page);
  expect(outcome, '거부된 주소가 있으면 결과창은 반드시 뜬다').not.toBeNull();
  expect(outcome).toContain('nobody-here@example.com');

  // 발신자 받은 편지함에 발송 실패 안내메일이 들어온다.
  // 제목은 "[Delivery failed] 원래 제목" 이다 (server/src/i18n.ts mail.notice.subject)
  const shell = new ShellPage(page);
  const reading = new ReadingPage(page);
  await shell.selectMailbox('Inbox');
  await expect(async () => {
    await page.reload();
    await expect(list.row(`[Delivery failed] ${subject}`)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });

  // 안내메일에는 못 간 주소와 사유만 담고 원문은 붙이지 않는다 (README 핵심 원칙)
  await list.open(`[Delivery failed] ${subject}`);
  await reading.waitForBody();
  await expect(reading.body.locator('body')).toContainText('nobody-here@example.com');
  await expect(reading.attachmentList).toHaveCount(0);
});

test('첨부를 붙여 보내면 받는 쪽에서 내려받을 수 있다', async ({ browser, page, signIn }) => {
  const tag = runTag();
  const subject = `${tag} 첨부 포함`;

  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await signIn(E2E.user1);

  await list.composeFab.click();
  await compose.addRecipient(E2E.user2);
  await compose.subjectInput.fill(subject);
  await compose.typeBody('첨부를 확인하세요');
  await compose.attachFile('명세서.txt', 'text/plain', `${tag} attachment payload`);
  await expect(compose.attachItems).toHaveCount(1);
  await compose.sendButton.click();
  await finishSend(page);

  const receiverContext = await browser.newContext();
  const receiverPage = await receiverContext.newPage();
  try {
    await receiverPage.addInitScript(() => {
      try {
        localStorage.setItem('j9-locale', 'en');
      } catch {
        /* 비공개 창 */
      }
    });
    const receiverShell = new ShellPage(receiverPage);
    const receiverList = new MailboxPage(receiverPage);
    const receiverReading = new ReadingPage(receiverPage);
    await receiverShell.login(E2E.user2, E2E.password);

    await expect(async () => {
      await receiverPage.reload();
      await expect(receiverList.row(subject)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });

    await receiverList.open(subject);
    await receiverReading.waitForBody();

    // 한글 파일 이름이 깨지지 않고 내려온다 (RFC 2231)
    await expect(receiverReading.attachmentList).toContainText('명세서.txt');
    const download = receiverPage.waitForEvent('download');
    await receiverReading.attachment('명세서.txt').getByRole('link').first().click();
    expect((await download).suggestedFilename()).toBe('명세서.txt');
  } finally {
    await receiverContext.close();
  }
});

/**
 * 수신확인 요청(MDN) 전 구간 — 요청 헤더 발신 → 받는 쪽에서 묻기 → 회신 도착 (feature-gap 4-4).
 *
 * 이 스펙만이 확인할 수 있는 것: 회신이 **실제로 SMTP 를 타고 발신자 편지함에 도착하는가**.
 * 회신은 우리가 손으로 조립한 multipart/report 라(mime/mdn.ts) 조립이 틀리면 배달이 되고도
 * 읽기 화면에서 빈 메일로 뜬다 — 그래서 도착만 보지 않고 본문 글자까지 확인한다.
 */
test('수신확인요청을 켜서 보내면 받는 쪽이 확인을 누른 뒤 발신자에게 회신이 온다', async ({
  browser,
  page,
  signIn,
}) => {
  const tag = runTag();
  const subject = `${tag} 수신확인 요청`;

  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await signIn(E2E.user1);

  await list.composeFab.click();
  await compose.addRecipient(E2E.user2);
  await compose.subjectInput.fill(subject);
  await compose.typeBody('읽으셨으면 알려 주세요');
  await compose.option('Request read receipt').check();
  await compose.sendButton.click();
  await finishSend(page);

  // ---------------------------------------------------------------- 받는 쪽: 묻고, 누른다
  const receiverContext = await browser.newContext();
  const receiverPage = await receiverContext.newPage();
  try {
    await receiverPage.addInitScript(() => {
      try {
        localStorage.setItem('j9-locale', 'en');
      } catch {
        /* 비공개 창 */
      }
    });
    const receiverShell = new ShellPage(receiverPage);
    const receiverList = new MailboxPage(receiverPage);
    const receiverReading = new ReadingPage(receiverPage);
    await receiverShell.login(E2E.user2, E2E.password);

    await expect(async () => {
      await receiverPage.reload();
      await expect(receiverList.row(subject)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });

    await receiverList.open(subject);

    // 열었다고 회신이 나가지는 않는다. 묻기만 한다
    await expect(receiverReading.readReceiptBox).toContainText('The sender asked for a read receipt');
    await expect(receiverReading.readReceiptBox).toContainText(E2E.user1);

    await receiverReading.readReceiptSendButton.click();
    await expect(receiverReading.readReceiptBox).toContainText('Read receipt sent');

    // 한 통만 나간다 — 다시 열어도 묻지 않는다
    await receiverPage.reload();
    await receiverList.open(subject);
    await expect(receiverReading.readReceiptBox).toContainText('Read receipt sent');
    await expect(receiverReading.readReceiptSendButton).toHaveCount(0);
  } finally {
    await receiverContext.close();
  }

  // ---------------------------------------------------------------- 발신자: 회신이 도착한다
  const shell = new ShellPage(page);
  const reading = new ReadingPage(page);
  await shell.selectMailbox('Inbox');
  await expect(async () => {
    await page.reload();
    await expect(list.row(`[Read receipt] ${subject}`)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });

  await list.open(`[Read receipt] ${subject}`);
  await reading.waitForBody();
  // 손으로 조립한 multipart/report 가 제대로 풀려 사람이 읽는 파트가 보인다
  await expect(reading.body.locator('body')).toContainText(E2E.user2);
  await expect(reading.body.locator('body')).toContainText(subject);
});
