/**
 * 캘린더 ↔ 바깥 세계.
 *
 *  - 초대 메일(iTIP · iMIP, RFC 5546/6047): 참석자가 있는 일정을 저장하면 REQUEST, 지우면 CANCEL,
 *    받은 초대에 답하면 주최자에게 REPLY 를 보낸다. 발송은 평소 메일쓰기 경로(sendMail)를 그대로 탄다 —
 *    From 검증 · 보낸 편지함 사본 · 반송 안내가 똑같이 붙는다.
 *  - .ics 가져오기 · 내보내기 · 게시(구독 주소) · 네트워크 캘린더(ICS 구독) 새로 고침.
 */
import { randomBytes } from 'node:crypto';
import { badRequest, forbidden } from '../errors.js';
import { uuidv7 } from '../util/uuidv7.js';
import { config } from '../config.js';
import * as repo from '../repositories/calendar.js';
import type { CalendarRecord, ItemFull } from '../repositories/calendar.js';
import { parseCalendar, serializeCalendar, type IcsItem } from '../calendar/ical.js';
import { DAY, formatWall, isValidTimeZone, parseWall } from '../calendar/time.js';
import { parseRule } from '../calendar/recur.js';
import { cleanCategories, computeIndex, dedupeAlarms, displayTzOf, myAddresses, defaultCalendar } from './calendar.js';
import { sendMail } from './compose.js';
import { escapeHtml } from '../mime/build.js';
import { resolveAllowedHost } from './externalMail.js';
import * as users from '../repositories/users.js';
import { t, type Locale } from '../i18n.js';

// ------------------------------------------------------------------ 변환

export function toIcs(item: ItemFull): IcsItem {
  return {
    type: item.type,
    uid: item.uid,
    recurrenceId: item.recurrenceId,
    title: item.title,
    location: item.location,
    description: item.description,
    url: item.url,
    allDay: item.allDay,
    tzid: item.tzid,
    start: item.start,
    end: item.end,
    due: item.due,
    completed: item.completed,
    percent: item.percent,
    status: item.status,
    priority: item.priority,
    privacy: item.privacy,
    transp: item.transp,
    rrule: item.parentId ? null : item.rrule,
    exdates: item.parentId ? [] : item.exdates,
    categories: item.categories,
    organizer: item.organizer,
    sequence: item.sequence,
    attendees: item.attendees,
    alarms: item.alarms.map(({ offsetMin, related }) => ({ offsetMin, related })),
    attachments: item.attachments,
  };
}

/** 받은 .ics 한 항목을 저장할 모양으로. 형식이 틀린 값은 버린다 */
function fromIcs(
  ics: IcsItem,
  base: { itemId: string; userName: string; calendarId: number; parentId: string | null; regDate: Date },
): ItemFull | null {
  if (!ics.start && !ics.due) {
    if (ics.type === 'E') return null;
  }
  const tzid = isValidTimeZone(ics.tzid) ? ics.tzid : 'UTC';
  const start = ics.start;
  let end = ics.type === 'E' ? ics.end : null;
  if (ics.type === 'E' && start && end && parseWall(end) < parseWall(start)) end = start;
  if (ics.type === 'E' && ics.allDay && start && (!end || parseWall(end) <= parseWall(start))) {
    end = formatWall(parseWall(start) + DAY, true);
  }
  const rrule = base.parentId === null && ics.rrule && parseRule(ics.rrule) ? ics.rrule : null;
  return {
    itemId: base.itemId,
    calendarId: base.calendarId,
    userName: base.userName,
    type: ics.type,
    uid: ics.uid.slice(0, 255),
    parentId: base.parentId,
    recurrenceId: base.parentId ? ics.recurrenceId : null,
    title: ics.title.slice(0, 500),
    location: ics.location,
    description: ics.description,
    url: ics.url && /^https?:\/\//i.test(ics.url) ? ics.url.slice(0, 1000) : null,
    allDay: ics.allDay,
    tzid,
    start,
    end,
    due: ics.type === 'T' ? ics.due : null,
    completed: ics.completed,
    percent: ics.percent,
    status: ics.status?.slice(0, 12) ?? null,
    priority: [0, 1, 5, 9].includes(ics.priority) ? ics.priority : ics.priority <= 4 && ics.priority > 0 ? 1 : ics.priority >= 6 ? 9 : ics.priority ? 5 : 0,
    privacy: ['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(ics.privacy) ? ics.privacy : 'PUBLIC',
    transp: ics.transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE',
    rrule,
    exdates: rrule ? ics.exdates : [],
    categories: cleanCategories(ics.categories),
    organizer: ics.organizer,
    sequence: ics.sequence,
    regDate: base.regDate,
    updateDate: new Date(),
    attendees: ics.attendees.slice(0, 200).map((a) => ({ ...a, email: a.email.slice(0, 255), name: a.name?.slice(0, 255) ?? null })),
    alarms: dedupeAlarms(ics.alarms),
    attachments: ics.attachments.slice(0, 50).map((a) => ({ url: a.url.slice(0, 1000), name: a.name?.slice(0, 255) ?? null })),
    // keepExtra 로 읽은 것(CalDAV)만 X- 속성을 바꾼다. 나머지 경로는 undefined 라 있던 값이 남는다
    ...(ics.extra ? { extraProps: ics.extra } : {}),
  };
}

/**
 * 받은 항목들을 넣는다. 같은 UID 가 있으면 그 자리를 고친다(초대 갱신 · 구독 새로 고침),
 * 없으면 calendarId 에 새로 넣는다. accept 는 고쳐도 되는 기존 행인지 고른다.
 * keepAlarms: 받은 쪽에 알림이 없으면 내 알림을 남긴다 (초대에는 알림이 없다). CalDAV 는
 * 본인 프로그램이 보낸 전체 내용이라 알림을 지운 것도 그대로 따른다.
 */
export async function upsertIcs(
  userName: string,
  calendarId: number,
  items: IcsItem[],
  accept: (existing: ItemFull) => boolean,
  adjust?: (item: ItemFull) => void,
  options: { keepAlarms?: boolean } = {},
): Promise<{ saved: number; uids: string[] }> {
  const keepAlarms = options.keepAlarms ?? true;
  const groups = new Map<string, IcsItem[]>();
  for (const item of items) {
    if (!groups.has(item.uid)) groups.set(item.uid, []);
    groups.get(item.uid)!.push(item);
  }
  let saved = 0;
  for (const [uid, group] of groups) {
    const existing = (await repo.findByUid(userName, uid)).filter(accept);
    const oldMaster = existing.find((e) => !e.parentId) ?? null;
    const masterIcs = group.find((g) => !g.recurrenceId) ?? null;
    let master: ItemFull | null = oldMaster;
    if (masterIcs) {
      const next = fromIcs(masterIcs, {
        itemId: oldMaster?.itemId ?? uuidv7(),
        userName,
        calendarId: oldMaster?.calendarId ?? calendarId,
        parentId: null,
        regDate: oldMaster?.regDate ?? new Date(),
      });
      if (next) {
        // 이미 있는 내 알림은 받은 쪽 값으로 덮지 않는다 (초대에는 알림이 없다)
        if (keepAlarms && oldMaster && !next.alarms.length) next.alarms = oldMaster.alarms;
        adjust?.(next);
        await repo.saveItem(next, computeIndex(next), !oldMaster);
        master = next;
        saved++;
      }
    }
    for (const exIcs of group.filter((g) => g.recurrenceId)) {
      const old = existing.find((e) => e.parentId && e.recurrenceId === exIcs.recurrenceId) ?? null;
      const next = fromIcs(exIcs, {
        itemId: old?.itemId ?? uuidv7(),
        userName,
        calendarId: master?.calendarId ?? calendarId,
        parentId: master?.itemId ?? null,
        regDate: old?.regDate ?? new Date(),
      });
      if (!next) continue;
      if (keepAlarms && old && !next.alarms.length) next.alarms = old.alarms;
      adjust?.(next);
      await repo.saveItem(next, computeIndex(next), !old);
      saved++;
    }
  }
  return { saved, uids: [...groups.keys()] };
}

// ------------------------------------------------------------------ 초대 메일

function baseUrlOr(baseUrl: string | undefined): string {
  return baseUrl || config.publicBaseUrl || `http://localhost:${config.port}`;
}

function whenText(item: ItemFull, locale: Locale): string {
  const start = item.start ?? item.due ?? '';
  const end = item.type === 'E' ? item.end : null;
  if (item.allDay) {
    const last = end ? formatWall(parseWall(end) - DAY, true) : start;
    return `${start}${last && last !== start ? ` ~ ${last}` : ''} (${t(locale, 'mail.cal.allDay')})`;
  }
  const show = (v: string) => v.replace('T', ' ');
  const sameDay = end && end.slice(0, 10) === start.slice(0, 10);
  return `${show(start)}${end ? ` ~ ${sameDay ? end.slice(11) : show(end)}` : ''} (${item.tzid})`;
}

function inviteHtml(item: ItemFull, intro: string, locale: Locale): string {
  const row = (label: string, value: string | null) =>
    value
      ? `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0">${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`
      : '';
  const attendees = item.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join('\n');
  return (
    `<div style="font-family:sans-serif;font-size:14px">` +
    `<p>${escapeHtml(intro)}</p>` +
    `<h3 style="margin:8px 0">${escapeHtml(item.title || t(locale, 'mail.cal.untitled'))}</h3>` +
    `<table style="border-collapse:collapse">` +
    row(t(locale, 'mail.cal.when'), whenText(item, locale)) +
    row(t(locale, 'mail.cal.where'), item.location) +
    row(t(locale, 'mail.cal.organizer'), item.organizer) +
    row(t(locale, 'mail.cal.attendees'), attendees || null) +
    row(t(locale, 'mail.cal.description'), item.description) +
    `</table></div>`
  );
}

/**
 * UID 하나(원본 + 예외 회차)를 참석자에게 보낸다. 내가 주최자일 때만 보낸다 —
 * 받은 초대를 내 캘린더에서 고쳤다고 남의 참석자들에게 메일이 나가면 안 된다.
 */
async function sendSeries(
  userName: string,
  series: ItemFull[],
  method: 'REQUEST' | 'CANCEL',
  locale: Locale,
  baseUrl?: string,
): Promise<string | null> {
  const master = series.find((i) => !i.parentId) ?? series[0];
  if (!master) return null;
  const mine = await myAddresses(userName);
  if (master.organizer && !mine.has(master.organizer.toLowerCase())) return null;
  const recipients = new Map<string, string | null>();
  for (const item of series) {
    for (const a of item.attendees) if (!mine.has(a.email.toLowerCase())) recipients.set(a.email.toLowerCase(), a.name);
  }
  if (!recipients.size) return null;

  const items = series.map((item) => {
    const ics = toIcs({ ...item, organizer: item.organizer ?? userName });
    if (method === 'CANCEL') ics.status = 'CANCELLED';
    return ics;
  });
  const subject =
    method === 'CANCEL'
      ? t(locale, 'mail.cal.cancelSubject', { title: master.title })
      : master.sequence > 0
        ? t(locale, 'mail.cal.updateSubject', { title: master.title })
        : master.title || t(locale, 'mail.cal.untitled');
  const intro = t(locale, method === 'CANCEL' ? 'mail.cal.cancelIntro' : 'mail.cal.inviteIntro');
  try {
    await sendMail(
      userName,
      {
        to: [...recipients].map(([address, name]) => ({ address, name })),
        cc: [],
        bcc: [],
        subject,
        html: inviteHtml(master, intro, locale),
        attachments: [],
        largeAttachIds: [],
        icalendar: serializeCalendar(items, { method }),
        icalMethod: method,
      },
      baseUrlOr(baseUrl),
      locale,
    );
    return null;
  } catch (cause) {
    return (cause as Error).message || 'send failed';
  }
}

/** 고친 뒤 갱신 초대. 실패해도 저장은 이미 끝났다 — 경고로만 돌려준다 */
export async function notifyUpdated(userName: string, uids: string[], locale: Locale, baseUrl?: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const uid of new Set(uids)) {
    const series = await repo.findByUid(userName, uid);
    if (!series.length) continue;
    const failed = await sendSeries(userName, series, 'REQUEST', locale, baseUrl);
    if (failed) warnings.push(t(locale, 'err.calInviteFailed'));
  }
  return warnings;
}

export async function notifyCancelled(userName: string, groups: ItemFull[][], locale: Locale, baseUrl?: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const series of groups) {
    const failed = await sendSeries(userName, series, 'CANCEL', locale, baseUrl);
    if (failed) warnings.push(t(locale, 'err.calInviteFailed'));
  }
  return warnings;
}

// ------------------------------------------------------------------ 받은 초대

export type InviteResponse = 'ACCEPT' | 'TENTATIVE' | 'DECLINE';

const PARTSTAT: Record<InviteResponse, string> = { ACCEPT: 'ACCEPTED', TENTATIVE: 'TENTATIVE', DECLINE: 'DECLINED' };

/**
 * 받은 초대(REQUEST)에 답한다. 수락 · 미정이면 기본 캘린더에 넣고(이미 있으면 갱신), 거절이면 뺀다.
 * 주최자가 내가 아니면 REPLY 를 보낸다 — 내 참석자 줄 하나만 담는다 (RFC 5546 3.2.3).
 */
export async function respondToInvite(
  userName: string,
  icsText: string,
  response: InviteResponse,
  locale: Locale,
  baseUrl?: string,
): Promise<{ saved: number; replied: boolean; warnings: string[] }> {
  const displayTz = await displayTzOf(userName);
  const parsed = parseCalendar(icsText, displayTz);
  const items = parsed.items.filter((i) => i.type === 'E' || i.type === 'T');
  if (!items.length) throw badRequest('err.calParseFailed');
  const mine = await myAddresses(userName);
  const partstat = PARTSTAT[response];
  const me = (list: IcsItem['attendees']) => list.find((a) => mine.has(a.email.toLowerCase()));

  let saved = 0;
  if (response === 'DECLINE') {
    for (const uid of new Set(items.map((i) => i.uid))) {
      const rows = (await repo.findByUid(userName, uid)).filter((r) => r.organizer && !mine.has(r.organizer.toLowerCase()));
      await repo.deleteItems(rows.map((r) => r.itemId));
    }
  } else {
    const target = await defaultCalendar(userName, locale);
    const writable = new Set((await repo.listCalendars(userName)).filter((c) => !c.readonly).map((c) => c.calendarId));
    const result = await upsertIcs(
      userName,
      target.calendarId,
      items,
      (row) => writable.has(row.calendarId),
      (row) => {
        for (const a of row.attendees) if (mine.has(a.email.toLowerCase())) a.partstat = partstat;
        if (response === 'TENTATIVE' && row.type === 'E') row.status = row.status ?? 'TENTATIVE';
      },
    );
    saved = result.saved;
  }

  const organizer = items.find((i) => i.organizer)?.organizer ?? null;
  const warnings: string[] = [];
  let replied = false;
  if (organizer && !mine.has(organizer.toLowerCase())) {
    const user = await users.findUser(userName);
    const replyItems: IcsItem[] = items.map((item) => {
      const found = me(item.attendees);
      return {
        ...item,
        alarms: [],
        attendees: [
          {
            email: found?.email ?? userName,
            name: found?.name ?? user?.displayName ?? null,
            role: found?.role ?? 'REQ-PARTICIPANT',
            partstat,
            rsvp: false,
          },
        ],
      };
    });
    const master = replyItems.find((i) => !i.recurrenceId) ?? replyItems[0]!;
    try {
      await sendMail(
        userName,
        {
          to: [{ address: organizer }],
          cc: [],
          bcc: [],
          subject: t(locale, `mail.cal.reply.${partstat}`, { title: master.title }),
          html: `<p>${escapeHtml(t(locale, `mail.cal.replyBody.${partstat}`, { who: user?.displayName || userName, title: master.title }))}</p>`,
          attachments: [],
          largeAttachIds: [],
          icalendar: serializeCalendar(replyItems, { method: 'REPLY' }),
          icalMethod: 'REPLY',
        },
        baseUrlOr(baseUrl),
        locale,
      );
      replied = true;
    } catch {
      warnings.push(t(locale, 'err.calReplyFailed'));
    }
  }
  return { saved, replied, warnings };
}

/**
 * 받은 iTIP 를 캘린더에 반영한다 (읽기 화면의 버튼).
 *   import  그냥 내 캘린더에 넣는다 (PUBLISH · 첨부 .ics)
 *   reply   참석자 응답(REPLY)을 내가 주최한 일정의 참석자 상태에 적는다
 *   cancel  주최자가 취소(CANCEL)한 일정을 내 캘린더에서 지운다
 */
export async function applyItip(
  userName: string,
  icsText: string,
  action: 'import' | 'reply' | 'cancel',
  locale: Locale,
  calendarId?: number,
): Promise<{ changed: number }> {
  const displayTz = await displayTzOf(userName);
  const parsed = parseCalendar(icsText, displayTz);
  if (!parsed.items.length) throw badRequest('err.calParseFailed');
  const mine = await myAddresses(userName);

  if (action === 'import') {
    const target = calendarId
      ? await repo.findCalendar(userName, calendarId)
      : await defaultCalendar(userName, locale);
    if (!target) throw badRequest('err.calNotFound');
    if (target.readonly) throw forbidden('err.calReadonly');
    const writable = new Set((await repo.listCalendars(userName)).filter((c) => !c.readonly).map((c) => c.calendarId));
    const result = await upsertIcs(userName, target.calendarId, parsed.items, (row) => writable.has(row.calendarId));
    return { changed: result.saved };
  }

  let changed = 0;
  for (const incoming of parsed.items) {
    const rows = await repo.findByUid(userName, incoming.uid);
    if (action === 'reply') {
      const row =
        rows.find((r) => (incoming.recurrenceId ? r.recurrenceId === incoming.recurrenceId : !r.parentId)) ??
        rows.find((r) => !r.parentId);
      // 내가 주최한 일정에만 적는다. 남의 응답 메일로 내 일정이 아닌 것을 고치지 않는다
      if (!row || (row.organizer && !mine.has(row.organizer.toLowerCase()))) continue;
      let touched = false;
      for (const reply of incoming.attendees) {
        const target = row.attendees.find((a) => a.email.toLowerCase() === reply.email.toLowerCase());
        if (target && target.partstat !== reply.partstat) {
          target.partstat = reply.partstat;
          touched = true;
        }
      }
      if (touched) {
        row.updateDate = new Date();
        await repo.saveItem(row, computeIndex(row), false);
        changed++;
      }
    } else {
      // 취소: 주최자가 보낸 것만 받는다
      const own = rows.filter((r) => !r.organizer || !incoming.organizer || r.organizer.toLowerCase() === incoming.organizer.toLowerCase());
      if (incoming.recurrenceId) {
        const master = own.find((r) => !r.parentId);
        const ex = own.find((r) => r.recurrenceId === incoming.recurrenceId);
        if (ex) await repo.deleteItems([ex.itemId]);
        if (master && !master.exdates.includes(incoming.recurrenceId)) {
          master.exdates = [...master.exdates, incoming.recurrenceId].sort();
          master.updateDate = new Date();
          await repo.saveItem(master, computeIndex(master), false);
        }
        changed++;
      } else if (own.length) {
        await repo.deleteItems(own.map((r) => r.itemId));
        changed++;
      }
    }
  }
  return { changed };
}

// ------------------------------------------------------------------ 가져오기 · 내보내기 · 게시

export async function importIntoCalendar(userName: string, calendar: CalendarRecord, icsText: string): Promise<number> {
  if (calendar.readonly) throw forbidden('err.calReadonly');
  const displayTz = await displayTzOf(userName);
  const parsed = parseCalendar(icsText, displayTz);
  if (!parsed.items.length) throw badRequest('err.calParseFailed');
  const result = await upsertIcs(userName, calendar.calendarId, parsed.items, (row) => row.calendarId === calendar.calendarId);
  return result.saved;
}

export async function exportCalendar(calendar: CalendarRecord): Promise<string> {
  const items = await repo.listCalendarItems(calendar.calendarId);
  return serializeCalendar(items.map(toIcs), { name: calendar.name, method: 'PUBLISH' });
}

export async function exportItems(userName: string, itemIds: string[]): Promise<string> {
  const picked = await repo.listItemsByIds(userName, itemIds);
  // 반복 원본을 고르면 예외 회차도 같이 내보내야 같은 일정이 된다
  const masters = picked.filter((i) => i.rrule && !i.parentId).map((i) => i.itemId);
  const extra = await repo.withChildren(await repo.exceptionsOf(masters));
  const all = new Map([...picked, ...extra].map((i) => [i.itemId, i]));
  return serializeCalendar([...all.values()].map(toIcs), { method: 'PUBLISH' });
}

// ------------------------------------------------------------------ 네트워크 캘린더 (ICS 구독)

/** 받을 .ics 크기 상한 */
const MAX_ICS_BYTES = 10 * 1024 * 1024;

export function normalizeFeedUrl(raw: string): string {
  const value = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('err.calBadUrl');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('err.calBadUrl');
  return url.toString();
}

/**
 * 구독 주소에서 .ics 를 받는다. 주소마다 IP 를 풀어 막힌 대역(사내망 · 메타데이터)인지 본다 —
 * 외부메일 설정과 같은 검사다 (services/externalMail.ts). 넘겨주기(redirect)도 한 번씩 다시 본다.
 */
async function fetchIcs(rawUrl: string): Promise<string> {
  let target = normalizeFeedUrl(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    const url = new URL(target);
    await resolveAllowedHost(url.hostname.replace(/^\[|\]$/g, ''));
    const res = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'text/calendar, */*;q=0.5', 'user-agent': 'james9Mail-Calendar' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = normalizeFeedUrl(new URL(res.headers.get('location')!, target).toString());
      continue;
    }
    if (!res.ok) throw badRequest('err.calFetchFailed', { status: res.status });
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_ICS_BYTES) throw badRequest('err.calTooLarge');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_ICS_BYTES) throw badRequest('err.calTooLarge');
    return body.toString('utf8');
  }
  throw badRequest('err.calFetchFailed', { status: 310 });
}

/** 구독 캘린더를 새로 받는다. 피드에서 사라진 일정은 지운다 */
export async function refreshSubscription(userName: string, calendar: CalendarRecord): Promise<number> {
  if (calendar.type !== 'ICS' || !calendar.sourceUrl) return 0;
  try {
    const text = await fetchIcs(calendar.sourceUrl);
    const displayTz = await displayTzOf(userName);
    const parsed = parseCalendar(text, displayTz);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw badRequest('err.calParseFailed');
    const result = await upsertIcs(userName, calendar.calendarId, parsed.items, (row) => row.calendarId === calendar.calendarId);
    const keep = new Set(result.uids);
    const stale = (await repo.listCalendarItems(calendar.calendarId)).filter((i) => !keep.has(i.uid));
    await repo.deleteItems(stale.map((i) => i.itemId));
    await repo.updateCalendar(calendar.calendarId, { lastSync: new Date(), syncError: null });
    return result.saved;
  } catch (cause) {
    await repo.updateCalendar(calendar.calendarId, {
      lastSync: new Date(),
      syncError: ((cause as Error).message || 'error').slice(0, 500),
    });
    throw cause;
  }
}

/** 새로 고칠 때가 된 구독 캘린더를 뒤에서 받는다. 화면 응답을 기다리게 하지 않는다 */
const refreshing = new Set<number>();
export function refreshStaleSubscriptions(userName: string, calendars: CalendarRecord[]): void {
  const now = Date.now();
  for (const cal of calendars) {
    if (cal.type !== 'ICS' || refreshing.has(cal.calendarId)) continue;
    const last = cal.lastSync ? Date.parse(cal.lastSync) : 0;
    if (now - last < Math.max(5, cal.refreshMin) * 60_000) continue;
    refreshing.add(cal.calendarId);
    void refreshSubscription(userName, cal)
      .catch(() => undefined)
      .finally(() => refreshing.delete(cal.calendarId));
  }
}

/** 게시 주소 토큰. 이 값을 아는 사람은 누구나 캘린더를 읽을 수 있으므로 추측할 수 없어야 한다 */
export function feedTokenNew(): string {
  return randomBytes(24).toString('hex');
}
