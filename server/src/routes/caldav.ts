/**
 * CalDAV 엔드포인트 (RFC 4791 · 4918 · 6764). 썬더버드 · DAVx⁵ · iOS 캘린더 등이 쓴다.
 * 캘린더 설정 > 일반의 "외부에서 일정 관리 사용" 을 켠 사용자만 들어온다 (services/caldav.ts authenticate).
 *
 *   /.well-known/caldav · carddav            → /dav/ 로 넘긴다 (자동 검색)
 *   /dav/                                    루트
 *   /dav/principals/<사용자>/                 주체 (calendar-home-set · addressbook-home-set)
 *   /dav/addressbooks/<사용자>/…              주소록 — routes/carddav.ts 가 맡는다
 *   /dav/calendars/<사용자>/                  캘린더 모음
 *   /dav/calendars/<사용자>/<캘린더ID>/        캘린더 (CAL_CALENDAR)
 *   /dav/calendars/<사용자>/<캘린더ID>/<이름>  일정 · 할 일 하나 (같은 UID 의 원본 + 예외 회차)
 *
 * 인증은 세션 쿠키가 아니라 요청마다 Basic(아이디 · 메일 비밀번호)이다. /api/ 가 아니라 CSRF 헤더
 * 검사(app.ts)도 타지 않는다 — 쿠키를 쓰지 않으니 다른 사이트가 사용자 대신 보낼 수 없다.
 * 지원 범위: PROPFIND · PROPPATCH(이름 · 색) · REPORT(calendar-multiget · calendar-query) ·
 * GET · PUT · DELETE · OPTIONS. sync-collection · 서버 쪽 일정 초대(RFC 6638)는 하지 않는다.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import * as repo from '../repositories/calendar.js';
import type { CalendarRecord } from '../repositories/calendar.js';
import * as dav from '../services/caldav.js';
import { exportCalendar } from '../services/calendarItip.js';
import { sessionOf } from '../plugins/auth.js';
import { schemaHint } from '../db/schemaCheck.js';
import {
  CAL,
  CARD,
  CS,
  DAV,
  ICAL,
  child,
  childrenOf,
  describe,
  enc,
  errorBody,
  escapeXml,
  href,
  key,
  memberName,
  multistatus,
  notFoundResponse,
  parseXml,
  privileges,
  PRIV_READ,
  PRIV_WRITE,
  propstat,
  requested,
  segmentsOf,
} from '../dav/xml.js';
import { addressbookHomeHref, addressbookHref, carddavHandle } from './carddav.js';

/** PROPFIND · REPORT 등 Fastify 기본에 없는 메서드. app.ts 가 라우트보다 먼저 등록한다 */
export const DAV_METHODS = ['PROPFIND', 'PROPPATCH', 'REPORT', 'MKCOL', 'MKCALENDAR'] as const;
const METHODS = ['GET', 'PUT', 'DELETE', 'OPTIONS', ...DAV_METHODS];
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT';
/** calendar-auto-schedule 은 일부러 빼 둔다 — 그래야 썬더버드가 초대 메일을 직접 보낸다 */
const DAV_HEADER = '1, 3, calendar-access, addressbook';
const BODY_LIMIT = 12 * 1024 * 1024;

// ------------------------------------------------------------------ 경로

const principalHref = (user: string) => `/dav/principals/${enc(user)}/`;
const homeHref = (user: string) => `/dav/calendars/${enc(user)}/`;
const calendarHref = (user: string, id: number) => `${homeHref(user)}${id}/`;
const objectHref = (user: string, id: number, name: string) => `${calendarHref(user, id)}${enc(name)}`;

type Target =
  | { kind: 'root' }
  | { kind: 'principal' }
  | { kind: 'home' }
  | { kind: 'calendar'; calendar: CalendarRecord }
  | { kind: 'object'; calendar: CalendarRecord; name: string };

/** 남의 주소 · 없는 캘린더는 null (404) */
async function resolve(segments: string[], userName: string): Promise<Target | null> {
  const [top, kind, user, calId, name, ...rest] = segments;
  if (top !== 'dav' || rest.length) return null;
  if (!kind) return { kind: 'root' };
  if (!user || user.toLowerCase() !== userName.toLowerCase()) return null;
  if (kind === 'principals') return calId === undefined ? { kind: 'principal' } : null;
  if (kind !== 'calendars') return null;
  if (calId === undefined) return { kind: 'home' };
  if (!/^\d{1,15}$/.test(calId)) return null;
  const calendar = await repo.findCalendar(userName, Number(calId));
  if (!calendar) return null;
  return name === undefined ? { kind: 'calendar', calendar } : { kind: 'object', calendar, name };
}

// ------------------------------------------------------------------ 속성

const SUPPORTED_REPORTS = ['c:calendar-multiget', 'c:calendar-query']
  .map((r) => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`)
  .join('');

const CALENDAR_DATA = key(CAL, 'calendar-data');

interface Ctx {
  userName: string;
  displayName: string | null;
  /** 이 계정이 켠 것 (개인 환경설정). 주체 속성에 그쪽 home-set 만 알린다 */
  caldav: boolean;
  carddav: boolean;
  resources: Map<number, dav.DavResource[]>;
}

async function resourcesOf(ctx: Ctx, calendarId: number): Promise<dav.DavResource[]> {
  let list = ctx.resources.get(calendarId);
  if (!list) {
    list = await dav.listResources(calendarId);
    ctx.resources.set(calendarId, list);
  }
  return list;
}

/** 자원이 가진 속성 전부 (calendar-data 는 따로). 값은 요소 안쪽 XML */
async function propsOf(target: Target, ctx: Ctx, resource?: dav.DavResource): Promise<Map<string, string>> {
  const p = new Map<string, string>();
  const me = ctx.userName;
  p.set(key(DAV, 'current-user-principal'), href(principalHref(me)));
  switch (target.kind) {
    case 'root':
      p.set(key(DAV, 'resourcetype'), '<d:collection/>');
      p.set(key(DAV, 'displayname'), 'DAV');
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_READ));
      break;
    case 'principal':
      p.set(key(DAV, 'resourcetype'), '<d:principal/>');
      p.set(key(DAV, 'displayname'), escapeXml(ctx.displayName || me));
      p.set(key(DAV, 'principal-URL'), href(principalHref(me)));
      if (ctx.caldav) p.set(key(CAL, 'calendar-home-set'), href(homeHref(me)));
      if (ctx.carddav) p.set(key(CARD, 'addressbook-home-set'), href(addressbookHomeHref(me)));
      if (me.includes('@')) p.set(key(CAL, 'calendar-user-address-set'), href(`mailto:${me}`));
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_READ));
      break;
    case 'home':
      p.set(key(DAV, 'resourcetype'), '<d:collection/>');
      p.set(key(DAV, 'displayname'), escapeXml(ctx.displayName || me));
      p.set(key(DAV, 'owner'), href(principalHref(me)));
      // bind 를 주지 않는다 — 캘린더 만들기 · 지우기는 웹에서만 한다
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_READ));
      break;
    case 'calendar': {
      const cal = target.calendar;
      p.set(key(DAV, 'resourcetype'), '<d:collection/><c:calendar/>');
      p.set(key(DAV, 'displayname'), escapeXml(cal.name));
      p.set(key(DAV, 'owner'), href(principalHref(me)));
      p.set(key(DAV, 'current-user-privilege-set'), privileges(cal.readonly ? PRIV_READ : PRIV_WRITE));
      p.set(key(DAV, 'supported-report-set'), SUPPORTED_REPORTS);
      p.set(key(CAL, 'supported-calendar-component-set'), '<c:comp name="VEVENT"/><c:comp name="VTODO"/>');
      p.set(key(CAL, 'supported-calendar-data'), '<c:calendar-data content-type="text/calendar" version="2.0"/>');
      p.set(key(CS, 'getctag'), dav.ctagOf(cal, await resourcesOf(ctx, cal.calendarId)));
      p.set(key(ICAL, 'calendar-color'), escapeXml(cal.color));
      p.set(key(ICAL, 'calendar-order'), String(cal.sortOrder));
      break;
    }
    case 'object':
      if (!resource) break;
      p.set(key(DAV, 'resourcetype'), '');
      p.set(key(DAV, 'getetag'), escapeXml(resource.etag));
      p.set(key(DAV, 'getlastmodified'), resource.lastModified.toUTCString());
      p.set(
        key(DAV, 'getcontenttype'),
        `text/calendar; charset=utf-8; component=${resource.type === 'T' ? 'VTODO' : 'VEVENT'}`,
      );
      p.set(key(DAV, 'current-user-privilege-set'), privileges(target.calendar.readonly ? PRIV_READ : PRIV_WRITE));
      break;
  }
  return p;
}

/** 일정 자원 응답들. calendar-data 를 달라고 했을 때만 본문을 읽는다 */
async function objectResponses(
  ctx: Ctx,
  calendar: CalendarRecord,
  list: dav.DavResource[],
  wanted: string[] | null,
): Promise<string[]> {
  const bodies = wanted?.includes(CALENDAR_DATA) ? await dav.loadBodies(calendar.calendarId, list) : null;
  const out: string[] = [];
  for (const resource of list) {
    const target: Target = { kind: 'object', calendar, name: resource.name };
    const props = await propsOf(target, ctx, resource);
    const body = bodies?.get(resource.uid);
    out.push(
      describe(
        objectHref(ctx.userName, calendar.calendarId, resource.name),
        props,
        wanted,
        body === undefined ? undefined : { key: CALENDAR_DATA, body },
      ),
    );
  }
  return out;
}

function hrefOf(target: Target, userName: string): string {
  switch (target.kind) {
    case 'root':
      return '/dav/';
    case 'principal':
      return principalHref(userName);
    case 'home':
      return homeHref(userName);
    case 'calendar':
      return calendarHref(userName, target.calendar.calendarId);
    case 'object':
      return objectHref(userName, target.calendar.calendarId, target.name);
  }
}

// ------------------------------------------------------------------ 메서드

function sendXml(reply: FastifyReply, status: number, xml: string): FastifyReply {
  return reply.code(status).header('Content-Type', 'application/xml; charset=utf-8').send(xml);
}

async function propfind(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const body = typeof request.body === 'string' ? request.body.trim() : '';
  const root = body ? parseXml(body) : null;
  if (body && !root) return reply.code(400).send('bad xml');
  const wanted = requested(root);
  const depth = String(request.headers.depth ?? '1').trim() === '0' ? 0 : 1;
  const responses: string[] = [];

  if (target.kind === 'object') {
    const resource = (await resourcesOf(ctx, target.calendar.calendarId)).find((r) => r.name === target.name);
    if (!resource) return reply.code(404).send();
    responses.push(...(await objectResponses(ctx, target.calendar, [resource], wanted)));
    return sendXml(reply, 207, multistatus(responses));
  }

  responses.push(describe(hrefOf(target, ctx.userName), await propsOf(target, ctx), wanted));
  if (depth === 1) {
    if (target.kind === 'home') {
      for (const calendar of await repo.listCalendars(ctx.userName)) {
        const t: Target = { kind: 'calendar', calendar };
        responses.push(describe(hrefOf(t, ctx.userName), await propsOf(t, ctx), wanted));
      }
    } else if (target.kind === 'calendar') {
      const list = await resourcesOf(ctx, target.calendar.calendarId);
      responses.push(...(await objectResponses(ctx, target.calendar, list, wanted)));
    }
  }
  return sendXml(reply, 207, multistatus(responses));
}

/** 20261001T000000Z → Date */
function parseUtc(value: string | undefined): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value?.trim() ?? '');
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
}

async function report(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const root = typeof request.body === 'string' ? parseXml(request.body.trim()) : null;
  if (!root) return reply.code(400).send('bad xml');
  if (target.kind !== 'calendar' && target.kind !== 'object') {
    return sendXml(reply, 403, errorBody(DAV, 'supported-report'));
  }
  const calendar = target.calendar;
  const wanted = requested(root) ?? [key(DAV, 'getetag'), CALENDAR_DATA];
  const all = await resourcesOf(ctx, calendar.calendarId);

  if (root.ns === CAL && root.name === 'calendar-multiget') {
    const base = calendarHref(ctx.userName, calendar.calendarId);
    const picked: dav.DavResource[] = [];
    const missing: string[] = [];
    for (const h of childrenOf(root, DAV, 'href')) {
      const name = memberName(h.text, base);
      const resource = name ? all.find((r) => r.name === name) : undefined;
      if (resource) picked.push(resource);
      else missing.push(h.text.trim());
    }
    const responses = await objectResponses(ctx, calendar, picked, wanted);
    for (const m of missing) {
      responses.push(notFoundResponse(m));
    }
    return sendXml(reply, 207, multistatus(responses));
  }

  if (root.ns === CAL && root.name === 'calendar-query') {
    // filter > comp-filter VCALENDAR > comp-filter VEVENT|VTODO > time-range
    const top = child(child(root, CAL, 'filter'), CAL, 'comp-filter');
    const comp = top ? child(top, CAL, 'comp-filter') : null;
    const compName = comp?.attrs.name?.toUpperCase();
    const range = comp ? child(comp, CAL, 'time-range') : null;
    const from = parseUtc(range?.attrs.start);
    const to = parseUtc(range?.attrs.end);
    const list = all.filter((r) => {
      if (compName === 'VEVENT' && r.type !== 'E') return false;
      if (compName === 'VTODO' && r.type !== 'T') return false;
      if (compName && compName !== 'VEVENT' && compName !== 'VTODO') return false;
      return dav.overlaps(r, from, to);
    });
    return sendXml(reply, 207, multistatus(await objectResponses(ctx, calendar, list, wanted)));
  }

  return sendXml(reply, 403, errorBody(DAV, 'supported-report'));
}

/** 캘린더 이름 · 색만 바꿀 수 있다. 나머지 속성은 403 으로 돌려준다 */
async function proppatch(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const root = typeof request.body === 'string' ? parseXml(request.body.trim()) : null;
  if (!root || root.ns !== DAV || root.name !== 'propertyupdate') return reply.code(400).send('bad xml');
  const ok: [string, string][] = [];
  const denied: [string, string][] = [];
  const patch: { name?: string; color?: string } = {};
  for (const action of root.children) {
    const isSet = action.ns === DAV && action.name === 'set';
    for (const prop of child(action, DAV, 'prop')?.children ?? []) {
      const k = key(prop.ns, prop.name);
      const value = prop.text.trim();
      if (target.kind === 'calendar' && isSet && k === key(DAV, 'displayname') && value && value.length <= 100) {
        patch.name = value;
        ok.push([k, '']);
      } else if (target.kind === 'calendar' && isSet && k === key(ICAL, 'calendar-color') && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
        patch.color = value.slice(0, 7).toLowerCase();
        ok.push([k, '']);
      } else {
        denied.push([k, '']);
      }
    }
  }
  // 하나라도 거절되면 아무것도 바꾸지 않는다 (RFC 4918 9.2 원자성)
  if (denied.length) {
    const failed = ok.length ? propstat(ok, '424 Failed Dependency') : '';
    return sendXml(
      reply,
      207,
      multistatus([`<d:response>${href(hrefOf(target, ctx.userName))}${propstat(denied, '403 Forbidden')}${failed}</d:response>`]),
    );
  }
  if (target.kind === 'calendar' && (patch.name || patch.color)) {
    await repo.updateCalendar(target.calendar.calendarId, patch);
  }
  return sendXml(reply, 207, multistatus([`<d:response>${href(hrefOf(target, ctx.userName))}${propstat(ok, '200 OK')}</d:response>`]));
}

function conditions(request: FastifyRequest): dav.Conditions {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
  return { ifMatch: one(request.headers['if-match']), ifNoneMatch: one(request.headers['if-none-match']) };
}

function sendOutcome(reply: FastifyReply, outcome: dav.WriteOutcome): FastifyReply {
  if (outcome.status === 201 || outcome.status === 204) {
    if (outcome.etag) reply.header('ETag', outcome.etag);
    return reply.code(outcome.status).send();
  }
  if ('condition' in outcome && outcome.condition) {
    const ns = outcome.condition === 'need-privileges' ? DAV : CAL;
    return sendXml(reply, outcome.status, errorBody(ns, outcome.condition));
  }
  return reply.code(outcome.status).send();
}

// ------------------------------------------------------------------ 라우트

export async function caldavRoutes(app: FastifyInstance): Promise<void> {
  // 이 플러그인 안에서만: XML · iCalendar 본문을 문자열 그대로 받는다
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

  // 바깥 오류 처리기는 JSON 을 쓴다. 캘린더 프로그램에는 상태 코드만 의미가 있다
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const script = schemaHint(error);
    if (script) {
      // server/sql 의 새 스크립트를 안 돌린 DB. 외부 프로그램은 503 이면 잠시 뒤 다시 시도한다
      request.log.error({ err: error, script }, 'database schema is out of date');
      reply.code(503).header('Content-Type', 'text/plain; charset=utf-8').send(`database update required: run ${script}`);
      return;
    }
    if (status >= 500) request.log.error({ err: error }, 'caldav request failed');
    reply.code(status).header('Content-Type', 'text/plain; charset=utf-8').send(status >= 500 ? 'error' : (error as Error).message);
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('DAV', DAV_HEADER);
  });

  // RFC 6764 자동 검색. 썬더버드에 서버 주소만 넣어도 여기서 /dav/ 를 찾는다
  app.route({
    method: METHODS,
    url: '/.well-known/caldav',
    handler: async (_request, reply) => reply.code(301).header('Location', '/dav/').send(),
  });
  // CardDAV (RFC 6352 · 6764) 도 같은 /dav/ 아래에 있다 (routes/carddav.ts)
  app.route({
    method: METHODS,
    url: '/.well-known/carddav',
    handler: async (_request, reply) => reply.code(301).header('Location', '/dav/').send(),
  });
  // 서버 주소(https://host/)만 넣으면 썬더버드는 루트부터 PROPFIND 한다. 화면(GET /)과 겹치지 않는다
  app.route({
    method: 'PROPFIND',
    url: '/',
    handler: async (_request, reply) => reply.code(301).header('Location', '/dav/').send(),
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS') {
      return reply.code(200).header('Allow', ALLOW).header('Content-Length', '0').send();
    }

    const auth = await dav.authenticate(request.headers.authorization, request.ip);
    if (!auth.ok) {
      if (auth.status === 401) {
        // realm 을 바꾸면 썬더버드가 저장해 둔 비밀번호를 못 찾는다 — CardDAV 도 같은 realm 을 쓴다
        reply.header('WWW-Authenticate', 'Basic realm="CalDAV", charset="UTF-8"');
      }
      if (auth.retryAfterSec) reply.header('Retry-After', String(auth.retryAfterSec));
      return reply.code(auth.status).header('Content-Type', 'text/plain; charset=utf-8').send(
        auth.status === 403 ? 'CalDAV/CardDAV is not enabled for this account' : '',
      );
    }

    const segments = segmentsOf(request.url);
    if (!segments) return reply.code(400).send();
    // 일정 · 주소록은 개인 환경설정에서 따로 켠다. 켜지 않은 쪽은 비밀번호가 맞아도 막는다
    const area = segments[0] === 'dav' ? segments[1] : undefined;
    if ((area === 'calendars' && !auth.caldav) || (area === 'addressbooks' && !auth.carddav)) {
      return reply.code(403).header('Content-Type', 'text/plain; charset=utf-8').send(
        area === 'calendars' ? 'CalDAV is not enabled for this account' : 'CardDAV is not enabled for this account',
      );
    }
    if (area === 'addressbooks') return carddavHandle(request, reply, segments, auth);
    const target = await resolve(segments, auth.userName);
    if (!target) return reply.code(404).send();
    const ctx: Ctx = {
      userName: auth.userName,
      displayName: auth.displayName,
      caldav: auth.caldav,
      carddav: auth.carddav,
      resources: new Map(),
    };

    switch (request.method) {
      case 'PROPFIND':
        return propfind(request, reply, target, ctx);
      case 'REPORT':
        return report(request, reply, target, ctx);
      case 'PROPPATCH':
        return proppatch(request, reply, target, ctx);
      case 'GET':
      case 'HEAD': {
        if (target.kind === 'calendar') {
          // 캘린더 주소를 그대로 열면 전체 .ics 를 준다 (내보내기와 같다)
          return reply
            .header('Content-Type', 'text/calendar; charset=utf-8')
            .send(await exportCalendar(target.calendar));
        }
        if (target.kind !== 'object') {
          return reply.header('Content-Type', 'text/plain; charset=utf-8').send('CalDAV');
        }
        const resource = (await resourcesOf(ctx, target.calendar.calendarId)).find((r) => r.name === target.name);
        if (!resource) return reply.code(404).send();
        const body = (await dav.loadBodies(target.calendar.calendarId, [resource])).get(resource.uid) ?? '';
        return reply
          .header('Content-Type', 'text/calendar; charset=utf-8')
          .header('ETag', resource.etag)
          .header('Last-Modified', resource.lastModified.toUTCString())
          .send(body);
      }
      case 'PUT': {
        if (target.kind !== 'object') return reply.code(405).header('Allow', ALLOW).send();
        const body = typeof request.body === 'string' ? request.body : '';
        return sendOutcome(reply, await dav.putResource(auth.userName, target.calendar, target.name, body, conditions(request)));
      }
      case 'DELETE': {
        // 캘린더 통째 삭제는 웹에서만 한다 — 외부 프로그램에서 캘린더를 지운다고 데이터가 사라지면 안 된다
        if (target.kind !== 'object') return sendXml(reply, 403, errorBody(DAV, 'need-privileges'));
        return sendOutcome(reply, await dav.deleteResource(target.calendar, target.name, conditions(request)));
      }
      default:
        // MKCOL · MKCALENDAR: 캘린더는 웹에서 만든다
        return sendXml(reply, 403, errorBody(DAV, 'need-privileges'));
    }
  };

  app.route({ method: METHODS, url: '/dav', handler });
  app.route({ method: METHODS, url: '/dav/*', handler });

  /** 캘린더 설정 > 일반 > 외부에서 일정 관리 안내에 보여 줄 접속 주소 (웹 세션으로 부른다) */
  app.get('/api/me/caldav', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const base = config.publicBaseUrl || `${request.protocol}://${request.headers.host ?? `localhost:${config.port}`}`;
    const calendars = await repo.listCalendars(session.userName);
    return {
      serverUrl: `${base}/`,
      davUrl: `${base}/dav/`,
      userName: session.userName,
      calendars: calendars.map((c) => ({
        name: c.name,
        color: c.color,
        readonly: c.readonly,
        url: `${base}${calendarHref(session.userName, c.calendarId)}`,
      })),
    };
  });

  /** 개인 환경설정 > 주소록 안내에 보여 줄 CardDAV 접속 주소 (웹 세션으로 부른다) */
  app.get('/api/me/carddav', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const base = config.publicBaseUrl || `${request.protocol}://${request.headers.host ?? `localhost:${config.port}`}`;
    return {
      serverUrl: `${base}/`,
      davUrl: `${base}/dav/`,
      userName: session.userName,
      addressbookUrl: `${base}${addressbookHref(session.userName)}`,
    };
  });
}
