/**
 * 벽시계 문자열 산술 ('YYYY-MM-DD' · 'YYYY-MM-DDTHH:mm').
 *
 * 서버가 화면 시간대로 맞춰 준 값을 그대로 다룬다. 브라우저 시간대가 끼어들지 않도록 Date 는
 * UTC 메서드로만 쓴다 — 로컬 Date 로 하루를 더하면 서머타임 경계에서 23 · 25 시간이 된다.
 */

export const MIN = 60_000;
export const DAY_MS = 24 * 60 * MIN;

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

export function ms(wall: string): number {
  const m = RE.exec(wall);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function wall(value: number, dateOnly = false): string {
  const d = new Date(value);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return dateOnly ? date : `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const dateOf = (value: string) => value.slice(0, 10);
export const timeOf = (value: string) => (value.length > 10 ? value.slice(11, 16) : '00:00');
export const isDateOnly = (value: string) => value.length === 10;

export function addDays(date: string, days: number): string {
  return wall(ms(date) + days * DAY_MS, isDateOnly(date));
}

export function addMinutes(value: string, minutes: number): string {
  return wall(ms(value) + minutes * MIN);
}

export function addMonths(date: string, months: number): string {
  const d = new Date(ms(date));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), dim));
  return wall(target.getTime(), true);
}

/** 0 일요일 … 6 토요일 */
export function weekdayOf(date: string): number {
  return new Date(ms(date)).getUTCDay();
}

export function startOfWeek(date: string, weekStart: number): string {
  return addDays(dateOf(date), -((weekdayOf(date) - weekStart + 7) % 7));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((ms(dateOf(b)) - ms(dateOf(a))) / DAY_MS);
}

/** ISO 8601 주 번호 (썬더버드 기본) */
export function isoWeek(date: string): number {
  const d = new Date(ms(date));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d.getTime() - firstThursday.getTime()) / DAY_MS;
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** 화면 시간대의 지금 */
export function nowIn(tz: string): string {
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date())) {
      parts[p.type] = p.value;
    }
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return wall(Date.now() - new Date().getTimezoneOffset() * MIN);
  }
}

export const todayIn = (tz: string) => dateOf(nowIn(tz));

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
}

export function minutesOfDay(value: string): number {
  return isDateOnly(value) ? 0 : Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
}

/** 날짜 + 분 → 벽시계 */
export function atMinutes(date: string, minutes: number): string {
  return wall(ms(dateOf(date)) + minutes * MIN);
}

export function rangeOverlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return ms(aStart) < ms(bEnd) && ms(aEnd) > ms(bStart);
}

export function compareWall(a: string, b: string): number {
  return ms(a) - ms(b);
}

// ------------------------------------------------------------------ 표기

function fmt(locale: string, options: Intl.DateTimeFormatOptions, value: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(new Date(ms(value)));
}

export const fmtMonthTitle = (locale: string, date: string) => fmt(locale, { year: 'numeric', month: 'long' }, date);
export const fmtDayTitle = (locale: string, date: string) =>
  fmt(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }, date);
export const fmtShortDate = (locale: string, date: string) => fmt(locale, { month: 'short', day: 'numeric' }, date);
export const fmtDate = (locale: string, date: string) => fmt(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }, date);
export const fmtWeekdayLong = (locale: string, date: string) => fmt(locale, { weekday: 'long' }, date);
export const fmtWeekdayShort = (locale: string, date: string) => fmt(locale, { weekday: 'narrow' }, date);
export const fmtTime = (locale: string, value: string) => fmt(locale, { hour: '2-digit', minute: '2-digit', hour12: false }, value);
export const fmtHour = (locale: string, hour: number) =>
  fmt(locale, { hour: 'numeric', hour12: locale !== 'ko' ? true : false }, `2000-01-01T${pad(hour)}:00`);

export function fmtDateTime(locale: string, value: string): string {
  return isDateOnly(value) ? fmtDate(locale, value) : `${fmtDate(locale, value)} ${fmtTime(locale, value)}`;
}

/** 목록 · 툴팁에 쓰는 기간 표기. 종일 끝(다음 날)은 하루 당겨 보여 준다 */
export function fmtRange(locale: string, start: string, end: string, allDay: boolean): string {
  if (allDay) {
    const last = addDays(end, -1);
    return last > start ? `${fmtDate(locale, start)} ~ ${fmtDate(locale, last)}` : fmtDate(locale, start);
  }
  if (dateOf(start) === dateOf(end)) return `${fmtDate(locale, start)} ${fmtTime(locale, start)} ~ ${fmtTime(locale, end)}`;
  return `${fmtDateTime(locale, start)} ~ ${fmtDateTime(locale, end)}`;
}

/**
 * 화면 한 줄(주)의 주 번호. ISO 주는 월요일에 시작하므로 일요일에 시작하는 줄은 그 줄 한가운데 날의
 * ISO 주를 쓴다 — 썬더버드와 같이 9월 27일(일) ~ 10월 3일(토) 줄이 40주가 된다.
 */
export function weekNumber(date: string, weekStart: number): number {
  return isoWeek(addDays(startOfWeek(date, weekStart), 3));
}
