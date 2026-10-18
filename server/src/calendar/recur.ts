/**
 * 반복 규칙(RRULE, RFC 5545 3.3.10) 펼치기.
 *
 * 썬더버드 반복 대화상자가 만드는 범위를 다룬다:
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
 *   BYDAY(2MO · -1FR 처럼 순번 포함), BYMONTHDAY(음수 포함), BYMONTH, BYSETPOS.
 * 그 밖의 BYxxx(BYHOUR · BYWEEKNO …)는 무시한다 — 가져온 일정이 그런 규칙이면 시작 시각 기준으로만 반복된다.
 *
 * 계산은 전부 벽시계(time.ts 의 wall ms) 위에서 한다. 주의 시작은 RFC 기본값인 월요일(WKST=MO)이다.
 */
import { DAY, addDays, daysInMonth, formatWall, parseWall, startOfDay, utcToWall, weekday } from './time.js';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ByDay {
  /** 0 이면 그 요일 전부, 2 면 둘째, -1 이면 마지막 */
  n: number;
  /** 0 일요일 … 6 토요일 */
  wd: number;
}

export interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  /** RRULE 에 적힌 UNTIL 원문 (20261231 · 20261231T145959Z) */
  until: string | null;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRule(text: string | null | undefined): Rule | null {
  if (!text) return null;
  const parts = new Map<string, string>();
  for (const piece of text.replace(/^RRULE:/i, '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts.set(piece.slice(0, eq).trim().toUpperCase(), piece.slice(eq + 1).trim().toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const ints = (key: string) =>
    (parts.get(key) ?? '')
      .split(',')
      .map((v) => Number.parseInt(v, 10))
      .filter((v) => Number.isFinite(v) && v !== 0);
  const byDay: ByDay[] = [];
  for (const raw of (parts.get('BYDAY') ?? '').split(',')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw.trim());
    if (m) byDay.push({ n: m[1] ? Number.parseInt(m[1], 10) : 0, wd: DAY_CODES.indexOf(m[2]!) });
  }
  const interval = Number.parseInt(parts.get('INTERVAL') ?? '1', 10);
  const count = parts.has('COUNT') ? Number.parseInt(parts.get('COUNT')!, 10) : null;
  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 1000) : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? count : null,
    until: parts.get('UNTIL') ?? null,
    byDay,
    byMonthDay: ints('BYMONTHDAY').filter((v) => Math.abs(v) <= 31),
    byMonth: ints('BYMONTH').filter((v) => v >= 1 && v <= 12),
    bySetPos: ints('BYSETPOS').filter((v) => Math.abs(v) <= 366),
  };
}

export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  else if (rule.until) parts.push(`UNTIL=${rule.until}`);
  if (rule.byDay.length) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.n || ''}${DAY_CODES[d.wd]}`).join(',')}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.bySetPos.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
  return parts.join(';');
}

/**
 * UNTIL 을 일정 시간대 벽시계로. 날짜만 있으면 그날 끝까지 포함한다.
 * UTC(Z) 값은 그 시간대로 옮긴다.
 */
export function untilWall(until: string | null, tz: string): number | null {
  if (!until) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(until);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return Date.UTC(Number(y), Number(mo) - 1, Number(d)) + DAY - 1;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  return z ? utcToWall(ms, tz) : ms;
}

/** 그 달에서 요일 wd 인 날들 (1 부터) */
function weekdaysInMonth(year: number, month0: number, wd: number): number[] {
  const first = weekday(Date.UTC(year, month0, 1));
  const days: number[] = [];
  for (let day = 1 + ((wd - first + 7) % 7); day <= daysInMonth(year, month0); day += 7) days.push(day);
  return days;
}

/** 한 달 안의 후보 날짜(일). 정렬해서 돌려준다 */
function monthDays(rule: Rule, year: number, month0: number, startDay: number): number[] {
  const dim = daysInMonth(year, month0);
  let days: number[];
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
    if (rule.byDay.length) {
      const allowed = new Set(rule.byDay.map((b) => b.wd));
      days = days.filter((d) => allowed.has(weekday(Date.UTC(year, month0, d))));
    }
  } else if (rule.byDay.length) {
    days = [];
    for (const { n, wd } of rule.byDay) {
      const all = weekdaysInMonth(year, month0, wd);
      if (n === 0) days.push(...all);
      else {
        const pick = n > 0 ? all[n - 1] : all[all.length + n];
        if (pick !== undefined) days.push(pick);
      }
    }
  } else {
    days = startDay <= dim ? [startDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function applySetPos(list: number[], setPos: number[]): number[] {
  if (!setPos.length) return list;
  const picked = setPos
    .map((p) => (p > 0 ? list[p - 1] : list[list.length + p]))
    .filter((v): v is number => v !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** 한 주기(period)의 후보 회차들. 주기 번호 i 는 0 부터 */
function periodCandidates(rule: Rule, start: number, i: number): number[] {
  const timeOfDay = start - startOfDay(start);
  const s = new Date(start);
  const sy = s.getUTCFullYear();
  const sm = s.getUTCMonth();
  const sd = s.getUTCDate();
  const monthOk = (ms: number) => !rule.byMonth.length || rule.byMonth.includes(new Date(ms).getUTCMonth() + 1);

  switch (rule.freq) {
    case 'DAILY': {
      const day = addDays(startOfDay(start), i * rule.interval) + timeOfDay;
      const d = new Date(day);
      if (!monthOk(day)) return [];
      if (rule.byMonthDay.length) {
        const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
        const ok = rule.byMonthDay.some((md) => (md > 0 ? md : dim + md + 1) === d.getUTCDate());
        if (!ok) return [];
      }
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === weekday(day))) return [];
      return [day];
    }
    case 'WEEKLY': {
      const weekStart = addDays(startOfDay(start), -((weekday(start) + 6) % 7) + i * rule.interval * 7);
      const wds = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.wd))] : [weekday(start)];
      return wds
        .map((wd) => addDays(weekStart, (wd + 6) % 7) + timeOfDay)
        .filter(monthOk)
        .sort((a, b) => a - b);
    }
    case 'MONTHLY': {
      const total = sm + i * rule.interval;
      const year = sy + Math.floor(total / 12);
      const month0 = ((total % 12) + 12) % 12;
      if (rule.byMonth.length && !rule.byMonth.includes(month0 + 1)) return [];
      const days = applySetPos(monthDays(rule, year, month0, sd), rule.bySetPos);
      return days.map((d) => Date.UTC(year, month0, d) + timeOfDay);
    }
    case 'YEARLY': {
      const year = sy + i * rule.interval;
      const months = rule.byMonth.length ? rule.byMonth.map((m) => m - 1) : [sm];
      const all: number[] = [];
      for (const month0 of months.sort((a, b) => a - b)) {
        for (const d of monthDays(rule, year, month0, sd)) all.push(Date.UTC(year, month0, d) + timeOfDay);
      }
      return applySetPos(all, rule.bySetPos);
    }
  }
}

/** 한 번 펼칠 때 훑는 주기 수 상한. 매일 반복을 100년 펼쳐도 넘지 않는다 */
const MAX_PERIODS = 40_000;

/**
 * 회차 시작(벽시계)을 앞에서부터 차례로 낸다. windowEnd 를 넘으면 멈춘다.
 * DTSTART 는 규칙에 맞지 않아도 첫 회차로 센다 (RFC 5545 3.8.5.3).
 * EXDATE 로 빠진 회차도 COUNT 에는 들어간다.
 */
export function* occurrences(params: {
  start: number;
  rule: Rule;
  tz: string;
  exdates?: Iterable<number>;
  windowEnd: number;
}): Generator<number> {
  const { start, rule, windowEnd } = params;
  const excluded = new Set(params.exdates ?? []);
  const limit = untilWall(rule.until, params.tz);
  let emitted = 0;

  const accept = (at: number): 'stop' | 'skip' | 'yield' => {
    if (limit !== null && at > limit) return 'stop';
    if (at > windowEnd) return 'stop';
    emitted += 1;
    if (rule.count !== null && emitted > rule.count) return 'stop';
    return excluded.has(at) ? 'skip' : 'yield';
  };

  const first = accept(start);
  if (first === 'stop') return;
  if (first === 'yield') yield start;

  for (let i = 0; i < MAX_PERIODS; i++) {
    const list = periodCandidates(rule, start, i);
    for (const at of list) {
      if (at <= start) continue;
      const verdict = accept(at);
      if (verdict === 'stop') return;
      if (verdict === 'yield') yield at;
    }
    // 빈 주기가 이어져도(2월 30일 같은 규칙) 상한까지 가면 멈춘다. 주기 시작이 창을 넘었으면 끝이다
    if (rule.freq === 'DAILY' && addDays(startOfDay(start), i * rule.interval) > windowEnd) return;
    if (rule.freq === 'WEEKLY' && addDays(startOfDay(start), (i * rule.interval - 1) * 7) > windowEnd) return;
    if (rule.freq === 'MONTHLY' && i * rule.interval > 12 * 300) return;
    if (rule.freq === 'YEARLY' && i * rule.interval > 300) return;
    if (list.length && list[0]! > windowEnd) return;
  }
}

/** 끝이 있는 규칙이면 마지막 회차 시작(벽시계). 끝이 없으면 null */
export function lastOccurrence(start: number, rule: Rule, tz: string, exdates: Iterable<number> = []): number | null {
  if (rule.count === null && rule.until === null) return null;
  let last: number | null = null;
  for (const at of occurrences({ start, rule, tz, exdates, windowEnd: Number.MAX_SAFE_INTEGER })) last = at;
  return last ?? start;
}

/** EXDATE 목록(쉼표 문자열) ↔ wall ms */
export function parseExdates(text: string | null | undefined): number[] {
  if (!text) return [];
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .flatMap((v) => {
      try {
        return [parseWall(v)];
      } catch {
        return [];
      }
    });
}

export function formatExdates(list: number[], dateOnly: boolean): string | null {
  if (!list.length) return null;
  return [...new Set(list)]
    .sort((a, b) => a - b)
    .map((v) => formatWall(v, dateOnly))
    .join(',');
}
