/**
 * CardDAV 엔드포인트 (RFC 6352 · 4918 · 6764). 썬더버드 · DAVx⁵ · iOS 연락처 등이 쓴다.
 * 개인 환경설정 > 주소록의 "외부에서 주소록 관리 사용" 을 켠 사용자만 들어온다.
 * 인증 · 공통 처리(OPTIONS · 오류 · DAV 헤더)는 routes/caldav.ts 의 /dav 처리기가 하고
 * /dav/addressbooks/ 아래만 여기로 넘어온다.
 *
 *   /.well-known/carddav                            → /dav/ (routes/caldav.ts)
 *   /dav/principals/<사용자>/                        주체 — addressbook-home-set 을 알린다 (routes/caldav.ts)
 *   /dav/addressbooks/<사용자>/                      주소록 모음
 *   /dav/addressbooks/<사용자>/contacts/             주소록 (GU_ADDRESS_BOOK 의 개인 연락처)
 *   /dav/addressbooks/<사용자>/contacts/<이름>.vcf   연락처 하나
 *
 * 지원 범위: PROPFIND · REPORT(addressbook-multiget · addressbook-query) · GET · PUT · DELETE.
 * sync-collection · 주소록 만들기/지우기(MKCOL) · 그룹은 하지 않는다.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as dav from '../services/carddav.js';
import { parseCard } from '../contacts/vcard.js';
import {
  CARD,
  CS,
  DAV,
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
} from '../dav/xml.js';
import { MAX_CARD_BYTES } from '../services/contacts.js';

/** 주소록은 하나다. 이름을 고정해 두면 썬더버드에 주소를 바로 넣어도 된다 */
const BOOK_ID = 'contacts';
const ADDRESS_DATA = key(CARD, 'address-data');

const principalHref = (user: string) => `/dav/principals/${enc(user)}/`;
export const addressbookHomeHref = (user: string) => `/dav/addressbooks/${enc(user)}/`;
export const addressbookHref = (user: string) => `${addressbookHomeHref(user)}${BOOK_ID}/`;
const cardHref = (user: string, name: string) => `${addressbookHref(user)}${enc(name)}`;

type Target = { kind: 'home' } | { kind: 'book' } | { kind: 'card'; name: string };

interface Auth {
  userName: string;
  displayName: string | null;
}

interface Ctx extends Auth {
  resources: dav.CardResource[] | null;
}

async function resourcesOf(ctx: Ctx): Promise<dav.CardResource[]> {
  if (!ctx.resources) ctx.resources = await dav.listResources(ctx.userName);
  return ctx.resources;
}

/** 남의 주소 · 없는 주소록은 null (404) */
function resolve(segments: string[], userName: string): Target | null {
  const [, , user, book, name, ...rest] = segments;
  if (rest.length || !user || user.toLowerCase() !== userName.toLowerCase()) return null;
  if (book === undefined) return { kind: 'home' };
  if (book !== BOOK_ID) return null;
  return name === undefined ? { kind: 'book' } : { kind: 'card', name };
}

function hrefOf(target: Target, userName: string): string {
  if (target.kind === 'home') return addressbookHomeHref(userName);
  if (target.kind === 'book') return addressbookHref(userName);
  return cardHref(userName, target.name);
}

const SUPPORTED_REPORTS = ['card:addressbook-multiget', 'card:addressbook-query']
  .map((r) => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`)
  .join('');

async function propsOf(target: Target, ctx: Ctx, resource?: dav.CardResource): Promise<Map<string, string>> {
  const p = new Map<string, string>();
  const me = ctx.userName;
  p.set(key(DAV, 'current-user-principal'), href(principalHref(me)));
  p.set(key(DAV, 'owner'), href(principalHref(me)));
  switch (target.kind) {
    case 'home':
      p.set(key(DAV, 'resourcetype'), '<d:collection/>');
      p.set(key(DAV, 'displayname'), escapeXml(ctx.displayName || me));
      // bind 를 주지 않는다 — 주소록을 더 만들 수 없다
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_READ));
      break;
    case 'book':
      p.set(key(DAV, 'resourcetype'), '<d:collection/><card:addressbook/>');
      p.set(key(DAV, 'displayname'), escapeXml(ctx.displayName ? `${ctx.displayName} 주소록` : '주소록'));
      p.set(key(CARD, 'addressbook-description'), 'Webmail');
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_WRITE));
      p.set(key(DAV, 'supported-report-set'), SUPPORTED_REPORTS);
      p.set(
        key(CARD, 'supported-address-data'),
        '<card:address-data-type content-type="text/vcard" version="3.0"/><card:address-data-type content-type="text/vcard" version="4.0"/>',
      );
      p.set(key(CARD, 'max-resource-size'), String(MAX_CARD_BYTES));
      p.set(key(CS, 'getctag'), dav.ctagOf(await resourcesOf(ctx)));
      break;
    case 'card':
      if (!resource) break;
      p.set(key(DAV, 'resourcetype'), '');
      p.set(key(DAV, 'getetag'), escapeXml(resource.etag));
      p.set(key(DAV, 'getlastmodified'), resource.lastModified.toUTCString());
      p.set(key(DAV, 'getcontenttype'), 'text/vcard; charset=utf-8');
      p.set(key(DAV, 'current-user-privilege-set'), privileges(PRIV_WRITE));
      break;
  }
  return p;
}

/** 연락처 자원 응답들. address-data 를 달라고 했을 때만 본문을 읽는다 */
async function cardResponses(ctx: Ctx, list: dav.CardResource[], wanted: string[] | null, bodies?: Map<number, string>): Promise<string[]> {
  const texts = bodies ?? (wanted?.includes(ADDRESS_DATA) ? await dav.loadBodies(ctx.userName, list) : null);
  const out: string[] = [];
  for (const resource of list) {
    const props = await propsOf({ kind: 'card', name: resource.name }, ctx, resource);
    const body = texts?.get(resource.row.addressId);
    out.push(describe(cardHref(ctx.userName, resource.name), props, wanted, body === undefined ? undefined : { key: ADDRESS_DATA, body }));
  }
  return out;
}

function sendXml(reply: FastifyReply, status: number, xml: string): FastifyReply {
  return reply.code(status).header('Content-Type', 'application/xml; charset=utf-8').send(xml);
}

async function propfind(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const body = typeof request.body === 'string' ? request.body.trim() : '';
  const root = body ? parseXml(body) : null;
  if (body && !root) return reply.code(400).send('bad xml');
  const wanted = requested(root);
  const depth = String(request.headers.depth ?? '1').trim() === '0' ? 0 : 1;

  if (target.kind === 'card') {
    const resource = (await resourcesOf(ctx)).find((r) => r.name === target.name);
    if (!resource) return reply.code(404).send();
    return sendXml(reply, 207, multistatus(await cardResponses(ctx, [resource], wanted)));
  }
  const responses = [describe(hrefOf(target, ctx.userName), await propsOf(target, ctx), wanted)];
  if (depth === 1) {
    if (target.kind === 'home') {
      const book: Target = { kind: 'book' };
      responses.push(describe(hrefOf(book, ctx.userName), await propsOf(book, ctx), wanted));
    } else {
      responses.push(...(await cardResponses(ctx, await resourcesOf(ctx), wanted)));
    }
  }
  return sendXml(reply, 207, multistatus(responses));
}

/** <card:filter> → CardFilter */
function filterOf(node: ReturnType<typeof parseXml>): dav.CardFilter {
  const filter = child(node, CARD, 'filter');
  return {
    test: filter?.attrs.test === 'allof' ? 'allof' : 'anyof',
    props: childrenOf(filter, CARD, 'prop-filter').map((pf) => ({
      name: pf.attrs.name ?? '',
      test: pf.attrs.test === 'allof' ? 'allof' : 'anyof',
      isNotDefined: Boolean(child(pf, CARD, 'is-not-defined')),
      textMatches: childrenOf(pf, CARD, 'text-match').map((tm) => ({
        text: tm.text,
        matchType: (['equals', 'contains', 'starts-with', 'ends-with'].includes(tm.attrs['match-type'] ?? '')
          ? tm.attrs['match-type']
          : 'contains') as dav.TextMatch['matchType'],
        negate: tm.attrs['negate-condition'] === 'yes',
      })),
    })),
  };
}

async function report(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const root = typeof request.body === 'string' ? parseXml(request.body.trim()) : null;
  if (!root) return reply.code(400).send('bad xml');
  if (target.kind === 'home') return sendXml(reply, 403, errorBody(DAV, 'supported-report'));
  const wanted = requested(root) ?? [key(DAV, 'getetag'), ADDRESS_DATA];
  const all = await resourcesOf(ctx);

  if (root.ns === CARD && root.name === 'addressbook-multiget') {
    const base = addressbookHref(ctx.userName);
    const picked: dav.CardResource[] = [];
    const missing: string[] = [];
    for (const h of childrenOf(root, DAV, 'href')) {
      const name = memberName(h.text, base);
      const resource = name ? all.find((r) => r.name === name) : undefined;
      if (resource) picked.push(resource);
      else missing.push(h.text.trim());
    }
    const responses = await cardResponses(ctx, picked, wanted);
    for (const m of missing) responses.push(notFoundResponse(m));
    return sendXml(reply, 207, multistatus(responses));
  }

  if (root.ns === CARD && root.name === 'addressbook-query') {
    const filter = filterOf(root);
    const limitText = child(child(root, CARD, 'limit'), CARD, 'nresults')?.text.trim();
    const limit = limitText && /^\d+$/.test(limitText) ? Number(limitText) : Number.POSITIVE_INFINITY;
    const scope = target.kind === 'card' ? all.filter((r) => r.name === target.name) : all;
    // 거르려면 본문을 읽어야 한다. 읽은 김에 응답에도 쓴다
    const bodies = await dav.loadBodies(ctx.userName, scope);
    const hits = scope.filter((r) => {
      const card = parseCard(bodies.get(r.row.addressId) ?? '');
      return card ? dav.matchesFilter(card, filter) : false;
    });
    const truncated = hits.length > limit;
    const responses = await cardResponses(ctx, hits.slice(0, truncated ? limit : undefined), wanted, bodies);
    if (truncated) {
      // RFC 6352 8.6.1: 잘렸으면 모음에 507 을 단다
      responses.push(`<d:response>${href(addressbookHref(ctx.userName))}<d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`);
    }
    return sendXml(reply, 207, multistatus(responses));
  }

  return sendXml(reply, 403, errorBody(DAV, 'supported-report'));
}

/** 주소록 속성은 바꿀 수 없다. 전부 403 으로 돌려준다 (RFC 4918 9.2) */
async function proppatch(request: FastifyRequest, reply: FastifyReply, target: Target, ctx: Ctx) {
  const root = typeof request.body === 'string' ? parseXml(request.body.trim()) : null;
  if (!root || root.ns !== DAV || root.name !== 'propertyupdate') return reply.code(400).send('bad xml');
  const denied: [string, string][] = [];
  for (const action of root.children) {
    for (const prop of child(action, DAV, 'prop')?.children ?? []) denied.push([key(prop.ns, prop.name), '']);
  }
  return sendXml(reply, 207, multistatus([`<d:response>${href(hrefOf(target, ctx.userName))}${propstat(denied, '403 Forbidden')}</d:response>`]));
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
    return sendXml(reply, outcome.status, errorBody(outcome.ns === 'DAV' ? DAV : CARD, outcome.condition));
  }
  return reply.code(outcome.status).send();
}

/** /dav/addressbooks/… 요청. 인증은 이미 끝났다 (routes/caldav.ts) */
export async function carddavHandle(request: FastifyRequest, reply: FastifyReply, segments: string[], auth: Auth) {
  const target = resolve(segments, auth.userName);
  if (!target) return reply.code(404).send();
  const ctx: Ctx = { userName: auth.userName, displayName: auth.displayName, resources: null };

  switch (request.method) {
    case 'PROPFIND':
      return propfind(request, reply, target, ctx);
    case 'REPORT':
      return report(request, reply, target, ctx);
    case 'PROPPATCH':
      return proppatch(request, reply, target, ctx);
    case 'GET':
    case 'HEAD': {
      if (target.kind !== 'card') return reply.header('Content-Type', 'text/plain; charset=utf-8').send('CardDAV');
      const resource = (await resourcesOf(ctx)).find((r) => r.name === target.name);
      if (!resource) return reply.code(404).send();
      const body = (await dav.loadBodies(ctx.userName, [resource])).get(resource.row.addressId) ?? '';
      return reply
        .header('Content-Type', 'text/vcard; charset=utf-8')
        .header('ETag', resource.etag)
        .header('Last-Modified', resource.lastModified.toUTCString())
        .send(body);
    }
    case 'PUT': {
      if (target.kind !== 'card') return reply.code(405).send();
      const body = typeof request.body === 'string' ? request.body : '';
      return sendOutcome(reply, await dav.putResource(ctx.userName, target.name, body, conditions(request)));
    }
    case 'DELETE':
      // 주소록 통째 삭제는 받지 않는다 — 외부 프로그램에서 주소록을 지운다고 데이터가 사라지면 안 된다
      if (target.kind !== 'card') return sendXml(reply, 403, errorBody(DAV, 'need-privileges'));
      return sendOutcome(reply, await dav.deleteResource(ctx.userName, target.name, conditions(request)));
    default:
      // MKCOL 등: 주소록은 하나뿐이다
      return sendXml(reply, 403, errorBody(DAV, 'need-privileges'));
  }
}
