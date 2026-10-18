/**
 * 읽기 화면 (ReadingPane.tsx, BodyViewer.tsx, useMessageBody.ts, mime/parse.worker.ts).
 *
 * 이 화면의 입력은 **원문(.eml)** 이다. 서버는 파일을 그대로 내려주고 브라우저가 Web Worker
 * 에서 MIME 을 파싱한 뒤 sandbox iframe 안에 본문을 그린다. 그래서 여기 스펙은 원문을
 * 골라 넣고 화면이 어떻게 해석하는지를 본다 — fixtures/eml.ts 가 원문을 만든다.
 *
 * 본문 글자는 iframe 안에 있으므로 frameLocator 로 들어가야 보인다.
 */
import { expect, test } from '../../fixtures';
import { BOX, makeMessage } from '../../fixtures/factories';
import {
  TINY_PNG,
  calendarEml,
  multipartEml,
  remoteImageEml,
  simpleEml,
  tnefEml,
  vcardEml,
} from '../../fixtures/eml';
import { MailboxPage } from '../../pages/MailboxPage';
import { ReadingPage } from '../../pages/ReadingPage';
import { attachBodyShot } from '../../pages/helpers';

const KEY = (uid: number) => `${BOX.inbox}:${uid}`;

test('메일을 고르면 제목·보낸사람·본문이 나온다', async ({ shell, page, state }, testInfo) => {
  state.messages = [makeMessage({ uid: 11, subject: 'Plain hello', seen: false })];
  state.raw.set(KEY(11), simpleEml({ subject: 'Plain hello', text: 'Hello from the parser.' }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Plain hello');

  await expect(reading.subject).toHaveText('Plain hello');
  await expect(reading.meta).toContainText('user2@example.com');
  await reading.waitForBody();
  // 본문은 iframe(srcdoc) 안에 있다
  await expect(reading.body.locator('body')).toContainText('Hello from the parser.');
  await attachBodyShot(page, testInfo, 'plain-body.png');
});

test('열면 읽음으로 표시된다 (수신확인이 찍히는 경로)', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 12, subject: 'Unread one', seen: false })];
  state.raw.set(KEY(12), simpleEml({ subject: 'Unread one' }));

  const list = new MailboxPage(page);
  await shell.open();
  await list.open('Unread one');

  // 원문을 받은 뒤 \Seen 을 따로 세팅한다. 이 호출이 없으면 READ_DATE 가 찍히지 않는다 (2-15)
  await expect
    .poll(() => state.calls.filter((call) => call.path === '/api/messages/flags').length)
    .toBeGreaterThan(0);
  const call = state.calls.findLast((item) => item.path === '/api/messages/flags');
  expect(call?.body).toMatchObject({ mailboxId: BOX.inbox, uids: [12], add: ['\\Seen'] });
});

test('한글 제목(RFC 2047)이 제대로 풀린다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 13, subject: '9월 정산 안내' })];
  state.raw.set(KEY(13), simpleEml({ subject: '9월 정산 안내', text: '내용' }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('9월 정산');

  await expect(reading.subject).toHaveText('9월 정산 안내');
  await reading.waitForBody();
  await expect(reading.body.locator('body')).toContainText('내용');
});

test('첨부는 목록에 나오고 내려받을 수 있다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 14, subject: 'With files', hasAttachment: true })];
  state.raw.set(
    KEY(14),
    multipartEml({
      subject: 'With files',
      html: '<p>첨부를 확인하세요</p>',
      attachments: [
        { filename: '보고서.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 fake').toString('base64') },
      ],
    }),
  );

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('With files');
  await reading.waitForBody();

  await expect(reading.attachmentList).toContainText('보고서.pdf');
  const download = page.waitForEvent('download');
  await reading.attachment('보고서.pdf').getByRole('link').first().click();
  // 한글 파일명이 깨지지 않는지까지 본다
  expect((await download).suggestedFilename()).toBe('보고서.pdf');
});

test('인라인 이미지(cid:)가 본문 안에 박힌다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 15, subject: 'Inline image' })];
  state.raw.set(
    KEY(15),
    multipartEml({
      subject: 'Inline image',
      html: '<p>로고</p><img src="cid:logo@example.com" alt="logo">',
      attachments: [
        { filename: 'logo.png', mimeType: 'image/png', content: TINY_PNG, contentId: 'logo@example.com' },
      ],
    }),
  );

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Inline image');
  await reading.waitForBody();

  // sandbox iframe 은 opaque origin 이라 blob: 을 열 수 없다. data: 로 바뀌어 있어야 한다
  const image = reading.body.locator('img[alt="logo"]');
  await expect(image).toHaveAttribute('src', /^data:image\/png/);
  // 첨부 목록으로 내려가지 않았다
  await expect(reading.attachmentList).toHaveCount(0);
});

test('원격 이미지는 기본 차단하고 사용자가 허용할 수 있다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 16, subject: 'Newsletter' })];
  state.raw.set(KEY(16), remoteImageEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Newsletter');
  await reading.waitForBody();

  await expect(reading.remoteBanner).toContainText('Remote images were blocked');
  await reading.showImagesButton.click();
  await expect(reading.remoteBanner).toHaveCount(0);
});

test('winmail.dat 은 미리보기할 수 없다고 알려 준다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 17, subject: 'Sent from Outlook', hasAttachment: true })];
  state.raw.set(KEY(17), tnefEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Sent from Outlook');
  await reading.waitForBody();

  // 워커는 localStorage 를 못 보므로 경고를 키로만 넘기고 읽기 화면이 번역한다
  await expect(reading.warnings).toContainText('winmail.dat');
});

test('약속메일은 참석 응답을 받고 한 번 답하면 잠긴다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 18, subject: '회의 요청' })];
  state.raw.set(KEY(18), calendarEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('회의 요청');
  await reading.waitForBody();

  await expect(reading.calendarBox).toBeVisible();

  await reading.answerAppointment('Accept');

  await expect(reading.calendarBox).toContainText('You answered: Accept');
  const call = state.calls.findLast((item) => item.path.endsWith('/calendar-response'));
  expect(call?.body).toMatchObject({ response: 'ACCEPT' });
});

/**
 * 일정 파트(text/calendar)는 워커가 바이트로 받아 그대로 디코드해야 읽힌다.
 * postal-mime 이 Uint8Array 를 주는 경우 String() 으로 바꾸면 "66,69,71,…" 이 되어
 * DTSTART 를 못 찾고 일정 상자가 빈 채로 뜬다 (mime/parse.worker.ts toArrayBuffer).
 */
test('약속메일이 일시·장소·내용을 모두 보여 준다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 23, subject: '회의 요청2' })];
  state.raw.set(KEY(23), calendarEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('회의 요청2');
  await reading.waitForBody();

  await expect(reading.appointmentField('When')).toHaveText('2026-10-01 14:00 ~ 15:00');
  await expect(reading.appointmentField('Where')).toHaveText('Meeting room A');
  await expect(reading.appointmentField('Details')).toHaveText('Quarterly planning, bring notes');
});

/** 일정 파트는 약속 상자가 내용을 이미 펼쳐 보여 주므로 첨부로 또 내걸지 않는다 */
test('약속메일의 일정 파트는 첨부 목록에 뜨지 않는다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 24, subject: '회의 요청3', hasAttachment: true })];
  state.raw.set(KEY(24), calendarEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('회의 요청3');
  await reading.waitForBody();

  await expect(reading.calendarBox).toBeVisible();
  await expect(reading.attachmentList).toHaveCount(0);
});

/**
 * v-Card 는 내려받아야 열리는 파일이 아니라 연락처다 — 썬더버드처럼 이름·메일·전화를
 * 바로 펼쳐 보여 주고, .vcf 는 첨부 목록에서 뺀다 (mime/vcard.ts · VCardBox.tsx).
 */
test('v-Card 첨부는 파일 대신 연락처로 펼쳐 보여 준다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 25, subject: 'dddddddddd', hasAttachment: true })];
  state.raw.set(KEY(25), vcardEml());

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('dddddddddd');
  await reading.waitForBody();

  await expect(reading.vcardBox).toContainText('관리자');
  await expect(reading.vcardBox.getByRole('link', { name: '<admin@example.com>' })).toHaveAttribute(
    'href',
    'mailto:admin@example.com',
  );
  await expect(reading.vcardField('Title')).toHaveText('팀장');
  await expect(reading.vcardField('Organization')).toHaveText('구름주식회사 · 개발팀');
  await expect(reading.vcardField('Mobile')).toHaveText('010-1234-5678');

  // .vcf 파일은 내걸지 않는다
  await expect(reading.attachmentList).toHaveCount(0);
});

/** 옛 메일 앱이 보낸 QUOTED-PRINTABLE 한글 이름도 글자로 되돌려야 한다 */
test('vCard 2.1 의 QUOTED-PRINTABLE 한글 이름이 깨지지 않는다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 26, subject: 'dddddddddd', hasAttachment: true })];
  state.raw.set(KEY(26), vcardEml({ quotedPrintable: true }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('dddddddddd');
  await reading.waitForBody();

  await expect(reading.vcardBox.locator('.vcard-name')).toHaveText('관리자');
});

test('원문 보기로 헤더를 그대로 확인할 수 있다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 19, subject: 'Raw please' })];
  state.raw.set(KEY(19), simpleEml({ subject: 'Raw please', messageId: '<raw-1@example.com>' }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Raw please');
  await reading.waitForBody();

  await reading.etcAction('View source');

  await expect(reading.sourceDialog).toContainText('Message-ID: <raw-1@example.com>');
});

test('임시 보관함 메일은 이어 쓰기로 열린다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 20, mailboxId: BOX.drafts, subject: 'Half written' })];
  state.raw.set(`${BOX.drafts}:20`, simpleEml({ subject: 'Half written', text: '쓰던 내용' }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await shell.selectMailbox('Drafts');
  await list.open('Half written');
  await reading.waitForBody();

  // 답장·전달 대신 [이어 쓰기] 한 개만 나온다
  await expect(reading.continueDraftButton).toBeVisible();
  await expect(reading.replyButton).toHaveCount(0);

  await reading.continueDraftButton.click();
  await expect(page.locator('.compose-body')).toBeVisible();
});

test('아무것도 고르지 않았으면 안내만 보인다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 21 })];
  const reading = new ReadingPage(page);
  await shell.open();

  await expect(reading.emptyHint).toContainText('Select a message to read it here.');
  await expect(reading.emptyHint).toContainText('user1@example.com');
});

test('원문을 못 받으면 읽기 화면이 사유를 보여 준다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 22, subject: 'Broken' })];
  state.failures.set(`GET /api/messages/${BOX.inbox}/22/raw`, { status: 500, error: 'boom' });

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Broken');

  await expect(reading.root.locator('.error')).toBeVisible();
});

/**
 * 수신확인 요청(MDN, feature-gap 4-4).
 *
 * 상자를 띄울지는 **서버가** 정한다 — 원문 헤더를 읽고 내가 보낸 메일인지까지 가려
 * `detail.readReceipt` 로 내려준다. 그래서 여기서는 원문이 아니라 상세 응답을 꾸며 넣는다.
 */
test('수신확인 요청이 있으면 수신자 정보 아래에서 발송 여부를 묻는다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 26, subject: 'Please confirm' })];
  state.details.set(KEY(26), { readReceipt: { requestedTo: 'boss@example.com', sentAt: null } });

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Please confirm');

  await expect(reading.readReceiptBox).toContainText('The sender asked for a read receipt');
  await expect(reading.readReceiptBox).toContainText('boss@example.com');

  await reading.readReceiptSendButton.click();

  // 몸통은 비어 있다. 회신받을 주소는 서버가 원문에서 꺼낸다
  const call = state.calls.findLast((item) => item.path.endsWith('/read-receipt'));
  expect(call?.method).toBe('POST');
  await expect(reading.readReceiptBox).toContainText('Read receipt sent');
  await expect(reading.readReceiptSendButton).toHaveCount(0);
});

test('이미 회신한 메일은 다시 묻지 않는다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 27, subject: 'Already confirmed' })];
  state.details.set(KEY(27), {
    readReceipt: { requestedTo: 'boss@example.com', sentAt: '2026-09-30T01:02:03.000Z' },
  });

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Already confirmed');

  await expect(reading.readReceiptBox).toContainText('Read receipt sent');
  await expect(reading.readReceiptSendButton).toHaveCount(0);
});

/** 요청이 없거나 내가 보낸 메일이면 서버가 null 을 내려주고, 화면에는 상자가 아예 없다 */
test('수신확인 요청이 없으면 상자가 뜨지 않는다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 28, subject: 'No request' })];

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('No request');

  await expect(reading.readReceiptBox).toHaveCount(0);
});
