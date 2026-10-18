/**
 * 주소록 (GU_ADDRESS_BOOK · GU_ADDRESS_EMAIL, sql/05-carddav.sql).
 * 한 행 = vCard 한 장. 원문은 VCARD_DATA, 목록 · 검색용 값은 원문에서 뽑아 같이 적는다
 * (services/contacts.ts 가 뽑는다). 메일 주소 전부는 GU_ADDRESS_EMAIL 에 둔다.
 *
 * UPDATE_DATE 는 CardDAV ETag 의 바탕이라 내용이 바뀔 때만 고친다.
 * 사용 횟수 · 최종 사용시각(touchUsage)은 ETag 를 바꾸지 않는다 — 메일을 보낼 때마다
 * 외부 프로그램이 주소록을 다시 받아 가지 않도록.
 */
import { sql } from 'kysely';
import { db, dbWrite } from '../db/kysely.js';
import { escapeLike, toIso } from '../util/mysql.js';
import { simpleCard, type ContactIndex } from '../contacts/vcard.js';

export interface ContactRow {
  addressId: number;
  uid: string;
  davName: string | null;
  kind: 'I' | 'G';
  contactName: string | null;
  mailAddress: string | null;
  org: string | null;
  phone: string | null;
  useCount: number;
  lastUsedAt: string | null;
  updateMs: number;
}

const LIST_COLUMNS = [
  'ADDRESS_ID',
  'CONTACT_UID',
  'DAV_NAME',
  'CONTACT_KIND',
  'CONTACT_NAME',
  'MAIL_ADDRESS',
  'ORG_NAME',
  'PHONE',
  'USE_COUNT',
  'LAST_USED_AT',
  'UPDATE_DATE',
] as const;

function toRow(r: {
  ADDRESS_ID: number | bigint;
  CONTACT_UID: string;
  DAV_NAME: string | null;
  CONTACT_KIND: string;
  CONTACT_NAME: string | null;
  MAIL_ADDRESS: string | null;
  ORG_NAME: string | null;
  PHONE: string | null;
  USE_COUNT: number;
  LAST_USED_AT: Date | null;
  UPDATE_DATE: Date;
}): ContactRow {
  return {
    addressId: Number(r.ADDRESS_ID),
    uid: r.CONTACT_UID,
    davName: r.DAV_NAME,
    kind: r.CONTACT_KIND === 'G' ? 'G' : 'I',
    contactName: r.CONTACT_NAME,
    mailAddress: r.MAIL_ADDRESS,
    org: r.ORG_NAME,
    phone: r.PHONE,
    useCount: r.USE_COUNT,
    lastUsedAt: toIso(r.LAST_USED_AT),
    updateMs: new Date(r.UPDATE_DATE).getTime(),
  };
}

export async function listContacts(params: {
  userName: string;
  keyword?: string;
  kind?: 'I' | 'G';
  limit: number;
  offset: number;
}): Promise<ContactRow[]> {
  let query = db.selectFrom('GU_ADDRESS_BOOK as b').select(LIST_COLUMNS.map((c) => `b.${c}` as const)).where('b.USER_NAME', '=', params.userName);
  if (params.kind) query = query.where('b.CONTACT_KIND', '=', params.kind);
  if (params.keyword?.trim()) {
    const like = `%${escapeLike(params.keyword.trim())}%`;
    query = query.where((eb) =>
      eb.or([
        eb('b.CONTACT_NAME', 'like', like),
        eb('b.ORG_NAME', 'like', like),
        eb('b.PHONE', 'like', like),
        eb.exists(
          eb
            .selectFrom('GU_ADDRESS_EMAIL as e')
            .select('e.ADDRESS_ID')
            .whereRef('e.ADDRESS_ID', '=', 'b.ADDRESS_ID')
            .where('e.MAIL_ADDRESS', 'like', like),
        ),
      ]),
    );
  }
  const rows = await query
    // 그룹을 앞에, 이름 없는 수집 주소는 뒤에
    .orderBy('b.CONTACT_KIND', 'asc') // G < I
    .orderBy(sql`b.CONTACT_NAME IS NULL`)
    .orderBy('b.CONTACT_NAME', 'asc')
    .orderBy('b.MAIL_ADDRESS', 'asc')
    .orderBy('b.ADDRESS_ID', 'asc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();
  return rows.map(toRow);
}

export async function getContacts(userName: string, ids: number[]): Promise<ContactRow[]> {
  if (!ids.length) return [];
  const rows = await dbWrite
    .selectFrom('GU_ADDRESS_BOOK')
    .select([...LIST_COLUMNS])
    .where('USER_NAME', '=', userName)
    .where('ADDRESS_ID', 'in', ids)
    .execute();
  return rows.map(toRow);
}

export async function getContactsByUids(userName: string, uids: string[]): Promise<ContactRow[]> {
  const out: ContactRow[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const rows = await dbWrite
      .selectFrom('GU_ADDRESS_BOOK')
      .select([...LIST_COLUMNS])
      .where('USER_NAME', '=', userName)
      .where('CONTACT_UID', 'in', uids.slice(i, i + 500))
      .execute();
    out.push(...rows.map(toRow));
  }
  return out;
}

/** 주소록 전체 (가벼운 값만). CardDAV 자원 목록 · 내보내기 · 그룹 멤버 풀기에 쓴다 */
export async function allContacts(userName: string, kind?: 'I' | 'G'): Promise<ContactRow[]> {
  let query = dbWrite.selectFrom('GU_ADDRESS_BOOK').select([...LIST_COLUMNS]).where('USER_NAME', '=', userName);
  if (kind) query = query.where('CONTACT_KIND', '=', kind);
  const rows = await query.orderBy('ADDRESS_ID', 'asc').limit(50_000).execute();
  return rows.map(toRow);
}

/** 원문. 원문이 없는 예전 행은 이름 · 메일로 만들어 준다 */
export async function loadCards(userName: string, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await dbWrite
      .selectFrom('GU_ADDRESS_BOOK')
      .select(['ADDRESS_ID', 'CONTACT_UID', 'CONTACT_NAME', 'MAIL_ADDRESS', 'VCARD_DATA'])
      .where('USER_NAME', '=', userName)
      .where('ADDRESS_ID', 'in', ids.slice(i, i + 500))
      .execute();
    for (const r of rows) {
      out.set(Number(r.ADDRESS_ID), r.VCARD_DATA ?? simpleCard(r.CONTACT_UID, r.CONTACT_NAME, r.MAIL_ADDRESS));
    }
  }
  return out;
}

/** 이 메일 주소를 가진 연락처 (그룹 제외). 앞선 것이 대표 메일로 가진 것 */
export async function findByEmail(userName: string, address: string): Promise<ContactRow[]> {
  const rows = await dbWrite
    .selectFrom('GU_ADDRESS_EMAIL as e')
    .innerJoin('GU_ADDRESS_BOOK as b', 'b.ADDRESS_ID', 'e.ADDRESS_ID')
    .select(LIST_COLUMNS.map((c) => `b.${c}` as const))
    .where('e.USER_NAME', '=', userName)
    .where('e.MAIL_ADDRESS', '=', address.trim())
    .where('b.CONTACT_KIND', '=', 'I')
    .orderBy('e.SORT_ORDER', 'asc')
    .orderBy('b.ADDRESS_ID', 'asc')
    .execute();
  const seen = new Set<number>();
  return rows.map(toRow).filter((r) => (seen.has(r.addressId) ? false : (seen.add(r.addressId), true)));
}

export interface ContactWrite {
  uid: string;
  davName?: string | null;
  vcard: string;
  index: ContactIndex;
}

function columnsOf(write: ContactWrite, now: Date) {
  return {
    CONTACT_UID: write.uid,
    CONTACT_KIND: write.index.kind,
    CONTACT_NAME: write.index.name,
    MAIL_ADDRESS: write.index.emails[0] ?? null,
    ORG_NAME: write.index.org,
    PHONE: write.index.phone,
    VCARD_DATA: write.vcard,
    UPDATE_DATE: now,
    ...(write.davName !== undefined ? { DAV_NAME: write.davName } : {}),
  };
}

export async function insertContact(
  userName: string,
  write: ContactWrite,
  usage?: { useCount: number; lastUsedAt: Date | null },
): Promise<number> {
  const now = new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const result = await trx
      .insertInto('GU_ADDRESS_BOOK')
      .values({
        USER_NAME: userName,
        ...columnsOf(write, now),
        USE_COUNT: usage?.useCount ?? 0,
        LAST_USED_AT: usage?.lastUsedAt ?? null,
        REG_DATE: now,
      })
      .executeTakeFirstOrThrow();
    const id = Number(result.insertId);
    if (write.index.emails.length) {
      await trx
        .insertInto('GU_ADDRESS_EMAIL')
        .values(write.index.emails.map((address, i) => ({ ADDRESS_ID: id, SORT_ORDER: i, USER_NAME: userName, MAIL_ADDRESS: address })))
        .execute();
    }
    return id;
  });
}

export async function updateContact(userName: string, addressId: number, write: ContactWrite): Promise<void> {
  const now = new Date();
  await dbWrite.transaction().execute(async (trx) => {
    await trx
      .updateTable('GU_ADDRESS_BOOK')
      .set(columnsOf(write, now))
      .where('ADDRESS_ID', '=', addressId)
      .where('USER_NAME', '=', userName)
      .execute();
    await trx.deleteFrom('GU_ADDRESS_EMAIL').where('ADDRESS_ID', '=', addressId).execute();
    if (write.index.emails.length) {
      await trx
        .insertInto('GU_ADDRESS_EMAIL')
        .values(write.index.emails.map((address, i) => ({ ADDRESS_ID: addressId, SORT_ORDER: i, USER_NAME: userName, MAIL_ADDRESS: address })))
        .execute();
    }
  });
}

export async function deleteContacts(userName: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  return dbWrite.transaction().execute(async (trx) => {
    const owned = (
      await trx.selectFrom('GU_ADDRESS_BOOK').select('ADDRESS_ID').where('USER_NAME', '=', userName).where('ADDRESS_ID', 'in', ids).execute()
    ).map((r) => Number(r.ADDRESS_ID));
    if (!owned.length) return 0;
    await trx.deleteFrom('GU_ADDRESS_EMAIL').where('ADDRESS_ID', 'in', owned).execute();
    await trx.deleteFrom('GU_ADDRESS_BOOK').where('ADDRESS_ID', 'in', owned).execute();
    return owned.length;
  });
}

/** 계정 삭제 (routes/admin.ts) */
export async function deleteAllOf(userName: string): Promise<void> {
  await dbWrite.deleteFrom('GU_ADDRESS_EMAIL').where('USER_NAME', '=', userName).execute();
  await dbWrite.deleteFrom('GU_ADDRESS_BOOK').where('USER_NAME', '=', userName).execute();
}

/** 발송할 때 쓴 횟수 · 시각. UPDATE_DATE(ETag)는 건드리지 않는다 */
export async function touchUsage(userName: string, addressId: number): Promise<void> {
  await dbWrite
    .updateTable('GU_ADDRESS_BOOK')
    .set((eb) => ({ USE_COUNT: eb('USE_COUNT', '+', 1), LAST_USED_AT: new Date() }))
    .where('ADDRESS_ID', '=', addressId)
    .where('USER_NAME', '=', userName)
    .execute();
}

/**
 * 수신자 자동완성(USR-1.4)용 검색. 메일 주소마다 한 줄 — 메일이 둘인 연락처는 두 줄이 된다.
 * 많이 · 최근에 쓴 주소를 앞에 둔다.
 */
export async function searchAddresses(
  userName: string,
  keyword: string,
  limit: number,
): Promise<{ address: string; name: string | null }[]> {
  const like = `%${escapeLike(keyword)}%`;
  const rows = await db
    .selectFrom('GU_ADDRESS_EMAIL as e')
    .innerJoin('GU_ADDRESS_BOOK as b', 'b.ADDRESS_ID', 'e.ADDRESS_ID')
    .select(['b.CONTACT_NAME', 'e.MAIL_ADDRESS'])
    .where('e.USER_NAME', '=', userName)
    .where((eb) => eb.or([eb('b.CONTACT_NAME', 'like', like), eb('e.MAIL_ADDRESS', 'like', like), eb('b.ORG_NAME', 'like', like)]))
    .orderBy('b.USE_COUNT', 'desc')
    .orderBy('b.LAST_USED_AT', 'desc')
    .orderBy('e.SORT_ORDER', 'asc')
    .orderBy('e.MAIL_ADDRESS', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({ address: row.MAIL_ADDRESS, name: row.CONTACT_NAME?.trim() || null }));
}

/** 이름으로 그룹 찾기 (자동완성) */
export async function searchGroups(userName: string, keyword: string, limit: number): Promise<ContactRow[]> {
  const like = `%${escapeLike(keyword)}%`;
  const rows = await db
    .selectFrom('GU_ADDRESS_BOOK')
    .select([...LIST_COLUMNS])
    .where('USER_NAME', '=', userName)
    .where('CONTACT_KIND', '=', 'G')
    .where('CONTACT_NAME', 'like', like)
    .orderBy('CONTACT_NAME', 'asc')
    .limit(limit)
    .execute();
  return rows.map(toRow);
}

/** 주소록에 적어 둔 이름을 주소로 한 번에 찾는다. 키는 소문자 주소다 */
export async function contactNames(userName: string, addresses: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('GU_ADDRESS_EMAIL as e')
    .innerJoin('GU_ADDRESS_BOOK as b', 'b.ADDRESS_ID', 'e.ADDRESS_ID')
    .select(['b.CONTACT_NAME', 'e.MAIL_ADDRESS'])
    .where('e.USER_NAME', '=', userName)
    .where('e.MAIL_ADDRESS', 'in', unique)
    .where('b.CONTACT_NAME', 'is not', null)
    .execute();
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = row.CONTACT_NAME?.trim();
    if (name && !map.has(row.MAIL_ADDRESS.toLowerCase())) map.set(row.MAIL_ADDRESS.toLowerCase(), name);
  }
  return map;
}
