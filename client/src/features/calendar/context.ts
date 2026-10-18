/** 캘린더 화면 공용 값과 동작. 보기 · 목록 · 오늘 패널이 같은 동작을 부른다 (CalendarPage 가 채운다) */
import { createContext, useContext, type MouseEvent } from 'react';
import type { Bootstrap, CalendarInfo, Occurrence, TaskRow } from './types';

export interface NewSeed {
  type?: 'E' | 'T';
  /** 벽시계. 날짜만 주면 그날 다음 정시에 기본 길이로 */
  start?: string;
  end?: string;
  allDay?: boolean;
  title?: string;
  description?: string;
}

export interface CalActions {
  openNew(seed?: NewSeed): void;
  openOccurrence(occ: Occurrence): void;
  openTask(task: TaskRow): void;
  deleteOccurrence(occ: Occurrence): void;
  moveOccurrence(occ: Occurrence, start: string, end: string | null, allDay: boolean): void;
  /** Ctrl 을 누른 채 끌어 놓기: 그 자리에 한 회차짜리 사본을 만든다 */
  copyTo(occ: Occurrence, start: string): void;
  occurrenceMenu(e: MouseEvent, occ: Occurrence): void;
  slotMenu(e: MouseEvent, date: string, time?: string): void;
  taskMenu(e: MouseEvent, task: TaskRow): void;
  select(occ: Occurrence | null): void;
  selectDate(date: string, time?: string): void;
  goToDate(date: string, view?: 'day' | 'week' | 'multiweek' | 'month'): void;
  toggleTask(itemId: string, completed: boolean, occurrence?: string | null): void;
  quickAddTask(title: string): void;
}

export interface CalContextValue {
  boot: Bootstrap;
  userName: string;
  calendarById: Map<number, CalendarInfo>;
  categoryColor: Map<string, string | null>;
  today: string;
  selectedId: string | null;
  selectedDate: string;
  actions: CalActions;
}

export const CalContext = createContext<CalContextValue | null>(null);

export function useCal(): CalContextValue {
  const value = useContext(CalContext);
  if (!value) throw new Error('CalContext missing');
  return value;
}

/** 일정 칩 색: 캘린더 색을 바탕으로, 첫 분류 색을 왼쪽 띠로 */
export function chipStyle(occ: Occurrence, ctx: CalContextValue): { background: string; borderLeft: string; color: string } {
  const color = ctx.calendarById.get(occ.calendarId)?.color ?? '#3b82f6';
  const category = occ.categories.map((c) => ctx.categoryColor.get(c)).find(Boolean);
  return {
    background: `color-mix(in srgb, ${color} 22%, white)`,
    borderLeft: `3px solid ${category ?? color}`,
    color: 'var(--text)',
  };
}

export function isWritable(occ: { calendarId: number }, ctx: CalContextValue): boolean {
  const cal = ctx.calendarById.get(occ.calendarId);
  return Boolean(cal && !cal.readonly);
}
