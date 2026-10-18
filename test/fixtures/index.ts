/**
 * mock 계층 공용 픽스처.
 *
 *   test('...', async ({ page, state, shell }) => { ... })
 *
 *  - state : 이 테스트만의 가짜 서버 상태. goto 전에 마음대로 꾸민다
 *  - page  : /api/** 가 이미 가로채인 페이지. 언어는 en 으로 고정돼 있다
 *  - shell : 로그인 · 화면 이동 같은 공통 조작
 *  - pageErrors : 화면에서 터진 예외. 스펙 끝에서 비어 있는지 확인할 수 있다
 *
 * 브라우저 컨텍스트는 테스트마다 새로 만들어진다(Playwright 기본). Dexie 미러(IndexedDB)가
 * 남지 않아야 목록 단정이 오염되지 않으므로 storageState 로 재사용하지 않는다.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { freshState, installMockApi, type MockState } from './mockApi';
import { ShellPage } from '../pages/ShellPage';

export interface MockFixtures {
  state: MockState;
  shell: ShellPage;
  pageErrors: string[];
}

export const test = base.extend<MockFixtures>({
  state: async ({}, use) => {
    await use(freshState());
  },

  pageErrors: async ({}, use) => {
    await use([]);
  },

  page: async ({ page, state, pageErrors }, use) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installMockApi(page, state);
    await use(page);
  },

  shell: async ({ page }, use) => {
    await use(new ShellPage(page));
  },
});

export { expect };
export type { MockState };

/**
 * confirm() · prompt() 는 Playwright 가 기본적으로 **거절**한다. 그대로 두면 삭제·비우기·
 * 편지함 추가가 조용히 아무 일도 하지 않는다. 대화상자를 쓰는 스펙은 이걸 먼저 부른다.
 *
 *   await acceptDialogs(page);                 // confirm 은 승인
 *   await acceptDialogs(page, 'Project');      // prompt 에는 이 값을 넣는다
 */
export async function acceptDialogs(page: Page, promptValue = ''): Promise<string[]> {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.accept(promptValue);
  });
  return seen;
}

/** confirm() 을 거절한다. "취소하면 아무 일도 없다" 를 확인할 때 */
export async function dismissDialogs(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}
