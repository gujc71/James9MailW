/**
 * POM 공용 헬퍼.
 *
 * 이 앱에는 data-testid 가 없고, 설정·관리자 화면의 입력칸은 label 이 input 을 감싸지 않는
 * `<div class="form-row"><label>이름</label><input></div>` 모양이다. 그래서
 * getByLabel 이 통하지 않는 자리가 많다 — 라벨이 있는 행을 집어 그 안의 입력칸을 쓴다.
 */
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * `<div class="form-row"><label>라벨</label><input></div>` 의 입력칸.
 *
 * `filter({ has: ... })` 대신 Playwright 의 `:has()` + `:text-is()` 를 쓴다 —
 * 바깥 로케이터를 다시 뿌리로 삼는 has 로케이터는 이 구조에서 맞지 않는다.
 */
export function formRowInput(scope: Page | Locator, label: string, index = 0): Locator {
  return scope
    .locator(`.form-row:has(> label:text-is("${label}"))`)
    .locator('input, select, textarea')
    .nth(index);
}

/** 라벨 텍스트가 부분 일치해도 되는 경우 (예: "* 이름", "Default quota per user") */
export function formRowInputLoose(scope: Page | Locator, label: string, index = 0): Locator {
  return scope
    .locator(`.form-row:has(> label:has-text("${label}"))`)
    .locator('input, select, textarea')
    .nth(index);
}

/**
 * 메일쓰기의 `<div class="field"><span>라벨</span>…</div>`.
 *
 * 받는사람 줄의 라벨 span 안에는 "+" 버튼이 함께 들어 있어 글자가 "To+" 가 된다.
 * 그래서 여기서는 정확히 같은지가 아니라 포함하는지로 고른다.
 */
export function fieldRow(scope: Page | Locator, label: string): Locator {
  return scope.locator('.field').filter({ hasText: label }).first();
}

/**
 * 드롭다운 메뉴(common/Menu.tsx)를 열고 항목을 누른다.
 * 메뉴 목록은 body 로 포털 렌더되므로 버튼 주변에서 찾으면 안 된다.
 */
export async function pickFromMenu(page: Page, button: Locator, item: string | RegExp): Promise<void> {
  // 문자열은 정확히 일치시킨다 — "Delete" 가 "Delete permanently" 까지 잡으면 안 된다.
  // 정규식은 그대로 넘긴다 (정렬 메뉴처럼 라벨에 체크표시·화살표가 섞인 경우)
  const name = typeof item === 'string' ? { name: item, exact: true } : { name: item };
  const list = page.locator('ul.menu-list');

  /**
   * 메뉴 목록은 body 로 포털 렌더되고 위치를 잰 뒤 한 번 움직인다. 그 사이에 뒤쪽 표가
   * 새로 그려지면(저장 후 목록 갱신) 포털이 통째로 떨어져 나간다.
   * 그래서 "열고 고르기" 를 통째로 다시 해 본다.
   */
  await expect(async () => {
    if (!(await list.isVisible())) await button.click();
    await list.waitFor({ state: 'visible', timeout: 2_000 });
    await list.getByRole('button', name).click({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * 본문 iframe. srcdoc + sandbox 라 별도 프레임으로 들어가야 본문 글자를 볼 수 있다
 * (message/BodyViewer.tsx).
 */
export function mailBody(page: Page) {
  return page.frameLocator('iframe[title="mail-body"]');
}

/**
 * 읽기 화면 스펙용 증거 남기기.
 * 본문은 blob:/srcdoc 이라 Trace Viewer 스냅샷에서 비어 보인다 — 실패를 나중에 판독할 수
 * 있도록 스크린샷을 직접 첨부한다.
 */
export async function attachBodyShot(page: Page, testInfo: TestInfo, name = 'reading-pane.png'): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}
