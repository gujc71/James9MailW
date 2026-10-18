/**
 * iCalendar(RFC 5545) 읽기 · 쓰기.
 *
 * 가져오기(.ics) · 네트워크 구독 · 받은 초대(iTIP) 를 읽고, 내보내기 · 게시 · 초대 메일을 쓴다.
 * 시각은 이 모듈을 나오면 전부 "그 일정 시간대의 벽시계" 다 (time.ts):
 *   - TZID=Asia/Seoul:20261007T090000 → tz Asia/Seoul, '2026-10-07T09:00'
 *   - 20261007T000000Z                → 기본 시간대로 옮긴 벽시계
 *   - VALUE=DATE:20261007             → 종일 '2026-10-07'
 */
import { DAY, MINUTE, formatWall, isDateOnly, normalizeTimeZone, parseWall, utcToWall, wallToUtc } from './time.js';

export interface IcsAttendee {
  email: string;
  name: string | null;
  role: string;
  partstat: string;
  rsvp: boolean;
}

export interface IcsItem {
  type: 'E' | 'T';
  uid: string;
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
  attendees: IcsAttendee[];
  alarms: { offsetMin: number; related: 'S' | 'E' }[];
  attachments: { url: string; name: string | null }[];
  /** 외부 프로그램이 붙인 X- 속성 원문 (펼친 한 줄씩). parseCalendar 에 keepExtra 를 줄 때만 채운다 */
  extra?: string[];
  /** DTSTAMP. 없으면 지금. CalDAV 는 내용이 같으면 본문도 같도록 수정 시각을 준다 */
  stamp?: Date;
}

export interface IcsCalendar {
  method: string | null;
  name: string | null;
  items: IcsItem[];
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
  /** 펼친 원문 한 줄 */
  raw: string;
}

// ------------------------------------------------------------------ 읽기

/** 접힌 줄을 펴고 한 줄씩 속성으로 */
function contentLines(text: string): Prop[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const props: Prop[] = [];
  for (const line of unfolded.split('\n')) {
    if (!line.trim()) continue;
    // 이름;파라미터=값;…:값 — 따옴표 안의 ; : 는 구분자가 아니다
    let i = 0;
    let inQuote = false;
    let colon = -1;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ':' && !inQuote) {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const segments: string[] = [];
    let current = '';
    inQuote = false;
    for (const ch of head) {
      if (ch === '"') inQuote = !inQuote;
      if (ch === ';' && !inQuote) {
        segments.push(current);
        current = '';
      } else current += ch;
    }
    segments.push(current);
    const params: Record<string, string> = {};
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf('=');
      if (eq > 0) params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1).replace(/^"|"$/g, '');
    }
    props.push({ name: segments[0]!.toUpperCase(), params, value, raw: line });
  }
  return props;
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/** 쉼표로 묶인 TEXT 목록. 이스케이프된 쉼표는 나누지 않는다 */
function splitText(value: string): string[] {
  return value
    .split(/(?<!\\),/)
    .map((v) => unescapeText(v).trim())
    .filter(Boolean);
}

interface ParsedTime {
  wall: string;
  allDay: boolean;
  tzid: string;
}

function parseTime(prop: Prop, defaultTz: string): ParsedTime | null {
  const value = prop.value.trim().split(',')[0]!;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h || prop.params.VALUE === 'DATE') return { wall: `${y}-${mo}-${d}`, allDay: true, tzid: defaultTz };
  const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (z) return { wall: formatWall(utcToWall(wallMs, defaultTz)), allDay: false, tzid: defaultTz };
  const tz = normalizeTimeZone(prop.params.TZID, defaultTz);
  return { wall: formatWall(wallMs), allDay: false, tzid: tz };
}

/** P1D · PT1H30M · -P2W → 분 */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi] = m;
  const minutes = Number(w ?? 0) * 7 * 1440 + Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(mi ?? 0);
  return sign === '-' ? -minutes : minutes;
}

function mailtoOf(value: string): string | null {
  const address = value.replace(/^mailto:/i, '').trim();
  return address.includes('@') ? address.toLowerCase() : null;
}

/** 블록(BEGIN..END) 단위로 나눈다 */
function blocks(props: Prop[], kind: string): Prop[][] {
  const out: Prop[][] = [];
  let depth = 0;
  let current: Prop[] | null = null;
  for (const prop of props) {
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === kind && depth === 0) {
      current = [];
      depth = 1;
      continue;
    }
    if (!current) continue;
    if (prop.name === 'BEGIN') depth++;
    if (prop.name === 'END') {
      depth--;
      if (depth === 0) {
        out.push(current);
        current = null;
        continue;
      }
    }
    current.push(prop);
  }
  return out;
}

/** 지켜 둘 X- 속성의 항목당 상한. 넘치면 뒤를 버린다 */
const EXTRA_MAX_BYTES = 32 * 1024;

function extraOf(own: Prop[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const prop of own) {
    if (!prop.name.startsWith('X-')) continue;
    bytes += Buffer.byteLength(prop.raw, 'utf8') + 1;
    if (bytes > EXTRA_MAX_BYTES) break;
    out.push(prop.raw);
  }
  return out;
}

function parseComponent(props: Prop[], type: 'E' | 'T', defaultTz: string, keepExtra = false): IcsItem | null {
  // 하위 블록(VALARM)은 따로 뗀다
  const own: Prop[] = [];
  let depth = 0;
  for (const prop of props) {
    if (prop.name === 'BEGIN') depth++;
    if (depth === 0) own.push(prop);
    if (prop.name === 'END') depth--;
  }
  const get = (name: string) => own.find((p) => p.name === name);
  const text = (name: string) => {
    const prop = get(name);
    return prop ? unescapeText(prop.value).trim() || null : null;
  };

  const uid = text('UID');
  if (!uid) return null;
  const startProp = get('DTSTART');
  const start = startProp ? parseTime(startProp, defaultTz) : null;
  const tzid = start?.tzid ?? defaultTz;
  const allDay = start?.allDay ?? false;

  /** 다른 시각 속성도 DTSTART 와 같은 시간대 벽시계로 맞춘다 */
  const timeOf = (name: string): string | null => {
    const prop = get(name);
    if (!prop) return null;
    const parsed = parseTime(prop, tzid);
    if (!parsed) return null;
    if (allDay || parsed.allDay) return parsed.wall;
    if (parsed.tzid === tzid) return parsed.wall;
    return formatWall(utcToWall(wallToUtc(parseWall(parsed.wall), parsed.tzid), tzid));
  };

  let end = type === 'E' ? timeOf('DTEND') : null;
  if (type === 'E' && start && !end) {
    const duration = get('DURATION') ? parseDuration(get('DURATION')!.value) : null;
    const base = parseWall(start.wall);
    if (duration !== null) end = formatWall(base + duration * MINUTE, allDay);
    else end = formatWall(allDay ? base + DAY : base, allDay);
  }
  const due = type === 'T' ? timeOf('DUE') : null;

  const exdates: string[] = [];
  for (const prop of own.filter((p) => p.name === 'EXDATE')) {
    for (const part of prop.value.split(',')) {
      const parsed = parseTime({ ...prop, value: part }, tzid);
      if (!parsed) continue;
      exdates.push(
        allDay || parsed.allDay || parsed.tzid === tzid
          ? parsed.wall
          : formatWall(utcToWall(wallToUtc(parseWall(parsed.wall), parsed.tzid), tzid)),
      );
    }
  }

  const attendees: IcsAttendee[] = [];
  for (const prop of own.filter((p) => p.name === 'ATTENDEE')) {
    const email = mailtoOf(prop.value);
    if (!email) continue;
    attendees.push({
      email,
      name: prop.params.CN ?? null,
      role: (prop.params.ROLE ?? 'REQ-PARTICIPANT').toUpperCase(),
      partstat: (prop.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase(),
      rsvp: (prop.params.RSVP ?? 'FALSE').toUpperCase() === 'TRUE',
    });
  }

  const alarms: IcsItem['alarms'] = [];
  for (const alarm of blocks(props, 'VALARM')) {
    const trigger = alarm.find((p) => p.name === 'TRIGGER');
    if (!trigger || trigger.params.VALUE === 'DATE-TIME') continue;
    const minutes = parseDuration(trigger.value);
    if (minutes === null) continue;
    alarms.push({ offsetMin: -minutes, related: trigger.params.RELATED === 'END' ? 'E' : 'S' });
  }

  const completedProp = get('COMPLETED');
  const completedTime = completedProp ? parseTime(completedProp, 'UTC') : null;

  const priority = Number.parseInt(text('PRIORITY') ?? '0', 10);
  const percent = Number.parseInt(text('PERCENT-COMPLETE') ?? '0', 10);
  const recurrenceProp = get('RECURRENCE-ID');
  return {
    type,
    uid,
    recurrenceId: recurrenceProp ? (timeOf('RECURRENCE-ID') ?? null) : null,
    title: text('SUMMARY') ?? '',
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    url: text('URL'),
    allDay,
    tzid,
    start: start?.wall ?? null,
    end,
    due,
    completed: completedTime ? new Date(wallToUtc(parseWall(completedTime.wall), 'UTC')) : null,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    status: text('STATUS')?.toUpperCase() ?? null,
    priority: Number.isFinite(priority) ? Math.max(0, Math.min(9, priority)) : 0,
    privacy: (text('CLASS') ?? 'PUBLIC').toUpperCase(),
    transp: (text('TRANSP') ?? 'OPAQUE').toUpperCase(),
    rrule: get('RRULE')?.value.trim() ?? null,
    exdates,
    categories: own.filter((p) => p.name === 'CATEGORIES').flatMap((p) => splitText(p.value)),
    organizer: get('ORGANIZER') ? mailtoOf(get('ORGANIZER')!.value) : null,
    sequence: Number.parseInt(text('SEQUENCE') ?? '0', 10) || 0,
    attendees,
    alarms,
    attachments: own
      .filter((p) => p.name === 'ATTACH' && /^https?:\/\//i.test(p.value) && p.params.VALUE !== 'BINARY')
      .map((p) => ({ url: p.value.trim(), name: p.params.FILENAME ?? p.params['X-FILENAME'] ?? null })),
    ...(keepExtra ? { extra: extraOf(own) } : {}),
  };
}

/**
 * keepExtra: 항목마다 X- 속성 원문을 extra 에 담는다. CalDAV 처럼 같은 프로그램이 다시 읽어 갈 때만 쓴다
 * (가져오기 · 초대 메일의 X- 속성은 남길 까닭이 없다).
 */
export function parseCalendar(text: string, defaultTz: string, options: { keepExtra?: boolean } = {}): IcsCalendar {
  const props = contentLines(text);
  const calendar = blocks(props, 'VCALENDAR')[0] ?? props;
  const top = calendar.filter((p) => p.name === 'METHOD' || p.name === 'X-WR-CALNAME');
  const items: IcsItem[] = [];
  for (const block of blocks(calendar, 'VEVENT')) {
    const item = parseComponent(block, 'E', defaultTz, options.keepExtra);
    if (item) items.push(item);
  }
  for (const block of blocks(calendar, 'VTODO')) {
    const item = parseComponent(block, 'T', defaultTz, options.keepExtra);
    if (item) items.push(item);
  }
  return {
    method: top.find((p) => p.name === 'METHOD')?.value.trim().toUpperCase() ?? null,
    name: top.find((p) => p.name === 'X-WR-CALNAME') ? unescapeText(top.find((p) => p.name === 'X-WR-CALNAME')!.value) : null,
    items,
  };
}

// ------------------------------------------------------------------ 쓰기

export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 75 옥텟마다 접는다 (RFC 5545 3.1). 다바이트 글자를 가르지 않는다 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const compact = (wall: string) => wall.replace(/[-:]/g, '');

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function timeProp(name: string, wall: string, tzid: string, allDay: boolean): string {
  if (allDay || isDateOnly(wall)) return `${name};VALUE=DATE:${compact(wall.slice(0, 10))}`;
  if (tzid === 'UTC') return `${name}:${compact(wall)}00Z`;
  return `${name};TZID=${tzid}:${compact(wall)}00`;
}

/** 분 → -PT15M 꼴 */
function durationText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  let rest = Math.abs(minutes);
  if (rest === 0) return 'PT0M';
  if (rest % (7 * 1440) === 0) return `${sign}P${rest / (7 * 1440)}W`;
  const days = Math.floor(rest / 1440);
  rest -= days * 1440;
  const hours = Math.floor(rest / 60);
  const mins = rest % 60;
  return `${sign}P${days ? `${days}D` : ''}${hours || mins ? 'T' : ''}${hours ? `${hours}H` : ''}${mins ? `${mins}M` : ''}`;
}

/**
 * VTIMEZONE. 서머타임이 없는 시간대만 오프셋 하나로 적어 준다 — 그런 곳(서울 · 도쿄)이 대부분이고,
 * 서머타임이 있는 곳은 IANA 이름(TZID)만으로 썬더버드 · 구글 · 아웃룩이 알아본다.
 */
function vtimezone(tz: string): string[] {
  if (tz === 'UTC') return [];
  const year = new Date().getUTCFullYear();
  const jan = utcToWall(Date.UTC(year, 0, 1), tz) - Date.UTC(year, 0, 1);
  const jul = utcToWall(Date.UTC(year, 6, 1), tz) - Date.UTC(year, 6, 1);
  if (jan !== jul) return [];
  const minutes = jan / MINUTE;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

export function serializeItem(item: IcsItem, options: { method?: string | null } = {}): string[] {
  const lines: string[] = [item.type === 'E' ? 'BEGIN:VEVENT' : 'BEGIN:VTODO'];
  const push = (line: string | null | false | undefined) => {
    if (line) lines.push(line);
  };
  push(`UID:${escapeText(item.uid)}`);
  push(`DTSTAMP:${utcStamp(item.stamp ?? new Date())}`);
  if (item.recurrenceId) push(timeProp('RECURRENCE-ID', item.recurrenceId, item.tzid, item.allDay));
  push(`SEQUENCE:${item.sequence}`);
  push(`SUMMARY:${escapeText(item.title)}`);
  if (item.start) push(timeProp('DTSTART', item.start, item.tzid, item.allDay));
  if (item.type === 'E' && item.end) push(timeProp('DTEND', item.end, item.tzid, item.allDay));
  if (item.type === 'T' && item.due) push(timeProp('DUE', item.due, item.tzid, item.allDay));
  if (item.location) push(`LOCATION:${escapeText(item.location)}`);
  if (item.description) push(`DESCRIPTION:${escapeText(item.description)}`);
  if (item.url) push(`URL:${item.url}`);
  if (item.status) push(`STATUS:${item.status}`);
  if (item.priority) push(`PRIORITY:${item.priority}`);
  if (item.privacy && item.privacy !== 'PUBLIC') push(`CLASS:${item.privacy}`);
  if (item.type === 'E') push(`TRANSP:${item.transp || 'OPAQUE'}`);
  if (item.type === 'T') {
    if (item.percent) push(`PERCENT-COMPLETE:${item.percent}`);
    if (item.completed) push(`COMPLETED:${utcStamp(item.completed)}`);
  }
  if (item.rrule) push(`RRULE:${item.rrule}`);
  if (item.exdates.length) {
    for (const ex of item.exdates) push(timeProp('EXDATE', ex, item.tzid, item.allDay));
  }
  if (item.categories.length) push(`CATEGORIES:${item.categories.map(escapeText).join(',')}`);
  if (item.organizer) push(`ORGANIZER:mailto:${item.organizer}`);
  for (const a of item.attendees) {
    const cn = a.name ? `;CN="${a.name.replace(/"/g, "'")}"` : '';
    push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${a.role};PARTSTAT=${a.partstat};RSVP=${a.rsvp ? 'TRUE' : 'FALSE'}${cn}:mailto:${a.email}`,
    );
  }
  for (const att of item.attachments) {
    push(`ATTACH${att.name ? `;FILENAME="${att.name.replace(/"/g, "'")}"` : ''}:${att.url}`);
  }
  for (const line of item.extra ?? []) push(line);
  // 초대 메일에는 알림을 싣지 않는다 — 받는 사람 알림은 받는 사람이 정한다
  if (!options.method || options.method === 'PUBLISH') {
    for (const alarm of item.alarms) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(item.title)}`,
        `TRIGGER${alarm.related === 'E' ? ';RELATED=END' : ''}:${durationText(-alarm.offsetMin)}`,
        'END:VALARM',
      );
    }
  }
  lines.push(item.type === 'E' ? 'END:VEVENT' : 'END:VTODO');
  return lines;
}

export function serializeCalendar(items: IcsItem[], options: { method?: string | null; name?: string | null } = {}): string {
  const zones = [...new Set(items.filter((i) => !i.allDay && i.tzid !== 'UTC').map((i) => i.tzid))];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//james9Mail//Calendar//KO',
    'CALSCALE:GREGORIAN',
    ...(options.method ? [`METHOD:${options.method}`] : []),
    ...(options.name ? [`X-WR-CALNAME:${escapeText(options.name)}`] : []),
    ...zones.flatMap(vtimezone),
    ...items.flatMap((item) => serializeItem(item, options)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
