/**
 * 목록 ↔ 읽기 영역 너비 조절 (Splitter.tsx).
 *
 * 손잡이를 끌어 목록 폭이 따라오는가, 끝과 끝에서 가둬지는가, 다음에 열 때도 그 폭인가를 본다.
 * 폭은 .body 의 CSS 변수(--list-w)로 내려가므로 단정은 실제로 그려진 .list-pane 의
 * 박스 너비로 한다 — 변수만 보면 미디어 쿼리가 그것을 무시하는 경우를 놓친다.
 */
import { expect, test } from '../../fixtures';
import { makeMessage } from '../../fixtures/factories';

/** Splitter.tsx 의 값들. 여기서 어긋나면 스펙이 먼저 깨지는 편이 낫다 */
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 280;

async function listWidth(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.locator('.list-pane').boundingBox();
  if (!box) throw new Error('목록 영역이 화면에 없다');
  return Math.round(box.width);
}

/** 손잡이를 dx 만큼 끈다. 집히는 폭이 5px 라 가운데를 잡아야 빗나가지 않는다 */
async function dragSplitter(page: import('@playwright/test').Page, dx: number): Promise<void> {
  const handle = page.locator('.splitter');
  const box = await handle.boundingBox();
  if (!box) throw new Error('손잡이가 화면에 없다');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // 한 번에 옮기면 pointermove 가 한 발도 안 올 수 있다. 두 걸음으로 끈다
  await page.mouse.move(box.x + box.width / 2 + dx / 2, y);
  await page.mouse.move(box.x + box.width / 2 + dx, y);
  await page.mouse.up();
}

test.beforeEach(async ({ state }) => {
  state.messages = [makeMessage({ uid: 1, subject: 'Width check', seen: true })];
});

test('처음에는 기본 너비이고, 손잡이를 끌면 그만큼 넓어진다', async ({ shell, page }) => {
  await shell.open();
  expect(await listWidth(page)).toBe(DEFAULT_WIDTH);

  await dragSplitter(page, 160);

  expect(await listWidth(page)).toBe(DEFAULT_WIDTH + 160);
});

test('왼쪽으로 끝까지 끌어도 최소 너비 아래로는 줄지 않는다', async ({ shell, page }) => {
  await shell.open();

  await dragSplitter(page, -600);

  expect(await listWidth(page)).toBe(MIN_WIDTH);
});

test('오른쪽으로 끝까지 끌어도 읽기 영역은 남는다', async ({ shell, page }) => {
  await shell.open();

  await dragSplitter(page, 2000);

  const read = await page.locator('.read-pane').boundingBox();
  expect(read?.width ?? 0).toBeGreaterThanOrEqual(400);
});

test('조절한 너비는 새로고침 뒤에도 그대로다', async ({ shell, page }) => {
  await shell.open();
  await dragSplitter(page, 120);
  const widened = await listWidth(page);

  await page.reload();

  expect(await listWidth(page)).toBe(widened);
});

test('손잡이를 두 번 누르면 기본 너비로 돌아온다', async ({ shell, page }) => {
  await shell.open();
  await dragSplitter(page, 180);
  expect(await listWidth(page)).not.toBe(DEFAULT_WIDTH);

  await page.locator('.splitter').dblclick();

  expect(await listWidth(page)).toBe(DEFAULT_WIDTH);
});

test('읽기 패널이 목록을 덮는 좁은 화면에서는 손잡이가 없다', async ({ shell, page }) => {
  await shell.open();
  await page.setViewportSize({ width: 1000, height: 900 });

  await expect(page.locator('.splitter')).toBeHidden();
});
