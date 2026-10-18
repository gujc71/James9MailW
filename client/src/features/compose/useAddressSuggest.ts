/**
 * 수신자 자동완성 후보 조회 (USR-1.4).
 *
 * 글자를 칠 때마다 DB 를 부르지 않는다.
 *  - 한 번 받아 온 목록은 그때 친 입력값을 열쇠로 캐시에 둔다.
 *  - 이어서 더 친 입력값은 캐시에 있는 접두 목록에서 걸러 쓴다.
 *    서버도 포함(LIKE %…%) 검색이라 "ab" 의 결과는 "abc" 의 결과를 반드시 품고 있다.
 *  - 캐시에 걸리는 접두 목록이 없고, 입력이 충분히 길 때(영문 2자·한글 1자)만 DB 를 부른다.
 * 한도(LIMIT)에 걸려 잘린 목록은 뒤가 잘려 있으니 캐시에 담지 않는다 (서버의 complete 플래그).
 *
 * 담아 둔 목록은 금방 상한다 — 서버는 지금 메일을 받을 수 있는 주소만 주는데(중지·삭제된
 * 계정과 중지된 알리아스는 뺀다), 관리자 화면도 같은 페이지 안에 있어서 중지해도 새로고침이
 * 없다. 그래서 수명을 둔다.
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { AddressSuggestResult, AddressSuggestion } from '../../api/types';

const DEBOUNCE_MS = 180;
const LIMIT = 50;
const MAX_ITEMS = 8;
/** 캐시 수명. 타자 사이의 조회를 막는 것이 목적이라 짧아도 효과는 그대로다 */
const CACHE_TTL_MS = 60_000;

/** 완성형 한글과 조합 중의 자모(ㄱ ㅏ …) */
const HANGUL_RE = /[ㄱ-ㆎ가-힣]/;

/**
 * 한 글자 영문은 걸리는 게 너무 많아 DB 까지 가지 않는다.
 * 한글은 한 글자로도 후보가 추려지므로 바로 조회한다.
 */
function longEnough(keyword: string): boolean {
  return keyword.length >= (HANGUL_RE.test(keyword) ? 1 : 2);
}

/** 작성창을 닫았다 다시 열어도 살아 있도록 모듈에 둔다. 계정이 바뀌면 통째로 버린다 */
const cache = new Map<string, { at: number; items: AddressSuggestion[] }>();
let cacheOwner = '';

/**
 * 담아 둔 목록을 바로 버린다. 관리자 화면처럼 주소의 사용 여부를 바꾼 자리에서 부르면
 * 같은 탭에서는 수명(CACHE_TTL_MS)을 기다리지 않고 반영된다.
 */
export function clearAddressSuggestCache(): void {
  cache.clear();
}

function ensureOwner(owner: string) {
  if (cacheOwner === owner) return;
  cache.clear();
  cacheOwner = owner;
}

/** 입력값의 접두 중 캐시에 있는 가장 긴 목록. 수명이 지난 것은 버리고 서버에 다시 묻는다 */
function cachedFor(keyword: string): AddressSuggestion[] | null {
  for (let length = keyword.length; length > 0; length -= 1) {
    const key = keyword.slice(0, length);
    const hit = cache.get(key);
    if (!hit) continue;
    if (Date.now() - hit.at <= CACHE_TTL_MS) return hit.items;
    cache.delete(key);
  }
  return null;
}

function matches(entry: AddressSuggestion, keyword: string): boolean {
  return (
    entry.address.toLowerCase().includes(keyword) ||
    (entry.name?.toLowerCase().includes(keyword) ?? false)
  );
}

/** 입력값으로 시작하는 후보를 앞에 둔다. 같은 점수면 서버가 준 순서(많이·최근에 쓴 순)를 지킨다 */
function score(entry: AddressSuggestion, keyword: string): number {
  if (entry.address.toLowerCase().startsWith(keyword)) return 0;
  if (entry.name?.toLowerCase().startsWith(keyword)) return 1;
  return 2;
}

function pickTop(list: AddressSuggestion[], keyword: string): AddressSuggestion[] {
  return list
    .filter((entry) => matches(entry, keyword))
    .map((entry, index) => ({ entry, index, rank: score(entry, keyword) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_ITEMS)
    .map((row) => row.entry);
}

export interface AddressSuggest {
  items: AddressSuggestion[];
  /** 입력값이 바뀔 때마다 부른다. 캐시에 있으면 즉시, 없으면 잠깐 기다렸다 한 번만 조회한다 */
  query: (text: string) => void;
  clear: () => void;
}

export function useAddressSuggest(owner: string): AddressSuggest {
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const timer = useRef<number | undefined>(undefined);
  /** 늦게 온 응답이 새 입력값의 결과를 덮지 않도록 하는 순번 */
  const seq = useRef(0);

  const clear = useCallback(() => {
    seq.current += 1;
    window.clearTimeout(timer.current);
    setItems([]);
  }, []);

  const query = useCallback(
    (text: string) => {
      ensureOwner(owner);
      const keyword = text.trim().toLowerCase();
      seq.current += 1;
      window.clearTimeout(timer.current);
      if (!keyword) {
        setItems([]);
        return;
      }
      const hit = cachedFor(keyword);
      if (hit) {
        setItems(pickTop(hit, keyword));
        return;
      }
      if (!longEnough(keyword)) {
        setItems([]);
        return;
      }
      const mine = seq.current;
      timer.current = window.setTimeout(() => {
        const path = `/api/addresses/suggest?q=${encodeURIComponent(keyword)}&limit=${LIMIT}`;
        api
          .get<AddressSuggestResult>(path)
          .then((result) => {
            if (result.complete) cache.set(keyword, { at: Date.now(), items: result.items });
            if (seq.current === mine) setItems(pickTop(result.items, keyword));
          })
          .catch(() => {
            // 자동완성은 거들 뿐이라 실패는 조용히 넘긴다
            if (seq.current === mine) setItems([]);
          });
      }, DEBOUNCE_MS);
    },
    [owner],
  );

  return { items, query, clear };
}
