/**
 * 편지함 만들기 → 메일 옮기기 → 이름 바꾸기 → 지우기 (전 구간).
 *
 * 편지함 쓰기는 모두 James 커스텀 WebAdmin 라우트를 지난다 (gu/mailboxes/*, 4-1).
 * 화면 모킹으로는 "요청을 보냈다" 까지만 알 수 있어서, MODSEQ·카운트가 실제로 맞는지는
 * 여기서만 확인된다.
 *
 * 만든 편지함은 끝에서 지운다. 실패로 중간에 멈추면 다음 실행이 같은 이름을 다시 만들지
 * 않도록 이름에 실행 꼬리표를 붙인다.
 */
import { E2E, expect, requireFullStack, runTag, test } from '../../fixtures/e2e';
import { MailboxPage } from '../../pages/MailboxPage';
import { SettingsPage } from '../../pages/SettingsPage';
import { ShellPage } from '../../pages/ShellPage';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ baseURL }) => {
  await requireFullStack(baseURL);
});

test('편지함을 만들고 이름을 바꾸고 지운다', async ({ page, signIn }) => {
  const name = `${runTag()}-box`;
  const renamed = `${name}-2`;

  const settings = new SettingsPage(page);
  const shell = new ShellPage(page);
  await signIn(E2E.user1);

  // ---------------------------------------------------------------- 만든다
  await settings.goto('mailbox');
  await settings.addMailboxButton.click();
  await settings.newMailboxNameInput.fill(name);
  await settings.modal.getByRole('button', { name: 'Save' }).click();

  await expect(settings.gridRow(name)).toBeVisible({ timeout: 15_000 });
  // 사이드바 트리에도 바로 붙는다
  await expect(shell.mailbox(name)).toBeVisible();

  // ---------------------------------------------------------------- 이름을 바꾼다
  page.once('dialog', (dialog) => void dialog.accept(renamed));
  await settings.mailboxRowAction(name, 'Rename');

  await expect(settings.gridRow(renamed)).toBeVisible({ timeout: 15_000 });

  // ---------------------------------------------------------------- 지운다
  page.once('dialog', (dialog) => void dialog.accept());
  await settings.mailboxRowCheckbox(renamed).check();
  await settings.content.getByRole('button', { name: 'Delete' }).click();

  await expect(settings.grid.locator('tbody tr', { hasText: renamed })).toHaveCount(0, { timeout: 15_000 });
});

test('메일을 새 편지함으로 옮기면 양쪽 통수가 함께 바뀐다', async ({ page, signIn }) => {
  const name = `${runTag()}-move`;

  const shell = new ShellPage(page);
  const list = new MailboxPage(page);
  const settings = new SettingsPage(page);
  await signIn(E2E.user1);

  // 옮길 메일이 하나라도 있어야 한다. 없으면 이 스펙은 의미가 없으니 건너뛴다
  await expect(list.title).toHaveText('Inbox');
  const hasMail = (await list.rows.count()) > 0;
  test.skip(!hasMail, '받은 편지함이 비어 있다. send-receive 스펙을 먼저 돌리면 메일이 생긴다');

  const subject = (await list.rows.first().locator('.row-subject').textContent())?.trim() ?? '';

  // 대상 편지함을 만든다
  await settings.goto('mailbox');
  await settings.addMailboxButton.click();
  await settings.newMailboxNameInput.fill(name);
  await settings.modal.getByRole('button', { name: 'Save' }).click();
  await expect(settings.gridRow(name)).toBeVisible({ timeout: 15_000 });

  // 옮긴다
  await shell.selectMailbox('Inbox');
  await list.rows.first().locator('input[type="checkbox"]').check();
  await list.bulkAction('Move');
  await list.pickMailbox(name);

  // 새 편지함에서 보인다
  await shell.selectMailbox(name);
  await expect(list.rows.filter({ hasText: subject.slice(0, 20) })).toHaveCount(1, { timeout: 20_000 });

  // 되돌려 놓고 편지함을 치운다
  await list.rows.first().locator('input[type="checkbox"]').check();
  await list.bulkAction('Move');
  await list.pickMailbox('Inbox');

  await settings.goto('mailbox');
  page.once('dialog', (dialog) => void dialog.accept());
  await settings.mailboxRowCheckbox(name).check();
  await settings.content.getByRole('button', { name: 'Delete' }).click();
  await expect(settings.grid.locator('tbody tr', { hasText: name })).toHaveCount(0, { timeout: 15_000 });
});
