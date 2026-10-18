/**
 * 캘린더 시각 계산.
 *
 * 일정 시각은 "그 일정의 시간대(TZID) 벽시계" 로 저장한다 ('2026-10-07T09:00', 종일은 '2026-10-07').
 * 계산할 때는 벽시계를 **UTC 로 착각한 밀리초**(wall ms)로 바꿔 Date.UTC 산술만 쓴다 —
 * 서버 프로세스의 시간대나 서머타임 경계가 날짜 덧셈에 끼어들지 않는다.
 * 실제 순간(UTC)이 필요할 때만 Intl 로 시간대 오프셋을 구해 바꾼다.
 */

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export function isWall(value: string): boolean {
  return WALL_RE.test(value);
}

/** 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:mm' → wall ms */
export function parseWall(value: string): number {
  const m = WALL_RE.exec(value);
  if (!m) throw new Error(`bad wall time: ${value}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** wall ms → 'YYYY-MM-DDTHH:mm' (dateOnly 면 'YYYY-MM-DD') */
export function formatWall(ms: number, dateOnly = false): string {
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return dateOnly ? date : `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function isDateOnly(value: string): boolean {
  return value.length === 10;
}

// ------------------------------------------------------------------ 시간대

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, found);
  }
  return found;
}

/** IANA 시간대 이름인지. 아니면 Intl 이 RangeError 를 던진다 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    formatterOf(tz);
    return true;
  } catch {
    return false;
  }
}

/** 그 순간 그 시간대가 UTC 보다 몇 분 앞서는가 */
export function offsetMinutes(tz: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asWall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((asWall - Math.floor(utcMs / 1000) * 1000) / MINUTE);
}

/** 그 시간대 벽시계 → UTC 순간. 서머타임으로 비는 시각은 뒤쪽으로 밀린다 */
export function wallToUtc(wallMs: number, tz: string): number {
  if (tz === 'UTC') return wallMs;
  const first = wallMs - offsetMinutes(tz, wallMs) * MINUTE;
  return wallMs - offsetMinutes(tz, first) * MINUTE;
}

export function utcToWall(utcMs: number, tz: string): number {
  if (tz === 'UTC') return utcMs;
  return utcMs + offsetMinutes(tz, utcMs) * MINUTE;
}

/** 다른 시간대의 벽시계로 옮긴다 (종일 값은 날짜 그대로 둔다 — 떠 있는 날짜다) */
export function convertWall(value: string, fromTz: string, toTz: string): string {
  if (isDateOnly(value) || fromTz === toTz) return value;
  return formatWall(utcToWall(wallToUtc(parseWall(value), fromTz), toTz));
}

/** 윈도 시간대 이름 몇 가지. 아웃룩 초대가 TZID 에 이 이름을 싣는다 */
const WINDOWS_ZONES: Record<string, string> = {
  'korea standard time': 'Asia/Seoul',
  'tokyo standard time': 'Asia/Tokyo',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'aus eastern standard time': 'Australia/Sydney',
};

/** iCalendar TZID 를 IANA 이름으로. 모르는 이름이면 fallback */
export function normalizeTimeZone(tzid: string | null | undefined, fallback: string): string {
  if (!tzid) return fallback;
  // "/mozilla.org/20050126_1/Asia/Seoul" 처럼 앞에 접두가 붙어 오기도 한다
  const cleaned = tzid.replace(/^"|"$/g, '').trim();
  if (isValidTimeZone(cleaned)) return cleaned;
  const tail = cleaned.match(/([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/)?.[1];
  if (tail && isValidTimeZone(tail)) return tail;
  return WINDOWS_ZONES[cleaned.toLowerCase()] ?? fallback;
}

// ------------------------------------------------------------------ 달력 산술

export function addDays(wallMs: number, days: number): number {
  return wallMs + days * DAY;
}

export function addMonths(wallMs: number, months: number): number {
  const d = new Date(wallMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes());
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** 0 일요일 … 6 토요일 */
export function weekday(wallMs: number): number {
  return new Date(wallMs).getUTCDay();
}

export function startOfDay(wallMs: number): number {
  return Math.floor(wallMs / DAY) * DAY;
}
