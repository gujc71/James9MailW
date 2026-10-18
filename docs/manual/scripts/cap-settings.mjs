// 5장 개인환경설정 · 관리자 매뉴얼 캡처 — 저장 버튼은 누르지 않는다
import { open, go, mark, shot, step, closeModals, t } from './lib.mjs';

const lastModal = (page) => page.locator('.modal').last();

async function modalShot(page, name, opener) {
  await step(name, async () => {
    await opener();
    await page.waitForTimeout(900);
    await shot(page, name, { el: lastModal(page) });
    await closeModals(page);
    await page.waitForTimeout(300);
  });
}

// ---------------------------------------------------------------- 개인환경설정 (user1)
{
  const { browser, page } = await open('user1');
  page.on('dialog', (d) => d.dismiss());
  const btn = (key) => page.locator('.settings-content button', { hasText: t(key) }).first();

  await step('settings-entry', async () => {
    await mark(page, [[page.locator(`button.gear[aria-label="${t('app.settings')}"]`), 1, 'b']]);
    await shot(page, '05-settings-entry', { el: page.locator('header.topbar'), pad: 14 });
  });

  await go(page, '#/settings/profile', 1800);
  await step('profile', async () => {
    await mark(page, [[page.locator('.settings-tabs'), 1], [page.locator('.settings-content'), 2]]);
    await shot(page, '05-profile');
  });
  await modalShot(page, '05-password', () => page.locator('.settings-content button.link', { hasText: t('profile.changePasswordTitle') }).click());

  await go(page, '#/settings/signature');
  await step('signature', () => shot(page, '05-signature'));
  await modalShot(page, '05-signature-editor', () => btn('signature.add').click());

  await go(page, '#/settings/addressbook', 2000);
  await step('addressbook', () => shot(page, '05-addressbook'));
  await modalShot(page, '05-contact-editor', () => btn('addressbook.newContact').click());
  await modalShot(page, '05-group-editor', () => btn('addressbook.newGroup').click());
  await modalShot(page, '05-addressbook-import', () => btn('addressbook.import').click());
  await step('carddav', async () => {
    const use = page.locator('[data-testid="carddav-use"]');
    const was = await use.isChecked();
    if (!was) await use.check(); else await page.locator('[data-testid="carddav-guide-open"]').click();
    await page.waitForTimeout(1200);
    await shot(page, '05-carddav-guide', { el: lastModal(page) });
    await closeModals(page);
    if (!was) { await use.uncheck(); await page.waitForTimeout(800); }
  });

  await go(page, '#/settings/mailbox');
  await step('mailbox', () => shot(page, '05-mailbox'));
  await modalShot(page, '05-mailbox-add', () => btn('common.add').click());
  await step('mailbox-menu', async () => {
    await page.locator('.settings-content .menu button.tb').first().click();
    await page.waitForTimeout(300);
    await shot(page, '05-mailbox-menu');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 30);
  });

  await go(page, '#/settings/filter');
  await step('filter', () => shot(page, '05-filter'));
  await modalShot(page, '05-filter-editor', () => btn('filter.add').click());

  await go(page, '#/settings/vacation');
  await step('vacation', async () => {
    const use = page.locator('.settings-content label.checkbox', { hasText: t('common.use') }).first().locator('input');
    const was = await use.isChecked();
    if (!was) await use.check();
    await page.waitForTimeout(800);
    await shot(page, '05-vacation');
    if (!was) await use.uncheck();
  });

  await go(page, '#/settings/reject');
  await step('reject', () => shot(page, '05-reject'));
  await modalShot(page, '05-reject-editor', () => btn('reject.add').click());

  await go(page, '#/settings/forward');
  await step('forward', () => shot(page, '05-forward'));
  await modalShot(page, '05-forward-editor', () => btn('forward.add').click());

  await go(page, '#/settings/external');
  await step('external', () => shot(page, '05-external'));
  await modalShot(page, '05-external-editor', () => btn('common.add').click());

  await go(page, '#/settings/upload');
  await step('upload', () => shot(page, '05-upload'));
  await modalShot(page, '05-upload-dialog', () => btn('common.add').click());

  await browser.close();
}

// ---------------------------------------------------------------- 관리자 (admin)
{
  const { browser, page } = await open('admin');
  page.on('dialog', (d) => d.dismiss());
  const btn = (key) => page.locator('.settings-content button', { hasText: t(key) }).first();

  await step('admin-entry', async () => {
    await mark(page, [[page.locator('.top-actions button.link', { hasText: t('app.admin') }), 1, 'b']]);
    await shot(page, 'A-entry', { el: page.locator('header.topbar'), pad: 14 });
  });

  await go(page, '#/admin/overview', 2500);
  await step('overview', async () => {
    await mark(page, [
      [page.locator('nav.settings-nav'), 1],
      [page.locator('.stat-cards'), 2],
    ]);
    await shot(page, 'A-overview');
  });

  await go(page, '#/admin/site', 2000);
  await step('site', () => shot(page, 'A-site'));

  await go(page, '#/admin/users', 2000);
  await step('users', () => shot(page, 'A-users'));
  await modalShot(page, 'A-user-add', () => btn('admin.addUserTitle').click());
  await step('user-menu', async () => {
    const row = page.locator('.settings-content tbody tr', { hasText: 'user2@example.com' }).first();
    await row.locator('.menu button.tb').click();
    await page.waitForTimeout(300);
    await shot(page, 'A-user-menu');
    await page.locator('ul.menu-list button', { hasText: t('admin.changeQuota') }).click();
    await page.waitForTimeout(800);
    await shot(page, 'A-quota', { el: lastModal(page) });
    await closeModals(page);
  });
  await modalShot(page, 'A-user-edit', () =>
    page.locator('.settings-content tbody tr', { hasText: 'user2@example.com' }).first().locator('td').first().click());

  await go(page, '#/admin/aliases', 2000);
  await step('aliases', () => shot(page, 'A-aliases'));
  await modalShot(page, 'A-alias-add', () => btn('admin.addAlias').click());

  await go(page, '#/admin/mails', 2500);
  await step('mails', () => shot(page, 'A-mails'));
  await modalShot(page, 'A-mail-view', () => page.locator('.settings-content tbody tr').first().locator('button, a', { hasText: t('admin.viewMail') }).last().click());

  await go(page, '#/admin/droplist', 2000);
  await step('droplist', () => shot(page, 'A-droplist'));
  await modalShot(page, 'A-drop-add', () => btn('common.add').click());

  await browser.close();
}
