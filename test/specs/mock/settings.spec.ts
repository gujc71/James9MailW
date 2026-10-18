/**
 * 사용자 설정 9탭 (settings/Settings.tsx 와 tabs/*).
 *
 * 먼저 9탭 전부가 열리는지를 한 번에 훑고(회귀에 제일 값싸게 걸린다), 그다음 탭마다
 * 저장·검증처럼 값이 오가는 자리를 따로 본다.
 */
import { acceptDialogs, expect, test } from '../../fixtures';
import { BOX, makeSignature, type UploadHistory } from '../../fixtures/factories';
import { SettingsPage, TAB_LABEL, TAB_ORDER } from '../../pages/SettingsPage';

test.describe('탭 전수 점검', () => {
  for (const tab of TAB_ORDER) {
    test(`${tab} 탭이 주소로 바로 열린다`, async ({ page, shell, pageErrors }) => {
      const settings = new SettingsPage(page);
      await settings.goto(tab);

      await expect(settings.heading).toHaveText(TAB_LABEL[tab]);
      await expect(settings.tabButton(tab)).toHaveClass(/active/);
      // 사이드바(편지함)는 설정 화면에서도 그대로 있다
      await expect(shell.sidebar).toBeVisible();
      expect(pageErrors).toEqual([]);
    });
  }

  test('탭을 눌러 이동하면 주소도 따라 바뀐다', async ({ page, shell }) => {
    const settings = new SettingsPage(page);
    await shell.open('settings');

    await settings.clickTab('vacation');

    expect(await shell.hash()).toBe('#/settings/vacation');
  });
});

test.describe('개인정보', () => {
  test('아이디는 고칠 수 없고 이름은 저장된다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('profile');

    await expect(settings.userIdInput).toHaveValue('user1@example.com');
    await expect(settings.userIdInput).toHaveAttribute('readonly', '');

    await settings.displayNameInput.fill('바뀐 이름');
    await settings.saveButton.click();

    await expect.poll(() => state.calls.some((call) => call.path === '/api/me/profile')).toBe(true);
    expect(state.calls.findLast((call) => call.path === '/api/me/profile')?.body).toMatchObject({
      displayName: '바뀐 이름',
    });
    await expect(settings.infoMessage).toBeVisible();
  });

  test('새 비밀번호가 서로 다르면 보내지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('profile');
    await settings.changePasswordLink.click();

    await settings.passwordField('Current password').fill('TEST1234');
    await settings.passwordField('New password').fill('abcd!@#$');
    await settings.passwordField('Confirm new password').fill('abcd!@#5');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.passwordModalError).toContainText('do not match');
    expect(state.calls.some((call) => call.path === '/api/me/password')).toBe(false);
  });

  test('비밀번호 정책(길이·특수문자)에 걸리면 보내지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('profile');
    await settings.changePasswordLink.click();

    await settings.passwordField('Current password').fill('TEST1234');
    await settings.passwordField('New password').fill('short1');
    await settings.passwordField('Confirm new password').fill('short1');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    // site.passwordMinLen 8 · passwordMinSpec 2 (factories.DEFAULT_SITE)
    await expect(settings.passwordModalError).toContainText('at least 8 characters');
    expect(state.calls.some((call) => call.path === '/api/me/password')).toBe(false);
  });

  test('정책을 지키면 서버로 보낸다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await acceptDialogs(page);
    await settings.goto('profile');
    await settings.changePasswordLink.click();

    await settings.passwordField('Current password').fill('TEST1234');
    await settings.passwordField('New password').fill('newPass!@');
    await settings.passwordField('Confirm new password').fill('newPass!@');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.calls.some((call) => call.path === '/api/me/password')).toBe(true);
  });

  test('로그아웃 시 캐시 삭제 여부는 이 브라우저에 계정별로 남는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('profile');
    const box = page.getByTestId('clear-cache-on-logout');

    // 기본은 남겨 둔다(빠르게 열기). 공용 PC 안내 문구가 함께 보인다
    await expect(box).not.toBeChecked();
    await expect(page.getByText('shared or public PC')).toBeVisible();

    await box.check();
    await expect(settings.infoMessage).toBeVisible();
    const key = 'j9-clear-cache-on-logout:user1@example.com';
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe('1');
    // 기기 설정이라 서버로 보내지 않는다
    expect(state.calls.some((call) => call.path.startsWith('/api/me/setting'))).toBe(false);

    await page.reload();
    await expect(page.getByTestId('clear-cache-on-logout')).toBeChecked();

    await page.getByTestId('clear-cache-on-logout').uncheck();
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
  });
});

test.describe('편지함 관리', () => {
  test('기본 편지함과 개인 편지함이 표에 모두 나온다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('mailbox');

    await expect(settings.gridRow('Inbox')).toBeVisible();
    await expect(settings.gridRow('Project')).toBeVisible();
    // 기본 편지함은 고를 수 없어 지워지지 않는다
    await expect(settings.mailboxRowCheckbox('Inbox')).toBeDisabled();
    await expect(settings.mailboxRowCheckbox('Project')).toBeEnabled();
  });

  test('편지함을 추가한다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('mailbox');

    await settings.addMailboxButton.click();
    await settings.newMailboxNameInput.fill('Archive2026');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.calls.some((call) => call.method === 'POST' && call.path === '/api/mailboxes')).toBe(true);
    expect(state.calls.findLast((call) => call.path === '/api/mailboxes' && call.method === 'POST')?.body).toMatchObject({
      name: 'Archive2026',
      parentId: null,
    });
  });

  test('개인 편지함을 골라 지운다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await acceptDialogs(page);
    await settings.goto('mailbox');

    await settings.mailboxRowCheckbox('Project').check();
    await settings.content.getByRole('button', { name: 'Delete' }).click();

    await expect
      .poll(() => state.calls.some((call) => call.method === 'DELETE' && call.path === `/api/mailboxes/${BOX.project}`))
      .toBe(true);
  });

  test('편지함 이름을 바꾼다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await acceptDialogs(page, 'Project2');
    await settings.goto('mailbox');

    await settings.mailboxRowAction('Project', 'Rename');

    await expect
      .poll(() => state.calls.some((call) => call.method === 'PUT' && call.path === `/api/mailboxes/${BOX.project}`))
      .toBe(true);
    expect(state.calls.findLast((call) => call.method === 'PUT')?.body).toMatchObject({ name: 'Project2' });
  });
});

test.describe('서명', () => {
  test('서명이 없으면 비었다고 알린다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('signature');

    await expect(settings.content).toContainText('No signatures yet.');
  });

  test('서명을 추가한다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('signature');

    await settings.addSignatureButton.click();
    await settings.signatureNameInput.fill('업무용');
    await settings.signatureBodyEditor.click();
    await page.keyboard.type('홍길동 / 개발팀');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.signatures.length).toBe(1);
    expect(state.signatures[0]).toMatchObject({ name: '업무용' });
    await expect(settings.gridRow('업무용')).toBeVisible();
  });

  test('이름 없이 저장하면 막는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('signature');

    await settings.addSignatureButton.click();
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toContainText('Enter a name for the signature');
    expect(state.signatures).toHaveLength(0);
  });

  test('기본 서명을 고르면 저장된다', async ({ page, state }) => {
    state.signatures = [makeSignature({ isDefault: false }), makeSignature({ signatureId: 2, name: 'Short', isDefault: false })];
    const settings = new SettingsPage(page);
    await settings.goto('signature');

    await settings.defaultSignatureSelect.selectOption({ label: 'Short' });
    await settings.saveButton.click();

    await expect.poll(() => state.signatures.find((row) => row.isDefault)?.name).toBe('Short');
  });

  test('서명을 지운다', async ({ page, state }) => {
    state.signatures = [makeSignature({ name: '지울 서명' })];
    const settings = new SettingsPage(page);
    await acceptDialogs(page);
    const settingsPage = settings;
    await settingsPage.goto('signature');

    await settingsPage.gridRow('지울 서명').getByRole('button', { name: 'Delete' }).click();

    await expect.poll(() => state.signatures.length).toBe(0);
  });
});

test.describe('부재중 응답', () => {
  test('켜면 기간·제목·본문 칸이 나온다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('vacation');

    await expect(settings.vacationSubjectInput).toHaveCount(0);
    await settings.vacationUseCheckbox.check();

    await expect(settings.vacationSubjectInput).toBeVisible();
    await expect(settings.content.locator('input[type="date"]')).toHaveCount(2);
  });

  test('저장하면 규칙 모델에 부재중이 실린다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('vacation');

    await settings.vacationUseCheckbox.check();
    await settings.vacationSubjectInput.fill('휴가 중입니다');
    await settings.content.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.rules.vacation?.subject).toBe('휴가 중입니다');
    expect(state.rules.vacation?.enabled).toBe(true);
  });
});

test.describe('메일 업로드', () => {
  test('이력이 없으면 비었다고 알린다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('upload');

    await expect(settings.content).toContainText('No upload history.');
  });

  test('이력이 표로 나온다', async ({ page, state }) => {
    const history: UploadHistory = {
      uploadId: 1,
      mailboxName: 'INBOX',
      fileCount: 3,
      doneCount: 3,
      runStatus: 'DONE',
      runDate: '2026-09-26T01:00:00.000Z',
    };
    state.uploads = [history];

    const settings = new SettingsPage(page);
    await settings.goto('upload');

    await expect(settings.gridRow('INBOX')).toContainText('3');
    await expect(settings.gridRow('INBOX')).toContainText('DONE');
  });

  test('.eml 을 골라 편지함을 지정하면 실행할 수 있다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('upload');

    await settings.uploadAddButton.click();
    await settings.uploadFileInput.setInputFiles({
      name: 'saved.eml',
      mimeType: 'message/rfc822',
      buffer: Buffer.from('From: a@b\r\nSubject: saved\r\n\r\nbody'),
    });
    // 편지함을 고르기 전에는 실행할 수 없다
    await expect(settings.uploadRunButton).toBeDisabled();

    await settings.modal.locator('button.tb.icon').click();
    const picker = page.locator('.modal-backdrop .modal').last();
    await picker.locator('ul.picker-list button', { hasText: 'Inbox' }).first().click();
    await picker.getByRole('button', { name: 'Select' }).click();

    await expect(settings.uploadRunButton).toBeEnabled();
    await settings.uploadRunButton.click();

    await expect.poll(() => state.calls.some((call) => call.path === '/api/messages/upload')).toBe(true);
  });
});

test.describe('외부메일', () => {
  test('계정이 없으면 비었다고 알린다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('external');

    await expect(settings.content).toContainText('No external mail accounts yet.');
  });

  test('필수 항목을 비우면 저장하지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('external');

    await settings.addExternalButton.click();
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toBeVisible();
    expect(state.external).toHaveLength(0);
  });
});
