/**
 * 로그아웃할 때 이 PC 에 남긴 메일 캐시를 지울지 (개인 정보 관리 화면의 체크 박스).
 *
 * 메일 목록과 원문은 빠르게 열려고 브라우저(IndexedDB)에 남겨 둔다(db/schema.ts). 자기 PC 라면
 * 다음 로그인 때 다시 받지 않아 빠르지만, 공용 PC 라면 다음 사람이 개발자 도구로 볼 수 있다.
 *
 * 값은 서버가 아니라 **이 브라우저의 localStorage** 에 둔다. 지울지 말지는 사람이 아니라 기기에 따라
 * 정해지는 것이라(내 PC 는 남기고 공용 PC 는 지운다) 서버에 두면 한쪽에서 고른 값이 다른 쪽을 덮는다.
 * 계정별 키라 같은 PC 를 쓰는 다른 사람의 선택과 섞이지 않는다.
 */
import { closeUserDb } from '../db/schema';
import { clearComposeDraft } from '../features/compose/draftStore';

const PREFIX = 'j9-clear-cache-on-logout:';

function keyOf(userName: string): string {
  return PREFIX + userName.trim().toLowerCase();
}

/** 기본값은 남긴다(false) — 지금까지와 같은 동작이고, 공용 PC 는 화면 안내를 보고 켠다 */
export function loadClearOnLogout(userName: string): boolean {
  try {
    return localStorage.getItem(keyOf(userName)) === '1';
  } catch {
    return false;
  }
}

export function saveClearOnLogout(userName: string, clear: boolean): void {
  try {
    if (clear) localStorage.setItem(keyOf(userName), '1');
    else localStorage.removeItem(keyOf(userName));
  } catch {
    // 저장이 막힌 브라우저(시크릿 창 등)는 닫으면 어차피 지워진다
  }
}

/**
 * 로그아웃 뒤 로컬 정리. 설정이 켜져 있으면 메일 캐시와 작성 중이던 자동 저장본까지 지운다.
 * 설정 값 자체는 남긴다 — 다음에 이 PC 에서 로그인해도 같은 선택이 이어져야 한다.
 */
export async function cleanupAfterLogout(userName: string): Promise<void> {
  const purge = loadClearOnLogout(userName);
  if (purge) clearComposeDraft(userName);
  await closeUserDb({ purge });
}
