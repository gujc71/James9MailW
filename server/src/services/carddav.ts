/**
 * CardDAV (RFC 6352) — 썬더버드 같은 외부 프로그램이 내 주소록을 직접 읽고 쓴다.
 * HTTP · XML 은 routes/carddav.ts 가 맡고, 여기서는 자원 목록 · 쓰기를 한다. 인증은 services/caldav.ts.
 *
 *  - 주소록은 하나(contacts)다. 자원(…/contacts/<이름>.vcf) 하나 = GU_ADDRESS_BOOK 한 행.
 *    이름은 DAV_NAME, 비어 있으면 '<UID>.vcf' (웹에서 만든 연락처 · 자동 수집 주소).
 *    썬더버드는 새 연락처를 '<UID>.vcf' 로 PUT 하므로 대개 둘이 같다.
 *  - 그룹(배포 리스트)은 내보내지 않는다. 썬더버드의 CardDAV 주소록은 메일링 리스트를 지원하지 않아
 *    그룹 카드를 메일 없는 연락처로 보여 준다. 그룹은 웹에서만 다룬다.
 *  - ETag 는 (ADDRESS_ID · 수정 시각), CTag 는 주소록 전체 ETag 로 만든다. 모든 쓰기가 UPDATE_DATE 를
 *    새로 적고, 사용 횟수만 올리는 수집(touchUsage)은 적지 않는다. sync-collection 은 하지 않는다 —
 *    썬더버드는 sync-token 이 없으면 CTag + multiget 으로 동기화한다.
 *  - PUT 본문은 받은 그대로 저장한다. GET 이 같은 바이트를 돌려줘야 ETag 를 믿을 수 있다.
 */
import { createHash } from 'node:crypto';
import * as repo from '../repositories/contacts.js';
import type { ContactRow } from '../repositories/contacts.js';
import { etagMatches } from '../dav/xml.js';
import { ensureUid, fieldsOf, indexOf, newUid, parseCard, splitCardTexts, uidOf, unescapeText, type VCard } from '../contacts/vcard.js';
import { MAX_CARD_BYTES, remove } from './contacts.js';

export interface CardResource {
  name: string;
  row: ContactRow;
  etag: string;
  lastModified: Date;
}

export const defaultName = (uid: string) => `${uid}.vcf`;

function etagOf(row: ContactRow): string {
  const hash = createHash('sha1').update(`${row.addressId}|${row.updateMs}`).digest('hex');
  return `"${hash.slice(0, 24)}"`;
}

/** 주소록의 자원들 (개인 연락처만) */
export async function listResources(userName: string): Promise<CardResource[]> {
  const rows = await repo.allContacts(userName, 'I');
  const taken = new Set<string>();
  const out: CardResource[] = [];
  // DAV_NAME 을 가진 행이 먼저 이름을 차지한다. 기본 이름('<UID>.vcf')이 겹치면 번호 이름으로 물러선다
  const ordered = [...rows.filter((r) => r.davName), ...rows.filter((r) => !r.davName)];
  for (const row of ordered) {
    let name = row.davName ?? defaultName(row.uid);
    if (taken.has(name)) name = `id-${row.addressId}.vcf`;
    taken.add(name);
    out.push({ name, row, etag: etagOf(row), lastModified: new Date(row.updateMs) });
  }
  return out;
}

export function ctagOf(resources: CardResource[]): string {
  const hash = createHash('sha1');
  for (const r of [...resources].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`${r.name}\0${r.etag}\n`);
  return hash.digest('hex').slice(0, 32);
}

export async function loadBodies(userName: string, resources: CardResource[]): Promise<Map<number, string>> {
  return repo.loadCards(
    userName,
    resources.map((r) => r.row.addressId),
  );
}

// ------------------------------------------------------------------ addressbook-query

export interface TextMatch {
  text: string;
  matchType: 'equals' | 'contains' | 'starts-with' | 'ends-with';
  negate: boolean;
}

export interface PropFilter {
  name: string;
  test: 'anyof' | 'allof';
  isNotDefined: boolean;
  textMatches: TextMatch[];
}

export interface CardFilter {
  test: 'anyof' | 'allof';
  props: PropFilter[];
}

function textMatches(value: string, m: TextMatch): boolean {
  const v = value.toLowerCase();
  const t = m.text.toLowerCase();
  const hit =
    m.matchType === 'equals'
      ? v === t
      : m.matchType === 'starts-with'
        ? v.startsWith(t)
        : m.matchType === 'ends-with'
          ? v.endsWith(t)
          : v.includes(t);
  return m.negate ? !hit : hit;
}

/** RFC 6352 10.5. 대소문자는 늘 무시한다 (i;unicode-casemap 과 거의 같다) */
export function matchesFilter(card: VCard, filter: CardFilter): boolean {
  if (!filter.props.length) return true;
  const results = filter.props.map((pf) => {
    const values = card.props.filter((p) => p.name === pf.name.toUpperCase()).map((p) => unescapeText(p.value));
    if (pf.isNotDefined) return values.length === 0;
    if (!values.length) return false;
    if (!pf.textMatches.length) return true;
    const each = pf.textMatches.map((m) => values.some((v) => textMatches(v, m)));
    return pf.test === 'allof' ? each.every(Boolean) : each.some(Boolean);
  });
  return filter.test === 'allof' ? results.every(Boolean) : results.some(Boolean);
}

// ------------------------------------------------------------------ 쓰기

export type WriteOutcome =
  | { status: 201 | 204; etag: string | null }
  | { status: 400 | 403 | 404 | 409 | 412 | 415; condition?: string; ns?: 'DAV' | 'CARD' };

export interface Conditions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

/** PUT. 본문은 연락처 하나의 전체 vCard 다 */
export async function putResource(userName: string, name: string, body: string, cond: Conditions): Promise<WriteOutcome> {
  if (Buffer.byteLength(body, 'utf8') > MAX_CARD_BYTES) return { status: 403, condition: 'max-resource-size', ns: 'CARD' };
  const chunks = splitCardTexts(body);
  if (chunks.length !== 1) return { status: 400, condition: 'valid-address-data', ns: 'CARD' };
  const card = parseCard(body);
  if (!card) return { status: 400, condition: 'valid-address-data', ns: 'CARD' };
  if (!card.version.startsWith('3') && !card.version.startsWith('4')) {
    return { status: 415, condition: 'supported-address-data', ns: 'CARD' };
  }
  const fields = fieldsOf(card);
  // 그룹은 웹에서만 다룬다 (머리말)
  if (fields.kind === 'group') return { status: 403, condition: 'need-privileges', ns: 'DAV' };

  let uid = uidOf(card);
  let stored = body;
  if (!uid) {
    // UID 는 필수지만(RFC 6350) 빠뜨리는 프로그램도 있다. 넣어서 저장하고 ETag 는 주지 않는다 → 다시 받아 간다
    uid = name.replace(/\.vcf$/i, '') || newUid();
    stored = ensureUid(card, uid);
  }
  if (uid.length > 255) return { status: 400, condition: 'valid-address-data', ns: 'CARD' };

  const resources = await listResources(userName);
  const existing = resources.find((r) => r.name === name) ?? null;
  if (cond.ifNoneMatch !== undefined && existing && etagMatches(cond.ifNoneMatch, existing.etag)) return { status: 412 };
  if (!etagMatches(cond.ifMatch, existing?.etag ?? null)) return { status: 412 };
  // 주소록 안에서 UID 는 자원 하나에만 있다 (RFC 6352 6.3.2.1 no-uid-conflict). 웹 그룹의 UID 도 겹치면 안 된다
  if (existing && existing.row.uid !== uid) return { status: 409, condition: 'no-uid-conflict', ns: 'CARD' };
  if (!existing) {
    const [sameUid] = await repo.getContactsByUids(userName, [uid]);
    if (sameUid) return { status: 409, condition: 'no-uid-conflict', ns: 'CARD' };
  }

  const write = { uid, davName: name, vcard: stored, index: indexOf(fields) };
  let addressId: number;
  if (existing) {
    addressId = existing.row.addressId;
    await repo.updateContact(userName, addressId, write);
  } else {
    addressId = await repo.insertContact(userName, write);
  }
  const [after] = await repo.getContacts(userName, [addressId]);
  return { status: existing ? 204 : 201, etag: after && stored === body ? etagOf(after) : null };
}

export async function deleteResource(userName: string, name: string, cond: Conditions): Promise<WriteOutcome> {
  const target = (await listResources(userName)).find((r) => r.name === name);
  if (!target) return { status: 404 };
  if (!etagMatches(cond.ifMatch, target.etag)) return { status: 412 };
  // 웹 그룹의 멤버에서도 뺀다
  await remove(userName, [target.row.addressId]);
  return { status: 204, etag: null };
}
