// 3장 메일 쓰기와 발송 (수신 확인 포함) 캡처 — 실제 발송은 하지 않는다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, mark, shot, step, closeModals, mailbox, t, exact, D } from './lib.mjs';

const { browser, page } = await open('user1');
let dialogAction = 'dismiss';
page.on('dialog', (d) => (dialogAction === 'accept' ? d.accept() : d.dismiss()));

const compose = page.locator('.modal.compose');
const field = (key) => compose.locator('.field', { has: page.locator(`span:text-is("${t(key)}")`) });
const modalTitled = (key) => page.locator('.modal').filter({ has: page.locator('h3', { hasText: t(key) }) });
const SAMPLE = path.join(os.tmpdir(), 'sample-report.pdf');
fs.writeFileSync(SAMPLE, '%PDF-1.4\n% sample\n');

async function openCompose() {
  await page.locator('button.fab').click();
  await page.waitForTimeout(1200);
}
async function closeCompose() {
  dialogAction = 'accept';
  await compose.locator('.modal-actions button', { hasText: t('common.cancel') }).click().catch(() => {});
  await page.waitForTimeout(500);
  dialogAction = 'dismiss';
}

await step('compose-empty', async () => {
  await openCompose();
  await mark(page, [
    [field('compose.from'), 1],
    [field('compose.to'), 2],
    [compose.locator('button.field-add'), 3, 'r'],
    [field('common.subject'), 4],
    [compose.locator('.attach-bar'), 5],
    [compose.locator('.lx-bar'), 6],
    [compose.locator('.compose-options'), 7],
    [compose.locator('.modal-actions'), 8],
  ]);
  await shot(page, '03-compose');
});

await step('recipients', async () => {
  const to = field('compose.to').locator('input.chip-input');
  await to.fill('user2@example.com');
  await to.press('Enter');
  await to.fill('wrong-address');
  await to.press('Enter');
  await to.pressSequentially(D.suggestTyping, { delay: 80 });
  await page.waitForTimeout(1200);
  await shot(page, '03-recipients', { el: field('compose.to').locator('..'), pad: 4 });
  await page.keyboard.press('Escape');
  await to.fill('');
});

await step('ccbcc', async () => {
  await compose.locator('button.field-add').click();
  await page.waitForTimeout(300);
  const cc = field('compose.cc').locator('input.chip-input');
  await cc.fill('admin@example.com');
  await cc.press('Enter');
  await field('common.subject').locator('input').fill(D.compose.subject);
  await shot(page, '03-ccbcc', { el: compose, pad: 0 });
});

await step('recent', async () => {
  await compose.locator(`button.tb[title="${t('compose.recentAddresses')}"]`).first().click();
  await page.waitForTimeout(400);
  await shot(page, '03-recent');
  await page.keyboard.press('Escape');
  await compose.locator('.modal-head h3').click();
});

await step('addressbook', async () => {
  await field('compose.to').locator('button.tb', { hasText: t('compose.addressBook') }).click();
  await page.waitForTimeout(1200);
  const ab = modalTitled('addressbook.title');
  await ab.locator('tbody input[type=checkbox]').first().check().catch(() => {});
  await shot(page, '03-addressbook', { el: ab });
  await ab.locator('.modal-actions button', { hasText: t('common.close') }).click();
});

await step('attach', async () => {
  await compose.locator('.attach-bar input[type=file]').setInputFiles([SAMPLE]);
  await page.waitForTimeout(800);
  const toggle = compose.locator(`button.tb[title="${t('compose.toggleAttachList')}"]`);
  if (!(await compose.locator('.attach-panel').isVisible().catch(() => false))) await toggle.click();
  await page.waitForTimeout(400);
  await mark(page, [
    [compose.locator('.attach-bar label.btn'), 1, 'b'],
    [compose.locator('.attach-bar button.tb', { hasText: t('compose.convertAllLarge') }), 2, 'b'],
    [compose.locator('.attach-usage'), 3],
    [compose.locator('.attach-list button', { hasText: t('compose.convert') }), 4, 'r'],
  ]);
  await shot(page, '03-attach', { el: compose.locator('.attach-bar, .attach-panel').first().locator('..'), pad: 4 });
});

await step('editor', async () => {
  await compose.locator('.lx-input').click();
  for (const [i, line] of D.compose.body.entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  await page.waitForTimeout(300);
  await shot(page, '03-editor', { el: compose.locator('.lx-shell'), pad: 4 });
  await compose.locator('.lx-bar button.lx-color').first().click();
  await page.waitForTimeout(300);
  await shot(page, '03-editor-color', { el: compose.locator('.lx-shell'), pad: 4 });
  await page.keyboard.press('Escape');
});

await step('options', async () => {
  await compose.locator('.compose-options label.checkbox', { hasText: t('compose.readReceipt') }).click();
  await shot(page, '03-options', { el: compose.locator('.compose-options'), pad: 8 });
});

await step('appointment', async () => {
  await compose.locator(`button.tb[title="${t('appointment.title')}"]`).click();
  await page.waitForTimeout(500);
  const dlg = modalTitled('appointment.title');
  await dlg.locator('input').nth(2).fill(D.compose.apptLocation).catch(() => {});
  await dlg.locator('textarea').fill(D.compose.apptDescription).catch(() => {});
  await shot(page, '03-appointment', { el: dlg });
  await dlg.locator('.modal-actions button', { hasText: t('common.confirm') }).click();
  await page.waitForTimeout(400);
  await shot(page, '03-appointment-line', { el: compose.locator('.appointment-line'), pad: 8 });
});

await step('preview', async () => {
  await compose.locator('.modal-actions button', { hasText: t('compose.preview') }).click();
  await page.waitForTimeout(1200);
  await shot(page, '03-preview', { el: page.locator('.modal').last() });
  await page.locator('.modal').last().locator('.modal-actions button', { hasText: t('common.close') }).click();
});

await step('autosave', async () => {
  await page.waitForTimeout(6500);
  await shot(page, '03-autosave', { el: compose.locator('.modal-actions'), pad: 6 });
  await closeCompose();
  await openCompose();
  await shot(page, '03-restore', { el: compose.locator('.restore-bar'), pad: 6 });
  // 복원본 삭제
  await compose.locator('.restore-bar button.link.danger').click().catch(() => {});
  await closeCompose();
});

await step('reply', async () => {
  await page.locator('.list .row', { hasText: D.q3.key }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.reading-toolbar button', { hasText: exact('read.reply') }).click();
  await page.waitForTimeout(1500);
  await shot(page, '03-reply');
  await closeCompose();
});

await step('accept-appointment', async () => {
  await page.locator('.list .row', { hasText: D.review.key }).first().click();
  await page.waitForTimeout(2000);
  // 다시 돌릴 때는 이미 응답해서 버튼이 없다. 응답한 뒤의 모습만 찍는다
  const accept = page.locator('.calendar-box .cal-actions button', { hasText: t('read.accept') });
  if (await accept.count()) await accept.click();
  await page.waitForTimeout(1500);
  await shot(page, '02-appointment-done', { el: page.locator('.calendar-box'), pad: 10 });
});

await step('receipts', async () => {
  await mailbox(page, 'Sent').click();
  await page.waitForTimeout(1500);
  // 보낸 편지함에는 원래 메일과 답장(Re:)이 함께 있다. 가장 오래된(맨 아래) 원래 메일을 연다
  await page.locator('.list .row', { hasText: D.kickoff.key }).last().click();
  await page.waitForTimeout(2000);
  await mark(page, [[page.locator('button.att-open'), 1]]);
  await shot(page, '03-receipts-button');
  await page.locator('button.att-open').click();
  await page.waitForTimeout(1200);
  await shot(page, '03-receipts', { el: page.locator('.modal') });
  await closeModals(page);
});

await browser.close();

// user2 가 보낸 약속메일의 수신확인 (응답 열)
const s2 = await open('user2');
await step('receipts-appointment', async () => {
  const p = s2.page;
  await mailbox(p, 'Sent').click();
  await p.waitForTimeout(1500);
  await p.locator('.list .row', { hasText: D.review.key }).first().click();
  await p.waitForTimeout(2000);
  await p.locator('button.att-open').click();
  await p.waitForTimeout(1200);
  await shot(p, '03-receipts-appointment', { el: p.locator('.modal') });
});
await s2.browser.close();
