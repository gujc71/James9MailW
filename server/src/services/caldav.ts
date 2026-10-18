/**
 * CalDAV (RFC 4791) — 썬더버드 같은 외부 캘린더 프로그램이 내 캘린더를 직접 읽고 쓴다.
 * HTTP · XML 은 routes/caldav.ts 가 맡고, 여기서는 인증 · 자원 목록 · 쓰기를 한다.
 *
 *  - 자원(…/<캘린더ID>/<이름>.ics) 하나 = UID 하나 = 원본 + 예외 회차. 이름은 CAL_ITEM.DAV_NAME,
 *    비어 있으면 '<UID>.ics' 다 (웹에서 만든 일정).
 *  - ETag 는 그 UID 행들의 (ITEM_ID · 수정 시각 · SEQUENCE) 로, CTag 는 캘린더 전체 ETag 로 만든다.
 *    모든 쓰기 경로가 UPDATE_DATE 를 새로 적으므로(services/calendar.ts · calendarItip.ts) 따로
 *    변경 번호를 두지 않는다. 삭제는 행 수 · ITEM_ID 가 바뀌어 CTag 에 잡힌다.
 *  - 초대 메일은 보내지 않는다. 서버가 calendar-auto-schedule 을 알리지 않으면 썬더버드가
 *    초대 · 응답 · 취소 메일을 직접 보낸다 (RFC 6638 을 쓰지 않는 클라이언트 쪽 iMIP).
 */
import { createHash } from 'node:crypto';
import * as repo from '../repositories/calendar.js';
import type { CalendarRecord, DavRow, ItemFull } from '../repositories/calendar.js';
import * as gu from '../repositories/gu.js';
import * as users from '../repositories/users.js';
import { verifyPassword } from '../auth/password.js';
import { loginFailures, loginFailuresByIp } from '../util/rateLimit.js';
import { parseCalendar, serializeCalendar } from '../calendar/ical.js';
import { DAY } from '../calendar/time.js';
import { displayTzOf } from './calendar.js';
import { toIcs, upsertIcs } from './calendarItip.js';

// ------------------------------------------------------------------ 인증

export type DavAuth =
  | { ok: true; userName: string; displayName: string | null; caldav: boolean; carddav: boolean }
  | { ok: false; status: 401 | 403 | 429; retryAfterSec?: number };

/**
 * 맞힌 비밀번호를 잠깐 기억한다. 외부 프로그램은 요청마다 Basic 인증을 보내는데
 * PBKDF2 같은 해시를 매번 돌리면 동기화 한 번에 수십 번이다. 키에 저장된 해시를 넣어
 * 비밀번호를 바꾸면 곧바로 맞지 않게 된다.
 */
const verified = new Map<string, number>();
const VERIFY_TTL_MS = 5 * 60_000;

function verifyKey(userName: string, storedHash: string, password: string): string {
  return createHash('sha256').update(`${userName}\0${storedHash}\0${password}`).digest('hex');
}

export async function authenticate(header: string | undefined, ip: string): Promise<DavAuth> {
  const m = /^Basic\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return { ok: false, status: 401 };
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return { ok: false, status: 401 };
  const userInput = decoded.slice(0, colon).trim();
  const password = decoded.slice(colon + 1);
  if (userInput.length > 320 || !password || password.length > 1024) return { ok: false, status: 401 };

  // 로그인 화면과 같은 잠금을 탄다 (routes/auth.ts)
  const pairKey = `${ip}|${userInput.toLowerCase()}`;
  const blocked = Math.max(loginFailures.blockedFor(pairKey), loginFailuresByIp.blockedFor(ip));
  if (blocked > 0) return { ok: false, status: 429, retryAfterSec: Math.ceil(blocked / 1000) };

  const user = await users.findUser(userInput);
  const key = user ? verifyKey(user.userName, user.passwordHash, password) : '';
  const now = Date.now();
  const cached = Boolean(user) && (verified.get(key) ?? 0) > now;
  if (!user || (!cached && !verifyPassword(password, user.userName, user.passwordHash, user.algorithm))) {
    loginFailures.hit(pairKey);
    loginFailuresByIp.hit(ip);
    return { ok: false, status: 401 };
  }
  if (!cached) {
    if (verified.size > 1000) {
      for (const [k, exp] of verified) if (exp <= now) verified.delete(k);
    }
    verified.set(key, now + VERIFY_TTL_MS);
  }
  loginFailures.reset(pairKey);

  // 중지한 계정 · 일정(CalDAV) · 주소록(CardDAV) 어느 쪽도 켜지 않은 계정은 비밀번호가 맞아도 막는다.
  // 한쪽만 켰으면 다른 쪽 경로는 routes/caldav.ts 가 막는다
  if ((user.status ?? 'Y').toUpperCase() === 'N') return { ok: false, status: 403 };
  const setting = await gu.getUserSetting(user.userName);
  if (!setting.caldavUseYn && !setting.carddavUseYn) return { ok: false, status: 403 };
  return {
    ok: true,
    userName: user.userName,
    displayName: user.displayName,
    caldav: setting.caldavUseYn,
    carddav: setting.carddavUseYn,
  };
}

// ------------------------------------------------------------------ 자원 목록

export interface DavResource {
  name: string;
  uid: string;
  type: 'E' | 'T';
  etag: string;
  lastModified: Date;
  rows: DavRow[];
}

export function defaultName(uid: string): string {
  return `${uid}.ics`;
}

function etagOf(rows: DavRow[]): string {
  const hash = createHash('sha1');
  for (const r of rows) hash.update(`${r.itemId}|${r.updateMs}|${r.sequence}\n`);
  return `"${hash.digest('hex').slice(0, 24)}"`;
}

/** 캘린더 하나의 자원들. 원본이 앞, 같은 UID 의 예외 회차가 뒤에 묶인다 */
export async function listResources(calendarId: number): Promise<DavResource[]> {
  const groups = new Map<string, DavRow[]>();
  for (const row of await repo.davRows(calendarId)) {
    const list = groups.get(row.uid);
    if (list) list.push(row);
    else groups.set(row.uid, [row]);
  }
  const out: DavResource[] = [];
  const taken = new Set<string>();
  for (const [uid, rows] of groups) {
    rows.sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.itemId.localeCompare(b.itemId));
    const master = rows.find((r) => !r.parentId) ?? rows[0]!;
    let name = rows.find((r) => r.davName)?.davName ?? defaultName(uid);
    // 다른 UID 가 이미 쓰는 이름이면 UID 이름으로 물러선다 (같은 이름 두 자원은 구별할 수 없다)
    if (taken.has(name)) name = defaultName(uid);
    taken.add(name);
    out.push({
      name,
      uid,
      type: master.type,
      etag: etagOf(rows),
      lastModified: new Date(Math.max(...rows.map((r) => r.updateMs))),
      rows,
    });
  }
  return out;
}

/** 캘린더가 바뀌었는지. 이름 · 색 · 쓰기 권한도 넣어 목록 화면 속성 변경을 잡는다 */
export function ctagOf(calendar: CalendarRecord, resources: DavResource[]): string {
  const hash = createHash('sha1');
  hash.update(`${calendar.name}\0${calendar.color}\0${calendar.readonly}\n`);
  for (const r of [...resources].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`${r.name}\0${r.etag}\n`);
  return hash.digest('hex').slice(0, 32);
}

/** calendar-query 의 time-range. 종일 일정은 UTC 로 착각한 날짜라 하루씩 넓혀 본다 */
export function overlaps(resource: DavResource, from: Date | null, to: Date | null): boolean {
  if (!from && !to) return true;
  return resource.rows.some((r) => {
    if (!r.startUtc) return true; // 날짜 없는 태스크는 늘 걸린다
    const start = r.startUtc.getTime() - DAY;
    const end = (r.rangeEndUtc?.getTime() ?? Number.POSITIVE_INFINITY) + DAY;
    return (!to || start < to.getTime()) && (!from || end > from.getTime());
  });
}

function render(items: ItemFull[]): string {
  const sorted = [...items].sort(
    (a, b) =>
      Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || (a.recurrenceId ?? '').localeCompare(b.recurrenceId ?? ''),
  );
  return serializeCalendar(
    sorted.map((item) => ({
      ...toIcs(item),
      // DTSTAMP 를 수정 시각으로 고정해야 같은 ETag 에 같은 본문이 나간다
      stamp: item.updateDate,
      ...(item.extraProps?.length ? { extra: item.extraProps } : {}),
    })),
  );
}

/** 자원들의 본문(.ics). UID → 본문 */
export async function loadBodies(calendarId: number, resources: DavResource[]): Promise<Map<string, string>> {
  const items = await repo.listCalendarItemsByUids(
    calendarId,
    resources.map((r) => r.uid),
  );
  const byUid = new Map<string, ItemFull[]>();
  for (const item of items) {
    const list = byUid.get(item.uid);
    if (list) list.push(item);
    else byUid.set(item.uid, [item]);
  }
  const out = new Map<string, string>();
  for (const [uid, list] of byUid) out.set(uid, render(list));
  return out;
}

// ------------------------------------------------------------------ 쓰기

/** If-Match: "a", "b" · * */
function matches(header: string | undefined, etag: string | null): boolean {
  if (header === undefined) return true;
  if (etag === null) return false;
  const tags = header.split(',').map((t) => t.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}

export type WriteOutcome =
  | { status: 201 | 204; etag: string | null }
  | { status: 400 | 403 | 404 | 409 | 412; condition?: string };

export interface Conditions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

/**
 * PUT. 본문은 그 자원의 전체 내용이다 — 빠진 예외 회차 · 지운 알림 · X- 속성까지 그대로 따른다.
 */
export async function putResource(
  userName: string,
  calendar: CalendarRecord,
  name: string,
  body: string,
  cond: Conditions,
): Promise<WriteOutcome> {
  if (calendar.readonly) return { status: 403, condition: 'need-privileges' };
  if (!/BEGIN:VCALENDAR/i.test(body)) return { status: 400, condition: 'valid-calendar-data' };
  const parsed = parseCalendar(body, await displayTzOf(userName), { keepExtra: true });
  const uids = new Set(parsed.items.map((i) => i.uid));
  if (uids.size !== 1) return { status: 400, condition: 'valid-calendar-object-resource' };
  const uid = [...uids][0]!;
  if (uid.length > 255) return { status: 400, condition: 'valid-calendar-object-resource' };

  const resources = await listResources(calendar.calendarId);
  const existing = resources.find((r) => r.name === name) ?? null;
  if (cond.ifNoneMatch !== undefined && existing && matches(cond.ifNoneMatch, existing.etag)) {
    return { status: 412 };
  }
  if (!matches(cond.ifMatch, existing?.etag ?? null)) return { status: 412 };
  // 한 캘린더 안에서 UID 는 자원 하나에만 있다 (RFC 4791 5.3.2.1 no-uid-conflict)
  if (existing && existing.uid !== uid) return { status: 409, condition: 'no-uid-conflict' };
  const sameUid = resources.find((r) => r.uid === uid);
  if (sameUid && sameUid.name !== name) return { status: 409, condition: 'no-uid-conflict' };

  const touched = new Set<string>();
  await upsertIcs(
    userName,
    calendar.calendarId,
    parsed.items,
    (row) => row.calendarId === calendar.calendarId,
    (item) => {
      item.davName = name;
      touched.add(item.itemId);
    },
    { keepAlarms: false },
  );
  // 시작 없는 일정처럼 하나도 못 넣었으면 있던 것을 지우지 않고 거절한다
  if (!touched.size) return { status: 400, condition: 'valid-calendar-object-resource' };

  // 본문에서 빠진 예외 회차(되살린 회차 등)는 지운다
  const stale = (await repo.findByUid(userName, uid)).filter(
    (row) => row.calendarId === calendar.calendarId && !touched.has(row.itemId),
  );
  await repo.deleteItems(stale.map((row) => row.itemId));

  const after = (await listResources(calendar.calendarId)).find((r) => r.uid === uid);
  return { status: existing ? 204 : 201, etag: after?.etag ?? null };
}

export async function deleteResource(calendar: CalendarRecord, name: string, cond: Conditions): Promise<WriteOutcome> {
  if (calendar.readonly) return { status: 403, condition: 'need-privileges' };
  const target = (await listResources(calendar.calendarId)).find((r) => r.name === name);
  if (!target) return { status: 404 };
  if (!matches(cond.ifMatch, target.etag)) return { status: 412 };
  await repo.deleteItems(target.rows.map((r) => r.itemId));
  return { status: 204, etag: null };
}
