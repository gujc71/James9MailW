/**
 * 목록 정렬 기준 (feature-gap.md 2-1).
 *
 * 썬더버드·아웃룩은 열 머리글을 눌러 정렬하지만 이 목록은 한 줄에 여러 값을 얹은 카드 행이라
 * 누를 머리글이 없다. 그래서 [정렬 ▾] 드롭다운으로 기준과 방향을 고른다.
 *
 * 고른 값은 **브라우저 localStorage** 에만 둔다. 서버 설정으로 올리면 화면 조작마다
 * 저장 요청이 붙고, 다른 기기와 어긋날 때 무엇이 맞는지 다투게 된다 — 목록 보기 방식은
 * 그 기기에서 보는 방식이면 충분하다. 저장이 막힌 창(시크릿 등)에서는 조용히 기본값으로 돈다.
 */
import type { MailboxRole } from '../../api/types';

/** 'from' 은 목록이 보여 주는 주소 열이다 — 보낸 편지함 계열은 받는 사람, 그 외는 보낸 사람 */
export type SortKey = 'date' | 'from' | 'subject' | 'size';

export interface ListSort {
  key: SortKey;
  desc: boolean;
}

export const DEFAULT_SORT: ListSort = { key: 'date', desc: true };

/** 기준을 새로 고를 때의 방향. 날짜·크기는 큰 값부터, 이름·제목은 ㄱ→ㅎ 순이 자연스럽다 */
export const FIRST_DIRECTION_DESC: Record<SortKey, boolean> = {
  date: true,
  size: true,
  from: false,
  subject: false,
};

export const SORT_KEYS: SortKey[] = ['date', 'from', 'subject', 'size'];

/**
 * 목록이 보낸 쪽(받는 사람 · 발송일시)을 보여 주는 편지함인가.
 * 서버 라우트의 SENT_VIEW_ROLES 와 같은 묶음이어야 정렬 순서가 화면과 어긋나지 않는다.
 */
export function showsRecipient(role: MailboxRole | null): boolean {
  return role === 'Sent' || role === 'Outbox' || role === 'Drafts';
}

const KEY = 'j9-list-sort';

export function loadSort(): ListSort {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<ListSort>;
    if (!parsed || !SORT_KEYS.includes(parsed.key as SortKey)) return DEFAULT_SORT;
    return { key: parsed.key as SortKey, desc: Boolean(parsed.desc) };
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSort(sort: ListSort): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sort));
  } catch {
    // 저장이 막힌 창에서는 이번 세션만 유지한다
  }
}

/**
 * 대화로 묶어 보기 (feature-gap 2-2). 정렬과 같은 성격의 "이 기기에서 보는 방식" 이라
 * 같은 자리(localStorage)에 둔다.
 */
const THREAD_KEY = 'j9-list-threaded';

export function loadThreaded(): boolean {
  try {
    return localStorage.getItem(THREAD_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveThreaded(threaded: boolean): void {
  try {
    localStorage.setItem(THREAD_KEY, threaded ? '1' : '0');
  } catch {
    // 저장이 막힌 창에서는 이번 세션만 유지한다
  }
}
