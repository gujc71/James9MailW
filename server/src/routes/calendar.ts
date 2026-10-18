/** 캘린더 · 태스크 (썬더버드 캘린더 기능). 계산은 services/calendar.ts, 바깥과의 주고받기는 services/calendarItip.ts */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { config } from '../config.js';
import { localeOf } from '../i18n.js';
import { badRequest, notFound } from '../errors.js';
import * as repo from '../repositories/calendar.js';
import * as cal from '../services/calendar.js';
import * as itip from '../services/calendarItip.js';
import { applyPendingReplies } from '../services/calendarReplies.js';
import { isValidTimeZone, isWall } from '../calendar/time.js';

const wall = z.string().refine(isWall, 'err.calBadTime');
const scope = z.enum(['this', 'following', 'all']).default('all');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const itemSchema = z.object({
  type: z.enum(['E', 'T']),
  calendarId: z.number().int(),
  title: z.string().max(500),
  location: z.string().max(500).default(''),
  description: z.string().max(200_000).default(''),
  url: z.string().max(1000).default(''),
  allDay: z.boolean().default(false),
  tzid: z.string().max(64),
  start: wall.nullable().default(null),
  end: wall.nullable().default(null),
  due: wall.nullable().default(null),
  status: z.string().max(12).nullable().default(null),
  priority: z.number().int().min(0).max(9).default(0),
  privacy: z.string().max(12).default('PUBLIC'),
  transp: z.string().max(12).default('OPAQUE'),
  percent: z.number().int().min(0).max(100).default(0),
  completed: z.string().max(40).nullable().default(null),
  rrule: z.string().max(500).nullable().default(null),
  categories: z.array(z.string().max(100)).max(50).default([]),
  alarms: z
    .array(z.object({ offsetMin: z.number().int().min(-525_600).max(525_600), related: z.enum(['S', 'E']) }))
    .max(10)
    .default([]),
  attendees: z
    .array(
      z.object({
        email: z.string().email('err.badAddressTo').max(255),
        name: z.string().max(255).nullable().default(null),
        role: z.string().max(20).default('REQ-PARTICIPANT'),
        partstat: z.string().max(20).default('NEEDS-ACTION'),
        rsvp: z.boolean().default(true),
      }),
    )
    .max(200)
    .default([]),
  attachments: z
    .array(z.object({ url: z.string().url().max(1000), name: z.string().max(255).nullable().default(null) }))
    .max(50)
    .default([]),
});

const settingSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, 'err.calBadTimezone'),
  weekStart: z.number().int().min(0).max(6),
  daysOff: z.array(z.number().int().min(0).max(6)).max(7),
  dayStartHour: z.number().int().min(0).max(23),
  dayEndHour: z.number().int().min(1).max(24),
  visibleHours: z.number().int().min(1).max(24),
  multiweekCount: z.number().int().min(1).max(6),
  prevWeeks: z.number().int().min(0).max(2),
  weekNumbers: z.boolean(),
  defaultLengthMin: z.number().int().min(0).max(10_080),
  defaultAlarmMin: z.number().int().min(-1).max(40_320),
  alarmSound: z.boolean(),
  alarmPopup: z.boolean(),
  missedAlarms: z.boolean(),
});

function baseUrl(request: FastifyRequest): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return `${request.protocol}://${request.headers.host ?? `localhost:${config.port}`}`;
}

/** 게시 주소. 브라우저에서 보이는 주소와 같은 호스트로 만든다 */
function feedUrl(request: FastifyRequest, token: string | null): string | null {
  return token ? `${baseUrl(request)}/api/calendar/feed/${token}.ics` : null;
}

function publicCalendar(request: FastifyRequest, calendar: repo.CalendarRecord) {
  const { feedToken, userName: _owner, ...rest } = calendar;
  return { ...rest, feedUrl: feedUrl(request, feedToken) };
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireUser] };

  // ---------------------------------------------------------------- 처음 열 때 한 번에

  app.get('/api/calendar/bootstrap', guard, async (request) => {
    const session = sessionOf(request);
    const { tz } = z.object({ tz: z.string().max(64).optional() }).parse(request.query);
    // 참석자가 보낸 응답(REPLY) 메일을 먼저 반영해 둔다
    await applyPendingReplies(session.userName, localeOf(request));
    const settings = await cal.settingsOf(session.userName, tz);
    const calendars = await cal.calendarsOf(session.userName, localeOf(request));
    itip.refreshStaleSubscriptions(session.userName, calendars);
    return {
      settings,
      calendars: calendars.map((c) => publicCalendar(request, c)),
      categories: await repo.listCategories(session.userName),
    };
  });

  app.put('/api/calendar/settings', guard, async (request) => {
    const session = sessionOf(request);
    const input = settingSchema.parse(request.body);
    if (input.dayEndHour <= input.dayStartHour) throw badRequest('err.calBadHours');
    await repo.saveSetting(session.userName, { ...input, daysOff: [...new Set(input.daysOff)].sort() });
    return { ok: true };
  });

  app.put('/api/calendar/categories', guard, async (request) => {
    const session = sessionOf(request);
    const { categories } = z
      .object({ categories: z.array(z.object({ name: z.string().min(1).max(100), color: color.nullable() })).max(200) })
      .parse(request.body);
    const names = cal.cleanCategories(categories.map((c) => c.name));
    const byName = new Map(categories.map((c) => [c.name.replace(/,/g, ' ').trim().toLowerCase(), c.color]));
    await repo.replaceCategories(
      session.userName,
      names.map((name) => ({ name, color: byName.get(name.toLowerCase()) ?? null })),
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------- 캘린더

  app.get('/api/calendar/calendars', guard, async (request) => {
    const session = sessionOf(request);
    const list = await cal.calendarsOf(session.userName, localeOf(request));
    return list.map((c) => publicCalendar(request, c));
  });

  app.post('/api/calendar/calendars', guard, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        color,
        type: z.enum(['LOCAL', 'ICS']),
        sourceUrl: z.string().max(1000).optional(),
        refreshMin: z.number().int().min(5).max(10_080).default(60),
        alarm: z.boolean().default(true),
      })
      .parse(request.body);
    const sourceUrl = input.type === 'ICS' ? itip.normalizeFeedUrl(input.sourceUrl ?? '') : null;
    const calendarId = await repo.createCalendar(session.userName, { ...input, sourceUrl });
    if (input.type === 'ICS') {
      const created = await repo.findCalendar(session.userName, calendarId);
      // 첫 받기는 기다린다. 주소가 틀렸으면 지금 알려야 한다 (캘린더는 남기고 오류만 표시한다)
      if (created) await itip.refreshSubscription(session.userName, created).catch(() => undefined);
    }
    return { calendarId };
  });

  app.put('/api/calendar/calendars/:id', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        color: color.optional(),
        visible: z.boolean().optional(),
        readonly: z.boolean().optional(),
        alarm: z.boolean().optional(),
        isDefault: z.boolean().optional(),
        refreshMin: z.number().int().min(5).max(10_080).optional(),
        sourceUrl: z.string().max(1000).optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(request.body);
    const current = await cal.requireCalendar(session.userName, id);
    const { isDefault, sourceUrl, ...patch } = input;
    await repo.updateCalendar(id, {
      ...patch,
      ...(sourceUrl !== undefined && current.type === 'ICS' ? { sourceUrl: itip.normalizeFeedUrl(sourceUrl), lastSync: null } : {}),
    });
    if (isDefault) await repo.setDefaultCalendar(session.userName, id);
    return { ok: true };
  });

  app.delete('/api/calendar/calendars/:id', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    await cal.requireCalendar(session.userName, id);
    const all = await repo.listCalendars(session.userName);
    // 쓸 수 있는 캘린더가 하나는 남아야 새 일정 · 초대 수락이 들어갈 곳이 있다
    if (!all.some((c) => c.calendarId !== id && !c.readonly)) throw badRequest('err.calLastCalendar');
    await repo.deleteCalendar(id);
    await cal.calendarsOf(session.userName, localeOf(request));
    return { ok: true };
  });

  app.post('/api/calendar/calendars/:id/refresh', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const calendar = await cal.requireCalendar(session.userName, id);
    return { saved: await itip.refreshSubscription(session.userName, calendar) };
  });

  app.post('/api/calendar/calendars/:id/publish', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const calendar = await cal.requireCalendar(session.userName, id);
    // 다시 켜면 새 토큰이다 — 끄기 전에 퍼진 주소는 계속 막혀 있어야 한다
    const token = enabled ? (calendar.feedToken ?? itip.feedTokenNew()) : null;
    await repo.updateCalendar(id, { feedToken: token });
    return { feedUrl: feedUrl(request, token) };
  });

  app.get('/api/calendar/calendars/:id/export', guard, async (request, reply) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const calendar = await cal.requireCalendar(session.userName, id);
    const text = await itip.exportCalendar(calendar);
    const name = encodeURIComponent(`${calendar.name}.ics`);
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${name}`)
      .send(text);
  });

  app.post('/api/calendar/calendars/:id/import', { ...guard, bodyLimit: 12 * 1024 * 1024 }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const { ics } = z.object({ ics: z.string().min(1).max(11 * 1024 * 1024) }).parse(request.body);
    const calendar = await cal.requireCalendar(session.userName, id, true);
    return { imported: await itip.importIntoCalendar(session.userName, calendar, ics) };
  });

  /** 게시한 캘린더. 로그인 없이 토큰으로만 읽는다 (다른 캘린더 프로그램이 구독한다) */
  app.get('/api/calendar/feed/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().max(80) }).parse(request.params);
    const calendar = await repo.findCalendarByFeed(token.replace(/\.ics$/i, ''));
    if (!calendar) throw notFound();
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(await itip.exportCalendar(calendar));
  });

  // ---------------------------------------------------------------- 조회

  app.get('/api/calendar/occurrences', guard, async (request) => {
    const session = sessionOf(request);
    await applyPendingReplies(session.userName, localeOf(request));
    const query = z
      .object({
        from: wall.optional(),
        to: wall.optional(),
        q: z.string().max(200).optional(),
        type: z.enum(['E', 'T']).optional(),
        /** series: 반복을 펼치지 않는다 ("모든 이벤트"). after 가 있으면 그 뒤 첫 회차 */
        mode: z.enum(['range', 'series']).default('range'),
        after: wall.optional(),
      })
      .parse(request.query);
    if (query.mode === 'series') return cal.seriesList(session.userName, { q: query.q || undefined, after: query.after });
    if (!query.from || !query.to) throw badRequest('err.calBadTime');
    return cal.occurrencesInRange(session.userName, {
      from: query.from,
      to: query.to,
      q: query.q || undefined,
      type: query.type,
    });
  });

  app.get('/api/calendar/recent-attendees', guard, async (request) =>
    repo.recentAttendees(sessionOf(request).userName, 10),
  );

  app.get('/api/calendar/tasks', guard, async (request) => cal.taskList(sessionOf(request).userName));

  app.get('/api/calendar/items/:id', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.string().max(36) }).parse(request.params);
    await applyPendingReplies(session.userName, localeOf(request));
    return cal.itemDetail(session.userName, id);
  });

  app.get('/api/calendar/freebusy', guard, async (request) => {
    const session = sessionOf(request);
    const query = z.object({ emails: z.string().max(10_000), from: wall, to: wall }).parse(request.query);
    return cal.freeBusy(session.userName, query.emails.split(','), query.from, query.to);
  });

  app.post('/api/calendar/items/export', guard, async (request, reply) => {
    const session = sessionOf(request);
    const { itemIds } = z.object({ itemIds: z.array(z.string().max(36)).min(1).max(5_000) }).parse(request.body);
    return reply.header('Content-Type', 'text/calendar; charset=utf-8').send(await itip.exportItems(session.userName, itemIds));
  });

  // ---------------------------------------------------------------- 쓰기

  app.post('/api/calendar/items', guard, async (request) => {
    const session = sessionOf(request);
    const body = z.object({ item: itemSchema, notify: z.boolean().default(false) }).parse(request.body);
    const result = await cal.createItem(session.userName, body.item);
    const warnings = body.notify ? await itip.notifyUpdated(session.userName, result.uids, localeOf(request), baseUrl(request)) : [];
    return { itemId: result.itemId, warnings };
  });

  app.put('/api/calendar/items/:id', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.string().max(36) }).parse(request.params);
    const body = z
      .object({ item: itemSchema, scope, occurrence: wall.nullable().default(null), notify: z.boolean().default(false) })
      .parse(request.body);
    const result = await cal.updateItem(session.userName, id, body.item, body.scope, body.occurrence);
    const warnings = body.notify ? await itip.notifyUpdated(session.userName, result.uids, localeOf(request), baseUrl(request)) : [];
    return { itemId: result.itemId, warnings };
  });

  app.post('/api/calendar/items/:id/move', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.string().max(36) }).parse(request.params);
    const body = z
      .object({
        start: wall,
        end: wall.nullable().default(null),
        allDay: z.boolean(),
        scope,
        occurrence: wall.nullable().default(null),
        notify: z.boolean().default(false),
      })
      .parse(request.body);
    const result = await cal.moveItem(session.userName, id, body);
    const warnings = body.notify ? await itip.notifyUpdated(session.userName, result.uids, localeOf(request), baseUrl(request)) : [];
    return { itemId: result.itemId, warnings };
  });

  app.post('/api/calendar/items/:id/quick', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.string().max(36) }).parse(request.params);
    const body = z
      .object({
        patch: z.object({
          categories: z.array(z.string().max(100)).max(50).optional(),
          status: z.string().max(12).nullable().optional(),
          percent: z.number().int().min(0).max(100).optional(),
          priority: z.number().int().min(0).max(9).optional(),
          privacy: z.string().max(12).optional(),
          calendarId: z.number().int().optional(),
          completed: z.boolean().optional(),
        }),
        scope,
        occurrence: wall.nullable().default(null),
      })
      .parse(request.body);
    const result = await cal.quickPatch(session.userName, id, body.patch, body.scope, body.occurrence);
    return { itemId: result.itemId };
  });

  app.delete('/api/calendar/items/:id', guard, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.string().max(36) }).parse(request.params);
    const query = z
      .object({
        scope,
        occurrence: wall.optional(),
        notify: z
          .enum(['0', '1', 'true', 'false'])
          .default('0')
          .transform((v) => v === '1' || v === 'true'),
      })
      .parse(request.query);
    const result = await cal.deleteItem(session.userName, id, query.scope, query.occurrence ?? null);
    const warnings: string[] = [];
    if (query.notify) {
      warnings.push(...(await itip.notifyCancelled(session.userName, result.cancelled, localeOf(request), baseUrl(request))));
      warnings.push(...(await itip.notifyUpdated(session.userName, result.updated, localeOf(request), baseUrl(request))));
    }
    return { ok: true, warnings };
  });

  // ---------------------------------------------------------------- 알림

  app.get('/api/calendar/alarms', guard, async (request) => cal.dueAlarms(sessionOf(request).userName));

  const alarmRefs = z.array(z.object({ alarmId: z.number().int(), occurrence: z.string().max(16) })).min(1).max(200);

  app.post('/api/calendar/alarms/snooze', guard, async (request) => {
    const session = sessionOf(request);
    const body = z.object({ items: alarmRefs, minutes: z.number().int().min(1).max(10_080) }).parse(request.body);
    await repo.setAlarmState(
      session.userName,
      body.items.map((i) => ({ alarmId: i.alarmId, occurKey: i.occurrence })),
      { snoozeUntil: new Date(Date.now() + body.minutes * 60_000), dismissed: false },
    );
    return { ok: true };
  });

  app.post('/api/calendar/alarms/dismiss', guard, async (request) => {
    const session = sessionOf(request);
    const body = z.object({ items: alarmRefs }).parse(request.body);
    await repo.setAlarmState(
      session.userName,
      body.items.map((i) => ({ alarmId: i.alarmId, occurKey: i.occurrence })),
      { snoozeUntil: null, dismissed: true },
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------- 받은 초대 · .ics

  app.post('/api/calendar/itip', { ...guard, bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const session = sessionOf(request);
    const body = z
      .object({
        ics: z.string().min(1).max(3 * 1024 * 1024),
        action: z.enum(['import', 'reply', 'cancel']),
        calendarId: z.number().int().optional(),
      })
      .parse(request.body);
    return itip.applyItip(session.userName, body.ics, body.action, localeOf(request), body.calendarId);
  });
}
