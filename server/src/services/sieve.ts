/**
 * Sieve 저장·조회 서비스.
 *
 * 스크립트 이름은 사용자당 고정값 한 개(james9mail)이고, 저장할 때마다 본문 전체를
 * 다시 만들어 갱신한다 (web.md 8.1). 쓰기는 James WebAdmin 의 기본 PUT 으로 한다 —
 * JPASieveRepository.putScript 가 같은 이름이면 덮어쓰도록 고쳐졌다 (webmail-issues.md 1-5).
 *
 * 저장은 모델 전체를 덮어쓰는 방식이라 두 곳에서 동시에 고치면 한쪽이 묻힌다.
 * 저장 전에 DB 의 현재 스크립트를 읽어 기준 시각을 비교한다 (5-4 낙관적 잠금).
 */
import { db } from '../db/kysely.js';
import { james } from '../james/webadmin.js';
import { generateSieve, SCRIPT_BYTE_LIMIT } from '../sieve/generate.js';
import { parseSieve } from '../sieve/parse.js';
import type { SieveModel } from '../sieve/model.js';
import { conflict, payloadTooLarge } from '../errors.js';
import { toIso, toBool } from '../util/mysql.js';

export const SCRIPT_NAME = 'james9mail';

export interface StoredScript {
  content: string;
  active: boolean;
  activatedAt: string | null;
}

export async function readActiveScript(userName: string): Promise<StoredScript | null> {
  const row = await db
    .selectFrom('JAMES_SIEVE_SCRIPT')
    .select(['SCRIPT_CONTENT', 'IS_ACTIVE', 'ACTIVATION_DATE_TIME'])
    .where('USER_NAME', '=', userName)
    .where('SCRIPT_NAME', '=', SCRIPT_NAME)
    .executeTakeFirst();
  if (!row) return null;
  return {
    content: row.SCRIPT_CONTENT,
    active: toBool(row.IS_ACTIVE),
    activatedAt: toIso(row.ACTIVATION_DATE_TIME),
  };
}

export async function readModel(userName: string): Promise<SieveModel> {
  const stored = await readActiveScript(userName);
  return parseSieve(stored?.content ?? '');
}

export interface SaveResult {
  script: string;
}

export async function saveModel(
  userName: string,
  model: SieveModel,
  options: { expectedActivatedAt?: string | null } = {},
): Promise<SaveResult> {
  if (options.expectedActivatedAt !== undefined) {
    const current = await readActiveScript(userName);
    if ((current?.activatedAt ?? null) !== (options.expectedActivatedAt ?? null)) {
      throw conflict('err.ruleConflict');
    }
  }

  // USER_NAME 은 hong@domain.com 형태라 그대로 부재중 자기발신 제외에 쓴다
  const script = generateSieve(model, { ownerAddress: userName });
  // 넘기면 James 가 저장에 실패하므로 보내기 전에 막는다 (5-1)
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > SCRIPT_BYTE_LIMIT) {
    throw payloadTooLarge(
      'err.ruleTooBig',
      { bytes, limit: SCRIPT_BYTE_LIMIT },
    );
  }
  await james.putSieveScript({ user: userName, name: SCRIPT_NAME, content: script });

  return { script };
}

/**
 * 편지함 이름이 바뀌면 fileinto 대상 이름도 바꿔야 한다 (web.md 8.3, 5-7).
 * 이름 변경 라우트가 James 쪽에서 같은 트랜잭션으로 처리하는 것이 원칙이지만,
 * 웹에서 변경한 경우에는 여기서 스크립트를 갱신한다.
 */
export async function renameMailboxInRules(
  userName: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const model = await readModel(userName);
  let changed = false;
  const rewrite = (rule: { action: SieveModel['filters'][number]['action'] }) => {
    if (
      (rule.action.type === 'FILEINTO' || rule.action.type === 'SPAM') &&
      (rule.action.mailboxName === oldName || rule.action.mailboxName.startsWith(`${oldName}.`))
    ) {
      rule.action.mailboxName = newName + rule.action.mailboxName.slice(oldName.length);
      changed = true;
    }
  };
  model.filters.forEach(rewrite);
  model.rejects.forEach(rewrite);
  if (changed) await saveModel(userName, model);
}

/**
 * 예전 스크립트를 지금 형태로 올려 둔다 (한 번만 하면 되는 일).
 *
 * 기간을 마커 주석에만 적어 두던 때의 스크립트는 기간이 지나도 규칙이 그대로 살아 있다.
 * 마커에 남은 시작일·종료일을 읽어 currentdate 테스트가 들어간 지금 형태로 다시 만든다.
 * 이미 지금 형태면 다시 만든 결과가 같아 아무것도 쓰지 않으므로, 서버가 뜰 때마다 불러도 된다.
 */
export async function regenerateScripts(): Promise<{ updated: number; failed: number }> {
  const rows = await db
    .selectFrom('JAMES_SIEVE_SCRIPT')
    .select(['USER_NAME', 'SCRIPT_CONTENT'])
    .where('SCRIPT_NAME', '=', SCRIPT_NAME)
    .execute();

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const next = generateSieve(parseSieve(row.SCRIPT_CONTENT), { ownerAddress: row.USER_NAME });
    if (next.trim() === row.SCRIPT_CONTENT.trim()) continue;
    try {
      await james.putSieveScript({ user: row.USER_NAME, name: SCRIPT_NAME, content: next });
      updated += 1;
    } catch {
      // 한 사람이 실패해도 나머지는 올린다. 다음 기동에서 다시 시도된다
      failed += 1;
    }
  }
  return { updated, failed };
}
