/**
 * 관리자 6탭 (settings/Admin.tsx).
 *
 * 관리자 화면은 계정·별칭·메일을 실제로 지우는 조작이 모여 있어서, 화면 스펙의 몫은
 * "확인을 받는가 · 검증에 걸리는가 · 무엇을 보내는가" 다.
 */
import { acceptDialogs, expect, test } from '../../fixtures';
import {
  DEFAULT_SITE,
  DEFAULT_THEME,
  makeMe,
  type AdminAlias,
  type AdminMailLog,
  type AdminUser,
  type DropEntry,
} from '../../fixtures/factories';
import { ADMIN_TAB_LABEL, ADMIN_TAB_ORDER, AdminPage } from '../../pages/AdminPage';

const users: AdminUser[] = [
  { userName: 'admin@example.com', displayName: '관리자', status: 'Y', used: 1024, limit: null, unlimited: true, regDate: '2026-01-01' },
  { userName: 'user1@example.com', displayName: 'User One', status: 'Y', used: 2048, limit: 1024 * 1024 * 1024, unlimited: false, regDate: '2026-02-01' },
  { userName: 'user2@example.com', displayName: 'User Two', status: 'N', used: 0, limit: 1024 * 1024 * 1024, unlimited: false, regDate: '2026-03-01' },
];

const aliases: AdminAlias[] = [
  { aliasAddress: 'group1@example.com', aliasName: '그룹1', status: 'Y', regDate: '2026-04-01', targets: ['user1@example.com', 'user2@example.com'] },
];

const mails: AdminMailLog[] = [
  {
    mailId: 'mail-1',
    subject: '월간 보고',
    date: '2026-09-26T01:00:00.000Z',
    from: 'user1@example.com',
    fromDisplay: 'User One',
    to: 'user2@example.com',
    toDisplay: 'User Two',
    mailType: 'II',
    recipientCount: 1,
  },
];

test.beforeEach(async ({ state }) => {
  // 관리자로 로그인된 상태에서 시작한다
  state.me = makeMe({ userName: 'admin@example.com', displayName: '관리자', isAdmin: true });
  state.admin.users = users;
  state.admin.aliases = aliases;
  state.admin.mails = mails;
});

test.describe('탭 전수 점검', () => {
  for (const tab of ADMIN_TAB_ORDER) {
    test(`${tab} 탭이 주소로 바로 열린다`, async ({ page, pageErrors }) => {
      const admin = new AdminPage(page);
      await admin.goto(tab);

      await expect(admin.heading).toHaveText(ADMIN_TAB_LABEL[tab]);
      await expect(admin.tabButton(tab)).toHaveClass(/active/);
      expect(pageErrors).toEqual([]);
    });
  }
});

test.describe('현황', () => {
  test('총계 카드와 차트가 나온다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('overview');

    await expect(admin.statCards.first()).toHaveText('3');
    await expect(admin.content).toContainText('Mail sent in the last 7 days');
    await expect(admin.content.locator('svg')).toHaveCount(2);
  });

  test('날짜를 바꾸면 그 날짜로 시간대별을 다시 받는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('overview');

    await admin.hourlyDateInput.fill('2026-09-20');

    await expect
      .poll(() => state.calls.findLast((call) => call.path === '/api/admin/hourly')?.query.date)
      .toBe('2026-09-20');
  });
});

test.describe('사용자', () => {
  test('계정 목록이 용량·상태와 함께 나온다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await expect(admin.gridRow('user1@example.com')).toContainText('User One');
    await expect(admin.gridRow('admin@example.com')).toContainText('UNLIMIT');
    await expect(admin.gridRow('user2@example.com')).toContainText('Suspended');
  });

  test('검색하면 조건이 서버로 넘어간다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.searchInput.fill('user2');
    await admin.searchButton.click();

    await expect
      .poll(() => state.calls.findLast((call) => call.path === '/api/admin/users')?.query.keyword)
      .toBe('user2');
    await expect(admin.gridRow('user2@example.com')).toBeVisible();
  });

  test('계정이 4자보다 짧으면 등록하지 않는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.addUserButton.click();
    await admin.displayNameField.fill('새 사용자');
    // 계정 칸은 @ 앞부분만 받고 도메인은 옆 선택칸에서 고른다 (Admin.tsx UserAddModal)
    await admin.accountLocalField.fill('abc');
    // 비밀번호 검증이 먼저 걸리므로 채워 두고 계정 길이만 남긴다
    await admin.passwordField.fill('passWord!@');
    await admin.passwordConfirmField.fill('passWord!@');
    await admin.registerButton.click();

    await expect(admin.modalError).toContainText('at least 4 characters');
    expect(state.calls.some((call) => call.method === 'POST' && call.path === '/api/admin/users')).toBe(false);
  });

  test('이미 있는 계정이면 중복확인이 알려 준다', async ({ page, state }) => {
    state.admin.userExists = true;
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.addUserButton.click();
    await admin.accountLocalField.fill('user1');
    await admin.checkDuplicateButton.click();

    await expect(admin.modal).toContainText('already taken');
  });

  test('계정을 등록한다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.addUserButton.click();
    await admin.displayNameField.fill('새 사용자');
    await admin.accountLocalField.fill('newbie');
    await admin.passwordField.fill('passWord!@');
    await admin.passwordConfirmField.fill('passWord!@');
    await admin.registerButton.click();

    await expect.poll(() => state.admin.users.length).toBe(4);
    expect(state.calls.findLast((call) => call.path === '/api/admin/users' && call.method === 'POST')?.body).toMatchObject({
      userName: 'newbie@example.com',
      displayName: '새 사용자',
    });
  });

  test('비밀번호 확인이 다르면 등록하지 않는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.addUserButton.click();
    await admin.displayNameField.fill('새 사용자');
    await admin.accountLocalField.fill('newbie');
    await admin.passwordField.fill('passWord!@');
    await admin.passwordConfirmField.fill('passWord!!');
    await admin.registerButton.click();

    await expect(admin.modalError).toContainText('do not match');
    expect(state.calls.some((call) => call.method === 'POST' && call.path === '/api/admin/users')).toBe(false);
  });

  test('계정을 중지시킨다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.rowAction('user1@example.com', 'Suspended');

    await expect
      .poll(() => state.admin.users.find((user) => user.userName === 'user1@example.com')?.status)
      .toBe('N');
  });

  test('계정 삭제는 메일까지 지운다고 먼저 묻는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    const asked = await acceptDialogs(page);
    await admin.goto('users');

    await admin.rowAction('user2@example.com', 'Delete');

    await expect.poll(() => state.admin.users.some((user) => user.userName === 'user2@example.com')).toBe(false);
    expect(asked.join(' ')).toContain('cannot be restored');
  });

  test('쓰고 있는 용량보다 작은 할당량은 막는다', async ({ page, state }) => {
    state.admin.users = [
      { userName: 'heavy@example.com', displayName: 'Heavy', status: 'Y', used: 500 * 1024 * 1024, limit: 1024 * 1024 * 1024, unlimited: false, regDate: '2026-01-01' },
    ];
    const admin = new AdminPage(page);
    await admin.goto('users');

    await admin.rowAction('heavy@example.com', 'Change quota');
    // 500MB 를 쓰고 있는데 100MB 로 줄이려 한다
    await admin.newQuotaInput.fill('100');
    await admin.modal.getByRole('button', { name: 'Save' }).click();

    await expect(admin.modal.locator('.error')).toContainText('cannot be smaller');
    expect(state.calls.some((call) => call.path.endsWith('/quota'))).toBe(false);
  });
});

test.describe('알리아스', () => {
  test('알리아스와 실제 계정이 함께 나온다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('aliases');

    const row = admin.gridRow('group1@example.com');
    await expect(row).toContainText('그룹1');
    await expect(row).toContainText('user1@example.com');
  });

  test('중복확인을 통과하기 전에는 등록 버튼이 잠겨 있다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('aliases');

    await admin.addAliasButton.click();
    await admin.aliasNameField.fill('그룹2');
    await admin.aliasLocalField.fill('group2');

    await expect(admin.aliasRegisterButton).toBeDisabled();

    await admin.checkDuplicateButton.click();

    await expect(admin.aliasRegisterButton).toBeEnabled();
  });

  test('실제 계정을 고르지 않으면 등록하지 않는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('aliases');

    await admin.addAliasButton.click();
    await admin.aliasNameField.fill('그룹2');
    await admin.aliasLocalField.fill('group2');
    await admin.checkDuplicateButton.click();
    await admin.aliasRegisterButton.click();

    // 중복확인을 통과한 뒤라 안내 자리는 info 클래스로 바뀌어 있다 (Admin.tsx AliasModal)
    await expect(admin.modal).toContainText('at least one real mail account');
    expect(state.admin.aliases).toHaveLength(1);
  });

  test('알리아스를 지울 때 실제 계정은 그대로라고 알린다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    const asked = await acceptDialogs(page);
    await admin.goto('aliases');

    await admin.rowAction('group1@example.com', 'Delete');

    await expect.poll(() => state.admin.aliases.length).toBe(0);
    expect(asked.join(' ')).toContain('real accounts are not affected');
  });
});

test.describe('메일 로그', () => {
  test('발신·수신·종류가 나온다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('mails');

    const row = admin.gridRow('월간 보고');
    await expect(row).toContainText('User One');
    await expect(row).toContainText('Internal');
  });

  test('완전 삭제는 되돌릴 수 없다고 먼저 묻는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    const asked = await acceptDialogs(page);
    await admin.goto('mails');

    await admin.gridRow('월간 보고').locator('input[type="checkbox"]').check();
    await admin.content.getByRole('button', { name: 'Delete' }).click();

    await expect.poll(() => state.admin.mails.length).toBe(0);
    expect(asked.join(' ')).toContain('cannot be undone');
  });
});

test.describe('차단 목록', () => {
  test('비어 있으면 그렇게 알린다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('droplist');

    await expect(admin.content).toContainText('Nothing is blocked yet.');
  });

  test('계정과 도메인을 구분해 보여 준다', async ({ page, state }) => {
    const entries: DropEntry[] = [
      { id: 1, type: 'ADDRESS', entity: 'spam@bad.com' },
      { id: 2, type: 'DOMAIN', entity: 'bad.com' },
    ];
    state.admin.droplist = entries;

    const admin = new AdminPage(page);
    await admin.goto('droplist');

    await expect(admin.gridRow('spam@bad.com')).toContainText('Account');
    // 'bad.com' 은 'spam@bad.com' 행에도 들어 있으므로 칸 값이 정확히 같은 행을 집는다
    await expect(
      admin.grid.locator('tbody tr').filter({ has: page.locator('td:text-is("bad.com")') }),
    ).toContainText('Domain');
  });

  test('차단 대상을 추가한다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('droplist');

    await admin.dropAddButton.click();
    await admin.dropEntityInput.fill('nogood@bad.com');
    await admin.dropSaveButton.click();

    await expect.poll(() => state.admin.droplist.length).toBe(1);
    expect(state.admin.droplist[0]).toMatchObject({ entity: 'nogood@bad.com', type: 'ADDRESS' });
  });
});

test.describe('기본 설정', () => {
  test('사이트 이름을 바꿔 저장한다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.siteNameInput.fill('우리회사 메일');
    await admin.content.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.admin.site.site.siteName).toBe('우리회사 메일');
  });

  test('할당량 칸은 숫자가 아닌 글자를 아예 받지 않는다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.defaultQuotaInput.fill('많이512abc');

    await expect(admin.defaultQuotaInput).toHaveValue('512');
  });

  test('상한을 넘는 할당량은 저장하지 않는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    // 1,048,576 MB(1TB)가 상한이다
    await admin.defaultQuotaInput.fill('2000000');
    await admin.content.getByRole('button', { name: 'Save' }).click();

    // 이 탭은 성공·실패 안내를 같은 자리(.info)에 띄운다
    await expect(admin.infoMessage).toContainText('whole number');
    expect(state.calls.some((call) => call.method === 'PUT' && call.path === '/api/admin/site')).toBe(false);
  });
});

test.describe('기본 설정 > 강조색', () => {
  test('서버가 내려준 색이 화면에 칠해진다', async ({ page, state }) => {
    const theme = { ...DEFAULT_THEME, accent: '#0f766e' };
    state.admin.site.site.theme = theme;
    // /api/me 로도 같은 색이 와야 한다 — 부팅 때 여기서 한 번 칠한다 (App.tsx)
    state.me = makeMe({
      userName: 'admin@example.com',
      displayName: '관리자',
      isAdmin: true,
      site: { ...DEFAULT_SITE, theme },
    });

    const admin = new AdminPage(page);
    await admin.goto('site');

    // 미리보기 버튼뿐 아니라 화면 전체가 --accent 를 쓴다
    await expect(admin.themeSampleButton).toHaveCSS('background-color', 'rgb(15, 118, 110)');
    await expect(admin.accentHex).toHaveValue('#0f766e');
  });

  test('기준색을 고르면 화면이 바로 바뀌고, 저장 전에는 서버로 가지 않는다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.accentHex.fill('b91c1c');

    await expect(admin.themeSampleButton).toHaveCSS('background-color', 'rgb(185, 28, 28)');
    expect(state.calls.some((call) => call.method === 'PUT' && call.path === '/api/admin/site')).toBe(false);
  });

  test('나머지 자동 계산은 여덟 색을 같은 색조로 채운다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.accentHex.fill('b91c1c');
    await admin.deriveButton.click();

    // 진하게 = 검정 섞기, 연하게 = 흰색 섞기. 색조(붉은 계열)는 그대로 남는다
    await expect(admin.themeHex('Button hover / darker accent')).toHaveValue('#a31919');
    await expect(admin.themeHex('Soft background')).toHaveValue('#f9ebeb');
    await expect(admin.themeHex('Gradient start')).toHaveValue('#bd2a2a');
  });

  test('항목별로 따로 골라 저장하면 그 색만 바뀐다', async ({ page, state }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.themeHex('Links and accent text').fill('0d6760');
    await admin.content.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => state.admin.site.site.theme.accentText).toBe('#0d6760');
    // 손대지 않은 항목은 그대로다
    expect(state.admin.site.site.theme.accent).toBe('#4f46e5');
  });

  test('기본 팔레트로 되돌린다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.accentHex.fill('b91c1c');
    await admin.deriveButton.click();
    await admin.resetThemeButton.click();

    await expect(admin.accentHex).toHaveValue('#4f46e5');
    await expect(admin.themeSampleButton).toHaveCSS('background-color', 'rgb(79, 70, 229)');
  });

  test('밝은 색을 고르면 흰 글자 대비 부족을 알린다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.accentHex.fill('facc15');

    await expect(admin.content.locator('.warn')).toContainText('hard to read');
  });

  test('저장하지 않고 다른 탭으로 나가면 서버 색으로 되돌아온다', async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.goto('site');

    await admin.accentHex.fill('b91c1c');
    await expect(admin.themeSampleButton).toHaveCSS('background-color', 'rgb(185, 28, 28)');

    await admin.tabButton('overview').click();
    await expect(admin.heading).toHaveText('Overview');

    // 관리자 LNB 의 활성 항목은 --accent-soft 를 쓴다 — 기본 팔레트 값으로 돌아와야 한다
    await expect(admin.tabButton('overview')).toHaveCSS('background-color', 'rgb(238, 240, 254)');
  });
});
