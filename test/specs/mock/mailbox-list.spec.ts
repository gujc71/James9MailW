/**
 * 편지함 트리 · 메일 목록 · 검색 · 정렬 · 필터 (Sidebar.tsx, MessageList.tsx, App.tsx).
 *
 * 목록은 가상 스크롤이라 화면에 보이는 만큼만 DOM 에 있다. 그래서 "몇 통" 을 세는 단정은
 * 피하고, 있어야 할 메일이 보이는지 · 없어야 할 메일이 사라졌는지로 확인한다.
 */
import { expect, test } from '../../fixtures';
import { acceptDialogs } from '../../fixtures';
import { BOX, makeMessage } from '../../fixtures/factories';
import { MailboxPage } from '../../pages/MailboxPage';

test.beforeEach(async ({ state }) => {
  state.messages = [
    makeMessage({ uid: 1, subject: 'Quarterly report', from: 'boss@example.com', fromDisplay: 'Boss', seen: false, receivedAt: '2026-09-26T10:00:00.000Z' }),
    makeMessage({ uid: 2, subject: 'Lunch?', from: 'user2@example.com', fromDisplay: 'User Two', seen: true, receivedAt: '2026-09-25T10:00:00.000Z', size: 500 }),
    makeMessage({ uid: 3, subject: 'Invoice 9월', from: 'billing@vendor.com', fromDisplay: null, seen: false, flagged: true, hasAttachment: true, important: true, receivedAt: '2026-09-24T10:00:00.000Z', size: 900_000 }),
    makeMessage({ uid: 4, mailboxId: BOX.sent, subject: 'Re: Quarterly report', to: 'boss@example.com', toDisplay: 'Boss' }),
    makeMessage({ uid: 5, mailboxId: BOX.spam, subject: 'You won', from: 'spam@bad.com' }),
  ];
});

test('받은 편지함이 기본으로 열리고 목록이 최근순으로 나온다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await expect(list.title).toHaveText('Inbox');
  await expect(list.rows.first()).toContainText('Quarterly report');
  await list.expectRow('Lunch?');
  // 다른 편지함 메일은 섞이지 않는다
  await list.expectNoRow('You won');
});

test('안 읽은 메일은 표시가 다르고 통수가 머리줄에 나온다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await expect(list.unseenBadge).toContainText('2 unread');
  await expect(list.row('Quarterly report')).toHaveClass(/unseen/);
  await expect(list.row('Lunch?')).not.toHaveClass(/unseen/);
});

test('첨부·중요도 표시가 행에 보인다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  const row = list.row('Invoice');
  await expect(row.locator('.clip')).toBeVisible();
  await expect(row.locator('.prio')).toHaveAttribute('aria-label', 'High importance');
  await expect(row.locator('button.star')).toHaveClass(/on/);
});

test('편지함을 고르면 그 편지함 메일만 나온다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await shell.selectMailbox('Spam');

  await expect(list.title).toHaveText('Spam');
  await list.expectRow('You won');
  await list.expectNoRow('Quarterly report');
});

test('보낸 편지함은 받는 사람을 보여 준다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await shell.selectMailbox('Sent');

  await expect(list.row('Re: Quarterly report').locator('.who')).toContainText('Boss');
});

test('전체 메일 보기는 편지함을 가로질러 모아 보여 준다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await shell.allMailButton.click();

  await expect(list.title).toHaveText('All mail');
  await list.expectRow('Quarterly report');
  await list.expectRow('You won');
  await list.expectRow('Re: Quarterly report');
});

test('메일이 없으면 비었다고 알린다', async ({ shell, page, state }) => {
  state.messages = [];
  const list = new MailboxPage(page);
  await shell.open();

  await expect(list.emptyNotice).toBeVisible();
});

test.describe('검색', () => {
  test('제목으로 찾는다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.search('Invoice', 'Subject');

    await list.expectRow('Invoice');
    await list.expectNoRow('Lunch?');
  });

  test('보낸 사람으로 찾는다', async ({ shell, page, state }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.search('billing@vendor.com', 'From');

    await list.expectRow('Invoice');
    // 검색 조건이 서버로 그대로 넘어간다
    const call = state.calls.findLast((item) => item.path === '/api/messages');
    expect(call?.query).toMatchObject({ searchField: 'from', keyword: 'billing@vendor.com' });
  });

  test('첨부 파일 이름 검색은 파일이름 조건으로 넘어간다', async ({ shell, page, state }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.search('bill.pdf', 'File name');

    const call = state.calls.findLast((item) => item.path === '/api/messages');
    expect(call?.query.searchField).toBe('filename');
  });
});

test.describe('필터', () => {
  test('안 읽은 메일만 걸러낸다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.toggleFilter('Unread');

    await list.expectRow('Quarterly report');
    await list.expectNoRow('Lunch?');
    await expect(list.filterButton).toContainText('Filter 1');
  });

  test('별표·첨부 필터를 겹쳐 쓸 수 있다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.toggleFilter('Starred');
    await list.toggleFilter('Attachment');

    await expect(list.filterButton).toContainText('Filter 2');
    await list.expectRow('Invoice');
    await list.expectNoRow('Quarterly report');
  });
});

test.describe('정렬', () => {
  test('크기순으로 고르면 날짜 자리에 크기가 나온다', async ({ shell, page, state }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.sortBy('Size');

    const call = state.calls.findLast((item) => item.path === '/api/messages');
    expect(call?.query).toMatchObject({ sort: 'size', dir: 'desc' });
    await expect(list.rows.first()).toContainText('Invoice');
    // 크기로 줄 세웠으면 무엇으로 세웠는지 보여야 한다 (MessageList.tsx)
    await expect(list.row('Invoice').locator('.date')).not.toHaveText(/2026/);
  });

  test('같은 기준을 다시 고르면 방향만 뒤집힌다', async ({ shell, page, state }) => {
    const list = new MailboxPage(page);
    await shell.open();

    await list.sortBy('Subject');
    await list.sortBy('Subject');

    const call = state.calls.findLast((item) => item.path === '/api/messages');
    expect(call?.query.sort).toBe('subject');
    expect(call?.query.dir).toBe('desc');
  });

  test('고른 정렬은 기기에 남는다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();
    await list.sortBy('Subject');

    await page.reload();

    await expect(list.sortButton).toContainText('Subject');
  });
});

test.describe('편지함 이동 시 목록 조건 초기화', () => {
  test('필터 · 검색 · 정렬을 걸어 둔 채 다른 편지함으로 옮기면 모두 풀린다', async ({ shell, page, state }) => {
    const list = new MailboxPage(page);
    await shell.open();
    await list.toggleFilter('Unread');
    await list.search('Quarterly', 'Subject');
    await list.sortBy('Subject');

    await shell.selectMailbox('Spam');

    // 화면에 남은 조건이 없다 — 검색어 · 검색 대상 · 필터 수 · 정렬 기준 모두 처음 상태다
    await expect(list.filterButton).toHaveText(/^All/);
    await expect(list.searchBox.locator('input')).toHaveValue('');
    await expect(list.searchBox.locator('select')).toHaveValue('all');
    await expect(list.sortButton).toContainText('Date');
    // 서버로 나가는 질의도 조건 없는 첫 페이지다
    const call = state.calls.findLast((item) => item.path === '/api/messages');
    expect(call?.query).toMatchObject({ mailbox: BOX.spam, sort: 'date', dir: 'desc' });
    expect(call?.query.keyword).toBeUndefined();
    expect(call?.query.unseen).toBeUndefined();
    // 앞 편지함의 필터에 걸렸을 메일(읽은 메일)이 가려지지 않는다
    await list.expectRow('You won');
  });

  test('전체 메일 보기로 옮길 때도 풀린다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();
    await list.search('Quarterly', 'Subject');

    await shell.allMailButton.click();

    await expect(list.searchBox.locator('input')).toHaveValue('');
    await list.expectRow('Lunch?');
    await list.expectRow('You won');
  });

  test('보고 있던 편지함을 다시 골라도 조건은 그대로다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    await shell.open();
    await list.search('Quarterly', 'Subject');

    await shell.selectMailbox('Inbox');

    await expect(list.searchBox.locator('input')).toHaveValue('Quarterly');
    await list.expectNoRow('Lunch?');
  });
});

test.describe('편지함 관리 (사이드바 ⋯ 메뉴)', () => {
  test('편지함을 추가한다', async ({ shell, page, state }) => {
    await shell.open();
    await acceptDialogs(page, 'Reports');

    await shell.mailboxAction('Inbox', 'Add mailbox');

    await expect
      .poll(() => state.calls.filter((call) => call.method === 'POST' && call.path === '/api/mailboxes').length)
      .toBe(1);
    const call = state.calls.findLast((item) => item.path === '/api/mailboxes' && item.method === 'POST');
    expect(call?.body).toMatchObject({ name: 'Reports', parentId: BOX.inbox });
    await expect(shell.mailbox('Reports')).toBeVisible();
  });

  test('기본 편지함은 이름을 바꿀 수 없다', async ({ shell }) => {
    await shell.open();
    const menu = await shell.openMailboxMenu('Inbox');

    await expect(menu.getByRole('button', { name: 'Rename mailbox' })).toBeDisabled();
  });

  test('휴지통 비우기는 완전 삭제라고 먼저 묻는다', async ({ shell, page, state }) => {
    await shell.open();
    const asked = await acceptDialogs(page);

    await shell.mailboxAction('Trash', 'Empty');

    await expect
      .poll(() => state.calls.some((call) => call.path.endsWith('/empty')))
      .toBe(true);
    expect(asked.join(' ')).toContain('permanently');
  });

  test('묻는 말에 취소하면 아무 일도 하지 않는다', async ({ shell, page, state }) => {
    await shell.open();
    // Playwright 는 대화상자를 기본적으로 거절한다 — 별도 처리 없이 그 상황이 된다
    await shell.mailboxAction('Trash', 'Empty');

    await page.waitForTimeout(300);
    expect(state.calls.some((call) => call.path.endsWith('/empty'))).toBe(false);
  });
});
