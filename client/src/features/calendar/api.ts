/** 캘린더 API 호출과 조회 훅. 쓰기 뒤에는 ['cal'] 아래 조회를 모두 다시 받는다 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type {
  Bootstrap,
  CalSettings,
  CalendarInfo,
  Category,
  DueAlarm,
  FreeBusy,
  ItemDetail,
  ItemInput,
  Occurrence,
  Scope,
  TaskRow,
} from './types';
import { browserTimeZone } from './wall';

export const calKeys = {
  all: ['cal'] as const,
  bootstrap: ['cal', 'bootstrap'] as const,
  range: (from: string, to: string, q = '') => ['cal', 'occ', from, to, q] as const,
  series: (q: string, after: string | null) => ['cal', 'series', q, after] as const,
  tasks: ['cal', 'tasks'] as const,
  item: (id: string) => ['cal', 'item', id] as const,
};

export function invalidateCalendar(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: calKeys.all });
}

export function useBootstrap() {
  return useQuery({
    queryKey: calKeys.bootstrap,
    queryFn: () => api.get<Bootstrap>(`/api/calendar/bootstrap?tz=${encodeURIComponent(browserTimeZone())}`),
    staleTime: 60_000,
  });
}

export function useRange(from: string, to: string, q = '', enabled = true) {
  return useQuery({
    queryKey: calKeys.range(from, to, q),
    queryFn: () =>
      api.get<Occurrence[]>(
        `/api/calendar/occurrences?from=${from}&to=${to}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useSeries(q: string, after: string | null, enabled: boolean) {
  return useQuery({
    queryKey: calKeys.series(q, after),
    queryFn: () =>
      api.get<Occurrence[]>(
        `/api/calendar/occurrences?mode=series${q ? `&q=${encodeURIComponent(q)}` : ''}${after ? `&after=${after}` : ''}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}

export function useTasks() {
  return useQuery({ queryKey: calKeys.tasks, queryFn: () => api.get<TaskRow[]>('/api/calendar/tasks'), staleTime: 30_000 });
}

export const calApi = {
  item: (id: string) => api.get<ItemDetail>(`/api/calendar/items/${id}`),
  create: (item: ItemInput, notify: boolean) =>
    api.post<{ itemId: string; warnings: string[] }>('/api/calendar/items', { item, notify }),
  update: (id: string, item: ItemInput, scope: Scope, occurrence: string | null, notify: boolean) =>
    api.put<{ itemId: string; warnings: string[] }>(`/api/calendar/items/${id}`, { item, scope, occurrence, notify }),
  move: (
    id: string,
    body: { start: string; end: string | null; allDay: boolean; scope: Scope; occurrence: string | null; notify: boolean },
  ) => api.post<{ itemId: string; warnings: string[] }>(`/api/calendar/items/${id}/move`, body),
  quick: (
    id: string,
    patch: Partial<{
      categories: string[];
      status: string | null;
      percent: number;
      priority: number;
      privacy: string;
      calendarId: number;
      completed: boolean;
    }>,
    scope: Scope = 'all',
    occurrence: string | null = null,
  ) => api.post<{ itemId: string }>(`/api/calendar/items/${id}/quick`, { patch, scope, occurrence }),
  remove: (id: string, scope: Scope, occurrence: string | null, notify: boolean) =>
    api.del<{ ok: boolean; warnings: string[] }>(
      `/api/calendar/items/${id}?scope=${scope}${occurrence ? `&occurrence=${encodeURIComponent(occurrence)}` : ''}&notify=${notify ? 1 : 0}`,
    ),
  exportItems: async (itemIds: string[]): Promise<string> => {
    const res = await fetch('/api/calendar/items/export', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'james9mail' },
      body: JSON.stringify({ itemIds }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return res.text();
  },
  freeBusy: (emails: string[], from: string, to: string) =>
    api.get<FreeBusy>(`/api/calendar/freebusy?emails=${encodeURIComponent(emails.join(','))}&from=${from}&to=${to}`),
  recentAttendees: () => api.get<{ email: string; name: string | null }[]>('/api/calendar/recent-attendees'),
  saveSettings: (settings: CalSettings) => api.put('/api/calendar/settings', settings),
  saveCategories: (categories: Category[]) => api.put('/api/calendar/categories', { categories }),
  createCalendar: (input: { name: string; color: string; type: 'LOCAL' | 'ICS'; sourceUrl?: string; refreshMin?: number; alarm?: boolean }) =>
    api.post<{ calendarId: number }>('/api/calendar/calendars', input),
  updateCalendar: (
    id: number,
    patch: Partial<Pick<CalendarInfo, 'name' | 'color' | 'visible' | 'readonly' | 'alarm' | 'isDefault' | 'refreshMin' | 'sortOrder'>> & {
      sourceUrl?: string;
    },
  ) => api.put(`/api/calendar/calendars/${id}`, patch),
  deleteCalendar: (id: number) => api.del(`/api/calendar/calendars/${id}`),
  refreshCalendar: (id: number) => api.post<{ saved: number }>(`/api/calendar/calendars/${id}/refresh`),
  publish: (id: number, enabled: boolean) => api.post<{ feedUrl: string | null }>(`/api/calendar/calendars/${id}/publish`, { enabled }),
  importIcs: (id: number, ics: string) => api.post<{ imported: number }>(`/api/calendar/calendars/${id}/import`, { ics }),
  exportUrl: (id: number) => `/api/calendar/calendars/${id}/export`,
  alarms: () => api.get<DueAlarm[]>('/api/calendar/alarms'),
  snooze: (items: { alarmId: number; occurrence: string }[], minutes: number) =>
    api.post('/api/calendar/alarms/snooze', { items, minutes }),
  dismiss: (items: { alarmId: number; occurrence: string }[]) => api.post('/api/calendar/alarms/dismiss', { items }),
  itip: (ics: string, action: 'import' | 'reply' | 'cancel', calendarId?: number) =>
    api.post<{ changed: number }>('/api/calendar/itip', { ics, action, calendarId }),
};

export function useInvalidate() {
  const client = useQueryClient();
  return () => invalidateCalendar(client);
}

/** 브라우저가 파일로 받게 한다 */
export function downloadText(name: string, text: string, type = 'text/calendar;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
