/**
 * 알리아스 발신 신원 (USR-1.4 / feature-gap 4-3).
 *
 * 알리아스의 실체는 JAMES_RECIPIENT_REWRITE 행이고(수신 → 실제 계정으로 되돌리는 방향),
 * 이름은 GU_MAIL_ALIAS 가 들고 있다. 사용여부는 두 표 모두에 있다 — 화면·자동완성은
 * GU_MAIL_ALIAS.ALIAS_STATUS 를, James 는 rewrite 행의 ALIAS_STATUS 를 본다.
 * 관리자 화면이 둘을 같이 바꾼다 (routes/admin.ts 의 setAliasRowStatus).
 * 발신은 그 방향을 뒤집어 읽는다 —
 * TARGET_ADDRESS 가 나인 Alias 행의 USER_NAME@DOMAIN_NAME 이 내가 From 에 쓸 수 있는 주소다.
 *
 * 587 이 아니라 무인증 릴레이(25)로 제출하므로 SMTP 가 발신자를 검증해 주지 않는다.
 * 이 목록이 유일한 위조 방지선이다 (james/smtp.ts 머리주석, webmail-issues.md 1-2).
 */
import { sql } from 'kysely';
import { db } from '../db/kysely.js';
import { escapeLike } from '../util/mysql.js';
import { MappingType } from '../james/webadmin.js';

export interface SendableAlias {
  /** From 에 들어갈 주소 */
  address: string;
  /** 관리자가 붙인 이름. From 의 표시이름으로 쓴다 (예: "그룹1") */
  aliasName: string;
}

/**
 * 이 계정이 From 으로 쓸 수 있는 알리아스.
 *
 * - `MAPPING_TYPE = 'Alias'` 만 본다. 같은 표에 Forward(부재중 전달)·Group 행도 쌓이는데,
 *   "내게 전달되는 주소" 와 "내가 사칭해도 되는 주소" 는 다르다.
 * - GU_MAIL_ALIAS 와 조인해 **관리자 화면이 만든 알리아스**만 인정한다.
 * - 중지(ALIAS_STATUS='N')해도 rewrite 행은 남는다(webmail-issues.md 7-4). 배달을 막는 것은
 *   rewrite 행의 상태 컬럼이므로, 발신 권한도 두 표의 상태를 모두 보고 판정한다.
 */
export async function listSendableAliases(userName: string): Promise<SendableAlias[]> {
  const rows = await db
    .selectFrom('JAMES_RECIPIENT_REWRITE as r')
    .innerJoin('GU_MAIL_ALIAS as a', (join) =>
      join
        .onRef('a.ALIAS_USER', '=', 'r.USER_NAME')
        .onRef('a.ALIAS_DOMAIN', '=', 'r.DOMAIN_NAME'),
    )
    .select(['r.USER_NAME as aliasUser', 'r.DOMAIN_NAME as aliasDomain', 'a.ALIAS_NAME as aliasName'])
    .where('r.MAPPING_TYPE', '=', MappingType.Alias)
    .where('a.ALIAS_STATUS', '=', 'Y')
    .where('r.ALIAS_STATUS', '!=', 'N')
    .where('r.TARGET_ADDRESS', '=', userName)
    .orderBy('a.ALIAS_NAME')
    .execute();

  return rows.map((row) => ({
    address: `${row.aliasUser}@${row.aliasDomain}`,
    aliasName: row.aliasName,
  }));
}

/**
 * From 후보 하나를 확정한다. 목록에 없으면 null — 호출자가 거절한다.
 *
 * 화면이 들고 있는 목록은 캐시지만 판정은 **발송 시점**에 이 함수가 다시 한다.
 * 메일쓰기 창을 띄워 둔 사이 관리자가 알리아스를 중지하거나 대상에서 뺐으면 그대로 막힌다.
 */
export async function findSendableAlias(
  userName: string,
  address: string,
): Promise<SendableAlias | null> {
  const wanted = address.trim().toLowerCase();
  const list = await listSendableAliases(userName);
  return list.find((item) => item.address.toLowerCase() === wanted) ?? null;
}

/**
 * 수신자 자동완성(USR-1.4)용 알리아스 검색.
 *
 * 알리아스도 메일을 받는 주소이므로 후보에 넣는다. 발신 권한(listSendableAliases)과 달리
 * 대상 계정을 가리지 않는다 — 알리아스는 누구나 보낼 수 있는 주소다.
 * ALIAS_USER 는 주소의 앞부분뿐이라 관리자 화면과 같이 ALIAS_USER·ALIAS_NAME 으로 찾고,
 * '@' 까지 친 입력도 걸리도록 붙인 전체 주소로 한 번 더 본다.
 * 중지(ALIAS_STATUS='N')면 James 가 배달에서 건너뛰어 메일이 가지 않으므로 뺀다.
 */
export async function searchAliases(
  keyword: string,
  limit: number,
): Promise<{ address: string; name: string | null }[]> {
  const like = `%${escapeLike(keyword)}%`;
  const rows = await db
    .selectFrom('GU_MAIL_ALIAS')
    .select(['ALIAS_USER', 'ALIAS_DOMAIN', 'ALIAS_NAME'])
    .where('ALIAS_STATUS', '=', 'Y')
    .where((eb) =>
      eb.or([
        eb('ALIAS_USER', 'like', like),
        eb('ALIAS_NAME', 'like', like),
        eb(sql<string>`concat(ALIAS_USER, '@', ALIAS_DOMAIN)`, 'like', like),
      ]),
    )
    .orderBy('ALIAS_NAME', 'asc')
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    address: `${row.ALIAS_USER}@${row.ALIAS_DOMAIN}`,
    name: row.ALIAS_NAME.trim() || null,
  }));
}

/**
 * 준 주소 중 **살아 있는 알리아스**만 골라 돌려준다. 키는 소문자 주소다.
 * users.activeAddresses 와 짝을 이뤄 자동완성의 죽은 내부 주소를 거른다 (4-3).
 */
export async function activeAliasAddresses(addresses: string[]): Promise<Set<string>> {
  const wanted = new Set(
    addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@')),
  );
  if (wanted.size === 0) return new Set();
  const localParts = [...new Set([...wanted].map((a) => a.slice(0, a.indexOf('@'))))];
  const rows = await db
    .selectFrom('GU_MAIL_ALIAS')
    .select(['ALIAS_USER', 'ALIAS_DOMAIN'])
    .where('ALIAS_USER', 'in', localParts)
    .where('ALIAS_STATUS', '=', 'Y')
    .execute();

  const live = new Set<string>();
  for (const row of rows) {
    const address = `${row.ALIAS_USER}@${row.ALIAS_DOMAIN}`.toLowerCase();
    if (wanted.has(address)) live.add(address);
  }
  return live;
}

/**
 * 알리아스 이름을 주소로 한 번에 찾는다. 키는 소문자 주소다.
 * 주소록·계정 쪽에서 이름 없이 주소만 걸린 후보의 이름을 채우는 데 쓴다.
 * ALIAS_USER 로 좁혀 온 뒤 도메인까지 맞는 행만 담는다 (같은 앞부분이 여러 도메인에 있다).
 */
export async function aliasNames(addresses: string[]): Promise<Map<string, string>> {
  const wanted = new Set(
    addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@')),
  );
  if (wanted.size === 0) return new Map();
  const localParts = [...new Set([...wanted].map((a) => a.slice(0, a.indexOf('@'))))];
  const rows = await db
    .selectFrom('GU_MAIL_ALIAS')
    .select(['ALIAS_USER', 'ALIAS_DOMAIN', 'ALIAS_NAME'])
    .where('ALIAS_USER', 'in', localParts)
    .where('ALIAS_STATUS', '=', 'Y')
    .execute();

  const map = new Map<string, string>();
  for (const row of rows) {
    const address = `${row.ALIAS_USER}@${row.ALIAS_DOMAIN}`.toLowerCase();
    const name = row.ALIAS_NAME.trim();
    if (name && wanted.has(address)) map.set(address, name);
  }
  return map;
}
