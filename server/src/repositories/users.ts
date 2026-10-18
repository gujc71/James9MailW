/**
 * JAMES_USER / JAMES_DOMAIN 조회.
 *
 * 식별자 컬럼은 실제 스키마의 USER_NAME 이다 (문서의 EMAIL 과 다름 — db/schema.ts 주석 참고).
 * 값은 hong@domain.com 형태의 full address 다.
 */
import { db, dbWrite } from '../db/kysely.js';
import { escapeLike, toIso } from '../util/mysql.js';

export interface UserRow {
  userName: string;
  displayName: string | null;
  photo: string | null;
  status: string | null;
  isAdmin: boolean;
  regDate: string | null;
  passwordHash: string;
  algorithm: string;
}

export async function findUser(userName: string): Promise<UserRow | null> {
  const row = await db
    .selectFrom('JAMES_USER')
    .select([
      'USER_NAME',
      'PASSWORD',
      'PASSWORD_HASH_ALGORITHM',
      'USER_DISPLAY_NAME',
      'USER_PHOTO',
      'USER_STATUS',
      'USER_DATE',
      'IS_ADMIN',
    ])
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return null;
  return {
    userName: row.USER_NAME,
    displayName: row.USER_DISPLAY_NAME || null,
    photo: row.USER_PHOTO,
    status: row.USER_STATUS,
    isAdmin: (row.IS_ADMIN ?? 'N').toUpperCase() === 'Y',
    regDate: toIso(row.USER_DATE),
    passwordHash: row.PASSWORD,
    algorithm: row.PASSWORD_HASH_ALGORITHM,
  };
}

export async function userExists(address: string): Promise<boolean> {
  const row = await db
    .selectFrom('JAMES_USER')
    .select('USER_NAME')
    .where('USER_NAME', '=', address)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * 도메인 목록은 발송·자동완성·수신거부마다 읽지만 거의 바뀌지 않는다. 짧게 캐시한다
 * (도메인 추가는 James 쪽 작업이라 웹이 비울 시점을 알 수 없어 TTL 로만 맞춘다).
 */
const DOMAIN_CACHE_MS = 60_000;
let domainCache: { value: Promise<string[]>; at: number } | null = null;

export function listDomains(): Promise<string[]> {
  const now = Date.now();
  if (domainCache && now - domainCache.at < DOMAIN_CACHE_MS) return domainCache.value;
  const value = db
    .selectFrom('JAMES_DOMAIN')
    .select('DOMAIN_NAME')
    .execute()
    .then((rows) => rows.map((r) => r.DOMAIN_NAME.toLowerCase()));
  domainCache = { value, at: now };
  value.catch(() => {
    if (domainCache?.value === value) domainCache = null;
  });
  // 호출자가 배열을 고쳐도 캐시가 오염되지 않게 사본을 준다
  return value.then((list) => [...list]);
}

export async function isLocalDomain(domain: string): Promise<boolean> {
  const domains = await listDomains();
  return domains.includes(domain.toLowerCase());
}

/**
 * 표시 이름·사진만 갱신한다. 이 두 컬럼은 James 엔진이 쓰지 않는 웹 전용 값이라
 * 직접 UPDATE 해도 MODSEQ·리스너 정합성 문제가 없다.
 * 비밀번호 변경은 반드시 James WebAdmin 을 거친다 (해시 알고리즘·version 컬럼).
 */
export async function updateProfile(
  userName: string,
  patch: { displayName?: string | null; photo?: string | null },
): Promise<void> {
  const values: Record<string, unknown> = {};
  // 빈 문자열은 NULL 로 저장한다. 화면은 이름이 없으면 아이디를 대신 보여준다.
  if (patch.displayName !== undefined) values.USER_DISPLAY_NAME = patch.displayName?.trim() || null;
  if (patch.photo !== undefined) values.USER_PHOTO = patch.photo;
  if (Object.keys(values).length === 0) return;
  await dbWrite
    .updateTable('JAMES_USER')
    .set(values as never)
    .where('USER_NAME', '=', userName)
    .execute();
}

/** ADM-3 사용자 리스트 */
export async function listUsers(params: {
  keyword?: string;
  /** 중지된 계정을 뺀다. 알리아스 대상 지정처럼 살아 있는 계정만 골라야 하는 화면용 */
  activeOnly?: boolean;
  limit: number;
  offset: number;
}): Promise<{ rows: UserRow[]; total: number }> {
  let query = db
    .selectFrom('JAMES_USER')
    .select([
      'USER_NAME',
      'PASSWORD',
      'PASSWORD_HASH_ALGORITHM',
      'USER_DISPLAY_NAME',
      'USER_PHOTO',
      'USER_STATUS',
      'USER_DATE',
      'IS_ADMIN',
    ]);
  let countQuery = db.selectFrom('JAMES_USER').select(({ fn }) => fn.countAll<number>().as('cnt'));

  if (params.keyword?.trim()) {
    const like = `%${escapeLike(params.keyword.trim())}%`;
    query = query.where((eb) =>
      eb.or([eb('USER_NAME', 'like', like), eb('USER_DISPLAY_NAME', 'like', like)]),
    );
    countQuery = countQuery.where((eb) =>
      eb.or([eb('USER_NAME', 'like', like), eb('USER_DISPLAY_NAME', 'like', like)]),
    );
  }

  if (params.activeOnly) {
    // USER_STATUS 는 NULL 이면 사용 중이다 (한 번도 중지한 적 없는 계정)
    query = query.where((eb) =>
      eb.or([eb('USER_STATUS', 'is', null), eb('USER_STATUS', 'not in', ['N', 'n'])]),
    );
    countQuery = countQuery.where((eb) =>
      eb.or([eb('USER_STATUS', 'is', null), eb('USER_STATUS', 'not in', ['N', 'n'])]),
    );
  }

  const [rows, count] = await Promise.all([
    query.orderBy('USER_DATE', 'desc').limit(params.limit).offset(params.offset).execute(),
    countQuery.executeTakeFirst(),
  ]);

  return {
    rows: rows.map((row) => ({
      userName: row.USER_NAME,
      displayName: row.USER_DISPLAY_NAME || null,
      photo: row.USER_PHOTO,
      status: row.USER_STATUS,
      isAdmin: (row.IS_ADMIN ?? 'N').toUpperCase() === 'Y',
      regDate: toIso(row.USER_DATE),
      passwordHash: row.PASSWORD,
      algorithm: row.PASSWORD_HASH_ALGORITHM,
    })),
    total: Number(count?.cnt ?? 0),
  };
}

/** ADM-3 사용/중지. 중지 계정은 로그인과 메일 수신이 막힌다 */
export async function setUserStatus(userName: string, status: 'Y' | 'N'): Promise<void> {
  await dbWrite
    .updateTable('JAMES_USER')
    .set({ USER_STATUS: status } as never)
    .where('USER_NAME', '=', userName)
    .execute();
}

/** 계정 생성 시 웹 전용 컬럼을 채운다 (계정 자체는 James WebAdmin 이 만든다) */
export async function setUserProfileOnCreate(
  userName: string,
  displayName: string,
): Promise<void> {
  await dbWrite
    .updateTable('JAMES_USER')
    .set({ USER_DISPLAY_NAME: displayName, USER_STATUS: 'Y' } as never)
    .where('USER_NAME', '=', userName)
    .execute();
}

/**
 * 수신자 자동완성(USR-1.4)용 내부 계정 검색. 계정·표시이름 어느 쪽에 들어 있어도 찾는다.
 * 중지(USER_STATUS = 'N') 계정은 메일을 받지 못하므로 후보에서 뺀다.
 */
export async function searchUsers(
  keyword: string,
  limit: number,
): Promise<{ address: string; name: string | null }[]> {
  const like = `%${escapeLike(keyword)}%`;
  const rows = await db
    .selectFrom('JAMES_USER')
    .select(['USER_NAME', 'USER_DISPLAY_NAME'])
    .where((eb) =>
      eb.or([eb('USER_NAME', 'like', like), eb('USER_DISPLAY_NAME', 'like', like)]),
    )
    .where((eb) => eb.or([eb('USER_STATUS', 'is', null), eb('USER_STATUS', '!=', 'N')]))
    .orderBy('USER_NAME', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    address: row.USER_NAME,
    name: row.USER_DISPLAY_NAME?.trim() || null,
  }));
}

/**
 * 준 주소 중 **메일을 받을 수 있는** 내부 계정만 골라 돌려준다. 키는 소문자 주소다.
 * 자동완성이 주소록에 남아 있는 죽은 내부 주소를 거르는 데 쓴다 (4-3).
 */
export async function activeAddresses(addresses: string[]): Promise<Set<string>> {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await db
    .selectFrom('JAMES_USER')
    .select('USER_NAME')
    .where('USER_NAME', 'in', unique)
    .where((eb) => eb.or([eb('USER_STATUS', 'is', null), eb('USER_STATUS', '!=', 'N')]))
    .execute();
  return new Set(rows.map((row) => row.USER_NAME.toLowerCase()));
}

/**
 * 내부 계정의 표시 이름을 한 번에 찾는다. 키는 소문자 주소다.
 * 주소록에 이름 없이 주소만 들어오는 자리(자동 수집 · 주소록 수동 등록)에서
 * USER_DISPLAY_NAME 을 이름 기본값으로 쓰기 위한 조회다.
 */
export async function displayNames(addresses: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('JAMES_USER')
    .select(['USER_NAME', 'USER_DISPLAY_NAME'])
    .where('USER_NAME', 'in', unique)
    .execute();
  const map = new Map<string, string>();
  for (const row of rows) {
    const name = row.USER_DISPLAY_NAME?.trim();
    if (name) map.set(row.USER_NAME.toLowerCase(), name);
  }
  return map;
}
