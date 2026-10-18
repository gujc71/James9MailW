/**
 * Dexie 미러에서 목록 한 페이지를 만든다 (feature-gap 8-5, 오프라인 읽기).
 *
 * 서버 `/api/messages` 와 **같은 순서·같은 필터** 를 내야 한다. 다르면 온라인에서 보던
 * 목록과 오프라인에서 보는 목록이 어긋나 "메일이 사라졌다" 로 읽힌다. 그래서 정렬 식과
 * 필터 조건은 repositories/messages.ts 의 sortExpr()·listMessages() 를 그대로 옮겨 왔다.
 *
 * 두 가지는 로컬에서 할 수 없다:
 *  - 파일이름 검색 — MIME 파트 행(JAMES_MAIL_MIME_PART)은 미러에 없다.
 *  - 본문 검색 — 원문 캐시는 일부만 있다 (3-1 도 서버 인덱스를 전제한다).
 * 이런 질의는 canQueryLocally() 가 false 를 돌려 서버 경로로 보낸다.
 *
 * 정렬은 인덱스를 타지 않고 메모리에서 한다. 한 편지함 규모(수천~수만 통)에서는 감당할
 * 수준이고, 서버 쪽 filesort 와 처지가 같다.
 */
import { db, type StoredMessage } from './schema';
import type { MessageSummary } from '../api/types';

export interface LocalSort {
  key: 'date' | 'from' | 'subject' | 'size';
  desc: boolean;
}

export interface LocalFilters {
  unseen?: boolean;
  flagged?: boolean;
  important?: boolean;
  attachment?: boolean;
  searchField?: 'all' | 'from' | 'to' | 'subject' | 'filename';
  keyword?: string;
}

export interface LocalQuery {
  mailboxIds: string[];
  /** 보낸 편지함 계열인가. 날짜는 발송일시, 주소 열은 받는 사람을 본다 */
  sentView: boolean;
  sort: LocalSort;
  filters: LocalFilters;
  limit: number;
}

/** 미러로 답할 수 있는 질의인가. 파일이름 검색만 서버 몫이다 */
export function canQueryLocally(filters: LocalFilters): boolean {
  if (!filters.keyword?.trim()) return true;
  return (filters.searchField ?? 'all') !== 'filename';
}

/** 서버 sortExpr() 과 같은 값. NULL 은 빈 문자열·0 으로 메운다 */
function sortValue(message: StoredMessage, query: LocalQuery): string | number {
  switch (query.sort.key) {
    case 'from':
      return (
        (query.sentView
          ? message.toDisplay || message.to
          : message.fromDisplay || message.from) ?? ''
      );
    case 'subject':
      return message.subject ?? '';
    case 'size':
      return message.size;
    default:
      // Date 헤더가 없는 메일은 수신일시로 되돌린다 (서버의 COALESCE 와 같다)
      return (query.sentView ? message.sentAt ?? message.receivedAt : message.receivedAt) ?? '';
  }
}

/**
 * 정렬 값 비교. 크기는 수, 날짜는 ISO 문자열(사전순 = 시간순), 이름·제목은 로케일 비교다.
 * MySQL 의 utf8mb4 대소문자 무시 정렬에 맞추려고 sensitivity: 'base' 로 본다.
 */
function compareValues(a: string | number, b: string | number, key: LocalSort['key']): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a);
  const right = String(b);
  if (key === 'date') return left < right ? -1 : left > right ? 1 : 0;
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function matchesSearch(message: StoredMessage, filters: LocalFilters): boolean {
  const keyword = filters.keyword?.trim().toLowerCase();
  if (!keyword) return true;
  const has = (value: string | null) => Boolean(value && value.toLowerCase().includes(keyword));
  switch (filters.searchField ?? 'all') {
    case 'subject':
      return has(message.subject);
    case 'from':
      return has(message.from) || has(message.fromDisplay);
    case 'to':
      return has(message.to) || has(message.toDisplay);
    case 'filename':
      // canQueryLocally() 가 먼저 걸러 내지만, 부르는 곳이 빠뜨려도 조용히 다 보여 주지는 않는다
      return false;
    default:
      return (
        has(message.subject) ||
        has(message.from) ||
        has(message.fromDisplay) ||
        has(message.to) ||
        has(message.toDisplay)
      );
  }
}

function matchesFilters(message: StoredMessage, filters: LocalFilters): boolean {
  // 미러에는 \Deleted 행도 들어온다 (/api/sync 는 지운 표시만 된 행도 보낸다).
  // 서버 목록은 MAIL_IS_DELETED = 0 만 보여 주므로 여기서도 걷어낸다
  if (message.flags.includes('\\Deleted')) return false;
  if (filters.unseen && message.flags.includes('\\Seen')) return false;
  if (filters.flagged && !message.flags.includes('\\Flagged')) return false;
  if (filters.important && message.importance !== 'high') return false;
  if (filters.attachment && !message.hasAttachment) return false;
  return matchesSearch(message, filters);
}

export interface LocalPage {
  messages: MessageSummary[];
  hasMore: boolean;
  /** 어떤 질의의 결과인지. 화면이 갈아탄 뒤 남아 있는 앞 질의 결과를 가려내는 데 쓴다 */
  signature: string;
}

/**
 * 질의를 한 줄 문자열로. live-query 는 구독을 갈아타는 동안 **앞 결과를 그대로 들고 있다** —
 * 편지함을 바꾼 첫 프레임에 앞 편지함 목록이 한 번 스쳐 보이지 않게, 부르는 쪽이 이 값으로
 * "내가 물어본 질의의 답" 인지 확인한다.
 */
export function signatureOf(query: LocalQuery): string {
  const f = query.filters;
  return JSON.stringify([
    [...query.mailboxIds].sort(),
    query.sentView,
    query.sort.key,
    query.sort.desc,
    Boolean(f.unseen),
    Boolean(f.flagged),
    Boolean(f.important),
    Boolean(f.attachment),
    f.searchField ?? 'all',
    f.keyword ?? '',
    query.limit,
  ]);
}

/**
 * 미러에서 앞에서부터 limit 통. 커서 대신 limit 을 늘려 이어 받는다 —
 * 로컬에서는 페이지를 이어 붙이지 않고 같은 질의를 다시 풀어도 값이 싸고, 그래야 동기화가
 * 끼어들어도(새 메일·플래그 변경) 목록 전체가 한 번에 맞는 상태로 다시 그려진다.
 */
export async function queryLocalPage(query: LocalQuery): Promise<LocalPage> {
  if (query.mailboxIds.length === 0)
    return { messages: [], hasMore: false, signature: signatureOf(query) };

  const rows = await db.messages.where('mailboxId').anyOf(query.mailboxIds).toArray();
  const kept = rows.filter((row) => matchesFilters(row, query.filters));

  const direction = query.sort.desc ? -1 : 1;
  kept.sort((a, b) => {
    const primary = compareValues(sortValue(a, query), sortValue(b, query), query.sort.key);
    if (primary !== 0) return primary * direction;
    // 정렬 값이 같은 행은 uid, 그것도 같으면 편지함으로 갈라 순서를 하나로 못박는다 (서버와 동일)
    if (a.uid !== b.uid) return (a.uid - b.uid) * direction;
    return a.mailboxId.localeCompare(b.mailboxId) * direction;
  });

  return {
    messages: kept.slice(0, query.limit).map(({ dirty: _dirty, ...message }) => message),
    hasMore: kept.length > query.limit,
    signature: signatureOf(query),
  };
}

/** 낙관적 플래그 변경을 미러에도 남긴다. 확인 전이라는 표시(dirty)를 달아 둔다 */
export async function patchLocalFlags(
  mailboxId: string,
  uid: number,
  flags: string[],
): Promise<void> {
  // 미러에 없는 메일(아직 동기화 안 된 편지함)이면 아무 일도 일어나지 않는다
  await db.messages.update([mailboxId, uid], { flags, dirty: true });
}
