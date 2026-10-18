/**
 * 캘린더 · 태스크 (썬더버드 캘린더 기능).
 *
 * - 반복 일정은 원본 한 행 + 예외 회차 행(PARENT_ID · RECURRENCE_ID)으로 저장하고, 화면이 달라는
 *   기간만큼 여기서 펼친다. 펼친 결과는 사용자 화면 시간대(CAL_SETTING.TIMEZONE)의 벽시계다.
 * - 반복 일정 고치기 · 지우기는 썬더버드와 같은 세 범위를 받는다:
 *     this      이 회차만 (예외 회차를 만들거나 EXDATE 를 더한다)
 *     following 이 회차와 이후 (원본을 이 회차 앞에서 끊고 새 반복을 만든다)
 *     all       전체
 * - 초대 메일은 services/calendarItip.ts 가 보낸다. 여기 쓰기 함수들은 무엇이 바뀌었는지(UID)만 돌려준다.
 */
import { badRequest, forbidden, notFound } from '../errors.js';
import { uuidv7 } from '../util/uuidv7.js';
import * as repo from '../repositories/calendar.js';
import type { CalendarRecord, ItemFull, ItemIndex, ItemRecord, SettingRecord } from '../repositories/calendar.js';
import {
  DAY,
  MINUTE,
  convertWall,
  formatWall,
  isDateOnly,
  isValidTimeZone,
  isWall,
  parseWall,
  utcToWall,
  wallToUtc,
} from '../calendar/time.js';
import { formatExdates, formatRule, lastOccurrence, occurrences, parseExdates, parseRule, untilWall } from '../calendar/recur.js';
import * as users from '../repositories/users.js';
import * as aliases from '../repositories/aliases.js';
import { t, type Locale } from '../i18n.js';

export type Scope = 'this' | 'following' | 'all';

export const CALENDAR_COLORS = ['#3b82f6', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#64748b'];

const FALLBACK_TZ = 'Asia/Seoul';
/** 한 번에 펼쳐 돌려주는 회차 상한. 화면이 이보다 많이 그릴 일은 없다 */
const MAX_OCCURRENCES = 5_000;

// ------------------------------------------------------------------ 입력 · 출력 모양

export interface AttendeeInput {
  email: string;
  name: string | null;
  role: string;
  partstat: string;
  rsvp: boolean;
}

export interface ItemInput {
  type: 'E' | 'T';
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
  alarms: { offsetMin: number; related: 'S' | 'E' }[];
  attendees: AttendeeInput[];
  attachments: { url: string; name: string | null }[];
}

/** 화면에 그릴 회차 하나. start · end 는 화면 시간대 벽시계 (종일이면 날짜, end 는 다음 날) */
export interface Occurrence {
  id: string;
  itemId: string;
  /** 반복 회차의 원래 시작 (일정 시간대 벽시계). 반복이 아니면 null */
  occurrence: string | null;
  type: 'E' | 'T';
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

export interface WriteResult {
  itemId: string;
  /** 초대를 다시 보낼 대상 */
  uids: string[];
}

// ------------------------------------------------------------------ 공통 도우미

const MANAGED_STATUSES: Record<'E' | 'T', string[]> = {
  E: ['TENTATIVE', 'CONFIRMED', 'CANCELLED'],
  T: ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'],
};

/** 내가 From 으로 쓸 수 있는 주소 (계정 + 살아 있는 알리아스) */
export async function myAddresses(userName: string): Promise<Set<string>> {
  const sendable = await aliases.listSendableAliases(userName).catch(() => []);
  return new Set([userName.toLowerCase(), ...sendable.map((a) => a.address.toLowerCase())]);
}

export function cleanCategories(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.replace(/,/g, ' ').trim().slice(0, 100);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, 50);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 일정 벽시계 → UTC ms. 종일은 떠 있는 날짜라 UTC 로 착각한 값을 그대로 쓴다 (조회 쪽이 하루씩 넓힌다) */
function toUtcMs(wall: string, item: Pick<ItemRecord, 'allDay' | 'tzid'>): number {
  const ms = parseWall(wall);
  return item.allDay || isDateOnly(wall) ? ms : wallToUtc(ms, item.tzid);
}

/** 기간 조회용 색인 (START_UTC · END_UTC · RANGE_END_UTC) */
export function computeIndex(item: ItemRecord): ItemIndex {
  const base = item.start ?? item.due;
  if (!base) return { startUtc: null, endUtc: null, rangeEndUtc: null };
  const endWall = item.type === 'E' ? (item.end ?? base) : (item.due ?? base);
  const startUtc = toUtcMs(base, item);
  const endUtc = Math.max(startUtc, toUtcMs(endWall, item));
  let rangeEnd: number | null = endUtc;
  if (item.rrule && !item.parentId) {
    const rule = parseRule(item.rrule);
    if (rule) {
      const last = lastOccurrence(parseWall(base), rule, item.tzid, parseExdates(item.exdates.join(',')));
      rangeEnd = last === null ? null : toUtcMs(formatWall(last, item.allDay), item) + (endUtc - startUtc);
    }
  }
  return {
    startUtc: new Date(startUtc),
    endUtc: new Date(endUtc),
    rangeEndUtc: rangeEnd === null ? null : new Date(rangeEnd),
  };
}

function durationMs(item: ItemRecord): number {
  const base = item.start ?? item.due;
  if (!base) return 0;
  const endWall = item.type === 'E' ? item.end : item.start && item.due ? item.due : null;
  if (!endWall) return item.allDay && item.type === 'E' ? DAY : 0;
  return Math.max(0, parseWall(endWall) - parseWall(base));
}

// ------------------------------------------------------------------ 설정 · 캘린더

export async function settingsOf(userName: string, browserTz?: string): Promise<SettingRecord> {
  const found = await repo.getSetting(userName);
  if (found) return found;
  const created: SettingRecord = {
    ...repo.DEFAULT_SETTING,
    timezone: browserTz && isValidTimeZone(browserTz) ? browserTz : FALLBACK_TZ,
  };
  await repo.saveSetting(userName, created);
  return created;
}

export async function displayTzOf(userName: string): Promise<string> {
  const s = await repo.getSetting(userName);
  return s && isValidTimeZone(s.timezone) ? s.timezone : FALLBACK_TZ;
}

/** 캘린더가 하나도 없으면 기본 "홈" 캘린더를 만든다 (썬더버드 첫 실행과 같다) */
export async function calendarsOf(userName: string, locale: Locale): Promise<CalendarRecord[]> {
  let list = await repo.listCalendars(userName);
  if (!list.length) {
    await repo.createCalendar(userName, {
      name: t(locale, 'cal.defaultName'),
      color: CALENDAR_COLORS[0]!,
      type: 'LOCAL',
      isDefault: true,
    });
    list = await repo.listCalendars(userName);
  }
  if (!list.some((c) => c.isDefault)) {
    const first = list.find((c) => !c.readonly) ?? list[0]!;
    await repo.setDefaultCalendar(userName, first.calendarId);
    list = await repo.listCalendars(userName);
  }
  return list;
}

export async function requireCalendar(userName: string, calendarId: number, writable = false): Promise<CalendarRecord> {
  const cal = await repo.findCalendar(userName, calendarId);
  if (!cal) throw notFound('err.calNotFound');
  if (writable && cal.readonly) throw forbidden('err.calReadonly');
  return cal;
}

export async function defaultCalendar(userName: string, locale: Locale): Promise<CalendarRecord> {
  const list = await calendarsOf(userName, locale);
  return list.find((c) => c.isDefault && !c.readonly) ?? list.find((c) => !c.readonly) ?? list[0]!;
}

// ------------------------------------------------------------------ 입력 검증

/** 브라우저가 보낸 항목을 저장할 모양으로. 시각 형식 · 순서 · 반복 규칙을 여기서 바로잡는다 */
export function normalizeInput(input: ItemInput): Omit<
  ItemRecord,
  'itemId' | 'userName' | 'uid' | 'parentId' | 'recurrenceId' | 'exdates' | 'organizer' | 'sequence' | 'regDate' | 'updateDate'
> & Pick<ItemFull, 'attendees' | 'alarms' | 'attachments'> {
  if (!isValidTimeZone(input.tzid)) throw badRequest('err.calBadTimezone');
  const fix = (value: string | null): string | null => {
    if (!value) return null;
    if (!isWall(value)) throw badRequest('err.calBadTime');
    return input.allDay ? value.slice(0, 10) : value.length === 10 ? `${value}T00:00` : value;
  };
  let start = fix(input.start);
  let end = fix(input.end);
  let due = fix(input.due);

  if (input.type === 'E') {
    if (!start) throw badRequest('err.calBadTime');
    if (!end) end = input.allDay ? formatWall(parseWall(start) + DAY, true) : start;
    if (parseWall(end) < parseWall(start)) throw badRequest('err.calEndBeforeStart');
    // 종일 일정의 끝은 다음 날이다(DTEND 배타). 같은 날이면 하루로 늘린다
    if (input.allDay && parseWall(end) === parseWall(start)) end = formatWall(parseWall(start) + DAY, true);
    due = null;
  } else {
    end = null;
    if (start && due && parseWall(due) < parseWall(start)) throw badRequest('err.calEndBeforeStart');
  }

  let rrule: string | null = null;
  if (input.rrule) {
    const rule = parseRule(input.rrule);
    if (!rule) throw badRequest('err.calBadRule');
    if (!(start ?? due)) throw badRequest('err.calBadRule');
    // RFC 5545: DTSTART 가 시간대를 가지면 UNTIL 은 UTC 다. 화면은 그날 끝(벽시계)을 보내므로 여기서 바꾼다
    if (rule.until && input.allDay) rule.until = rule.until.slice(0, 8);
    else if (rule.until && /^\d{8}T\d{6}$/.test(rule.until)) {
      const local = untilWall(rule.until, input.tzid);
      if (local !== null) rule.until = new Date(wallToUtc(local, input.tzid)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    }
    rrule = formatRule(rule);
  }

  let status = input.status && MANAGED_STATUSES[input.type].includes(input.status) ? input.status : null;
  let percent = Math.max(0, Math.min(100, Math.round(input.percent)));
  let completed: Date | null = null;
  if (input.type === 'T') {
    if (status === 'COMPLETED' || percent === 100) {
      status = 'COMPLETED';
      percent = 100;
      const at = input.completed ? new Date(input.completed) : new Date();
      completed = Number.isNaN(at.getTime()) ? new Date() : at;
    } else if (percent > 0 && !status) status = 'IN-PROCESS';
  } else percent = 0;

  return {
    calendarId: input.calendarId,
    type: input.type,
    title: input.title.trim().slice(0, 500),
    location: input.location.trim() || null,
    description: input.description || null,
    url: input.url.trim() && isHttpUrl(input.url.trim()) ? input.url.trim() : null,
    allDay: input.allDay,
    tzid: input.tzid,
    start,
    end,
    due,
    completed,
    percent,
    status,
    priority: [0, 1, 5, 9].includes(input.priority) ? input.priority : 0,
    privacy: ['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(input.privacy) ? input.privacy : 'PUBLIC',
    transp: input.transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE',
    rrule,
    categories: cleanCategories(input.categories),
    attendees: input.attendees.map((a) => ({
      email: a.email.trim().toLowerCase(),
      name: a.name?.trim() || null,
      role: ['REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT', 'CHAIR'].includes(a.role) ? a.role : 'REQ-PARTICIPANT',
      partstat: ['NEEDS-ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED', 'DELEGATED'].includes(a.partstat)
        ? a.partstat
        : 'NEEDS-ACTION',
      rsvp: a.rsvp,
    })),
    alarms: dedupeAlarms(input.alarms),
    attachments: input.attachments.filter((a) => isHttpUrl(a.url)).map((a) => ({ url: a.url, name: a.name || null })),
  };
}

export function dedupeAlarms(list: { offsetMin: number; related: 'S' | 'E' }[]): { offsetMin: number; related: 'S' | 'E' }[] {
  const seen = new Set<string>();
  return list
    .filter((a) => {
      const key = `${a.offsetMin}|${a.related}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

// ------------------------------------------------------------------ 펼치기

interface ExpandContext {
  fromUtc: number;
  toUtc: number;
  /** 종일 일정 비교용 화면 시간대 벽시계 */
  fromWall: number;
  toWall: number;
  displayTz: string;
}

function toOccurrence(item: ItemFull | ItemRecord, occ: string | null, startOut: string, endOut: string, extras: { hasAlarm: boolean; attendees: number }, displayTz: string): Occurrence {
  return {
    id: `${item.itemId}|${occ ?? ''}`,
    itemId: item.itemId,
    occurrence: occ,
    type: item.type,
    calendarId: item.calendarId,
    title: item.title,
    location: item.location,
    start: startOut,
    end: endOut,
    allDay: item.allDay,
    due: item.due ? (item.allDay ? item.due : convertWall(item.due, item.tzid, displayTz)) : null,
    categories: item.categories,
    status: item.status,
    privacy: item.privacy,
    transp: item.transp,
    priority: item.priority,
    percent: item.percent,
    completed: Boolean(item.completed) || item.status === 'COMPLETED',
    recurring: Boolean(item.rrule) || Boolean(item.parentId),
    exception: Boolean(item.parentId),
    ...extras,
    organizer: item.organizer,
  };
}

/** 한 항목을 기간 안 회차들로. exceptionKeys 는 예외 행이 따로 있는 회차라 원본에서는 건너뛴다 */
function expandItem(item: ItemFull, exceptionKeys: Set<string>, ctx: ExpandContext, out: Occurrence[]): void {
  const base = item.start ?? item.due;
  if (!base) return;
  const extras = { hasAlarm: item.alarms.length > 0, attendees: item.attendees.length };
  const length = durationMs(item);

  const emit = (startWall: number, key: string | null) => {
    if (item.type === 'T') {
      // 태스크는 기간이 아니라 한 점(기한, 없으면 시작)에 놓는다 — 썬더버드 보기와 같다
      const point = startWall + length;
      const visible = item.allDay
        ? point >= ctx.fromWall && point < ctx.toWall
        : wallToUtc(point, item.tzid) >= ctx.fromUtc && wallToUtc(point, item.tzid) < ctx.toUtc;
      if (!visible) return;
      const shown = item.allDay ? formatWall(point, true) : formatWall(utcToWall(wallToUtc(point, item.tzid), ctx.displayTz));
      out.push({ ...toOccurrence(item, key, shown, shown, extras, ctx.displayTz), due: item.due ? shown : null });
      return;
    }
    if (item.allDay) {
      const endWall = startWall + Math.max(length, item.type === 'E' ? DAY : 0);
      const visible = item.type === 'E' ? startWall < ctx.toWall && endWall > ctx.fromWall : startWall >= ctx.fromWall && startWall < ctx.toWall;
      if (!visible) return;
      out.push(toOccurrence(item, key, formatWall(startWall, true), formatWall(endWall, true), extras, ctx.displayTz));
      return;
    }
    const s = wallToUtc(startWall, item.tzid);
    const e = wallToUtc(startWall + length, item.tzid);
    const visible = e > s ? s < ctx.toUtc && e > ctx.fromUtc : s >= ctx.fromUtc && s < ctx.toUtc;
    if (!visible) return;
    out.push(
      toOccurrence(item, key, formatWall(utcToWall(s, ctx.displayTz)), formatWall(utcToWall(e, ctx.displayTz)), extras, ctx.displayTz),
    );
  };

  const rule = !item.parentId && item.rrule ? parseRule(item.rrule) : null;
  if (!rule) {
    emit(parseWall(base), item.parentId ? item.recurrenceId : null);
    return;
  }
  const windowEnd = item.allDay ? ctx.toWall + DAY : utcToWall(ctx.toUtc, item.tzid) + DAY;
  for (const at of occurrences({
    start: parseWall(base),
    rule,
    tz: item.tzid,
    exdates: parseExdates(item.exdates.join(',')),
    windowEnd,
  })) {
    const key = formatWall(at, item.allDay);
    if (exceptionKeys.has(key)) continue;
    emit(at, key);
    if (out.length > MAX_OCCURRENCES) return;
  }
}

function matchesQuery(item: ItemRecord, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [item.title, item.location ?? '', item.description ?? '', item.categories.join(' ')].some((v) =>
    v.toLowerCase().includes(needle),
  );
}

/**
 * 기간 [from, to) 의 회차들. from · to 는 화면 시간대의 날짜('YYYY-MM-DD') 또는 벽시계.
 * 숨긴 캘린더도 함께 돌려준다 — 체크를 껐다 켤 때 다시 조회하지 않고 화면이 거른다.
 */
export async function occurrencesInRange(
  userName: string,
  range: { from: string; to: string; q?: string; type?: 'E' | 'T'; displayTz?: string; calendarIds?: number[] },
): Promise<Occurrence[]> {
  const displayTz = range.displayTz ?? (await displayTzOf(userName));
  const fromWall = parseWall(range.from);
  const toWall = parseWall(range.to);
  const ctx: ExpandContext = {
    fromWall,
    toWall,
    fromUtc: wallToUtc(fromWall, displayTz),
    toUtc: wallToUtc(toWall, displayTz),
    displayTz,
  };
  // 종일 일정은 UTC 로 착각한 값으로 색인돼 있어 하루씩 넉넉히 읽고 정확한 비교는 펼치며 한다
  const rows = await repo.queryRange(userName, new Date(ctx.fromUtc - DAY), new Date(ctx.toUtc + DAY), {
    type: range.type,
    calendarIds: range.calendarIds,
  });
  const filtered = rows.filter((r) => matchesQuery(r, range.q));
  const full = await repo.withChildren(filtered);
  const masters = full.filter((i) => i.rrule && !i.parentId).map((i) => i.itemId);
  const keys = new Map<string, Set<string>>();
  for (const ex of await repo.exceptionsOf(masters)) {
    if (!ex.parentId || !ex.recurrenceId) continue;
    if (!keys.has(ex.parentId)) keys.set(ex.parentId, new Set());
    keys.get(ex.parentId)!.add(ex.recurrenceId);
  }
  const out: Occurrence[] = [];
  for (const item of full) {
    expandItem(item, keys.get(item.itemId) ?? new Set(), ctx, out);
    if (out.length > MAX_OCCURRENCES) break;
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
}

/**
 * 반복을 펼치지 않은 목록 (목록 보기의 "모든 이벤트" · "앞으로의 모든 이벤트").
 * after 가 있으면 반복 일정은 그 뒤 첫 회차를 보여 준다.
 */
export async function seriesList(userName: string, options: { q?: string; after?: string }): Promise<Occurrence[]> {
  const displayTz = await displayTzOf(userName);
  const afterUtc = options.after ? wallToUtc(parseWall(options.after), displayTz) : null;
  const rows = (
    await repo.listMasters(userName, { type: 'E', afterUtc: afterUtc === null ? undefined : new Date(afterUtc) })
  ).filter((r) => matchesQuery(r, options.q));
  const full = await repo.withChildren(rows.slice(0, 3_000));
  const out: Occurrence[] = [];
  for (const item of full) {
    if (!item.start) continue;
    const extras = { hasAlarm: item.alarms.length > 0, attendees: item.attendees.length };
    let startWall = parseWall(item.start);
    let key: string | null = null;
    const rule = item.rrule ? parseRule(item.rrule) : null;
    if (rule && afterUtc !== null) {
      const afterWall = item.allDay ? utcToWall(afterUtc, displayTz) : utcToWall(afterUtc, item.tzid);
      for (const at of occurrences({ start: startWall, rule, tz: item.tzid, exdates: parseExdates(item.exdates.join(',')), windowEnd: Number.MAX_SAFE_INTEGER })) {
        if (at + durationMs(item) > afterWall) {
          startWall = at;
          break;
        }
      }
    }
    if (rule) key = formatWall(startWall, item.allDay);
    const endWall = startWall + durationMs(item);
    if (item.allDay) {
      out.push(toOccurrence(item, key, formatWall(startWall, true), formatWall(endWall, true), extras, displayTz));
    } else {
      out.push(
        toOccurrence(
          item,
          key,
          formatWall(utcToWall(wallToUtc(startWall, item.tzid), displayTz)),
          formatWall(utcToWall(wallToUtc(endWall, item.tzid), displayTz)),
          extras,
          displayTz,
        ),
      );
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** 태스크 목록. 거르기는 화면이 한다 (썬더버드 태스크 탭의 필터는 즉시 바뀐다) */
export async function taskList(userName: string): Promise<TaskRow[]> {
  const displayTz = await displayTzOf(userName);
  const full = await repo.withChildren(await repo.listMasters(userName, { type: 'T' }));
  const show = (item: ItemRecord, wall: string | null) =>
    wall ? (item.allDay || isDateOnly(wall) ? wall : convertWall(wall, item.tzid, displayTz)) : null;
  return full.map((item) => ({
    itemId: item.itemId,
    calendarId: item.calendarId,
    title: item.title,
    location: item.location,
    description: item.description,
    start: show(item, item.start),
    due: show(item, item.due),
    allDay: item.allDay,
    completed: item.completed ? item.completed.toISOString() : null,
    percent: item.percent,
    status: item.status,
    priority: item.priority,
    categories: item.categories,
    recurring: Boolean(item.rrule),
    hasAlarm: item.alarms.length > 0,
  }));
}

// ------------------------------------------------------------------ 한 건 읽기

export interface ItemDetail extends ItemFull {
  /** 반복 원본이면 예외 회차들의 원래 자리 */
  exceptions: string[];
  /** 내가 주최자인가 (초대를 보낼 수 있는가) */
  isOrganizer: boolean;
}

export async function itemDetail(userName: string, itemId: string): Promise<ItemDetail> {
  const item = await repo.getItem(userName, itemId);
  if (!item) throw notFound('err.calItemNotFound');
  const exceptions = item.rrule && !item.parentId ? await repo.exceptionsOf([item.itemId]) : [];
  const mine = await myAddresses(userName);
  return {
    ...item,
    exceptions: exceptions.map((e) => e.recurrenceId).filter((v): v is string => Boolean(v)),
    isOrganizer: !item.organizer || mine.has(item.organizer.toLowerCase()),
  };
}

// ------------------------------------------------------------------ 쓰기

async function persist(item: ItemFull, isNew: boolean): Promise<void> {
  await repo.saveItem(item, computeIndex(item), isNew);
}

function newUid(): string {
  return `${uuidv7()}@james9mail`;
}

export async function createItem(userName: string, input: ItemInput): Promise<WriteResult> {
  await requireCalendar(userName, input.calendarId, true);
  const data = normalizeInput(input);
  const now = new Date();
  const item: ItemFull = {
    ...data,
    itemId: uuidv7(),
    userName,
    uid: newUid(),
    parentId: null,
    recurrenceId: null,
    exdates: [],
    organizer: data.attendees.length ? userName : null,
    sequence: 0,
    regDate: now,
    updateDate: now,
  };
  await persist(item, true);
  return { itemId: item.itemId, uids: [item.uid] };
}

async function loadOwned(userName: string, itemId: string): Promise<{ item: ItemFull; master: ItemFull }> {
  const item = await repo.getItem(userName, itemId);
  if (!item) throw notFound('err.calItemNotFound');
  const master = item.parentId ? await repo.getItem(userName, item.parentId) : item;
  if (!master) throw notFound('err.calItemNotFound');
  await requireCalendar(userName, master.calendarId, true);
  return { item, master };
}

function assertOccurrenceKey(master: ItemRecord, occurrence: string | null | undefined): string {
  if (!occurrence || !isWall(occurrence) || isDateOnly(occurrence) !== master.allDay) throw badRequest('err.calBadScope');
  return occurrence;
}

const startOfDayWall = (ms: number) => Math.floor(ms / DAY) * DAY;

/**
 * 반복 전체를 다른 요일 · 날짜로 끌어 옮기면 규칙의 요일(BYDAY) · 날짜(BYMONTHDAY)도 같은 날수만큼 민다.
 * 그대로 두면 "매주 월요일" 을 화요일로 옮겨도 월요일에 계속 생긴다.
 */
function shiftRuleDays(rrule: string | null, days: number): string | null {
  const rule = parseRule(rrule);
  if (!rule || !days) return rrule;
  rule.byDay = rule.byDay.map((d) => ({ ...d, wd: (((d.wd + days) % 7) + 7) % 7 }));
  rule.byMonthDay = rule.byMonthDay.map((d) => (d > 0 ? Math.min(31, Math.max(1, d + days)) : d));
  return formatRule(rule);
}

/** 원본 시작이 delta 만큼 옮겨지면 빠진 회차 · 예외 회차 자리도 같이 옮긴다 */
async function shiftSeriesKeys(userName: string, master: ItemFull, delta: number): Promise<void> {
  if (!delta) return;
  master.exdates = master.exdates.map((v) => formatWall(parseWall(v) + delta, master.allDay));
  for (const ex of await repo.exceptionsOf([master.itemId])) {
    if (!ex.recurrenceId) continue;
    const full = await repo.getItem(userName, ex.itemId);
    if (!full) continue;
    full.recurrenceId = formatWall(parseWall(ex.recurrenceId) + delta, master.allDay);
    full.updateDate = new Date();
    await persist(full, false);
  }
}

/** 반복을 occurrence 앞에서 끊는다. 이 회차 이후의 예외 · 빠진 회차는 버린다 */
async function truncateSeries(userName: string, master: ItemFull, occurrence: string): Promise<void> {
  const rule = parseRule(master.rrule);
  if (!rule) return;
  const cut = parseWall(occurrence);
  // UNTIL 은 UTC 로 적는다 (RFC 5545: DTSTART 가 TZID 를 가지면 UNTIL 은 UTC)
  rule.count = null;
  if (master.allDay) rule.until = formatWall(cut - DAY, true).replace(/-/g, '');
  else {
    const utc = new Date(wallToUtc(cut, master.tzid) - MINUTE);
    rule.until = utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  master.rrule = formatRule(rule);
  master.exdates = master.exdates.filter((v) => parseWall(v) < cut);
  master.sequence += 1;
  master.updateDate = new Date();
  await persist(master, false);
  const drop = (await repo.exceptionsOf([master.itemId])).filter((e) => e.recurrenceId && parseWall(e.recurrenceId) >= cut);
  await repo.deleteItems(drop.map((e) => e.itemId));
}

/** 원본을 그대로 베낀 예외 회차 (아직 저장 전) */
function exceptionFrom(master: ItemFull, occurrence: string): ItemFull {
  const length = durationMs(master);
  const startWall = parseWall(occurrence);
  const now = new Date();
  const isTask = master.type === 'T';
  const fmt = (ms: number) => formatWall(ms, master.allDay);
  return {
    ...master,
    itemId: uuidv7(),
    parentId: master.itemId,
    recurrenceId: occurrence,
    rrule: null,
    exdates: [],
    start: isTask && !master.start ? null : fmt(startWall),
    end: isTask ? null : fmt(startWall + length),
    due: isTask && master.due ? fmt(master.start ? startWall + length : startWall) : null,
    attendees: master.attendees.map((a) => ({ ...a })),
    alarms: master.alarms.map(({ offsetMin, related }) => ({ offsetMin, related })),
    attachments: master.attachments.map((a) => ({ ...a })),
    regDate: now,
    updateDate: now,
  };
}

/**
 * 고치기. 범위가 all 이면 input 은 원본 값(대화상자가 원본을 열었다), this · following 이면 그 회차 값이다.
 */
export async function updateItem(
  userName: string,
  itemId: string,
  input: ItemInput,
  scope: Scope,
  occurrence: string | null,
): Promise<WriteResult> {
  const { item, master } = await loadOwned(userName, itemId);
  const data = normalizeInput(input);
  if (data.calendarId !== master.calendarId) await requireCalendar(userName, data.calendarId, true);
  const now = new Date();
  const recurring = Boolean(master.rrule);
  const organizer = master.organizer ?? (data.attendees.length ? userName : null);

  // 반복이 아닌 일정 · 예외 회차 하나 · 원본 전체
  if (!recurring || scope === 'all' || (item.parentId && scope === 'this')) {
    const target = scope === 'all' ? master : item;
    const before = target.start ?? target.due;
    const next: ItemFull = {
      ...target,
      ...data,
      // 예외 회차는 반복 규칙을 갖지 않는다
      rrule: target.parentId ? null : data.rrule,
      organizer,
      sequence: target.sequence + 1,
      updateDate: now,
    };
    if (!target.parentId && recurring) {
      const after = next.start ?? next.due;
      if (target.allDay !== next.allDay) {
        // 종일 ↔ 시각 일정으로 바뀌면 회차 자리 형식이 달라진다. 예외 · 빠진 회차는 맞출 수 없어 버린다
        next.exdates = [];
        await repo.deleteItems((await repo.exceptionsOf([target.itemId])).map((e) => e.itemId));
      } else if (before && after) {
        const fromWall = target.tzid === next.tzid ? before : convertWall(before, target.tzid, next.tzid);
        await shiftSeriesKeys(userName, next, parseWall(after) - parseWall(fromWall));
      }
    }
    await persist(next, false);
    // 다른 캘린더로 옮기면 예외 회차도 같이 간다
    if (!target.parentId && next.calendarId !== target.calendarId) await moveExceptions(userName, next.itemId, next.calendarId);
    return { itemId: next.itemId, uids: [next.uid] };
  }

  const key = item.parentId ? item.recurrenceId! : assertOccurrenceKey(master, occurrence);

  if (scope === 'this') {
    const ex: ItemFull = {
      ...exceptionFrom(master, key),
      ...data,
      rrule: null,
      calendarId: master.calendarId,
      organizer,
      sequence: master.sequence + 1,
    };
    await persist(ex, true);
    master.sequence += 1;
    master.updateDate = now;
    await persist(master, false);
    return { itemId: ex.itemId, uids: [master.uid] };
  }

  // following: 이 회차부터는 새 반복이다. 원본 시작과 같으면 전체 고치기와 같다
  if (master.start && parseWall(key) <= parseWall(master.start)) {
    return updateItem(userName, master.itemId, input, 'all', null);
  }
  await truncateSeries(userName, master, key);
  const fresh: ItemFull = {
    ...data,
    itemId: uuidv7(),
    userName,
    uid: newUid(),
    parentId: null,
    recurrenceId: null,
    exdates: [],
    organizer,
    sequence: 0,
    regDate: now,
    updateDate: now,
  };
  await persist(fresh, true);
  return { itemId: fresh.itemId, uids: [master.uid, fresh.uid] };
}

async function moveExceptions(userName: string, masterId: string, calendarId: number): Promise<void> {
  for (const ex of await repo.exceptionsOf([masterId])) {
    const full = await repo.getItem(userName, ex.itemId);
    if (!full) continue;
    full.calendarId = calendarId;
    full.updateDate = new Date();
    await persist(full, false);
  }
}

/**
 * 끌어서 옮기기 · 길이 바꾸기. start · end 는 화면 시간대 벽시계다.
 * 반복 일정의 all 은 "이 회차가 옮겨진 만큼 전체를 옮긴다" 이다 (썬더버드와 같다).
 */
export async function moveItem(
  userName: string,
  itemId: string,
  move: { start: string; end: string | null; allDay: boolean; scope: Scope; occurrence: string | null },
): Promise<WriteResult> {
  const { item, master } = await loadOwned(userName, itemId);
  const displayTz = await displayTzOf(userName);
  if (!isWall(move.start) || (move.end && !isWall(move.end))) throw badRequest('err.calBadTime');

  // 예외가 아닌 항목이면 item 과 master 는 같은 객체다 — 비교 대신 범위로 가른다
  const wholeSeries = Boolean(master.rrule) && !item.parentId && move.scope !== 'this';
  const target = wholeSeries ? master : item;
  const toTarget = (wall: string) =>
    move.allDay ? wall.slice(0, 10) : convertWall(wall.length === 10 ? `${wall}T00:00` : wall, displayTz, target.tzid);
  let newStart = toTarget(move.start);
  let newEnd = move.end ? toTarget(move.end) : null;
  if (move.allDay && newEnd && parseWall(newEnd) <= parseWall(newStart)) newEnd = formatWall(parseWall(newStart) + DAY, true);
  if (newEnd && parseWall(newEnd) < parseWall(newStart)) newEnd = newStart;

  const apply = (row: ItemFull, startWall: string, endWall: string | null, allDay: boolean): ItemFull => {
    const next = { ...row, allDay, sequence: row.sequence + 1, updateDate: new Date() };
    if (row.type === 'E') {
      next.start = startWall;
      next.end = endWall ?? startWall;
    } else {
      // 태스크는 시작 · 기한을 같은 만큼 민다. 기한만 있으면 기한이 옮겨진다
      const base = row.start ?? row.due;
      const delta = base ? parseWall(startWall) - parseWall(base) : 0;
      const fmt = (v: string | null) => (v ? formatWall(parseWall(v) + delta, allDay) : null);
      next.start = fmt(row.start);
      next.due = fmt(row.due);
    }
    return next;
  };

  if (wholeSeries) {
    // 전체 옮기기: 회차가 옮겨진 만큼
    if (move.allDay !== master.allDay) throw badRequest('err.calBadScope');
    const key = assertOccurrenceKey(master, move.occurrence);
    const delta = parseWall(newStart) - parseWall(key);
    const base = master.start ?? master.due!;
    const length = newEnd ? parseWall(newEnd) - parseWall(newStart) : durationMs(master);
    const shiftedStart = formatWall(parseWall(base) + delta, master.allDay);
    const next = apply(master, shiftedStart, master.type === 'E' ? formatWall(parseWall(shiftedStart) + length, master.allDay) : null, master.allDay);
    next.rrule = shiftRuleDays(next.rrule, Math.round((startOfDayWall(parseWall(key) + delta) - startOfDayWall(parseWall(key))) / DAY));
    await shiftSeriesKeys(userName, next, delta);
    await persist(next, false);
    return { itemId: master.itemId, uids: [master.uid] };
  }

  if (master.rrule && !item.parentId) {
    // 이 회차만: 예외 회차를 새로 만든다
    const key = assertOccurrenceKey(master, move.occurrence);
    const ex = apply(exceptionFrom(master, key), newStart, newEnd, move.allDay);
    ex.sequence = master.sequence + 1;
    await persist(ex, true);
    return { itemId: ex.itemId, uids: [master.uid] };
  }

  const next = apply(item, newStart, newEnd, move.allDay);
  await persist(next, false);
  return { itemId: next.itemId, uids: [next.uid] };
}

export interface QuickPatch {
  categories?: string[];
  status?: string | null;
  percent?: number;
  priority?: number;
  privacy?: string;
  calendarId?: number;
  completed?: boolean;
}

/** 메뉴 · 체크박스로 바꾸는 값 (분류 · 상태 · 진행률 · 우선순위 · 캘린더 이동 · 완료) */
export async function quickPatch(
  userName: string,
  itemId: string,
  patch: QuickPatch,
  scope: Scope,
  occurrence: string | null,
): Promise<WriteResult> {
  const { item, master } = await loadOwned(userName, itemId);
  if (patch.calendarId !== undefined) await requireCalendar(userName, patch.calendarId, true);
  let target: ItemFull;
  let isNew = false;
  if (master.rrule && !item.parentId && scope === 'this' && patch.calendarId === undefined) {
    target = exceptionFrom(master, assertOccurrenceKey(master, occurrence));
    isNew = true;
  } else {
    target = patch.calendarId !== undefined || scope === 'all' ? master : item;
  }
  const next: ItemFull = { ...target, sequence: target.sequence + 1, updateDate: new Date() };
  if (patch.categories) next.categories = cleanCategories(patch.categories);
  if (patch.status !== undefined) next.status = patch.status && MANAGED_STATUSES[next.type].includes(patch.status) ? patch.status : null;
  if (patch.priority !== undefined && [0, 1, 5, 9].includes(patch.priority)) next.priority = patch.priority;
  if (patch.privacy && ['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(patch.privacy)) next.privacy = patch.privacy;
  if (patch.percent !== undefined) {
    next.percent = Math.max(0, Math.min(100, Math.round(patch.percent)));
    if (next.percent === 100) patch.completed = true;
    else if (next.status === 'COMPLETED') {
      next.status = next.percent > 0 ? 'IN-PROCESS' : 'NEEDS-ACTION';
      next.completed = null;
    }
  }
  if (patch.completed !== undefined && next.type === 'T') {
    if (patch.completed) {
      next.completed = next.completed ?? new Date();
      next.percent = 100;
      next.status = 'COMPLETED';
    } else {
      next.completed = null;
      if (next.percent === 100) next.percent = 0;
      if (next.status === 'COMPLETED') next.status = 'NEEDS-ACTION';
    }
  }
  if (patch.status === 'COMPLETED' && next.type === 'T') {
    next.completed = next.completed ?? new Date();
    next.percent = 100;
  }
  if (patch.calendarId !== undefined) next.calendarId = patch.calendarId;
  await persist(next, isNew);
  if (patch.calendarId !== undefined && !next.parentId) await moveExceptions(userName, next.itemId, patch.calendarId);
  return { itemId: next.itemId, uids: [master.uid] };
}

export interface DeleteResult {
  /** 남은 반복이 있어 갱신 초대(REQUEST)를 보낼 UID */
  updated: string[];
  /** 통째로 지워져 취소(CANCEL)를 보낼 묶음. 지우기 전에 읽어 둔 것이다 */
  cancelled: ItemFull[][];
}

export async function deleteItem(
  userName: string,
  itemId: string,
  scope: Scope,
  occurrence: string | null,
): Promise<DeleteResult> {
  const { item, master } = await loadOwned(userName, itemId);
  const series = async () => [master, ...(await repo.withChildren(await repo.exceptionsOf([master.itemId])))];

  if (!master.rrule && !item.parentId) {
    await repo.deleteItems([item.itemId]);
    return { updated: [], cancelled: [[item]] };
  }

  if (scope === 'all') {
    const all = await series();
    await repo.deleteItems(all.map((i) => i.itemId));
    return { updated: [], cancelled: [all] };
  }

  const key = item.parentId ? item.recurrenceId! : assertOccurrenceKey(master, occurrence);

  if (scope === 'following') {
    if (master.start && parseWall(key) <= parseWall(master.start)) return deleteItem(userName, master.itemId, 'all', null);
    await truncateSeries(userName, master, key);
    return { updated: [master.uid], cancelled: [] };
  }

  // this: 빠진 회차로 남긴다. 예외 행이 있으면 같이 지운다
  const ex = (await repo.exceptionsOf([master.itemId])).find((e) => e.recurrenceId === key);
  if (ex) await repo.deleteItems([ex.itemId]);
  master.exdates = (formatExdates([...parseExdates(master.exdates.join(',')), parseWall(key)], master.allDay) ?? '')
    .split(',')
    .filter(Boolean);
  master.sequence += 1;
  master.updateDate = new Date();
  await persist(master, false);
  return { updated: [master.uid], cancelled: [] };
}

// ------------------------------------------------------------------ 알림

export interface DueAlarm {
  alarmId: number;
  occurrence: string;
  itemId: string;
  type: 'E' | 'T';
  calendarId: number;
  title: string;
  location: string | null;
  /** 화면 시간대 벽시계 */
  start: string | null;
  allDay: boolean;
  fireAt: string;
}

/**
 * 지금 울려야 하는 알림. 썬더버드처럼
 *  - 놓친 알림(앱을 닫아 둔 사이 시각이 지난 것)도 설정이 켜져 있으면 보여 주고,
 *  - 항목을 마지막으로 고친 때보다 앞선 알림은 띄우지 않는다 (X-MOZ-LASTACK 와 같은 생각 —
 *    지난 일정을 새로 만들거나 고쳤다고 알림이 쏟아지면 안 된다).
 */
export async function dueAlarms(userName: string, now = new Date()): Promise<DueAlarm[]> {
  const settings = await repo.getSetting(userName);
  const displayTz = settings && isValidTimeZone(settings.timezone) ? settings.timezone : FALLBACK_TZ;
  const lookback = settings?.missedAlarms === false ? 15 * MINUTE : 7 * DAY;
  const nowMs = now.getTime();
  // 알림은 길어야 몇 주 앞이다. 그만큼 앞뒤를 넉넉히 훑는다
  const items = await repo.itemsWithAlarms(userName, new Date(nowMs - 8 * DAY), new Date(nowMs + 60 * DAY));
  const states = await repo.alarmStates(items.flatMap((i) => i.alarms.map((a) => a.alarmId!)));
  const stateOf = new Map(states.map((s) => [`${s.alarmId}|${s.occurKey}`, s]));
  const masters = items.filter((i) => i.rrule && !i.parentId).map((i) => i.itemId);
  const exKeys = new Map<string, Set<string>>();
  for (const ex of await repo.exceptionsOf(masters)) {
    if (ex.parentId && ex.recurrenceId) {
      if (!exKeys.has(ex.parentId)) exKeys.set(ex.parentId, new Set());
      exKeys.get(ex.parentId)!.add(ex.recurrenceId);
    }
  }

  const due: DueAlarm[] = [];
  for (const item of items) {
    if (item.status === 'CANCELLED' || (item.type === 'T' && (item.completed || item.status === 'COMPLETED'))) continue;
    const base = item.start ?? item.due;
    if (!base) continue;
    const length = durationMs(item);
    const maxOffset = Math.max(0, ...item.alarms.map((a) => a.offsetMin)) * MINUTE;
    const rule = item.rrule && !item.parentId ? parseRule(item.rrule) : null;
    const starts: number[] = [];
    if (rule) {
      const windowEnd = utcToWall(nowMs + maxOffset + DAY, item.allDay ? displayTz : item.tzid);
      for (const at of occurrences({ start: parseWall(base), rule, tz: item.tzid, exdates: parseExdates(item.exdates.join(',')), windowEnd })) {
        if (!exKeys.get(item.itemId)?.has(formatWall(at, item.allDay))) starts.push(at);
      }
    } else starts.push(parseWall(base));

    for (const startWall of starts) {
      const key = item.parentId ? item.recurrenceId ?? formatWall(startWall, item.allDay) : formatWall(startWall, item.allDay);
      // 종일 일정은 화면 시간대의 그날 0시를 기준으로 울린다
      const toUtc = (wall: number) => wallToUtc(wall, item.allDay ? displayTz : item.tzid);
      for (const alarm of item.alarms) {
        const anchorWall = alarm.related === 'E' ? startWall + length : startWall;
        // 태스크의 "끝" 은 기한이다. 시작만 있는 태스크면 시작으로 본다
        const anchor = item.type === 'T' && alarm.related === 'E' && item.due && item.start
          ? toUtc(parseWall(item.due) + (startWall - parseWall(item.start)))
          : toUtc(anchorWall);
        const fireAt = anchor - alarm.offsetMin * MINUTE;
        const state = stateOf.get(`${alarm.alarmId}|${key}`);
        if (state?.dismissed) continue;
        let fire = false;
        if (state?.snoozeUntil) fire = state.snoozeUntil.getTime() <= nowMs;
        else fire = fireAt <= nowMs && fireAt >= nowMs - lookback && fireAt >= item.updateDate.getTime() - MINUTE;
        if (!fire) continue;
        due.push({
          alarmId: alarm.alarmId!,
          occurrence: key,
          itemId: item.itemId,
          type: item.type,
          calendarId: item.calendarId,
          title: item.title,
          location: item.location,
          start: item.allDay ? formatWall(startWall, true) : formatWall(utcToWall(toUtc(startWall), displayTz)),
          allDay: item.allDay,
          fireAt: new Date(state?.snoozeUntil?.getTime() ?? fireAt).toISOString(),
        });
      }
    }
  }
  return due.sort((a, b) => (a.fireAt < b.fireAt ? -1 : 1)).slice(0, 200);
}

// ------------------------------------------------------------------ 일정 확인 (Free/Busy)

export interface BusyBlock {
  start: string;
  end: string;
  tentative: boolean;
}

/**
 * 참석자 일정 확인. 같은 서버 사용자만 알 수 있다 — 시각만 주고 제목 · 장소는 내주지 않는다.
 * 한가함(TRANSPARENT) · 취소된 일정은 바쁨으로 치지 않는다.
 */
export async function freeBusy(
  userName: string,
  emails: string[],
  from: string,
  to: string,
): Promise<Record<string, { known: boolean; busy: BusyBlock[] }>> {
  const displayTz = await displayTzOf(userName);
  const out: Record<string, { known: boolean; busy: BusyBlock[] }> = {};
  for (const raw of emails.slice(0, 50)) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const user = await users.findUser(email);
    if (!user || (user.status ?? 'Y').toUpperCase() === 'N') {
      out[email] = { known: false, busy: [] };
      continue;
    }
    const list = await occurrencesInRange(user.userName, { from, to, type: 'E', displayTz });
    out[email] = {
      known: true,
      busy: list
        .filter((o) => o.transp !== 'TRANSPARENT' && o.status !== 'CANCELLED')
        .map((o) => ({ start: o.start, end: o.end, tentative: o.status === 'TENTATIVE' })),
    };
  }
  return out;
}
