// 1장 시작하기 · 2장 메일 읽기와 관리 캡처
import { open, mark, shot, step, closeModals, PASSWORD, t, exact, D } from './lib.mjs';

const { browser, page } = await open(null);

await step('login', async () => {
  await page.locator('input[autocomplete=username]').fill('user1@example.com');
  await page.locator('input[type=password]').fill(PASSWORD);
  await mark(page, [
    [page.locator('.locale-tabs'), 1],
    [page.locator('input[autocomplete=username]'), 2],
    [page.locator('input[type=password]'), 3],
    [page.locator('.login-card label.checkbox'), 4],
    [page.locator('.login-card button[type=submit]'), 5],
  ]);
  await shot(page, '01-login', { el: page.locator('.login-card'), pad: 30 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
});

const row = (subject) => page.locator('.list .row', { hasText: subject }).first();
const inbox = page.locator('ul.tree button.mbox').first();
const sortBtn = page.locator(`.list-header button.tb[title="${t('list.sort')}"]`);
const listTb = (key) => page.locator('.list-header button.tb', { hasText: t(key) });
const menuItem = (key) => page.locator('ul.menu-list button', { hasText: t(key) }).first();

await step('layout', async () => {
  await mark(page, [
    [page.locator('header.topbar'), 1],
    [page.locator('aside.sidebar nav'), 2],
    [page.locator('.list-header'), 3],
    [page.locator('.read-pane, .reading-area, .read-empty').first(), 4],
    [page.locator('button.fab'), 5],
    [page.locator('.usage'), 6],
  ]);
  await shot(page, '01-layout');
});

await step('topbar', async () => {
  await mark(page, [
    [page.locator('button.burger'), 1],
    [page.locator('button.bell'), 2, 'b'],
    [page.locator('button.gear').nth(0), 3, 'b'],
    [page.locator('button.gear').nth(1), 4, 'b'],
    [page.locator('.top-actions .who, .top-actions .me-photo').first(), 5, 'b'],
    [page.locator('.top-actions button.link', { hasText: t('app.logout') }), 6, 'b'],
  ]);
  await shot(page, '01-topbar', { el: page.locator('header.topbar'), pad: 14 });
});

await step('sidebar-hidden', async () => {
  await page.locator('button.burger').click();
  await page.waitForTimeout(500);
  await shot(page, '01-sidebar-hidden');
  await page.locator('button.burger').click();
  await page.waitForTimeout(400);
});

await step('splitter', async () => {
  await mark(page, [[page.locator('div.splitter'), '↔']]);
  await shot(page, '01-splitter', { el: page.locator('.list, div.splitter').first(), pad: 30 });
});

await step('sidebar', async () => {
  await mark(page, [
    [page.locator('button.mbox.all'), 1],
    [page.locator('ul.tree').first(), 2],
    [inbox.locator('.unseen'), 3, 'r'],
  ]);
  await shot(page, '02-sidebar', { el: page.locator('aside.sidebar nav') });
});

await step('mbox-menu', async () => {
  await page.locator('ul.tree .mbox-row').first().hover();
  await page.locator('ul.tree .mbox-row').first().locator('button.mbox-more').click({ force: true });
  await page.waitForTimeout(300);
  await shot(page, '02-mailbox-menu', { el: page.locator('aside.sidebar, ul.menu-list').first() });
  await closeModals(page);
  await page.mouse.click(1000, 600);
});

await step('list-header', async () => {
  await mark(page, [
    [page.locator('.list-header label.checkbox'), 1, 'b'],
    [page.locator('.filter-wrap > button.tb'), 2, 'b'],
    [sortBtn, 3, 'b'],
    [listTb('list.etc'), 4, 'b'],
    [listTb('list.thisPerson'), 5, 'b'],
  ]);
  await shot(page, '02-list-header', { el: page.locator('.mailbox-header, .list-header').first().locator('..'), pad: 4 });
});

await step('list-row', async () => {
  const r = row(D.q3.key);
  await mark(page, [
    [r.locator('input[type=checkbox]'), 1],
    [r.locator('.avatar'), 2],
    [r.locator('.who'), 3, 'r'],
    [r.locator('button.star'), 4, 'b'],
    [r.locator('.clip'), 5, 'b'],
    [r.locator('.date'), 6, 'r'],
  ]);
  await shot(page, '02-list-row', { el: page.locator('.list'), pad: 4 });
});

await step('filter', async () => {
  await page.locator('.filter-wrap > button.tb').click();
  await page.waitForTimeout(300);
  await shot(page, '02-filter', { el: page.locator('.list').locator('..'), pad: 0 });
  await page.locator('.filter-wrap > button.tb').click();
});

await step('sort', async () => {
  await sortBtn.click();
  await page.waitForTimeout(300);
  await shot(page, '02-sort');
  await page.keyboard.press('Escape');
  await page.mouse.click(1000, 700);
});

await step('more', async () => {
  await row(D.lunch.key).locator('input[type=checkbox]').check();
  await row(D.news.key).locator('input[type=checkbox]').check();
  await listTb('list.etc').click();
  await page.waitForTimeout(300);
  await shot(page, '02-more-menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(1000, 700);
});

await step('picker', async () => {
  await listTb('list.etc').click();
  await menuItem('common.move').click();
  await page.waitForTimeout(500);
  await page.locator('ul.picker-list button').first().click();
  await shot(page, '02-mailbox-picker', { el: page.locator('.modal') });
  await closeModals(page);
  await page.locator('.list-header label.checkbox input').check();
  await page.locator('.list-header label.checkbox input').uncheck();
});

await step('sender-menu', async () => {
  await row(D.q3.key).locator('input[type=checkbox]').check();
  await listTb('list.thisPerson').click();
  await page.waitForTimeout(300);
  await shot(page, '02-sender-menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(1000, 700);
  await row(D.q3.key).locator('input[type=checkbox]').uncheck();
});

await step('thread', async () => {
  await sortBtn.click();
  await menuItem('list.threadView').click();
  await page.waitForTimeout(800);
  await page.mouse.click(1000, 700);
  const toggle = page.locator('.list button.thread-toggle').first();
  await toggle.click().catch(() => {});
  await page.waitForTimeout(500);
  await mark(page, [
    [toggle, 1],
    [page.locator('.list button.thread-count').first(), 2, 'r'],
  ]);
  await shot(page, '02-thread', { el: page.locator('.list'), pad: 4 });
});

await step('conversation', async () => {
  await page.locator('.list button.thread-count').first().click();
  await page.waitForTimeout(1500);
  await shot(page, '02-conversation');
  // 묶기 원복
  await sortBtn.click();
  await menuItem('list.threadView').click();
  await page.waitForTimeout(600);
  await page.mouse.click(1000, 700);
});

await step('search', async () => {
  const s = page.locator('.read-search .search');
  await s.locator('select').selectOption('subject');
  await s.locator('input').fill(D.searchWord);
  await s.locator('input').press('Enter');
  await page.waitForTimeout(1500);
  await mark(page, [[s.locator('select'), 1, 'b'], [s.locator('input'), 2, 'b'], [s.locator('button'), 3, 'b']]);
  await shot(page, '02-search');
  await s.locator('input').fill('');
  await s.locator('input').press('Enter');
  await page.waitForTimeout(1000);
});

const tool = page.locator('.reading-toolbar');

await step('reading', async () => {
  await row(D.q3.key).click();
  await page.waitForTimeout(2500);
  await mark(page, [
    [tool.locator('button', { hasText: exact('read.reply') }), 1, 'b'],
    [tool.locator('button', { hasText: t('read.replyAll') }), 2, 'b'],
    [tool.locator('button', { hasText: t('read.forward') }), 3, 'b'],
    [tool.locator('button', { hasText: exact('common.delete') }), 4, 'b'],
    [tool.locator('button', { hasText: t('common.purge') }), 5, 'b'],
    [tool.locator('button', { hasText: t('list.etc') }), 6, 'b'],
    [page.locator('.mdn-box'), 7],
    [page.locator('.attachments'), 8],
  ]);
  await shot(page, '02-reading');
});

await step('reading-forward', async () => {
  await tool.locator('button', { hasText: t('read.forward') }).click();
  await page.waitForTimeout(300);
  await shot(page, '02-forward-menu', { el: page.locator('.reading'), pad: 0 });
  await page.keyboard.press('Escape');
  await page.mouse.click(1000, 800);
});

await step('reading-etc', async () => {
  await tool.locator('button', { hasText: t('list.etc') }).click();
  await page.waitForTimeout(300);
  await shot(page, '02-reading-etc', { el: page.locator('.reading'), pad: 0 });
  await menuItem('read.viewSource').click();
  await page.waitForTimeout(1500);
  await shot(page, '02-source', { el: page.locator('.modal') });
  await closeModals(page);
});

await step('mdn', async () => {
  await shot(page, '02-mdn', { el: page.locator('.mdn-box') });
});

await step('remote-images', async () => {
  await row(D.news.key).click();
  await page.waitForTimeout(2500);
  await mark(page, [[page.locator('.remote-banner button'), 1]]);
  await shot(page, '02-remote-images', { el: page.locator('.reading'), pad: 0 });
});

await step('appointment', async () => {
  await row(D.review.key).click();
  await page.waitForTimeout(2500);
  await shot(page, '02-appointment', { el: page.locator('.calendar-box'), pad: 10 });
});

await step('drag', async () => {
  await row(D.lunch.key).hover();
  await page.mouse.down();
  await page.mouse.move(120, 270, { steps: 10 });
  await page.waitForTimeout(300);
  await shot(page, '02-drag');
  await page.keyboard.press('Escape');
  await page.mouse.move(800, 700, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(800);
});

await browser.close();
