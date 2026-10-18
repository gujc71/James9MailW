/**
 * 메일쓰기 (compose/Compose.tsx, RecipientInput.tsx, draftStore.ts).
 *
 * 확인하는 것
 *  - 수신자 블럭(chip) 위젯: Enter · 콤마로 확정, 잘못된 주소 표시, 참조/숨은참조 열기
 *  - 발송 · 임시저장이 서버로 무엇을 보내는가 (multipart 필드)
 *  - 수신자 없이 보내려 할 때 막는가
 *  - 거부된 주소가 있으면 결과창을 반드시 띄우는가
 *  - 자동 저장한 초안이 다음에 열 때 복원되는가
 */
import { expect, test } from '../../fixtures';
import { ACCOUNT, OTHER, makeAddress, makeMessage, makeSignature } from '../../fixtures/factories';
import { multipartEml, simpleEml } from '../../fixtures/eml';
import { formField, formFileNames } from '../../fixtures/multipart';
import { ComposePage } from '../../pages/ComposePage';
import { MailboxPage } from '../../pages/MailboxPage';

test.beforeEach(async ({ state }) => {
  state.addresses = [makeAddress(), makeAddress({ addressId: 2, contactName: 'Boss', mailAddress: 'boss@example.com' })];
  state.signatures = [makeSignature()];
});

test('새 메일 창이 열리고 기본 항목이 갖춰져 있다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();

  await list.composeFab.click();

  await compose.expectOpen();
  await expect(compose.recipientInput('To')).toBeVisible();
  await expect(compose.subjectInput).toBeVisible();
  await expect(compose.bodyEditor).toBeVisible();
  // 참조·숨은참조는 접혀 있다
  await expect(compose.recipientInput('Cc')).toHaveCount(0);
});

test('주소를 Enter 로 확정하면 블럭이 된다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.addRecipient('boss@example.com');

  await expect(compose.chips('To')).toHaveCount(2);
  await expect(compose.chips('To').first()).toHaveText(new RegExp(OTHER));
});

test('형식이 틀린 주소는 블럭에 표시된다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient('not-an-address');

  await expect(compose.chips('To').first()).toHaveClass(/invalid/);
});

test('참조·숨은참조를 열 수 있다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addCcBccButton.click();

  await expect(compose.recipientInput('Cc')).toBeVisible();
  await expect(compose.recipientInput('Bcc')).toBeVisible();
});

test('주소를 입력하면 주소록에서 후보를 펼친다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.recipientInput('To').fill('boss');

  await expect(compose.suggestList).toBeVisible();
  await expect(compose.suggestList).toContainText('boss@example.com');
});

test('수신자 없이 보내려 하면 막고 알려 준다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.subjectInput.fill('제목만 있음');
  await compose.sendButton.click();

  await expect(shell.toast).toContainText('Enter at least one recipient');
  expect(state.calls.some((call) => call.path === '/api/compose/send')).toBe(false);
});

test('발송하면 수신자·제목·본문이 서버로 넘어간다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.subjectInput.fill('안녕하세요');
  await compose.typeBody('본문입니다');
  await compose.sendButton.click();

  // 보내는사람 확인 설정이 켜져 있으면 결과창이 뜬다 (setting.sendConfirmYn)
  await expect(page.locator('.modal.send-confirm')).toContainText('Message sent');

  const call = state.calls.findLast((item) => item.path === '/api/compose/send');
  expect(formField(call?.body, 'to')).toBe(OTHER);
  expect(formField(call?.body, 'subject')).toBe('안녕하세요');
  expect(formField(call?.body, 'html')).toContain('본문입니다');
});

test('거부된 주소가 있으면 설정과 무관하게 결과창이 뜬다', async ({ shell, page, state }) => {
  state.me = { ...state.me!, setting: { ...state.me!.setting, sendConfirmYn: false } };
  state.sendOutcome = {
    ...state.sendOutcome,
    delivered: false,
    accepted: [],
    rejected: ['nobody@example.com'],
    noticeSent: true,
    warnings: ['nobody@example.com: 550 5.1.1 Unknown user'],
  };

  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();
  await compose.addRecipient('nobody@example.com');
  await compose.sendButton.click();

  const result = page.locator('.modal.send-confirm');
  await expect(result).toContainText('The message was not sent');
  await expect(result).toContainText('550 5.1.1 Unknown user');
});

test('발송 옵션(중요·내게도·개별발송·수신확인요청)이 그대로 실린다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.option('High importance').check();
  await compose.option('Send a copy to me').check();
  await compose.option('Send individually').check();
  await compose.option('Request read receipt').check();
  await compose.sendButton.click();

  const call = state.calls.findLast((item) => item.path === '/api/compose/send');
  expect(formField(call?.body, 'important')).toBe('true');
  expect(formField(call?.body, 'sendToSelf')).toBe('true');
  expect(formField(call?.body, 'individual')).toBe('true');
  expect(formField(call?.body, 'readReceipt')).toBe('true');
});

test('서명을 고르면 서명 번호가 함께 넘어간다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.signatureSelect.selectOption({ label: 'Work' });
  await compose.sendButton.click();

  const call = state.calls.findLast((item) => item.path === '/api/compose/send');
  expect(formField(call?.body, 'signatureId')).toBe('1');
});

test('첨부를 붙이면 목록에 나오고 발송에 실린다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.attachFile('명세서.txt', 'text/plain', 'hello');

  await expect(compose.attachItems).toHaveCount(1);
  await expect(compose.attachItems.first()).toContainText('명세서.txt');

  await compose.sendButton.click();
  const call = state.calls.findLast((item) => item.path === '/api/compose/send');
  expect(formFileNames(call?.body).join()).toContain('명세서.txt');
});

test('대용량으로 전환하면 먼저 업로드한 뒤 발송한다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.attachFile('big.bin', 'application/octet-stream', 'x'.repeat(1000));
  await compose.convertAllLargeButton.click();
  await expect(compose.attachItems.first()).toContainText('Large');

  await compose.sendButton.click();

  // 업로드 → 발송 두 번의 왕복이라 둘 다 들어올 때까지 기다린다
  await expect.poll(() => state.calls.some((call) => call.path === '/api/compose/send')).toBe(true);
  const order = state.calls.map((call) => call.path);
  expect(order).toContain('/api/attachments/large');
  // 대용량은 먼저 올리고 그 id 를 발송에 싣는다
  expect(order.indexOf('/api/attachments/large')).toBeLessThan(order.lastIndexOf('/api/compose/send'));
});

test('임시저장은 초안 경로로 보낸다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.subjectInput.fill('나중에 이어 쓸 메일');
  await compose.saveDraftButton.click();

  await expect
    .poll(() => state.calls.some((call) => call.path === '/api/compose/draft'))
    .toBe(true);
  const call = state.calls.findLast((item) => item.path === '/api/compose/draft');
  expect(formField(call?.body, 'subject')).toBe('나중에 이어 쓸 메일');
});

test('미리보기는 보낼 모양을 그대로 보여 준다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const compose = new ComposePage(page);
  await shell.open();
  await list.composeFab.click();

  await compose.addRecipient(OTHER);
  await compose.subjectInput.fill('미리보기 제목');
  await compose.typeBody('미리보기 본문');
  await compose.previewButton.click();

  const preview = page.locator('.modal-backdrop .modal').last();
  await expect(preview).toContainText('미리보기 제목');
  await expect(preview).toContainText(OTHER);
});

test.describe('자동 저장 (브라우저에만 남는 초안)', () => {
  test('쓰다 남긴 글이 있으면 다음에 열 때 복원을 권한다', async ({ shell, page }) => {
    // 이 계정으로 자동 저장된 초안을 미리 심어 둔다 (compose/draftStore.ts 의 키 규칙)
    await page.addInitScript(
      ({ account }) => {
        localStorage.setItem(
          `j9-compose-draft:${account}`,
          JSON.stringify({
            savedAt: Date.now() - 60_000,
            to: 'user2@example.com',
            cc: '',
            bcc: '',
            subject: '쓰다 만 메일',
            html: '<p>여기까지 썼다</p>',
            important: false,
            sendToSelf: false,
            individual: false,
            vcardYn: false,
            signatureId: null,
            droppedAttachments: ['첨부.pdf'],
          }),
        );
      },
      { account: ACCOUNT },
    );

    const list = new MailboxPage(page);
    const compose = new ComposePage(page);
    await shell.open();
    await list.composeFab.click();

    await expect(compose.restoreBar).toContainText('You have an unfinished message');
    // 첨부는 복원되지 않는다고 분명히 알린다
    await expect(compose.restoreBar).toContainText('첨부.pdf');

    await compose.restoreButton.click();

    await expect(compose.subjectInput).toHaveValue('쓰다 만 메일');
    await expect(compose.chips('To')).toHaveCount(1);
  });

  test('쓰는 동안 자동 저장 상태가 표시된다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const compose = new ComposePage(page);
    await shell.open();
    await list.composeFab.click();

    await compose.subjectInput.fill('자동 저장 확인');
    await compose.typeBody('내용');

    await expect(compose.autosaveNote).toContainText('Auto-saved', { timeout: 15_000 });
  });
});

test.describe('답장 · 전달', () => {
  test('답장은 보낸 사람이 받는사람에 들어가고 제목에 Re: 가 붙는다', async ({ shell, page, state }) => {
    state.messages = [makeMessage({ uid: 31, subject: 'Original subject', from: 'boss@example.com' })];
    state.raw.set(`${state.messages[0]!.mailboxId}:31`, simpleEml({ from: 'boss@example.com', subject: 'Original subject', text: '원문 본문' }));

    const list = new MailboxPage(page);
    const compose = new ComposePage(page);
    await shell.open();
    await list.open('Original subject');
    await page.locator('iframe[title="mail-body"]').waitFor();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();

    await compose.expectOpen();
    await expect(compose.subjectInput).toHaveValue('Re: Original subject');
    await expect(compose.chips('To').first()).toHaveText(/boss@example.com/);
    // 원문이 인용되어 들어간다 (feature-gap 1-1)
    expect(await compose.bodyText()).toContain('원문 본문');
  });

  test('전달은 제목에 Fwd: 가 붙고 원문 첨부가 붙는다', async ({ shell, page, state }) => {
    state.messages = [makeMessage({ uid: 32, subject: 'Forward me', hasAttachment: true })];
    state.raw.set(
      `${state.messages[0]!.mailboxId}:32`,
      multipartEml({
        subject: 'Forward me',
        html: '<p>원본</p>',
        attachments: [{ filename: 'spec.txt', mimeType: 'text/plain', content: Buffer.from('spec').toString('base64') }],
      }),
    );

    const list = new MailboxPage(page);
    const compose = new ComposePage(page);
    await shell.open();
    await list.open('Forward me');
    await page.locator('iframe[title="mail-body"]').waitFor();

    const forwardMenu = page.locator('.reading-toolbar .menu > button.tb').filter({ hasText: 'Forward' });
    await forwardMenu.click();
    await page.locator('ul.menu-list').getByRole('button', { name: 'Forward (with attachments)' }).click();

    await compose.expectOpen();
    await expect(compose.subjectInput).toHaveValue('Fwd: Forward me');
    // 원본 첨부가 그대로 따라온다 (feature-gap 1-2).
    // 첨부가 붙으면 첨부칸이 저절로 펼쳐지므로 따로 열지 않는다 (Compose.addFiles)
    await expect(compose.attachPanel).toContainText('spec.txt');
  });
});
