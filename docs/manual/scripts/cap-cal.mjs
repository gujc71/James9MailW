// 4장 캘린더와 태스크 캡처
import { open, go, mark, shot, step, closeModals, t, exact, D } from './lib.mjs';

const { browser, page } = await open('user1');
page.on('dialog', (d) => d.dismiss());
const tb = (key) => page.locator('.cal-toolbar button.tb', { hasText: t(key) }).first();
const view = (key) => page.locator('.cal-views button', { hasText: exact(key) });
const newEvent = page.locator('button.cal-new', { hasText: t('cal.newEvent') });
const dlg = page.locator('.cal-item-dialog');

await go(page, '#/calendar', 2500);

await step('week-view', async () => {
  await view('cal.view.week').click();
  await page.waitForTimeout(1200);
});

await step('create-event', async () => {
  // 다시 돌릴 때 같은 일정이 쌓이지 않도록, 이미 있으면 창만 찍고 취소한다
  const exists = (await page.getByText(D.calendar.event).count()) > 0;
  await newEvent.click();
  await page.waitForTimeout(800);
  await dlg.locator('input').first().fill(D.calendar.event);
  await dlg.locator('input').nth(1).fill(D.calendar.location);
  await dlg.locator('.cal-repeat-row select').first().selectOption({ label: t('cal.repeat.weekly') }).catch((e) => console.warn(' repeat', e.message));
  await page.waitForTimeout(400);
  await mark(page, [
    [dlg.locator('input').first(), 1],
    [dlg.locator('.cal-date-range'), 2],
    [dlg.locator('.cal-repeat-row'), 3],
    [dlg.locator('.cal-chips').first(), 4],
    [dlg.locator('.cal-dlg-tabs'), 5],
  ]);
  await shot(page, '04-item-dialog', { el: dlg });
  await dlg.locator('.cal-dlg-tabs .tab-btn', { hasText: t('cal.f.attendees') }).click();
  await page.waitForTimeout(300);
  await shot(page, '04-attendees', { el: dlg });
  if (exists) await dlg.locator('button', { hasText: t('common.cancel') }).last().click();
  else await dlg.locator('button.primary', { hasText: t('cal.dlg.saveClose') }).click();
  await page.waitForTimeout(1500);
});

await step('recurrence', async () => {
  await newEvent.click();
  await page.waitForTimeout(800);
  await dlg.locator('.cal-repeat-row select').first().selectOption({ label: t('cal.repeat.custom') });
  await page.waitForTimeout(800);
  await shot(page, '04-recurrence', { el: page.locator('.modal').last() });
  await closeModals(page);
});

await step('calendar-main', async () => {
  await page.locator('.cal-tg-col, .cal-month').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await mark(page, [
    [page.locator('.cal-toolbar'), 1],
    [page.locator('button.cal-new').first(), 2],
    [page.locator('.cal-mini'), 3],
    [page.locator('.cal-list'), 4],
    [page.locator('.cal-viewbar'), 5],
    [page.locator('.cal-views'), 6, 'b'],
  ]);
  await shot(page, '04-calendar');
});

await step('day-view', async () => {
  await view('cal.view.day').click();
  await page.waitForTimeout(800);
  await shot(page, '04-day');
});

await step('month-view', async () => {
  await view('cal.view.month').click();
  await page.waitForTimeout(1200);
  await shot(page, '04-month');
});

await step('context', async () => {
  const chip = page.locator('.cal-chip', { hasText: D.review.key }).first();
  await chip.click({ button: 'right' });
  await page.waitForTimeout(400);
  await shot(page, '04-context-menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 30);
});

await step('view-options', async () => {
  await page.locator(`.cal-viewbar button[title="${t('cal.viewOptions')}"]`).click();
  await page.waitForTimeout(300);
  await shot(page, '04-view-options', { el: page.locator('.cal-main, .cal-body').first(), pad: 0 });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 30);
});

await step('today-pane', async () => {
  await view('cal.view.week').click();
  await page.waitForTimeout(600);
  const btn = tb('cal.todayPane');
  const on = await btn.evaluate((n) => n.classList.contains('active'));
  if (!on) await btn.click();
  await page.waitForTimeout(800);
  await mark(page, [[page.locator('aside.cal-today'), 1]]);
  await shot(page, '04-today-pane');
  if (!on) await btn.click();
});

await step('tasks', async () => {
  await page.locator('.cal-tabs button', { hasText: t('cal.tasks') }).click();
  await page.waitForTimeout(1200);
  const quick = page.locator('.cal-tasks input.cal-quick');
  if ((await page.locator('.cal-tasks-table tbody tr').count()) < 3) for (const task of D.calendar.tasks) {
    await quick.fill(task);
    await quick.press('Enter');
    await page.waitForTimeout(700);
  }
  await page.locator('.cal-tasks-table tbody tr').nth(1).click();
  await page.waitForTimeout(500);
  await mark(page, [
    [page.locator('.cal-task-filters'), 1],
    [quick, 2],
    [page.locator('.cal-tasks-table'), 3],
    [page.locator('.cal-task-detail'), 4],
  ]);
  await shot(page, '04-tasks');
  await page.locator('.cal-tabs button', { hasText: t('cal.calendar') }).click();
  await page.waitForTimeout(800);
});

await step('new-calendar', async () => {
  await page.locator(`.cal-list .cal-icon-btn[title="${t('cal.newCalendar')}"]`).click();
  await page.waitForTimeout(600);
  await shot(page, '04-new-calendar', { el: page.locator('.modal').last() });
  await closeModals(page);
});

await step('cal-list-menu', async () => {
  await page.locator('.cal-list .cal-list-name').first().click({ button: 'right' });
  await page.waitForTimeout(300);
  await shot(page, '04-calendar-menu', { el: page.locator('aside.cal-side'), pad: 0 });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 30);
});

await step('settings', async () => {
  await tb('cal.settings').click();
  await page.waitForTimeout(800);
  const m = page.locator('.modal').last();
  await shot(page, '04-settings', { el: m });
  for (const tab of [t('cal.set.tab.view'), t('cal.set.tab.alarm'), t('cal.set.tab.category')]) {
    await m.locator('.cal-dlg-tabs button', { hasText: tab }).click();
    await page.waitForTimeout(300);
  }
  await m.locator('.cal-dlg-tabs button', { hasText: t('cal.set.tab.view') }).click();
  await page.waitForTimeout(300);
  await shot(page, '04-settings-view', { el: m });
  await m.locator('.cal-dlg-tabs button', { hasText: t('cal.set.tab.general') }).click();
  await page.waitForTimeout(300);
  const use = page.locator('[data-testid="caldav-use"]');
  const was = await use.isChecked();
  if (!was) await use.check();
  else await page.locator('[data-testid="caldav-guide-open"]').click();
  await page.waitForTimeout(1200);
  await shot(page, '04-caldav-guide', { el: page.locator('.modal').last() });
  await page.locator('.modal').last().locator('.modal-actions button', { hasText: t('common.close') }).click().catch(() => page.keyboard.press('Escape'));
  await page.waitForTimeout(500);
  await mark(page, [[page.locator('.cal-caldav'), 1]]);
  await shot(page, '04-caldav', { el: m });
  if (!was) await use.uncheck();
  await page.waitForTimeout(500);
  await closeModals(page);
});

await browser.close();
