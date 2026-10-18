/**
 * 메일 화면 ↔ 캘린더 화면 사이에 넘기는 일감. 화면이 해시 라우팅으로 바뀌므로(lib/hashRoute.ts)
 * prop 대신 모듈에 한 건씩 맡겨 두고, 받는 화면이 열리면서 꺼내 간다.
 *
 *  - 메일 → 캘린더: "이벤트로 변환 · 태스크로 변환" (썬더버드 메시지 메뉴) · 알림 창에서 일정 열기
 *  - 캘린더 → 메일: "참석자에게 메일 보내기"
 */
export interface CalendarSeed {
  type: 'E' | 'T';
  title: string;
  description: string;
}

export interface ComposeRequest {
  to: string;
  subject: string;
}

let calendarSeed: CalendarSeed | null = null;
let focusDate: { date: string; itemId?: string } | null = null;
let compose: ComposeRequest | null = null;

export function handToCalendar(seed: CalendarSeed): void {
  calendarSeed = seed;
}

export function takeCalendarSeed(): CalendarSeed | null {
  const seed = calendarSeed;
  calendarSeed = null;
  return seed;
}

export function focusCalendarOn(date: string, itemId?: string): void {
  focusDate = { date, itemId };
  window.dispatchEvent(new Event('j9-cal-focus'));
}

export function takeCalendarFocus(): { date: string; itemId?: string } | null {
  const value = focusDate;
  focusDate = null;
  return value;
}

export function handToCompose(request: ComposeRequest): void {
  compose = request;
}

export function takeCompose(): ComposeRequest | null {
  const value = compose;
  compose = null;
  return value;
}
