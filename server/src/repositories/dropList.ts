/**
 * 수신거부 목록(JAMES_DROP_LIST) 등록 (USR-11 스팸차단 · ADM-6).
 *
 * 사용자 화면과 관리자 화면이 같은 규칙으로 넣도록 한 곳에 모았다.
 *  - 값은 메일 주소 또는 도메인 형식만 받는다. 아무 문자열이나 들어가면 James 가 매번 비교한다.
 *  - 같은 (범위, 주인, 값) 은 한 번만 넣는다.
 *  - 사용자 범위는 개수 상한을 둔다. 없으면 한 계정이 표를 무한히 키울 수 있다.
 *  - DROPLIST_ID 는 James 가 발급하지 않아 웹이 만든다. 시각만 쓰면 같은 밀리초의 두 요청이
 *    PK 에서 부딪혀 500 이 나므로 하위 자리에 난수를 섞고, 그래도 겹치면 다시 뽑는다.
 */
import { randomInt } from 'node:crypto';
import { db, dbWrite } from '../db/kysely.js';
import { badRequest, conflict } from '../errors.js';

/** 사용자 한 명이 등록할 수 있는 수신거부 개수 */
export const USER_DROP_LIMIT = 500;

const ADDRESS_RE = /^[^\s@<>",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const DOMAIN_RE = /^(?=.{3,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export type DropScope = 'GLOBAL' | 'USER';

/** 입력값을 정리하고 종류를 판정한다. 형식이 틀리면 400 */
export function normalizeDropEntity(raw: string): { entity: string; type: 'ADDRESS' | 'DOMAIN' } {
  const entity = raw.trim().toLowerCase();
  if (ADDRESS_RE.test(entity)) return { entity, type: 'ADDRESS' };
  if (DOMAIN_RE.test(entity)) return { entity, type: 'DOMAIN' };
  throw badRequest('err.dropInvalid');
}

function newId(): number {
  // 밀리초 × 1000 + 난수 3자리. 2^53 안쪽이라 BIGINT 와 JS number 양쪽에서 정확하다
  return Date.now() * 1000 + randomInt(1000);
}

export async function addDropEntry(params: {
  scope: DropScope;
  owner: string | null;
  entity: string;
  type: 'ADDRESS' | 'DOMAIN';
}): Promise<void> {
  let ownerFilter = db
    .selectFrom('JAMES_DROP_LIST')
    .select('DROPLIST_ID')
    .where('OWNER_SCOPE', '=', params.scope)
    .where('DENIED_ENTITY', '=', params.entity);
  ownerFilter =
    params.owner === null
      ? ownerFilter.where('OWNER', 'is', null)
      : ownerFilter.where('OWNER', '=', params.owner);
  if (await ownerFilter.executeTakeFirst()) throw conflict('err.dropExists');

  if (params.scope === 'USER' && params.owner) {
    const count = await db
      .selectFrom('JAMES_DROP_LIST')
      .select(({ fn }) => fn.countAll<number>().as('cnt'))
      .where('OWNER_SCOPE', '=', 'USER')
      .where('OWNER', '=', params.owner)
      .executeTakeFirst();
    if (Number(count?.cnt ?? 0) >= USER_DROP_LIMIT) {
      throw badRequest('err.dropLimit', { n: USER_DROP_LIMIT });
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await dbWrite
        .insertInto('JAMES_DROP_LIST')
        .values({
          DROPLIST_ID: newId(),
          OWNER_SCOPE: params.scope,
          OWNER: params.owner,
          DENIED_ENTITY_TYPE: params.type,
          DENIED_ENTITY: params.entity,
        })
        .execute();
      return;
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'ER_DUP_ENTRY' || attempt >= 4) throw cause;
    }
  }
}
