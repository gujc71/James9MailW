/** 캘린더 API 모양 (server/src/routes/calendar.ts · services/calendar.ts 와 같다) */

export type ItemType = 'E' | 'T';
export type Scope = 'this' | 'following' | 'all';

export interface CalSettings {
  timezone: string;
  /** 0 일요일 … 6 토요일 */
  weekStart: number;
  daysOff: number[];
  dayStartHour: number;
  dayEndHour: number;
  visibleHours: number;
  multiweekCount: number;
  prevWeeks: number;
  weekNumbers: boolean;
  defaultLengthMin: number;
  /** -1 이면 알림 없음 */
  defaultAlarmMin: number;
  alarmSound: boolean;
  alarmPopup: boolean;
  missedAlarms: boolean;
}

export interface CalendarInfo {
  calendarId: number;
  name: string;
  color: string;
  type: 'LOCAL' | 'ICS';
  sourceUrl: string | null;
  refreshMin: number;
  lastSync: string | null;
  syncError: string | null;
  visible: boolean;
  readonly: boolean;
  alarm: boolean;
  isDefault: boolean;
  sortOrder: number;
  feedUrl: string | null;
}

export interface Category {
  name: string;
  color: string | null;
}

export interface Bootstrap {
  settings: CalSettings;
  calendars: CalendarInfo[];
  categories: Category[];
}

/** 화면에 그릴 회차. start · end 는 화면 시간대 벽시계 ('YYYY-MM-DDTHH:mm' · 종일은 날짜, end 는 다음 날) */
export interface Occurrence {
  id: string;
  itemId: string;
  occurrence: string | null;
  type: ItemType;
  calendarId: number;
  title: string;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  due: string | null;
  categories: string[];
  status: string | null;
  privacy: string;
  transp: string;
  priority: number;
  percent: number;
  completed: boolean;
  recurring: boolean;
  exception: boolean;
  hasAlarm: boolean;
  attendees: number;
  organizer: string | null;
}

export interface Attendee {
  email: string;
  name: string | null;
  role: string;
  partstat: string;
  rsvp: boolean;
}

export interface Alarm {
  alarmId?: number;
  /** 기준보다 몇 분 앞. 음수면 뒤 */
  offsetMin: number;
  related: 'S' | 'E';
}

export interface Attachment {
  url: string;
  name: string | null;
}

/** 서버에 저장된 항목 하나 (일정 시간대 벽시계) */
export interface ItemDetail {
  itemId: string;
  calendarId: number;
  type: ItemType;
  uid: string;
  parentId: string | null;
  recurrenceId: string | null;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  allDay: boolean;
  tzid: string;
  start: string | null;
  end: string | null;
  due: string | null;
  completed: string | null;
  percent: number;
  status: string | null;
  priority: number;
  privacy: string;
  transp: string;
  rrule: string | null;
  exdates: string[];
  categories: string[];
  organizer: string | null;
  sequence: number;
  attendees: Attendee[];
  alarms: Alarm[];
  attachments: Attachment[];
  exceptions: string[];
  isOrganizer: boolean;
}

/** 저장할 때 보내는 값 */
export interface ItemInput {
  type: ItemType;
  calendarId: number;
  title: string;
  location: string;
  description: string;
  url: string;
  allDay: boolean;
  tzid: string;
  start: string | null;
  end: string | null;
  due: string | null;
  status: string | null;
  priority: number;
  privacy: string;
  transp: string;
  percent: number;
  completed: string | null;
  rrule: string | null;
  categories: string[];
  alarms: Alarm[];
  attendees: Attendee[];
  attachments: Attachment[];
}

export interface TaskRow {
  itemId: string;
  calendarId: number;
  title: string;
  location: string | null;
  description: string | null;
  start: string | null;
  due: string | null;
  allDay: boolean;
  completed: string | null;
  percent: number;
  status: string | null;
  priority: number;
  categories: string[];
  recurring: boolean;
  hasAlarm: boolean;
}

export interface DueAlarm {
  alarmId: number;
  occurrence: string;
  itemId: string;
  type: ItemType;
  calendarId: number;
  title: string;
  location: string | null;
  start: string | null;
  allDay: boolean;
  fireAt: string;
}

export interface BusyBlock {
  start: string;
  end: string;
  tentative: boolean;
}

export type FreeBusy = Record<string, { known: boolean; busy: BusyBlock[] }>;

export type ViewKind = 'day' | 'week' | 'multiweek' | 'month';
