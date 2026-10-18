/**
 * 반복 대화상자의 모델 ↔ RRULE 문자열. 펼치기는 서버가 한다 (server/src/calendar/recur.ts) —
 * 여기서는 썬더버드 반복 대화상자가 고를 수 있는 모양만 다룬다.
 */
import { t, type MessageKey } from '../../i18n';
import { ms, weekdayOf } from './wall';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RuleModel {
  freq: Freq;
  interval: number;
  /** 매주: 요일들 (0 일요일 …) */
  weekdays: number[];
  /** 매월 · 매년: 날짜로(day) 또는 n 번째 요일로(nth) */
  monthlyMode: 'day' | 'nth';
  /** 1 … 31, -1 은 마지막 날 */
  monthDay: number;
  /** 1 … 5, -1 은 마지막 */
  nth: number;
  nthWeekday: number;
  /** 매년: 1 … 12 */
  month: number;
  end: 'never' | 'count' | 'until';
  count: number;
  /** 'YYYY-MM-DD' */
  until: string;
}

export type Preset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function partsOf(rrule: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const piece of rrule.replace(/^RRULE:/i, '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) map.set(piece.slice(0, eq).toUpperCase(), piece.slice(eq + 1).toUpperCase());
  }
  return map;
}

export function defaultModel(startDate: string): RuleModel {
  const day = Number(startDate.slice(8, 10));
  return {
    freq: 'WEEKLY',
    interval: 1,
    weekdays: [weekdayOf(startDate)],
    monthlyMode: 'day',
    monthDay: day,
    nth: Math.min(5, Math.ceil(day / 7)),
    nthWeekday: weekdayOf(startDate),
    month: Number(startDate.slice(5, 7)),
    end: 'never',
    count: 10,
    until: startDate,
  };
}

export function parseModel(rrule: string | null, startDate: string): RuleModel {
  const model = defaultModel(startDate);
  if (!rrule) return model;
  const p = partsOf(rrule);
  const freq = p.get('FREQ');
  if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY') model.freq = freq;
  model.interval = Math.max(1, Number(p.get('INTERVAL') ?? 1) || 1);
  const byDay = (p.get('BYDAY') ?? '')
    .split(',')
    .map((v) => /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(v))
    .filter((m): m is RegExpExecArray => Boolean(m));
  if (model.freq === 'WEEKLY' && byDay.length) model.weekdays = byDay.map((m) => CODES.indexOf(m[2]!));
  if ((model.freq === 'MONTHLY' || model.freq === 'YEARLY') && byDay.length) {
    model.monthlyMode = 'nth';
    model.nth = Number(byDay[0]![1] ?? p.get('BYSETPOS') ?? 1) || 1;
    model.nthWeekday = CODES.indexOf(byDay[0]![2]!);
  }
  if (p.get('BYMONTHDAY')) {
    model.monthlyMode = 'day';
    model.monthDay = Number(p.get('BYMONTHDAY')!.split(',')[0]) || model.monthDay;
  }
  if (p.get('BYMONTH')) model.month = Number(p.get('BYMONTH')!.split(',')[0]) || model.month;
  if (p.get('COUNT')) {
    model.end = 'count';
    model.count = Number(p.get('COUNT')) || 1;
  } else if (p.get('UNTIL')) {
    model.end = 'until';
    const u = p.get('UNTIL')!;
    model.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
  }
  return model;
}

/**
 * 모델 → RRULE. 시작 날짜와 같은 값(매월 같은 날 · 매년 같은 달)은 생략해도 되지만,
 * 시작을 옮겼을 때 규칙이 따라 바뀌지 않도록 적어 둔다 (썬더버드도 BYMONTHDAY 를 적는다).
 * UNTIL 은 그날 끝까지다. 시각 일정이면 서버가 UTC 로 바꿔 저장한다.
 */
export function formatModel(model: RuleModel, allDay: boolean): string {
  const parts = [`FREQ=${model.freq}`];
  if (model.interval > 1) parts.push(`INTERVAL=${model.interval}`);
  if (model.freq === 'WEEKLY') {
    const days = [...new Set(model.weekdays)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (days.length) parts.push(`BYDAY=${days.map((d) => CODES[d]).join(',')}`);
  }
  if (model.freq === 'MONTHLY' || model.freq === 'YEARLY') {
    if (model.monthlyMode === 'nth') parts.push(`BYDAY=${model.nth}${CODES[model.nthWeekday]}`);
    else parts.push(`BYMONTHDAY=${model.monthDay}`);
  }
  if (model.freq === 'YEARLY') parts.push(`BYMONTH=${model.month}`);
  if (model.end === 'count') parts.push(`COUNT=${Math.max(1, model.count)}`);
  if (model.end === 'until') {
    const d = model.until.replace(/-/g, '');
    parts.push(`UNTIL=${allDay ? d : `${d}T235959`}`);
  }
  return parts.join(';');
}

export function presetOf(rrule: string | null, startDate: string): Preset {
  if (!rrule) return 'none';
  const p = partsOf(rrule);
  const keys = [...p.keys()].filter((k) => k !== 'FREQ');
  const wd = CODES[weekdayOf(startDate)];
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  const freq = p.get('FREQ');
  const interval = Number(p.get('INTERVAL') ?? 1);
  if (freq === 'DAILY' && keys.length === 0) return 'daily';
  if (freq === 'WEEKLY' && p.get('BYDAY') === 'MO,TU,WE,TH,FR' && only('BYDAY')) return 'weekdays';
  if (freq === 'WEEKLY' && (!p.get('BYDAY') || p.get('BYDAY') === wd) && only('BYDAY', 'INTERVAL')) {
    if (interval === 1) return 'weekly';
    if (interval === 2) return 'biweekly';
  }
  if (freq === 'MONTHLY' && (keys.length === 0 || (only('BYMONTHDAY') && Number(p.get('BYMONTHDAY')) === Number(startDate.slice(8, 10)))))
    return 'monthly';
  if (freq === 'YEARLY' && only('BYMONTHDAY', 'BYMONTH') && (!p.get('BYMONTHDAY') || Number(p.get('BYMONTHDAY')) === Number(startDate.slice(8, 10))))
    return 'yearly';
  return 'custom';
}

export function presetRule(preset: Preset, startDate: string): string | null {
  const wd = CODES[weekdayOf(startDate)];
  const day = Number(startDate.slice(8, 10));
  switch (preset) {
    case 'none':
      return null;
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${wd}`;
    case 'biweekly':
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${wd}`;
    case 'monthly':
      return `FREQ=MONTHLY;BYMONTHDAY=${day}`;
    case 'yearly':
      return `FREQ=YEARLY;BYMONTHDAY=${day};BYMONTH=${Number(startDate.slice(5, 7))}`;
    case 'custom':
      return null;
  }
}

const NTH_KEYS: Record<number, MessageKey> = {
  1: 'cal.rule.nth1',
  2: 'cal.rule.nth2',
  3: 'cal.rule.nth3',
  4: 'cal.rule.nth4',
  5: 'cal.rule.nth5',
  [-1]: 'cal.rule.nthLast',
};

export function weekdayName(locale: string, wd: number, style: 'long' | 'short' | 'narrow' = 'long'): string {
  // 2023-01-01 은 일요일
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + wd)));
}

export function monthName(locale: string, month: number): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, month - 1, 1)));
}

/** "2주마다 월, 수요일 · 10회" 같은 요약 */
export function describeRule(rrule: string | null, startDate: string, locale: string): string {
  if (!rrule) return t('cal.repeat.none');
  const m = parseModel(rrule, startDate);
  let text: string;
  switch (m.freq) {
    case 'DAILY':
      text = m.interval > 1 ? t('cal.rule.everyNDays', { n: m.interval }) : t('cal.rule.everyDay');
      break;
    case 'WEEKLY': {
      const days = m.weekdays.map((d) => weekdayName(locale, d, 'short')).join(', ');
      text = (m.interval > 1 ? t('cal.rule.everyNWeeks', { n: m.interval }) : t('cal.rule.everyWeek')) + (days ? ` (${days})` : '');
      break;
    }
    case 'MONTHLY': {
      const which =
        m.monthlyMode === 'nth'
          ? t('cal.rule.nthWeekday', { nth: t(NTH_KEYS[m.nth] ?? 'cal.rule.nth1'), day: weekdayName(locale, m.nthWeekday) })
          : m.monthDay === -1
            ? t('cal.rule.lastDay')
            : t('cal.rule.dayN', { n: m.monthDay });
      text = `${m.interval > 1 ? t('cal.rule.everyNMonths', { n: m.interval }) : t('cal.rule.everyMonth')} ${which}`;
      break;
    }
    case 'YEARLY': {
      const which =
        m.monthlyMode === 'nth'
          ? t('cal.rule.nthWeekday', { nth: t(NTH_KEYS[m.nth] ?? 'cal.rule.nth1'), day: weekdayName(locale, m.nthWeekday) })
          : t('cal.rule.dayN', { n: m.monthDay });
      text = `${m.interval > 1 ? t('cal.rule.everyNYears', { n: m.interval }) : t('cal.rule.everyYear')} ${monthName(locale, m.month)} ${which}`;
      break;
    }
  }
  if (m.end === 'count') text += ` · ${t('cal.rule.times', { n: m.count })}`;
  if (m.end === 'until') text += ` · ${t('cal.rule.until', { date: m.until })}`;
  return text;
}

export { NTH_KEYS };

/** 반복 원본의 회차인지 판단할 때 쓰는 시작 날짜 비교 */
export function sameStart(a: string | null, b: string | null): boolean {
  return Boolean(a && b && ms(a) === ms(b));
}
