/**
 * 규칙 네 화면 (자동분류 · 부재중 · 수신거부 · 포워딩) — settings/rules/*.
 *
 * 네 화면이 **Sieve 스크립트 하나**로 저장된다. 그래서 화면 스펙이 지켜야 할 선은
 * "한 화면을 저장할 때 다른 화면 규칙이 지워지지 않는가" 다 — useRules 가 모델 전체를
 * 다시 보내는지 여기서 확인한다. Sieve 문법 자체(생성↔파싱 왕복)는 specs/api 쪽이 본다.
 */
import { acceptDialogs, expect, test } from '../../fixtures';
import { emptyRules, type RuleModelRule } from '../../fixtures/factories';
import { SettingsPage } from '../../pages/SettingsPage';
import { formRowInputLoose } from '../../pages/helpers';

const filterRule: RuleModelRule = {
  screen: 'FILTER',
  order: 1,
  enabled: true,
  name: '영수증 모으기',
  conditions: [{ field: 'SUBJECT', values: ['영수증', 'receipt'] }],
  action: { type: 'FILEINTO', mailboxName: 'Project' },
};

const rejectRule: RuleModelRule = {
  screen: 'REJECT',
  order: 1,
  enabled: true,
  name: '광고 차단',
  conditions: [{ field: 'FROM_DOMAIN', values: ['ad.example.com'] }],
  action: { type: 'DELETE' },
};

test.describe('자동분류', () => {
  test('규칙이 없으면 비었다고 알린다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    await expect(settings.content).toContainText('No filter rules yet.');
    await expect(settings.ruleTotal).toContainText('0 rule');
  });

  test('규칙 목록이 조건·처리 요약과 함께 나온다', async ({ page, state }) => {
    state.rules = { ...emptyRules(), filters: [filterRule] };
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    const row = settings.ruleRow('영수증 모으기');
    await expect(row).toContainText('Subject 영수증, receipt');
    // 편지함은 표시 이름으로 바뀐다
    await expect(row).toContainText('File into Project');
  });

  test('규칙을 추가한다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('공지 분류');
    await settings.modal.locator('.cond input').first().fill('공지');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.rules.filters.length).toBe(1);
    expect(state.rules.filters[0]).toMatchObject({
      name: '공지 분류',
      screen: 'FILTER',
      order: 1,
      enabled: true,
    });
    expect(state.rules.filters[0]?.conditions[0]?.values).toEqual(['공지']);
  });

  test('이름이 없으면 저장하지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toContainText('Enter a rule name');
    expect(state.rules.filters).toHaveLength(0);
  });

  test('조건 값이 비면 저장하지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('값 없는 규칙');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toContainText('Enter a condition value');
    expect(state.rules.filters).toHaveLength(0);
  });

  test('다른 화면의 규칙을 지우지 않고 저장한다', async ({ page, state }) => {
    // 수신거부 규칙이 이미 있는 상태에서 자동분류를 저장한다
    state.rules = { ...emptyRules(), rejects: [rejectRule] };
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('새 분류');
    await settings.modal.locator('.cond input').first().fill('공지');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.rules.filters.length).toBe(1);
    // 같은 Sieve 스크립트에 함께 담기므로 이게 무너지면 사용자 규칙이 사라진다
    expect(state.rules.rejects).toHaveLength(1);
    expect(state.rules.rejects[0]?.name).toBe('광고 차단');
  });

  test('사용 체크박스를 끄면 그 자리에서 저장된다', async ({ page, state }) => {
    state.rules = { ...emptyRules(), filters: [filterRule] };
    const settings = new SettingsPage(page);
    await settings.goto('filter');

    // 체크 상태는 저장이 끝나고 모델을 다시 받아야 바뀐다. uncheck() 는 누른 직후의
    // 상태를 보기 때문에 여기서는 클릭만 하고 결과는 저장된 값으로 확인한다
    await settings.ruleRow('영수증 모으기').locator('input[type="checkbox"]').click();

    await expect.poll(() => state.rules.filters[0]?.enabled).toBe(false);
    await expect(settings.ruleRow('영수증 모으기').locator('input[type="checkbox"]')).not.toBeChecked();
  });

  test('규칙을 지울 때 확인을 받는다', async ({ page, state }) => {
    state.rules = { ...emptyRules(), filters: [filterRule] };
    const settings = new SettingsPage(page);
    const asked = await acceptDialogs(page);
    await settings.goto('filter');

    await settings.ruleRow('영수증 모으기').getByRole('button', { name: 'Delete' }).click();

    await expect.poll(() => state.rules.filters.length).toBe(0);
    expect(asked.join(' ')).toContain('영수증 모으기');
  });
});

test.describe('수신거부', () => {
  test('처리 방법을 고를 수 있다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('reject');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('스팸 도메인');
    await settings.modal.locator('.cond input').first().fill('bad.example.com');
    await settings.modal.locator('select').last().selectOption({ label: 'Move to spam' });
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.rules.rejects.length).toBe(1);
    expect(state.rules.rejects[0]?.action).toMatchObject({ type: 'SPAM' });
  });

  test('차단 메일은 조용히 버려진다고 안내한다', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto('reject');

    await expect(settings.content.locator('ul.notes')).toContainText('nothing is bounced back');
  });
});

test.describe('포워딩', () => {
  test('주소 형식이 틀리면 저장하지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('forward');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('휴가 중 전달');
    await formRowInputLoose(settings.modal, 'Forwarding address').fill('없는주소');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toContainText('not valid');
    expect(state.rules.forwards).toHaveLength(0);
  });

  test('조건 없이 모든 메일을 전달할 수 있다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('forward');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('전부 전달');
    await settings.modal.locator('label.checkbox', { hasText: 'All incoming mail' }).locator('input').check();
    await formRowInputLoose(settings.modal, 'Forwarding address').fill('me@other.com');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => state.rules.forwards.length).toBe(1);
    expect(state.rules.forwards[0]?.conditions).toEqual([]);
    expect(state.rules.forwards[0]?.action).toMatchObject({ type: 'FORWARD', address: 'me@other.com' });
  });

  test('기간 한쪽만 넣으면 저장하지 않는다', async ({ page, state }) => {
    const settings = new SettingsPage(page);
    await settings.goto('forward');

    await settings.addRuleButton.click();
    await formRowInputLoose(settings.modal, 'Rule name').fill('기간 규칙');
    await settings.modal.locator('label.checkbox', { hasText: 'All incoming mail' }).locator('input').check();
    await formRowInputLoose(settings.modal, 'Forwarding address').fill('me@other.com');
    // 기간을 고르면 시작·종료가 오늘로 채워진다. 한쪽을 비우면 저장을 막아야 한다
    await settings.modal.locator('label.checkbox', { hasText: 'Choose a period' }).locator('input').check();
    await settings.modal.locator('input[type="date"]').first().fill('2026-10-01');
    await settings.modal.locator('input[type="date"]').last().fill('');
    await settings.modal.getByRole('button', { name: 'Save' }).click();

    await expect(settings.modal.locator('.error')).toContainText('both a start and an end date');
    expect(state.rules.forwards).toHaveLength(0);
  });
});
