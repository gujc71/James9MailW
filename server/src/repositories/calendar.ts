/**
 * 캘린더 테이블(CAL_*) 읽기 · 쓰기. 계산(반복 펼치기 · 시간대)은 services/calendar.ts 가 한다.
 * CAL_ 테이블은 웹서버 전용이라 GU_ 테이블처럼 dbWrite 로 직접 쓴다.
 */
import { sql } from 'kysely';
import { db, dbWrite } from '../db/kysely.js';
import type { CalItem } from '../db/schema.js';

// ------------------------------------------------------------------ 타입

export interface CalendarRecord {
  calendarId: number;
  userName: string;
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
  feedToken: string | null;
  sortOrder: number;
}

export interface AttendeeRecord {
  email: string;
  name: string | null;
  role: string;
  partstat: string;
  rsvp: boolean;
}

export interface AlarmRecord {
  alarmId?: number;
  offsetMin: number;
  related: 'S' | 'E';
}

export interface AttachRecord {
  url: string;
  name: string | null;
}

export interface ItemRecord {
  itemId: string;
  calendarId: number;
  userName: string;
  type: 'E' | 'T';
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
  completed: Date | null;
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
  regDate: Date;
  updateDate: Date;
  /**
   * CalDAV 자원 이름 · 외부 프로그램의 X- 속성 원문 (routes/caldav.ts).
   * undefined 면 저장할 때 손대지 않는다 — 화면 · 초대 메일 경로는 이 값을 모른다.
   */
  davName?: string | null;
  extraProps?: string[] | null;
}

export interface ItemFull extends ItemRecord {
  attendees: AttendeeRecord[];
  alarms: AlarmRecord[];
  attachments: AttachRecord[];
}

/** 기간 조회용으로 서비스가 계산해 넘기는 값 */
export interface ItemIndex {
  startUtc: Date | null;
  endUtc: Date | null;
  rangeEndUtc: Date | null;
}

export interface SettingRecord {
  timezone: string;
  weekStart: number;
  daysOff: number[];
  dayStartHour: number;
  dayEndHour: number;
  visibleHours: number;
  multiweekCount: number;
  prevWeeks: number;
  weekNumbers: boolean;
  defaultLengthMin: number;
  defaultAlarmMin: number;
  alarmSound: boolean;
  alarmPopup: boolean;
  missedAlarms: boolean;
}

export interface CategoryRecord {
  name: string;
  color: string | null;
}

const yn = (value: boolean) => (value ? 'Y' : 'N');
const isY = (value: string | null | undefined) => (value ?? '').toUpperCase() === 'Y';
const splitList = (value: string | null) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

// ------------------------------------------------------------------ 캘린더

type CalendarRow = {
  CALENDAR_ID: number;
  USER_NAME: string;
  CAL_NAME: string;
  CAL_COLOR: string;
  CAL_TYPE: string;
  SOURCE_URL: string | null;
  REFRESH_MIN: number;
  LAST_SYNC: Date | null;
  SYNC_ERROR: string | null;
  VISIBLE_YN: string;
  READONLY_YN: string;
  ALARM_YN: string;
  DEFAULT_YN: string;
  FEED_TOKEN: string | null;
  SORT_ORDER: number;
};

function toCalendar(row: CalendarRow): CalendarRecord {
  return {
    calendarId: Number(row.CALENDAR_ID),
    userName: row.USER_NAME,
    name: row.CAL_NAME,
    color: row.CAL_COLOR,
    type: row.CAL_TYPE === 'ICS' ? 'ICS' : 'LOCAL',
    sourceUrl: row.SOURCE_URL,
    refreshMin: row.REFRESH_MIN,
    lastSync: row.LAST_SYNC ? new Date(row.LAST_SYNC).toISOString() : null,
    syncError: row.SYNC_ERROR,
    visible: isY(row.VISIBLE_YN),
    // 네트워크 구독은 늘 읽기 전용이다. 다음 새로 고침이 고친 내용을 덮어쓴다
    readonly: isY(row.READONLY_YN) || row.CAL_TYPE === 'ICS',
    alarm: isY(row.ALARM_YN),
    isDefault: isY(row.DEFAULT_YN),
    feedToken: row.FEED_TOKEN,
    sortOrder: row.SORT_ORDER,
  };
}

const CALENDAR_COLUMNS = [
  'CALENDAR_ID',
  'USER_NAME',
  'CAL_NAME',
  'CAL_COLOR',
  'CAL_TYPE',
  'SOURCE_URL',
  'REFRESH_MIN',
  'LAST_SYNC',
  'SYNC_ERROR',
  'VISIBLE_YN',
  'READONLY_YN',
  'ALARM_YN',
  'DEFAULT_YN',
  'FEED_TOKEN',
  'SORT_ORDER',
] as const;

export async function listCalendars(userName: string): Promise<CalendarRecord[]> {
  const rows = await db
    .selectFrom('CAL_CALENDAR')
    .select(CALENDAR_COLUMNS)
    .where('USER_NAME', '=', userName)
    .orderBy('SORT_ORDER')
    .orderBy('CALENDAR_ID')
    .execute();
  return rows.map((row) => toCalendar(row as CalendarRow));
}

export async function findCalendar(userName: string, calendarId: number): Promise<CalendarRecord | null> {
  const row = await db
    .selectFrom('CAL_CALENDAR')
    .select(CALENDAR_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('CALENDAR_ID', '=', calendarId)
    .executeTakeFirst();
  return row ? toCalendar(row as CalendarRow) : null;
}

export async function findCalendarByFeed(token: string): Promise<CalendarRecord | null> {
  const row = await db
    .selectFrom('CAL_CALENDAR')
    .select(CALENDAR_COLUMNS)
    .where('FEED_TOKEN', '=', token)
    .executeTakeFirst();
  return row ? toCalendar(row as CalendarRow) : null;
}

export async function createCalendar(
  userName: string,
  input: {
    name: string;
    color: string;
    type: 'LOCAL' | 'ICS';
    sourceUrl?: string | null;
    refreshMin?: number;
    readonly?: boolean;
    alarm?: boolean;
    isDefault?: boolean;
  },
): Promise<number> {
  const now = new Date();
  const max = await db
    .selectFrom('CAL_CALENDAR')
    .select(sql<number>`COALESCE(MAX(SORT_ORDER), 0)`.as('m'))
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  const result = await dbWrite
    .insertInto('CAL_CALENDAR')
    .values({
      USER_NAME: userName,
      CAL_NAME: input.name,
      CAL_COLOR: input.color,
      CAL_TYPE: input.type,
      SOURCE_URL: input.sourceUrl ?? null,
      REFRESH_MIN: input.refreshMin ?? 60,
      LAST_SYNC: null,
      SYNC_ERROR: null,
      VISIBLE_YN: 'Y',
      READONLY_YN: yn(input.readonly ?? input.type === 'ICS'),
      ALARM_YN: yn(input.alarm ?? true),
      DEFAULT_YN: yn(input.isDefault ?? false),
      FEED_TOKEN: null,
      SORT_ORDER: Number(max?.m ?? 0) + 1,
      REG_DATE: now,
      UPDATE_DATE: now,
    })
    .executeTakeFirst();
  return Number(result.insertId);
}

export async function updateCalendar(
  calendarId: number,
  patch: Partial<{
    name: string;
    color: string;
    sourceUrl: string | null;
    refreshMin: number;
    visible: boolean;
    readonly: boolean;
    alarm: boolean;
    isDefault: boolean;
    feedToken: string | null;
    lastSync: Date | null;
    syncError: string | null;
    sortOrder: number;
  }>,
): Promise<void> {
  const values: Record<string, unknown> = { UPDATE_DATE: new Date() };
  if (patch.name !== undefined) values.CAL_NAME = patch.name;
  if (patch.color !== undefined) values.CAL_COLOR = patch.color;
  if (patch.sourceUrl !== undefined) values.SOURCE_URL = patch.sourceUrl;
  if (patch.refreshMin !== undefined) values.REFRESH_MIN = patch.refreshMin;
  if (patch.visible !== undefined) values.VISIBLE_YN = yn(patch.visible);
  if (patch.readonly !== undefined) values.READONLY_YN = yn(patch.readonly);
  if (patch.alarm !== undefined) values.ALARM_YN = yn(patch.alarm);
  if (patch.isDefault !== undefined) values.DEFAULT_YN = yn(patch.isDefault);
  if (patch.feedToken !== undefined) values.FEED_TOKEN = patch.feedToken;
  if (patch.lastSync !== undefined) values.LAST_SYNC = patch.lastSync;
  if (patch.syncError !== undefined) values.SYNC_ERROR = patch.syncError;
  if (patch.sortOrder !== undefined) values.SORT_ORDER = patch.sortOrder;
  await dbWrite.updateTable('CAL_CALENDAR').set(values).where('CALENDAR_ID', '=', calendarId).execute();
}

/** 기본 캘린더는 한 사람에 하나다 */
export async function setDefaultCalendar(userName: string, calendarId: number): Promise<void> {
  await dbWrite
    .updateTable('CAL_CALENDAR')
    .set({ DEFAULT_YN: sql<string>`CASE WHEN CALENDAR_ID = ${calendarId} THEN 'Y' ELSE 'N' END` })
    .where('USER_NAME', '=', userName)
    .execute();
}

export async function deleteCalendar(calendarId: number): Promise<void> {
  const ids = await dbWrite
    .selectFrom('CAL_ITEM')
    .select('ITEM_ID')
    .where('CALENDAR_ID', '=', calendarId)
    .execute();
  await deleteItems(ids.map((r) => r.ITEM_ID));
  await dbWrite.deleteFrom('CAL_CALENDAR').where('CALENDAR_ID', '=', calendarId).execute();
}

// ------------------------------------------------------------------ 설정 · 분류

export const DEFAULT_SETTING: Omit<SettingRecord, 'timezone'> = {
  weekStart: 0,
  daysOff: [0, 6],
  dayStartHour: 8,
  dayEndHour: 17,
  visibleHours: 12,
  multiweekCount: 4,
  prevWeeks: 0,
  weekNumbers: true,
  defaultLengthMin: 60,
  defaultAlarmMin: -1,
  alarmSound: true,
  alarmPopup: true,
  missedAlarms: true,
};

export async function getSetting(userName: string): Promise<SettingRecord | null> {
  const row = await db.selectFrom('CAL_SETTING').selectAll().where('USER_NAME', '=', userName).executeTakeFirst();
  if (!row) return null;
  return {
    timezone: row.TIMEZONE,
    weekStart: row.WEEK_START,
    daysOff: splitList(row.DAYS_OFF)
      .map(Number)
      .filter((n) => n >= 0 && n <= 6),
    dayStartHour: row.DAY_START_HOUR,
    dayEndHour: row.DAY_END_HOUR,
    visibleHours: row.VISIBLE_HOURS,
    multiweekCount: row.MULTIWEEK_COUNT,
    prevWeeks: row.PREV_WEEKS,
    weekNumbers: isY(row.WEEKNUM_YN),
    defaultLengthMin: row.DEFAULT_LENGTH_MIN,
    defaultAlarmMin: row.DEFAULT_ALARM_MIN,
    alarmSound: isY(row.ALARM_SOUND_YN),
    alarmPopup: isY(row.ALARM_POPUP_YN),
    missedAlarms: isY(row.MISSED_ALARM_YN),
  };
}

export async function saveSetting(userName: string, s: SettingRecord): Promise<void> {
  const values = {
    TIMEZONE: s.timezone,
    WEEK_START: s.weekStart,
    DAYS_OFF: s.daysOff.join(','),
    DAY_START_HOUR: s.dayStartHour,
    DAY_END_HOUR: s.dayEndHour,
    VISIBLE_HOURS: s.visibleHours,
    MULTIWEEK_COUNT: s.multiweekCount,
    PREV_WEEKS: s.prevWeeks,
    WEEKNUM_YN: yn(s.weekNumbers),
    DEFAULT_LENGTH_MIN: s.defaultLengthMin,
    DEFAULT_ALARM_MIN: s.defaultAlarmMin,
    ALARM_SOUND_YN: yn(s.alarmSound),
    ALARM_POPUP_YN: yn(s.alarmPopup),
    MISSED_ALARM_YN: yn(s.missedAlarms),
    UPDATE_DATE: new Date(),
  };
  await dbWrite
    .insertInto('CAL_SETTING')
    .values({ USER_NAME: userName, ...values })
    .onDuplicateKeyUpdate(values)
    .execute();
}

/** 최근 초대한 참석자. 내 일정에 넣은 주소를 일정을 고친 시각이 늦은 순으로, 주소당 한 번 */
export async function recentAttendees(userName: string, limit = 10): Promise<{ email: string; name: string | null }[]> {
  const rows = await db
    .selectFrom('CAL_ATTENDEE as a')
    .innerJoin('CAL_ITEM as i', 'i.ITEM_ID', 'a.ITEM_ID')
    .select(['a.EMAIL', sql<string | null>`MAX(a.ATT_NAME)`.as('NAME'), sql<Date>`MAX(i.UPDATE_DATE)`.as('LAST_AT')])
    .where('i.USER_NAME', '=', userName)
    .where('a.EMAIL', '<>', userName.toLowerCase())
    .groupBy('a.EMAIL')
    .orderBy('LAST_AT', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ email: r.EMAIL, name: r.NAME }));
}

export async function listCategories(userName: string): Promise<CategoryRecord[]> {
  const rows = await db
    .selectFrom('CAL_CATEGORY')
    .select(['CATEGORY_NAME', 'CATEGORY_COLOR'])
    .where('USER_NAME', '=', userName)
    .orderBy('SORT_ORDER')
    .orderBy('CATEGORY_NAME')
    .execute();
  return rows.map((r) => ({ name: r.CATEGORY_NAME, color: r.CATEGORY_COLOR }));
}

export async function replaceCategories(userName: string, list: CategoryRecord[]): Promise<void> {
  await dbWrite.transaction().execute(async (trx) => {
    await trx.deleteFrom('CAL_CATEGORY').where('USER_NAME', '=', userName).execute();
    if (list.length) {
      await trx
        .insertInto('CAL_CATEGORY')
        .values(
          list.map((c, i) => ({ USER_NAME: userName, CATEGORY_NAME: c.name, CATEGORY_COLOR: c.color, SORT_ORDER: i })),
        )
        .execute();
    }
  });
}

// ------------------------------------------------------------------ 항목

type ItemRow = Omit<CalItem, 'START_UTC' | 'END_UTC' | 'RANGE_END_UTC' | 'COMPLETED_DATE' | 'REG_DATE' | 'UPDATE_DATE'> & {
  COMPLETED_DATE: Date | null;
  REG_DATE: Date;
  UPDATE_DATE: Date;
};

const ITEM_COLUMNS = [
  'ITEM_ID',
  'CALENDAR_ID',
  'USER_NAME',
  'ITEM_TYPE',
  'ICAL_UID',
  'PARENT_ID',
  'RECURRENCE_ID',
  'TITLE',
  'LOCATION',
  'DESCRIPTION',
  'ITEM_URL',
  'ALL_DAY_YN',
  'TZID',
  'START_LOCAL',
  'END_LOCAL',
  'DUE_LOCAL',
  'COMPLETED_DATE',
  'PERCENT_DONE',
  'STATUS',
  'PRIORITY',
  'PRIVACY',
  'TRANSP',
  'RRULE',
  'EXDATES',
  'CATEGORIES',
  'ORGANIZER',
  'SEQUENCE_NO',
  'DAV_NAME',
  'EXTRA_PROPS',
  'REG_DATE',
  'UPDATE_DATE',
] as const;

function toItem(row: ItemRow): ItemRecord {
  return {
    itemId: row.ITEM_ID,
    calendarId: Number(row.CALENDAR_ID),
    userName: row.USER_NAME,
    type: row.ITEM_TYPE === 'T' ? 'T' : 'E',
    uid: row.ICAL_UID,
    parentId: row.PARENT_ID,
    recurrenceId: row.RECURRENCE_ID,
    title: row.TITLE,
    location: row.LOCATION,
    description: row.DESCRIPTION,
    url: row.ITEM_URL,
    allDay: isY(row.ALL_DAY_YN),
    tzid: row.TZID,
    start: row.START_LOCAL,
    end: row.END_LOCAL,
    due: row.DUE_LOCAL,
    completed: row.COMPLETED_DATE ? new Date(row.COMPLETED_DATE) : null,
    percent: row.PERCENT_DONE,
    status: row.STATUS,
    priority: row.PRIORITY,
    privacy: row.PRIVACY,
    transp: row.TRANSP,
    rrule: row.RRULE,
    exdates: splitList(row.EXDATES),
    categories: splitList(row.CATEGORIES),
    organizer: row.ORGANIZER,
    sequence: row.SEQUENCE_NO,
    regDate: new Date(row.REG_DATE),
    updateDate: new Date(row.UPDATE_DATE),
    davName: row.DAV_NAME,
    extraProps: row.EXTRA_PROPS ? row.EXTRA_PROPS.split('\n') : null,
  };
}

function itemValues(item: ItemRecord, index: ItemIndex) {
  return {
    CALENDAR_ID: item.calendarId,
    USER_NAME: item.userName,
    ITEM_TYPE: item.type,
    ICAL_UID: item.uid,
    PARENT_ID: item.parentId,
    RECURRENCE_ID: item.recurrenceId,
    TITLE: item.title.slice(0, 500),
    LOCATION: item.location?.slice(0, 500) || null,
    DESCRIPTION: item.description || null,
    ITEM_URL: item.url?.slice(0, 1000) || null,
    ALL_DAY_YN: yn(item.allDay),
    TZID: item.tzid,
    START_LOCAL: item.start,
    END_LOCAL: item.end,
    DUE_LOCAL: item.due,
    START_UTC: index.startUtc,
    END_UTC: index.endUtc,
    RANGE_END_UTC: index.rangeEndUtc,
    COMPLETED_DATE: item.completed,
    PERCENT_DONE: item.percent,
    STATUS: item.status,
    PRIORITY: item.priority,
    PRIVACY: item.privacy,
    TRANSP: item.transp,
    RRULE: item.rrule,
    EXDATES: item.exdates.length ? item.exdates.join(',') : null,
    // 분류 이름 안의 쉼표는 구분자와 겹치므로 미리 걷어 낸다 (services 가 넣을 때 정리한다)
    CATEGORIES: item.categories.length ? item.categories.join(',').slice(0, 1000) : null,
    ORGANIZER: item.organizer,
    SEQUENCE_NO: item.sequence,
    UPDATE_DATE: item.updateDate,
    ...(item.davName !== undefined ? { DAV_NAME: item.davName?.slice(0, 255) || null } : {}),
    ...(item.extraProps !== undefined ? { EXTRA_PROPS: item.extraProps?.length ? item.extraProps.join('\n') : null } : {}),
  };
}

/** 항목과 딸린 행(참석자 · 알림 · 첨부)을 한 번에 쓴다. 알림은 같은 것은 남겨 회차별 상태를 지킨다 */
export async function saveItem(item: ItemFull, index: ItemIndex, isNew: boolean): Promise<void> {
  await dbWrite.transaction().execute(async (trx) => {
    if (isNew) {
      await trx
        .insertInto('CAL_ITEM')
        .values({ ITEM_ID: item.itemId, REG_DATE: item.regDate, ...itemValues(item, index) })
        .execute();
    } else {
      await trx.updateTable('CAL_ITEM').set(itemValues(item, index)).where('ITEM_ID', '=', item.itemId).execute();
    }

    await trx.deleteFrom('CAL_ATTENDEE').where('ITEM_ID', '=', item.itemId).execute();
    const seen = new Set<string>();
    const attendees = item.attendees.filter((a) => {
      const key = a.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (attendees.length) {
      await trx
        .insertInto('CAL_ATTENDEE')
        .values(
          attendees.map((a) => ({
            ITEM_ID: item.itemId,
            EMAIL: a.email.toLowerCase(),
            ATT_NAME: a.name,
            ATT_ROLE: a.role,
            PARTSTAT: a.partstat,
            RSVP_YN: yn(a.rsvp),
          })),
        )
        .execute();
    }

    const existing = await trx
      .selectFrom('CAL_ALARM')
      .select(['ALARM_ID', 'OFFSET_MIN', 'RELATED'])
      .where('ITEM_ID', '=', item.itemId)
      .execute();
    const wanted = new Map(item.alarms.map((a) => [`${a.offsetMin}|${a.related}`, a]));
    const drop: number[] = [];
    for (const row of existing) {
      const key = `${row.OFFSET_MIN}|${row.RELATED}`;
      if (wanted.has(key)) wanted.delete(key);
      else drop.push(Number(row.ALARM_ID));
    }
    if (drop.length) {
      await trx.deleteFrom('CAL_ALARM_STATE').where('ALARM_ID', 'in', drop).execute();
      await trx.deleteFrom('CAL_ALARM').where('ALARM_ID', 'in', drop).execute();
    }
    if (wanted.size) {
      await trx
        .insertInto('CAL_ALARM')
        .values([...wanted.values()].map((a) => ({ ITEM_ID: item.itemId, OFFSET_MIN: a.offsetMin, RELATED: a.related })))
        .execute();
    }

    await trx.deleteFrom('CAL_ATTACH').where('ITEM_ID', '=', item.itemId).execute();
    if (item.attachments.length) {
      await trx
        .insertInto('CAL_ATTACH')
        .values(item.attachments.map((a) => ({ ITEM_ID: item.itemId, ATTACH_URL: a.url, ATTACH_NAME: a.name })))
        .execute();
    }
  });
}

export async function deleteItems(itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  await dbWrite.transaction().execute(async (trx) => {
    for (let i = 0; i < itemIds.length; i += 500) {
      const chunk = itemIds.slice(i, i + 500);
      const alarms = await trx.selectFrom('CAL_ALARM').select('ALARM_ID').where('ITEM_ID', 'in', chunk).execute();
      if (alarms.length) {
        await trx
          .deleteFrom('CAL_ALARM_STATE')
          .where(
            'ALARM_ID',
            'in',
            alarms.map((a) => Number(a.ALARM_ID)),
          )
          .execute();
      }
      await trx.deleteFrom('CAL_ALARM').where('ITEM_ID', 'in', chunk).execute();
      await trx.deleteFrom('CAL_ATTENDEE').where('ITEM_ID', 'in', chunk).execute();
      await trx.deleteFrom('CAL_ATTACH').where('ITEM_ID', 'in', chunk).execute();
      await trx.deleteFrom('CAL_ITEM').where('ITEM_ID', 'in', chunk).execute();
    }
  });
}

/** 딸린 행을 붙인다. 목록은 한 번에 묶어 읽는다 */
export async function withChildren(items: ItemRecord[], reader = db): Promise<ItemFull[]> {
  if (!items.length) return [];
  const ids = items.map((i) => i.itemId);
  const [attendees, alarms, attachments] = await Promise.all([
    reader.selectFrom('CAL_ATTENDEE').selectAll().where('ITEM_ID', 'in', ids).execute(),
    reader.selectFrom('CAL_ALARM').selectAll().where('ITEM_ID', 'in', ids).orderBy('OFFSET_MIN', 'desc').execute(),
    reader.selectFrom('CAL_ATTACH').selectAll().where('ITEM_ID', 'in', ids).orderBy('ATTACH_ID').execute(),
  ]);
  return items.map((item) => ({
    ...item,
    attendees: attendees
      .filter((a) => a.ITEM_ID === item.itemId)
      .map((a) => ({ email: a.EMAIL, name: a.ATT_NAME, role: a.ATT_ROLE, partstat: a.PARTSTAT, rsvp: isY(a.RSVP_YN) })),
    alarms: alarms
      .filter((a) => a.ITEM_ID === item.itemId)
      .map((a) => ({ alarmId: Number(a.ALARM_ID), offsetMin: a.OFFSET_MIN, related: a.RELATED === 'E' ? 'E' : 'S' })),
    attachments: attachments
      .filter((a) => a.ITEM_ID === item.itemId)
      .map((a) => ({ url: a.ATTACH_URL, name: a.ATTACH_NAME })),
  }));
}

/**
 * 한 건. 방금 쓴 것을 곧바로 다시 읽는 경로(저장 → 초대 발송)가 있어 쓰기 풀에서 읽는다 —
 * 읽기 풀은 커넥션이 달라 커밋 직후 값을 놓치지는 않지만, 쓰기 경로와 한 풀에 두는 편이 단순하다.
 */
export async function getItem(userName: string, itemId: string): Promise<ItemFull | null> {
  const row = await dbWrite
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('ITEM_ID', '=', itemId)
    .executeTakeFirst();
  if (!row) return null;
  return (await withChildren([toItem(row as ItemRow)], dbWrite))[0]!;
}

/** 같은 UID 의 원본 + 예외 회차 전부 */
export async function findByUid(userName: string, uid: string): Promise<ItemFull[]> {
  const rows = await dbWrite
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('ICAL_UID', '=', uid)
    .execute();
  return withChildren(rows.map((r) => toItem(r as ItemRow)), dbWrite);
}

export async function exceptionsOf(parentIds: string[]): Promise<ItemRecord[]> {
  if (!parentIds.length) return [];
  const rows = await db.selectFrom('CAL_ITEM').select(ITEM_COLUMNS).where('PARENT_ID', 'in', parentIds).execute();
  return rows.map((r) => toItem(r as ItemRow));
}

/**
 * 기간에 걸칠 수 있는 항목. 반복 원본은 끝(RANGE_END_UTC)이 없거나 기간 뒤에 있으면 걸린다.
 * 날짜가 하나도 없는 태스크(START_UTC NULL)는 기간 보기에 나오지 않는다.
 */
export async function queryRange(
  userName: string,
  fromUtc: Date,
  toUtc: Date,
  options: { type?: 'E' | 'T'; calendarIds?: number[] } = {},
): Promise<ItemRecord[]> {
  let query = db
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('START_UTC', 'is not', null)
    .where('START_UTC', '<', toUtc)
    .where((eb) => eb.or([eb('RANGE_END_UTC', 'is', null), eb('RANGE_END_UTC', '>=', fromUtc)]));
  if (options.type) query = query.where('ITEM_TYPE', '=', options.type);
  if (options.calendarIds) {
    if (!options.calendarIds.length) return [];
    query = query.where('CALENDAR_ID', 'in', options.calendarIds);
  }
  const rows = await query.limit(20_000).execute();
  return rows.map((r) => toItem(r as ItemRow));
}

/** 반복이든 아니든 원본만 (예외 회차 제외). 목록 보기 "모든 이벤트" · 태스크 목록 */
export async function listMasters(
  userName: string,
  options: { type?: 'E' | 'T'; calendarId?: number; afterUtc?: Date } = {},
): Promise<ItemRecord[]> {
  let query = db
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('PARENT_ID', 'is', null);
  if (options.type) query = query.where('ITEM_TYPE', '=', options.type);
  if (options.calendarId !== undefined) query = query.where('CALENDAR_ID', '=', options.calendarId);
  if (options.afterUtc) {
    const after = options.afterUtc;
    query = query.where((eb) => eb.or([eb('RANGE_END_UTC', 'is', null), eb('RANGE_END_UTC', '>=', after)]));
  }
  const rows = await query.orderBy('START_UTC').limit(20_000).execute();
  return rows.map((r) => toItem(r as ItemRow));
}

/** 캘린더 하나의 항목 전부 (내보내기 · 게시) */
export async function listCalendarItems(calendarId: number): Promise<ItemFull[]> {
  const rows = await db
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('CALENDAR_ID', '=', calendarId)
    .limit(50_000)
    .execute();
  return withChildren(rows.map((r) => toItem(r as ItemRow)));
}

export async function listItemsByIds(userName: string, itemIds: string[]): Promise<ItemFull[]> {
  if (!itemIds.length) return [];
  const rows = await db
    .selectFrom('CAL_ITEM')
    .select(ITEM_COLUMNS)
    .where('USER_NAME', '=', userName)
    .where('ITEM_ID', 'in', itemIds)
    .execute();
  return withChildren(rows.map((r) => toItem(r as ItemRow)));
}

/** CalDAV 목록용 가벼운 행. 본문 없이 자원 이름 · ETag · 기간만 계산한다 (services/caldav.ts) */
export interface DavRow {
  itemId: string;
  uid: string;
  parentId: string | null;
  davName: string | null;
  type: 'E' | 'T';
  sequence: number;
  updateMs: number;
  startUtc: Date | null;
  rangeEndUtc: Date | null;
}

/** 방금 쓴 것을 바로 다시 읽는 경로(PUT → ETag)가 있어 쓰기 풀에서 읽는다 (getItem 과 같다) */
export async function davRows(calendarId: number): Promise<DavRow[]> {
  const rows = await dbWrite
    .selectFrom('CAL_ITEM')
    .select(['ITEM_ID', 'ICAL_UID', 'PARENT_ID', 'DAV_NAME', 'ITEM_TYPE', 'SEQUENCE_NO', 'UPDATE_DATE', 'START_UTC', 'RANGE_END_UTC'])
    .where('CALENDAR_ID', '=', calendarId)
    .limit(50_000)
    .execute();
  return rows.map((r) => ({
    itemId: r.ITEM_ID,
    uid: r.ICAL_UID,
    parentId: r.PARENT_ID,
    davName: r.DAV_NAME,
    type: r.ITEM_TYPE === 'T' ? 'T' : 'E',
    sequence: r.SEQUENCE_NO,
    updateMs: new Date(r.UPDATE_DATE as Date).getTime(),
    startUtc: r.START_UTC ? new Date(r.START_UTC as Date) : null,
    rangeEndUtc: r.RANGE_END_UTC ? new Date(r.RANGE_END_UTC as Date) : null,
  }));
}

/** 캘린더 하나에서 UID 들의 원본 + 예외 회차 (CalDAV GET · multiget) */
export async function listCalendarItemsByUids(calendarId: number, uids: string[]): Promise<ItemFull[]> {
  if (!uids.length) return [];
  const out: ItemRecord[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const rows = await dbWrite
      .selectFrom('CAL_ITEM')
      .select(ITEM_COLUMNS)
      .where('CALENDAR_ID', '=', calendarId)
      .where('ICAL_UID', 'in', uids.slice(i, i + 500))
      .execute();
    out.push(...rows.map((r) => toItem(r as ItemRow)));
  }
  return withChildren(out, dbWrite);
}

/** 알림이 달린 항목 중 알림을 켠 캘린더 것 */
export async function itemsWithAlarms(userName: string, fromUtc: Date, toUtc: Date): Promise<ItemFull[]> {
  const rows = await db
    .selectFrom('CAL_ITEM as i')
    .innerJoin('CAL_CALENDAR as c', 'c.CALENDAR_ID', 'i.CALENDAR_ID')
    .select(ITEM_COLUMNS.map((c) => `i.${c}` as const))
    .where('i.USER_NAME', '=', userName)
    .where('c.ALARM_YN', '=', 'Y')
    .where('i.START_UTC', 'is not', null)
    .where('i.START_UTC', '<', toUtc)
    .where((eb) => eb.or([eb('i.RANGE_END_UTC', 'is', null), eb('i.RANGE_END_UTC', '>=', fromUtc)]))
    .where((eb) =>
      eb.exists(eb.selectFrom('CAL_ALARM as a').select('a.ALARM_ID').whereRef('a.ITEM_ID', '=', 'i.ITEM_ID')),
    )
    .limit(5_000)
    .execute();
  return withChildren(rows.map((r) => toItem(r as unknown as ItemRow)));
}

export interface AlarmStateRecord {
  alarmId: number;
  occurKey: string;
  snoozeUntil: Date | null;
  dismissed: boolean;
}

export async function alarmStates(alarmIds: number[]): Promise<AlarmStateRecord[]> {
  if (!alarmIds.length) return [];
  const rows = await db.selectFrom('CAL_ALARM_STATE').selectAll().where('ALARM_ID', 'in', alarmIds).execute();
  return rows.map((r) => ({
    alarmId: Number(r.ALARM_ID),
    occurKey: r.OCCUR_KEY,
    snoozeUntil: r.SNOOZE_UNTIL ? new Date(r.SNOOZE_UNTIL) : null,
    dismissed: isY(r.DISMISSED_YN),
  }));
}

/** 알림 상태를 쓴다. 남의 알림을 건드리지 못하게 소유자 확인을 같이 한다 */
export async function setAlarmState(
  userName: string,
  entries: { alarmId: number; occurKey: string }[],
  state: { snoozeUntil: Date | null; dismissed: boolean },
): Promise<void> {
  if (!entries.length) return;
  const owned = await dbWrite
    .selectFrom('CAL_ALARM as a')
    .innerJoin('CAL_ITEM as i', 'i.ITEM_ID', 'a.ITEM_ID')
    .select('a.ALARM_ID')
    .where('i.USER_NAME', '=', userName)
    .where(
      'a.ALARM_ID',
      'in',
      entries.map((e) => e.alarmId),
    )
    .execute();
  const ok = new Set(owned.map((r) => Number(r.ALARM_ID)));
  const now = new Date();
  for (const entry of entries.filter((e) => ok.has(e.alarmId))) {
    const values = { SNOOZE_UNTIL: state.snoozeUntil, DISMISSED_YN: yn(state.dismissed), UPDATE_DATE: now };
    await dbWrite
      .insertInto('CAL_ALARM_STATE')
      .values({ ALARM_ID: entry.alarmId, OCCUR_KEY: entry.occurKey, ...values })
      .onDuplicateKeyUpdate(values)
      .execute();
  }
}
