/**
 * James WebAdmin client. 모든 쓰기 연산은 여기를 거친다.
 *
 * James 테이블에 직접 UPDATE 하면 MODSEQ 이 오르지 않고, MailboxListener 가 뜨지 않아
 * 쿼터 카운터와 수신확인(JAMES_MAIL_RECEIPT.READ_DATE)이 어긋나며, OpenJPA 캐시도
 * 무효화되지 않는다 (webmail-architecture.md 2.3, webmail-issues.md 2-15).
 *
 * ── james9Mail 쪽에 추가해야 하는 커스텀 라우트 ──────────────────────────────
 * 아래 표기 중 [기본] 은 James 에 원래 있는 라우트, [커스텀] 은 james9Mail 에
 * 새로 만들어야 하는 라우트다. [커스텀] 이 배포되기 전에는 읽기 화면만 동작한다.
 *
 * 커스텀 라우트는 전부 /gu 아래에 둔다. James 가 이미 POST /users/{user}/mailboxes 와
 * PUT·DELETE /users/{user}/mailboxes/{mailboxName} 를 쓰고 있어서(Spark 는 먼저 등록된 라우트가
 * 이긴다) 같은 경로에 얹으면 어느 쪽이 잡힐지 Guice 가 Set 을 넘겨 준 순서에 달리게 된다.
 *
 * [커스텀] POST   /gu/mailboxes/{mailboxId}/messages/fromEml
 *          body { file, flags[], internalDate?, mailId? } -> { mailId, uid }
 *          file 은 **파일 이름만** 받는다. 폴더는 James 설정(james.mail.staging.dir)으로
 *          고정하고, "..", "/", "\" 가 들어오면 400, 읽기 전에 realpath 가 스테이징
 *          폴더 아래인지 확인한다 (4-1a). mailId 가 오면 세션 속성 gu.mailId 에 넣어
 *          JPAMessageMapper.deduplicateMessageContent 가 그 값을 MAIL_ID 로 쓰게 한다.
 * [커스텀] POST   /gu/mailboxes/{mailboxId}/messages/flags
 *          body { uids[], add[], remove[] } -> { updated }
 * [커스텀] POST   /gu/mailboxes/{mailboxId}/messages/move   { uids[], targetMailboxId }
 * [커스텀] POST   /gu/mailboxes/{mailboxId}/messages/copy   { uids[], targetMailboxId }
 * [커스텀] POST   /gu/mailboxes/{mailboxId}/messages/delete { uids[] }   (expunge)
 * [커스텀] POST   /users/{user}/mailboxes                { name, parentId? }
 * [커스텀] PUT    /users/{user}/mailboxes/{mailboxId}    { name }     (이름 변경 +
 *          같은 트랜잭션에서 Sieve 스크립트 재생성: webmail-issues.md 5-7)
 * [커스텀] DELETE /users/{user}/mailboxes/{mailboxId}
 * [기본]   PUT    /sieve/{user}/scripts/{name}?activate=true
 *          james9Mail 의 JPASieveRepository.putScript 를 "있으면 갱신" 으로 고쳤으므로
 *          기본 라우트로 덮어쓸 수 있다. 고치기 전에는 저장할 때마다 같은
 *          (USER_NAME, SCRIPT_NAME) 행이 쌓여 뒤이은 setActive 가
 *          NonUniqueResultException 으로 500 을 냈다 (webmail-issues.md 1-5).
 * [기본]   PUT/DELETE /quota/users/{user}/size           (6-1: DB 직접 INSERT 금지)
 * [기본]   PUT    /users/{user}          { password }   (신규 등록. 이미 있으면 409)
 * [기본]   PUT    /users/{user}?force    { password }   (기존 계정 비밀번호 변경)
 * [기본]   DELETE /users/{user}
 * [기본]   PUT/DELETE /address/aliases/... 또는 RecipientRewriteTable 라우트
 */
import { config } from '../config.js';
import { HttpError } from '../errors.js';

/**
 * James 쪽 오류. 사용자에게는 일반 문구만 가고(i18n), 원인(응답 본문·주소)은 details 에 실려
 * app.ts 의 errorHandler 가 로그로만 남긴다. WebAdmin 응답에는 스택·내부 경로가 섞여 나온다.
 */
function jamesError(status: number, key: string, code: string, details: Record<string, unknown>): HttpError {
  return new HttpError(status, key, code, details);
}

const BASE = config.james.webadminUrl;

/**
 * JAMES_RECIPIENT_REWRITE.MAPPING_TYPE 값. james9Mail 에서 매핑 타입을 TARGET_ADDRESS
 * 접두사("alias:")가 아니라 별도 컬럼에 저장하도록 고쳤고, 컬럼에는 James 의
 * Mapping.Type enum 이름이 그대로 들어간다. TARGET_ADDRESS 는 접두사 없는 순수 값이다.
 */
export const MappingType = {
  Alias: 'Alias',
  Group: 'Group',
  Forward: 'Forward',
  Address: 'Address',
  Regex: 'Regex',
  Domain: 'Domain',
  DomainAlias: 'DomainAlias',
  Error: 'Error',
} as const;

export type MappingTypeName = (typeof MappingType)[keyof typeof MappingType];

async function call<T>(
  method: string,
  pathname: string,
  body?: unknown,
  expectJson = true,
): Promise<T> {
  const url = `${BASE}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.james.webadminTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw jamesError(503, 'err.jamesUnreachable', 'JAMES_UNAVAILABLE', { base: BASE, reason: (cause as Error).message });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    const text = await response.text().catch(() => '');
    throw jamesError(503, 'err.jamesRouteMissing', 'JAMES_UNAVAILABLE', { method, path: pathname, text: text.trim() });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw jamesError(502, 'err.jamesFailed', 'JAMES_ERROR', { method, path: pathname, status: response.status, text });
  }
  if (!expectJson || response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export interface AppendResult {
  mailId: string;
  uid: number;
}

export const james = {
  /**
   * 스테이징 폴더에 놓인 원문 파일을 편지함에 넣는다.
   * 이 경로가 JPAMessageMapper.add 를 타면서 정식 위치 복사, JAMES_MAIL,
   * MIME_PART, RECIPIENTS, OWNER 행, UID/MODSEQ, MAILBOX_SIZE, 쿼터를 모두 처리한다.
   * 웹서버가 이것을 직접 흉내내면 안 된다 (webmail-issues.md 3-3).
   */
  appendFromEml(params: {
    mailboxId: string;
    file: string;
    flags?: string[];
    internalDate?: string;
    mailId?: string;
  }): Promise<AppendResult> {
    const { mailboxId, ...body } = params;
    return call<AppendResult>(
      'POST',
      `/gu/mailboxes/${encodeURIComponent(mailboxId)}/messages/fromEml`,
      body,
    );
  },

  /** 플래그 일괄 변경. 원문 조회 후 \Seen 을 여기로 세팅해야 수신확인이 찍힌다 (2-15) */
  setFlags(params: {
    mailboxId: string;
    uids: number[];
    add?: string[];
    remove?: string[];
  }): Promise<void> {
    const { mailboxId, ...body } = params;
    return call<void>(
      'POST',
      `/gu/mailboxes/${encodeURIComponent(mailboxId)}/messages/flags`,
      body,
      false,
    );
  },

  move(params: { mailboxId: string; uids: number[]; targetMailboxId: string }): Promise<void> {
    const { mailboxId, ...body } = params;
    return call<void>(
      'POST',
      `/gu/mailboxes/${encodeURIComponent(mailboxId)}/messages/move`,
      body,
      false,
    );
  },

  copy(params: { mailboxId: string; uids: number[]; targetMailboxId: string }): Promise<void> {
    const { mailboxId, ...body } = params;
    return call<void>(
      'POST',
      `/gu/mailboxes/${encodeURIComponent(mailboxId)}/messages/copy`,
      body,
      false,
    );
  },

  /** expunge. 하드 삭제이므로 툼스톤 리스너가 GU_MESSAGE_TOMBSTONE 에 기록한다 */
  expunge(params: { mailboxId: string; uids: number[] }): Promise<void> {
    const { mailboxId, ...body } = params;
    return call<void>(
      'POST',
      `/gu/mailboxes/${encodeURIComponent(mailboxId)}/messages/delete`,
      body,
      false,
    );
  },

  createMailbox(params: { user: string; name: string }): Promise<{ mailboxId: string }> {
    return call<{ mailboxId: string }>('POST', `/gu/users/${encodeURIComponent(params.user)}/mailboxes`, {
      name: params.name,
    });
  },

  renameMailbox(params: { mailboxId: string; name: string }): Promise<void> {
    return call<void>(
      'PUT',
      `/gu/mailboxes/${encodeURIComponent(params.mailboxId)}`,
      { name: params.name },
      false,
    );
  },

  deleteMailbox(params: { mailboxId: string }): Promise<void> {
    return call<void>(
      'DELETE',
      `/gu/mailboxes/${encodeURIComponent(params.mailboxId)}`,
      undefined,
      false,
    );
  },

  /**
   * Sieve 스크립트 덮어쓰기 + 활성화.
   * JPASieveRepository.putScript 가 같은 이름이면 행을 갱신하므로 기본 라우트로 덮어쓴다.
   */
  async putSieveScript(params: { user: string; name: string; content: string }): Promise<void> {
    const url =
      `${BASE}/sieve/${encodeURIComponent(params.user)}/scripts/${encodeURIComponent(params.name)}` +
      `?activate=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.james.webadminTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: params.content,
        signal: controller.signal,
      });
    } catch (cause) {
      throw jamesError(503, 'err.jamesUnreachable', 'JAMES_UNAVAILABLE', { base: BASE, reason: (cause as Error).message });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) {
      throw jamesError(503, 'err.sieveRouteMissing', 'JAMES_UNAVAILABLE', { user: params.user });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw jamesError(400, 'err.sieveSaveFailed', 'SIEVE_ERROR', { user: params.user, status: response.status, text });
    }
  },

  /** 쿼터는 quotaRoot(#private&user@domain) 를 James 가 계산하도록 기본 라우트로 넘긴다 (6-1) */
  setUserQuotaSize(user: string, bytes: number): Promise<void> {
    const url = `/quota/users/${encodeURIComponent(user)}/size`;
    return call<void>('PUT', url, bytes, false);
  },

  deleteUserQuotaSize(user: string): Promise<void> {
    return call<void>(
      'DELETE',
      `/quota/users/${encodeURIComponent(user)}/size`,
      undefined,
      false,
    );
  },

  createUser(user: string, password: string): Promise<void> {
    return call<void>('PUT', `/users/${encodeURIComponent(user)}`, { password }, false);
  },

  /**
   * 기존 계정의 비밀번호 변경. 같은 PUT 라우트지만 ?force 가 없으면 James 는
   * insertUser 를 타서 409 WrongState("user already exist") 를 낸다
   * (UserRoutes.upsertUser). 해시·version 컬럼 때문에 DB 직접 UPDATE 는 금지다.
   */
  setUserPassword(user: string, password: string): Promise<void> {
    return call<void>('PUT', `/users/${encodeURIComponent(user)}?force`, { password }, false);
  },

  deleteUser(user: string): Promise<void> {
    return call<void>('DELETE', `/users/${encodeURIComponent(user)}`, undefined, false);
  },

  /**
   * 알리아스. James 의 라우트는 PUT /address/aliases/{목적지}/sources/{알리아스주소} 이고,
   * JAMES_RECIPIENT_REWRITE 에 (USER_NAME/DOMAIN_NAME = 알리아스, MAPPING_TYPE = 'Alias',
   * TARGET_ADDRESS = 목적지) 행이 생긴다. TARGET_ADDRESS 에 "alias:" 접두사는 붙지 않는다.
   * 알리아스 하나에 실제 계정 N 개면 호출도 N 번이다 (web.md 7 절).
   */
  addAlias(destinationUser: string, aliasAddress: string): Promise<void> {
    return call<void>(
      'PUT',
      `/address/aliases/${encodeURIComponent(destinationUser)}/sources/${encodeURIComponent(aliasAddress)}`,
      undefined,
      false,
    );
  },

  removeAlias(destinationUser: string, aliasAddress: string): Promise<void> {
    return call<void>(
      'DELETE',
      `/address/aliases/${encodeURIComponent(destinationUser)}/sources/${encodeURIComponent(aliasAddress)}`,
      undefined,
      false,
    );
  },

  health(): Promise<unknown> {
    return call<unknown>('GET', '/healthcheck');
  },
};
