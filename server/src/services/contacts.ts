/**
 * 주소록 (POPUP-3 · 개인 환경설정 > 주소록 · CardDAV).
 * 화면은 필드(ContactFields)로 주고받고, 저장은 vCard 원문으로 한다 (contacts/vcard.ts).
 * 화면에서 고친 갈래만 원문에 얹으므로 썬더버드가 넣은 속성은 웹에서 고쳐도 남는다.
 */
import * as repo from '../repositories/contacts.js';
import type { ContactRow } from '../repositories/contacts.js';
import { badRequest, notFound } from '../errors.js';
import {
  EMPTY_FIELDS,
  ensureUid,
  fieldsOf,
  indexOf,
  mergeFields,
  newUid,
  parseCard,
  splitCardTexts,
  uidOf,
  type ContactFields,
} from '../contacts/vcard.js';
import { contactsFromCsv, contactsToCsv, decodeText } from '../contacts/csv.js';

/** 카드 한 장 상한. 사진이 대부분이다 */
export const MAX_CARD_BYTES = 4 * 1024 * 1024;
/** 화면에서 올리는 사진 상한 (data: URI 글자 수). 브라우저가 줄여서 올린다 */
const MAX_PHOTO_CHARS = 1024 * 1024;
const MAX_IMPORT = 5000;

export interface ContactDetail extends ContactRow {
  fields: ContactFields;
}

function cleanFields(fields: ContactFields): ContactFields {
  const f: ContactFields = { ...EMPTY_FIELDS, ...fields };
  if (f.photo && (f.photo.length > MAX_PHOTO_CHARS || !/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(f.photo))) {
    throw badRequest('err.contactPhoto');
  }
  f.emails = f.emails.filter((e) => e.value.trim());
  f.phones = f.phones.filter((p) => p.value.trim());
  f.urls = f.urls.filter((u) => u.trim());
  f.members = [...new Set(f.members.filter(Boolean))];
  if (f.kind === 'group' && !f.displayName.trim()) throw badRequest('err.groupName');
  if (
    f.kind === 'individual' &&
    !f.displayName.trim() &&
    !f.familyName.trim() &&
    !f.givenName.trim() &&
    !f.emails.length &&
    !f.phones.length
  ) {
    throw badRequest('err.contactEmpty');
  }
  return f;
}

async function cardOf(userName: string, addressId: number) {
  const text = (await repo.loadCards(userName, [addressId])).get(addressId);
  return text ? parseCard(text) : null;
}

export async function getDetail(userName: string, addressId: number): Promise<ContactDetail> {
  const [row] = await repo.getContacts(userName, [addressId]);
  if (!row) throw notFound('err.notFound');
  const card = await cardOf(userName, addressId);
  return { ...row, fields: card ? fieldsOf(card) : { ...EMPTY_FIELDS, displayName: row.contactName ?? '' } };
}

/** 화면에서 저장. addressId 가 없으면 새 연락처 · 그룹 */
export async function saveFields(userName: string, addressId: number | null, input: ContactFields): Promise<number> {
  const fields = cleanFields(input);
  if (addressId === null) {
    const uid = newUid();
    const vcard = mergeFields(null, fields, uid);
    return repo.insertContact(userName, { uid, vcard, index: indexOf(fields) });
  }
  const [row] = await repo.getContacts(userName, [addressId]);
  if (!row) throw notFound('err.notFound');
  const original = await cardOf(userName, addressId);
  // 개인 ↔ 그룹은 바꾸지 않는다
  fields.kind = row.kind === 'G' ? 'group' : 'individual';
  const vcard = mergeFields(original, fields, row.uid);
  if (Buffer.byteLength(vcard, 'utf8') > MAX_CARD_BYTES) throw badRequest('err.contactPhoto');
  await repo.updateContact(userName, addressId, { uid: row.uid, vcard, index: indexOf(fields) });
  return addressId;
}

/** 주소록 팝업의 빠른 추가: 이미 있는 주소면 이름만 고친다 */
export async function quickAdd(userName: string, mailAddress: string, contactName: string | null): Promise<void> {
  const [found] = await repo.findByEmail(userName, mailAddress);
  if (found) {
    if (contactName && contactName !== found.contactName) {
      const detail = await getDetail(userName, found.addressId);
      await saveFields(userName, found.addressId, { ...detail.fields, displayName: contactName });
    }
    return;
  }
  await saveFields(userName, null, {
    ...EMPTY_FIELDS,
    displayName: contactName ?? '',
    emails: [{ type: 'other', value: mailAddress }],
  });
}

/** 주소록 팝업의 빠른 수정: 이름과 대표 메일만 바꾸고 나머지는 둔다 */
export async function quickUpdate(
  userName: string,
  addressId: number,
  patch: { contactName?: string | null; mailAddress?: string },
): Promise<void> {
  const detail = await getDetail(userName, addressId);
  const fields = { ...detail.fields };
  if (patch.contactName !== undefined) fields.displayName = patch.contactName?.trim() ?? '';
  if (patch.mailAddress !== undefined) {
    const rest = fields.emails.slice(1).filter((e) => e.value.toLowerCase() !== patch.mailAddress!.toLowerCase());
    fields.emails = [{ type: fields.emails[0]?.type ?? 'other', value: patch.mailAddress }, ...rest];
  }
  await saveFields(userName, addressId, fields);
}

/** 지우고, 지운 연락처를 멤버로 가진 그룹에서도 뺀다 */
export async function remove(userName: string, ids: number[]): Promise<number> {
  const rows = await repo.getContacts(userName, ids);
  const removed = await repo.deleteContacts(userName, rows.map((r) => r.addressId));
  const gone = new Set(rows.map((r) => r.uid));
  if (!gone.size) return removed;
  for (const group of await repo.allContacts(userName, 'G')) {
    const card = await cardOf(userName, group.addressId);
    if (!card) continue;
    const fields = fieldsOf(card);
    if (!fields.members.some((m) => gone.has(m))) continue;
    fields.members = fields.members.filter((m) => !gone.has(m));
    await repo.updateContact(userName, group.addressId, {
      uid: group.uid,
      vcard: mergeFields(card, fields, group.uid),
      index: indexOf(fields),
    });
  }
  return removed;
}

/**
 * 메일을 보낸 외부 주소를 주소록에 모은다 (USR-1.4). 이미 있으면 사용 횟수만 올린다 —
 * 원문(ETag)은 이름이 비어 있던 연락처에 이름을 채울 때만 바뀐다.
 */
export async function collect(userName: string, mailAddress: string, contactName: string | null): Promise<void> {
  const [found] = await repo.findByEmail(userName, mailAddress);
  if (found) {
    await repo.touchUsage(userName, found.addressId);
    if (contactName && !found.contactName) {
      const detail = await getDetail(userName, found.addressId);
      if (!detail.fields.displayName.trim() || detail.fields.displayName.trim().toLowerCase() === mailAddress.toLowerCase()) {
        await saveFields(userName, found.addressId, { ...detail.fields, displayName: contactName });
      }
    }
    return;
  }
  const fields: ContactFields = {
    ...EMPTY_FIELDS,
    displayName: contactName ?? '',
    emails: [{ type: 'other', value: mailAddress }],
  };
  const uid = newUid();
  await repo.insertContact(userName, { uid, vcard: mergeFields(null, fields, uid), index: indexOf(fields) }, { useCount: 1, lastUsedAt: new Date() });
}

// ------------------------------------------------------------------ 그룹

export interface Recipient {
  name: string | null;
  address: string;
}

/** 그룹 멤버를 받는 사람 목록으로. 그룹 안의 그룹도 푼다 (한 번 본 그룹은 다시 보지 않는다) */
export async function expandGroups(userName: string, groupIds: number[]): Promise<Recipient[]> {
  const out = new Map<string, Recipient>();
  const seen = new Set<string>();
  let queue = (await repo.getContacts(userName, groupIds)).filter((r) => r.kind === 'G');
  while (queue.length) {
    const cards = await repo.loadCards(userName, queue.map((g) => g.addressId));
    const uids: string[] = [];
    for (const group of queue) {
      seen.add(group.uid);
      const text = cards.get(group.addressId);
      const card = text ? parseCard(text) : null;
      for (const member of card ? fieldsOf(card).members : []) {
        if (member.startsWith('mailto:')) {
          const address = member.slice(7).trim();
          if (address && !out.has(address.toLowerCase())) out.set(address.toLowerCase(), { name: null, address });
        } else if (!seen.has(member)) uids.push(member);
      }
    }
    const members = await repo.getContactsByUids(userName, [...new Set(uids)]);
    for (const m of members) {
      if (m.kind === 'I' && m.mailAddress && !out.has(m.mailAddress.toLowerCase())) {
        out.set(m.mailAddress.toLowerCase(), { name: m.contactName, address: m.mailAddress });
      }
    }
    queue = members.filter((m) => m.kind === 'G' && !seen.has(m.uid));
  }
  return [...out.values()];
}

/** 그룹 멤버 (편집 화면). UID → 연락처 행. 없는 UID 는 그대로 돌려준다 */
export async function groupMembers(userName: string, members: string[]): Promise<(ContactRow | { uid: string; missing: true } | { address: string })[]> {
  const rows = await repo.getContactsByUids(userName, members.filter((m) => !m.startsWith('mailto:')));
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  return members.map((m) => (m.startsWith('mailto:') ? { address: m.slice(7) } : (byUid.get(m) ?? { uid: m, missing: true as const })));
}

// ------------------------------------------------------------------ 가져오기 · 내보내기

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface Incoming {
  fields: ContactFields;
  /** 3.0 · 4.0 카드 원문 (새로 넣을 때 그대로 둔다) */
  raw: ReturnType<typeof parseCard>;
  uid: string | null;
}

function incomingOf(format: 'vcf' | 'csv', text: string): { list: Incoming[]; failed: number } {
  if (format === 'csv') return { list: contactsFromCsv(text).map((fields) => ({ fields, raw: null, uid: null })), failed: 0 };
  const list: Incoming[] = [];
  let failed = 0;
  for (const chunk of splitCardTexts(text)) {
    const card = parseCard(chunk);
    if (!card || Buffer.byteLength(chunk, 'utf8') > MAX_CARD_BYTES) {
      failed += 1;
      continue;
    }
    const fields = fieldsOf(card);
    const keepRaw = card.version.startsWith('3') || card.version.startsWith('4');
    list.push({ fields, raw: keepRaw ? card : null, uid: uidOf(card) });
  }
  return { list, failed };
}

/**
 * .vcf · .csv 가져오기. 같은 연락처(같은 UID, 없으면 같은 대표 메일)가 있으면
 * overwrite 일 때 덮어쓰고(가져온 필드를 얹는다) 아니면 건너뛴다.
 */
export async function importContacts(
  userName: string,
  format: 'vcf' | 'csv',
  bytes: Buffer,
  overwrite: boolean,
): Promise<ImportResult> {
  const { list, failed: unreadable } = incomingOf(format, decodeText(bytes));
  if (list.length > MAX_IMPORT) throw badRequest('err.importTooMany');
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, failed: unreadable };
  for (const item of list) {
    try {
      const fields = { ...EMPTY_FIELDS, ...item.fields };
      const empty =
        !fields.displayName.trim() && !fields.familyName.trim() && !fields.givenName.trim() && !fields.emails.length && !fields.phones.length;
      if (empty) {
        result.failed += 1;
        continue;
      }
      let match: ContactRow | undefined;
      if (item.uid) match = (await repo.getContactsByUids(userName, [item.uid]))[0];
      if (!match && fields.kind === 'individual' && fields.emails[0]) match = (await repo.findByEmail(userName, fields.emails[0].value))[0];
      if (match) {
        if (!overwrite) {
          result.skipped += 1;
          continue;
        }
        const original = await cardOf(userName, match.addressId);
        const merged = { ...fields, kind: match.kind === 'G' ? 'group' : 'individual' } as ContactFields;
        await repo.updateContact(userName, match.addressId, {
          uid: match.uid,
          vcard: mergeFields(original, merged, match.uid),
          index: indexOf(merged),
        });
        result.updated += 1;
        continue;
      }
      const uid = item.uid && item.uid.length <= 255 ? item.uid : newUid();
      const vcard = item.raw ? ensureUid(item.raw, uid) : mergeFields(null, fields, uid);
      await repo.insertContact(userName, { uid, vcard, index: indexOf(fields) });
      result.created += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** 내보내기. vcf 는 원문을 이어 붙이고(그룹 포함), csv 는 개인 연락처만 썬더버드 머리글로 */
export async function exportContacts(userName: string, format: 'vcf' | 'csv'): Promise<string> {
  const rows = await repo.allContacts(userName);
  const cards = await repo.loadCards(userName, rows.map((r) => r.addressId));
  const texts = rows.map((r) => cards.get(r.addressId)).filter((t): t is string => Boolean(t));
  if (format === 'vcf') return texts.map((t) => (t.endsWith('\n') ? t : `${t}\r\n`)).join('');
  const list = texts
    .map(parseCard)
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map(fieldsOf);
  return '﻿' + contactsToCsv(list);
}
