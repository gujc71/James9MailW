/**
 * 해시 라우팅 (#/settings/mailbox, #/admin/users).
 *
 * 화면 전환은 컴포넌트 상태가 아니라 주소창 해시에 남긴다. 그래서
 *  - F5 로 새로고침해도 보던 화면·탭이 그대로 돌아오고,
 *  - 브라우저 뒤로·앞으로 가기가 화면 이동으로 동작하고,
 *  - 특정 화면 주소를 그대로 공유할 수 있다.
 *
 * 해시(`#` 뒷부분)는 서버로 가지 않으므로 정적 서빙 설정을 건드릴 일이 없다
 * (`/settings/mailbox` 같은 진짜 경로를 쓰려면 서버가 index.html 을 되돌려 줘야 한다).
 */
import { useEffect, useMemo, useState } from 'react';

export type HashRoute = {
  /** 첫 칸: 화면 이름. 해시가 없으면 빈 문자열 */
  view: string;
  /** 둘째 칸: 화면 안의 탭. 없으면 null */
  tab: string | null;
};

export function parseHash(hash: string): HashRoute {
  const [view = '', tab = ''] = hash.replace(/^#\/?/, '').split('/');
  return { view: safeDecode(view), tab: tab ? safeDecode(tab) : null };
}

export function formatHash(view: string, tab?: string | null): string {
  return tab ? `#/${view}/${tab}` : `#/${view}`;
}

/**
 * 지금 주소의 화면·탭. 뒤로가기나 주소 직접 수정(hashchange)에도 다시 그린다.
 * 반환값은 해시가 같으면 같은 객체라 의존성 배열에 그대로 넣어도 된다.
 */
export function useHashRoute(): HashRoute {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener('hashchange', sync);
    // 이 훅이 붙기 전에 해시가 바뀌었을 수 있다
    sync();
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}

/** 화면을 옮긴다. 히스토리에 쌓이므로 뒤로가기로 직전 화면으로 돌아간다 */
export function goTo(view: string, tab?: string | null) {
  const next = formatHash(view, tab);
  if (window.location.hash !== next) window.location.hash = next;
}

/**
 * 히스토리에 쌓지 않고 주소만 고친다. 알 수 없는 해시나 권한 없는 화면을 바로잡을 때 쓴다 —
 * 히스토리에 쌓으면 뒤로가기가 그 잘못된 주소로 되돌아가 무한히 튕긴다.
 */
export function replaceRoute(view: string, tab?: string | null) {
  const next = formatHash(view, tab);
  if (window.location.hash === next) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
  // replaceState 는 hashchange 를 띄우지 않으므로 직접 알린다
  window.dispatchEvent(new Event('hashchange'));
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // 손으로 고친 주소에 반쪽짜리 %가 섞이면 decode 가 던진다
    return part;
  }
}
