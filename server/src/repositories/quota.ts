/**
 * JAMES_QUOTA_LIMIT 해석과 사용량 산정.
 *
 * JAMES_QUOTA_LIMIT.md:
 *  - 해석 순서 USER -> DOMAIN -> GLOBAL, 처음 발견된 값이 이긴다.
 *  - QUOTA_LIMIT 이 NULL 이면 "미설정"(상위 범위로 내려감), -1 이면 "무제한"(여기서 결정).
 *  - USER 행의 IDENTIFIER 는 이메일이 아니라 quotaRoot 형식(#private&user@domain) 이다.
 *    그래서 쓰기는 DB 직접 INSERT 가 아니라 James 의 quota 라우트로 한다 (webmail-issues.md 6-1).
 */
import { db } from '../db/kysely.js';

export const SCOPE_USER = 'USER';
export const SCOPE_DOMAIN = 'DOMAIN';
export const SCOPE_GLOBAL = 'GLOBAL';
export const GLOBAL_IDENTIFIER = 'default_key';
export const TYPE_SIZE = 'SIZE';
export const TYPE_COUNT = 'COUNT';

/** James 가 쓰는 quotaRoot 표기 */
export function quotaRootOf(userName: string): string {
  return `#private&${userName}`;
}

export interface ResolvedQuota {
  /** null 이면 설정된 상한이 없다 = UNLIMIT 로 표시 (설계서 USR-3) */
  limit: number | null;
  unlimited: boolean;
  scope: 'USER' | 'DOMAIN' | 'GLOBAL' | null;
}

export async function resolveQuota(
  userName: string,
  quotaType: 'SIZE' | 'COUNT' = TYPE_SIZE,
): Promise<ResolvedQuota> {
  const domain = userName.includes('@') ? userName.slice(userName.lastIndexOf('@') + 1) : '';
  const rows = await db
    .selectFrom('JAMES_QUOTA_LIMIT')
    .select(['QUOTA_SCOPE', 'IDENTIFIER', 'QUOTA_LIMIT'])
    .where('QUOTA_TYPE', '=', quotaType)
    .where((eb) =>
      eb.or([
        eb.and([eb('QUOTA_SCOPE', '=', SCOPE_USER), eb('IDENTIFIER', '=', quotaRootOf(userName))]),
        eb.and([eb('QUOTA_SCOPE', '=', SCOPE_DOMAIN), eb('IDENTIFIER', '=', domain)]),
        eb.and([
          eb('QUOTA_SCOPE', '=', SCOPE_GLOBAL),
          eb('IDENTIFIER', '=', GLOBAL_IDENTIFIER),
        ]),
      ]),
    )
    .execute();

  // QUOTA_LIMIT 이 NULL 인 행은 "미설정"이라 여기서 빠진다
  const byScope = new Map<string, number>();
  for (const row of rows) {
    if (row.QUOTA_LIMIT === null) continue;
    byScope.set(row.QUOTA_SCOPE, Number(row.QUOTA_LIMIT));
  }

  for (const scope of [SCOPE_USER, SCOPE_DOMAIN, SCOPE_GLOBAL] as const) {
    const value = byScope.get(scope);
    if (value === undefined) continue;
    if (value === -1) return { limit: null, unlimited: true, scope };
    return { limit: value, unlimited: false, scope };
  }
  return { limit: null, unlimited: true, scope: null };
}

/**
 * 사용량 = 사용자의 JAMES_MAILBOX.MAILBOX_SIZE 합 (설계서 USR-3).
 * 한 파일을 여러 계정이 공유해도 MAILBOX_SIZE 는 계정별로 더해지므로 계정 사용량은 각자 잡힌다
 * (webmail-issues.md 6-4 는 이 값을 James 의 CurrentQuotaManager 와 대조하라고 남겨 둔 확인 항목이다).
 */
export async function usedBytes(userName: string): Promise<number> {
  const row = await db
    .selectFrom('JAMES_MAILBOX')
    .select(({ fn }) => fn.sum<number>('MAILBOX_SIZE').as('total'))
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

export async function usageOf(userName: string): Promise<{
  used: number;
  limit: number | null;
  unlimited: boolean;
  scope: string | null;
}> {
  const [used, quota] = await Promise.all([usedBytes(userName), resolveQuota(userName)]);
  return { used, limit: quota.limit, unlimited: quota.unlimited, scope: quota.scope };
}

/** 내부 수신자에게 보내기 전 사전 검사 (webmail-issues.md 3-4) */
export async function wouldExceedQuota(userName: string, extraBytes: number): Promise<boolean> {
  const { used, limit, unlimited } = await usageOf(userName);
  if (unlimited || limit === null) return false;
  return used + extraBytes > limit;
}

/** ADM-1 현황: 전체 사용 용량과 전체 메일 수 */
export async function siteTotals(): Promise<{
  users: number;
  mailboxBytes: number;
  mails: number;
  domains: number;
}> {
  const [users, size, mails, domains] = await Promise.all([
    db
      .selectFrom('JAMES_USER')
      .select(({ fn }) => fn.countAll<number>().as('cnt'))
      .executeTakeFirst(),
    db
      .selectFrom('JAMES_MAILBOX')
      .select(({ fn }) => fn.sum<number>('MAILBOX_SIZE').as('total'))
      .executeTakeFirst(),
    db
      .selectFrom('JAMES_MAIL')
      .select(({ fn }) => fn.countAll<number>().as('cnt'))
      .executeTakeFirst(),
    db
      .selectFrom('JAMES_DOMAIN')
      .select(({ fn }) => fn.countAll<number>().as('cnt'))
      .executeTakeFirst(),
  ]);
  return {
    users: Number(users?.cnt ?? 0),
    mailboxBytes: Number(size?.total ?? 0),
    mails: Number(mails?.cnt ?? 0),
    domains: Number(domains?.cnt ?? 0),
  };
}

/**
 * 여러 계정의 사용량을 한 번에 (ADM-3 사용자 목록). 계정마다 usageOf 를 부르면
 * 한 페이지 50명에 쿼리가 100번 나간다. 합계 한 번 + 한도 한 번으로 줄인다.
 * 해석 규칙(USER → DOMAIN → GLOBAL, -1 무제한)은 resolveQuota 와 같다.
 */
export async function usageMany(userNames: string[]): Promise<
  Map<string, { used: number; limit: number | null; unlimited: boolean; scope: string | null }>
> {
  const result = new Map<string, { used: number; limit: number | null; unlimited: boolean; scope: string | null }>();
  if (userNames.length === 0) return result;
  const domainOf = (name: string) => (name.includes('@') ? name.slice(name.lastIndexOf('@') + 1) : '');
  const domains = [...new Set(userNames.map(domainOf))];

  const [sums, limits] = await Promise.all([
    db
      .selectFrom('JAMES_MAILBOX')
      .select(({ fn }) => ['USER_NAME', fn.sum<number>('MAILBOX_SIZE').as('total')])
      .where('USER_NAME', 'in', userNames)
      .groupBy('USER_NAME')
      .execute(),
    db
      .selectFrom('JAMES_QUOTA_LIMIT')
      .select(['QUOTA_SCOPE', 'IDENTIFIER', 'QUOTA_LIMIT'])
      .where('QUOTA_TYPE', '=', TYPE_SIZE)
      .where((eb) =>
        eb.or([
          eb.and([eb('QUOTA_SCOPE', '=', SCOPE_USER), eb('IDENTIFIER', 'in', userNames.map(quotaRootOf))]),
          eb.and([eb('QUOTA_SCOPE', '=', SCOPE_DOMAIN), eb('IDENTIFIER', 'in', domains)]),
          eb.and([eb('QUOTA_SCOPE', '=', SCOPE_GLOBAL), eb('IDENTIFIER', '=', GLOBAL_IDENTIFIER)]),
        ]),
      )
      .execute(),
  ]);

  const used = new Map(sums.map((row) => [row.USER_NAME, Number(row.total ?? 0)]));
  const limitOf = new Map<string, number>();
  for (const row of limits) {
    if (row.QUOTA_LIMIT === null) continue;
    limitOf.set(`${row.QUOTA_SCOPE}|${row.IDENTIFIER}`, Number(row.QUOTA_LIMIT));
  }

  for (const userName of userNames) {
    const candidates: [string, number | undefined][] = [
      [SCOPE_USER, limitOf.get(`${SCOPE_USER}|${quotaRootOf(userName)}`)],
      [SCOPE_DOMAIN, limitOf.get(`${SCOPE_DOMAIN}|${domainOf(userName)}`)],
      [SCOPE_GLOBAL, limitOf.get(`${SCOPE_GLOBAL}|${GLOBAL_IDENTIFIER}`)],
    ];
    const found = candidates.find(([, value]) => value !== undefined);
    const base = { used: used.get(userName) ?? 0 };
    if (!found) result.set(userName, { ...base, limit: null, unlimited: true, scope: null });
    else if (found[1] === -1) result.set(userName, { ...base, limit: null, unlimited: true, scope: found[0] });
    else result.set(userName, { ...base, limit: found[1]!, unlimited: false, scope: found[0] });
  }
  return result;
}
