/**
 * 메일 조작 — 플래그 · 이동 · 복사 · 삭제 · 스팸 · 모두 읽음 (routes/mutations.ts).
 *
 * 쓰기는 모두 James 를 경유하므로(직접 UPDATE 금지) 화면이 확인해야 하는 것은
 * "어떤 요청을 어떤 값으로 보냈는가" 와 "돌아온 뒤 목록이 맞게 바뀌는가" 두 가지다.
 */
import { acceptDialogs, expect, test } from '../../fixtures';
import { BOX, makeMessage } from '../../fixtures/factories';
import { MailboxPage } from '../../pages/MailboxPage';
import { ReadingPage } from '../../pages/ReadingPage';
import { simpleEml } from '../../fixtures/eml';

test.beforeEach(async ({ state }) => {
  state.messages = [
    makeMessage({ uid: 41, subject: 'Keep me', seen: true }),
    makeMessage({ uid: 42, subject: 'Move me', seen: false }),
    makeMessage({ uid: 43, subject: 'Delete me', seen: true }),
  ];
  for (const message of state.messages) {
    state.raw.set(`${message.mailboxId}:${message.uid}`, simpleEml({ subject: message.subject ?? '' }));
  }
});

test('별표를 눌러 켜고 끈다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.rowStar('Keep me').click();

  await expect
    .poll(() => state.calls.filter((call) => call.path === '/api/messages/flags').length)
    .toBe(1);
  expect(state.calls.findLast((call) => call.path === '/api/messages/flags')?.body).toMatchObject({
    uids: [41],
    add: ['\\Flagged'],
  });
  await expect(list.rowStar('Keep me')).toHaveClass(/on/);

  await list.rowStar('Keep me').click();
  await expect
    .poll(() => state.calls.findLast((call) => call.path === '/api/messages/flags')?.body)
    .toMatchObject({ remove: ['\\Flagged'] });
});

test('여러 통을 골라 읽음으로 바꾼다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Move me', 'Delete me');
  await list.bulkAction('Mark as read');

  const call = state.calls.findLast((item) => item.path === '/api/messages/flags');
  expect(call?.body).toMatchObject({ add: ['\\Seen'] });
  expect((call?.body as { uids: number[] }).uids.sort()).toEqual([42, 43]);
});

test('머리줄 체크박스로 전체를 고른다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.selectAllCheckbox.check();

  await expect(list.bulkMenuButton).toContainText('(3)');
});

test('아무것도 고르지 않았으면 조작 메뉴가 잠겨 있다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.bulkMenuButton.click();

  await expect(page.locator('ul.menu-list').getByRole('button', { name: 'Move' })).toBeDisabled();
});

test('다른 편지함으로 옮기면 목록에서 사라진다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Move me');
  await list.bulkAction('Move');
  await list.pickMailbox('Project');

  await expect
    .poll(() => state.calls.some((call) => call.path === '/api/messages/move'))
    .toBe(true);
  const call = state.calls.findLast((item) => item.path === '/api/messages/move');
  expect(call?.body).toMatchObject({ targetMailboxId: BOX.project });
  await list.expectNoRow('Move me');
});

test('복사는 원본을 남긴다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Keep me');
  await list.bulkAction('Copy');
  await list.pickMailbox('Project');

  await expect.poll(() => state.calls.some((call) => call.path === '/api/messages/copy')).toBe(true);
  await list.expectRow('Keep me');
});

test('삭제는 휴지통으로 보내고, 완전 삭제는 먼저 묻는다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Delete me');
  await list.bulkAction('Delete');

  await expect.poll(() => state.calls.some((call) => call.path === '/api/messages/delete')).toBe(true);
  expect(state.calls.findLast((item) => item.path === '/api/messages/delete')?.body).toMatchObject({
    permanent: false,
  });
  await list.expectNoRow('Delete me');

  // 완전 삭제는 되돌릴 수 없으므로 확인을 받는다
  const asked = await acceptDialogs(page);
  await list.select('Keep me');
  await list.bulkAction('Delete permanently');

  await expect
    .poll(() => state.calls.filter((item) => item.path === '/api/messages/delete').length)
    .toBe(2);
  expect(asked.join(' ')).toContain('cannot be undone');
});

test('스팸으로 신고하면 스팸 편지함으로 넘어간다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Move me');
  await list.bulkAction('Block as spam');

  await expect.poll(() => state.calls.some((call) => call.path === '/api/messages/spam')).toBe(true);
  await list.expectNoRow('Move me');

  await shell.selectMailbox('Spam');
  await list.expectRow('Move me');
});

test('수신거부를 쓰지 않는 계정에는 스팸 메뉴가 없다', async ({ shell, page, state }) => {
  state.me = { ...state.me!, setting: { ...state.me!.setting, rejectUseYn: false } };
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Move me');
  await list.bulkMenuButton.click();

  await expect(page.locator('ul.menu-list').getByRole('button', { name: 'Block as spam' })).toHaveCount(0);
});

test('편지함 전체를 읽음으로 바꾼다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await expect(list.unseenBadge).toBeVisible();

  await shell.mailboxAction('Inbox', 'Mark all as read');

  await expect
    .poll(() => state.calls.some((call) => call.path.endsWith('/read-all')))
    .toBe(true);
  await expect(list.unseenBadge).toHaveCount(0);
});

test('읽기 화면에서도 같은 조작을 할 수 있다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.open('Keep me');
  await reading.waitForBody();

  await reading.etcAction('Move');
  await list.pickMailbox('Project');

  const call = state.calls.findLast((item) => item.path === '/api/messages/move');
  expect(call?.body).toMatchObject({ targetMailboxId: BOX.project, uids: [41] });
});

test('휴지통에서는 삭제 버튼 대신 완전 삭제만 나온다', async ({ shell, page, state }) => {
  state.messages = [makeMessage({ uid: 44, mailboxId: BOX.trash, subject: 'Already trashed' })];
  state.raw.set(`${BOX.trash}:44`, simpleEml({ subject: 'Already trashed' }));

  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await shell.selectMailbox('Trash');
  await list.open('Already trashed');
  await reading.waitForBody();

  await expect(reading.purgeButton).toBeVisible();
  await expect(reading.deleteButton).toHaveCount(0);
});

test('받은 편지함에서 보낸 사람을 주소록에 넣을 수 있다', async ({ shell, page, state }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.select('Keep me');
  await list.senderAction('Add to contacts');

  await expect.poll(() => state.calls.some((call) => call.path === '/api/addresses' && call.method === 'POST')).toBe(true);
});
