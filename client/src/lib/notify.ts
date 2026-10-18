/**
 * 데스크톱 알림 · 파비콘 배지 (feature-gap.md 8-2, 8-3).
 *
 * 두 가지를 한 파일에 둔다. 둘 다 "안 읽은 새 메일" 하나를 근거로 움직이고,
 * 봉투 아이콘을 그리는 캔버스도 함께 쓴다(알림 아이콘 = 배지 없는 파비콘).
 *
 * 켜고 끄는 값은 **브라우저 localStorage** 에만 둔다. 알림 권한 자체가 브라우저·기기마다
 * 따로 걸리는 값이라 서버 설정으로 올리면 "켰다고 저장됐는데 이 기기에서는 안 뜬다" 가 된다
 * (목록 정렬을 localStorage 에 두는 것과 같은 이유 → mailbox/listSort.ts).
 *
 * 실제로 뜨는 조건은 **저장값 && 권한 허용** 둘 다다. 권한은 사용자가 브라우저 설정에서
 * 언제든 되돌릴 수 있으므로 저장값만 믿지 않는다.
 */
import type { MailboxRole, MessageSummary } from '../api/types';
import { displayNameOnly } from './format';
import { t } from '../i18n';

const PREF_KEY = 'j9-notify';

/** 탭 제목의 원본. 배지를 붙이기 전에 잡아 둔다 — 붙인 제목에 또 붙이면 "(2) (1) …" 이 된다 */
const BASE_TITLE = typeof document === 'undefined' ? '' : document.title;

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function loadPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function savePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, '1');
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // 저장이 막힌 창(시크릿 등)에서는 이번 세션만 유지한다
  }
}

/** 지금 알림을 띄울 수 있는가. 저장값과 브라우저 권한이 모두 맞아야 한다 */
export function notifyEnabled(): boolean {
  return notifySupported() && Notification.permission === 'granted' && loadPref();
}

/**
 * 알림 켜기. 권한 요청은 반드시 사용자 조작(버튼 클릭) 안에서 불러야 브라우저가 받아 준다.
 * 'denied' 는 사용자가 막았거나 예전에 막아 둔 상태다 — 코드로는 되돌릴 수 없고 사이트 설정에서만 풀린다.
 */
export async function enableNotify(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!notifySupported()) return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    savePref(false);
    return 'denied';
  }
  savePref(true);
  return 'granted';
}

export function disableNotify(): void {
  savePref(false);
}

/**
 * 새 메일 알림·배지에 셀 편지함인가.
 * 보낸·임시·발신대기는 내가 만든 변화고, 휴지통·스팸의 안 읽음은 알릴 일이 아니다.
 * 자동분류 규칙이 개인 편지함으로 넣은 메일은 받은편지함에 남지 않으므로 함께 센다.
 */
export function countsAsIncoming(role: MailboxRole): boolean {
  return role === 'INBOX' || role === 'personal' || role === 'Archive';
}

/** 한 번에 띄우는 알림 수. 이보다 많으면 나머지는 "그 밖에 N통" 한 줄로 묶는다 */
const MAX_NOTIFICATIONS = 3;

/**
 * 새로 도착한 안 읽은 메일을 알린다 (8-2). 보낸 사람이 제목, 제목이 본문, 클릭하면 그 메일이 열린다.
 *
 * **이 탭을 보고 있으면 띄우지 않는다.** 목록이 곧바로 갱신되는 화면 위에 같은 소식을 한 번 더
 * 올리는 셈이라 방해만 된다. visibilityState 만으로는 "다른 창에 가려진 보이는 탭" 을 놓치므로
 * 포커스까지 함께 본다.
 */
export function notifyNewMail(
  rows: MessageSummary[],
  onOpen: (row: MessageSummary) => void,
): void {
  if (rows.length === 0 || !notifyEnabled()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;

  const icon = iconUrl(0) || undefined;
  for (const row of rows.slice(0, MAX_NOTIFICATIONS)) {
    // tag 를 (편지함, uid) 로 두면 같은 메일이 두 번 알려지지 않는다 — 폴링이 겹쳐도 덮어쓰기만 된다
    const notification = new Notification(
      displayNameOnly(row.fromDisplay, row.from) || t('common.noAddress'),
      { body: row.subject?.trim() || t('common.noSubject'), tag: `j9:${row.mailboxId}:${row.uid}`, icon },
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
      onOpen(row);
    };
  }

  const rest = rows.length - MAX_NOTIFICATIONS;
  if (rest > 0) {
    new Notification(t('notify.moreTitle'), { body: t('notify.moreBody', { n: rest }), tag: 'j9:more', icon });
  }
}

/** 마지막으로 그린 수. 폴링마다 같은 값을 다시 그리지 않는다 */
let lastCount = -1;

/**
 * 탭 제목과 파비콘에 안 읽은 수를 얹는다 (8-3).
 *
 * 파비콘은 16px 로 줄어들므로 두 자리 숫자는 읽히지 않는다 — 아이콘에는 '9+' 까지만 넣고
 * 정확한 수는 탭 제목이 맡는다.
 */
export function applyUnseenBadge(count: number): void {
  const safe = Math.max(0, Math.trunc(count));
  if (safe === lastCount) return;
  lastCount = safe;
  document.title = safe > 0 ? `(${safe > 99 ? '99+' : safe}) ${BASE_TITLE}` : BASE_TITLE;
  const url = iconUrl(safe);
  if (url) iconLink().href = url;
}


function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  return link;
}

/** :root 나 style 속성에 얹힌 색 토큰을 꺼낸다. 값이 없으면 기본 팔레트를 쓴다 */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * 강조색이 바뀌면 캐시를 버리고 지금 수로 다시 그린다 (lib/theme.ts 의 applyTheme 가 부른다).
 * 색만 바뀌고 수는 그대로이므로 lastCount 를 지워 applyUnseenBadge 의 조기 반환을 푼다.
 */
export function redrawIcon(): void {
  iconCache.clear();
  const count = lastCount < 0 ? 0 : lastCount;
  lastCount = -1;
  applyUnseenBadge(count);
}

/** 그린 아이콘은 수가 같으면 다시 그리지 않는다. 폴링마다 캔버스를 새로 돌릴 일이 아니다 */
const iconCache = new Map<number, string>();

/** 봉투(+배지) 아이콘의 data URL. count 가 0 이면 배지 없는 기본 아이콘이다 */
function iconUrl(count: number): string {
  const key = count > 9 ? 10 : count;
  const cached = iconCache.get(key);
  if (cached !== undefined) return cached;
  const url = drawIcon(count);
  // 캔버스를 못 쓰는 환경의 빈 값은 캐시하지 않는다 — 다음 번에 다시 시도할 여지를 남긴다
  if (url) iconCache.set(key, url);
  return url;
}

/**
 * 64px 캔버스에 봉투를 그리고 필요하면 오른쪽 아래에 배지를 얹는다.
 * index.html 에 파비콘 파일이 없으므로 아이콘 자체도 여기서 만든다 — 파일 하나를 더 두고
 * 그 위에 숫자를 합성하는 것보다 색(styles.css 토큰)과 어긋날 일이 적다.
 */
function drawIcon(count: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // 색은 CSS 토큰에서 읽는다 — 관리자가 강조색을 바꾸면 파비콘도 따라간다 (lib/theme.ts)
  ctx.fillStyle = cssColor('--accent', '#4f46e5');
  roundRect(ctx, 4, 13, 56, 38, 8);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(13, 21);
  ctx.lineTo(32, 36);
  ctx.lineTo(51, 21);
  ctx.stroke();

  if (count > 0) {
    const label = count > 9 ? '9+' : String(count);
    // 흰 테두리를 먼저 깔아 봉투와 배지 경계를 띄운다. 16px 로 줄면 이 한 겹이 형태를 지켜 준다
    ctx.beginPath();
    ctx.arc(44, 44, 19, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(44, 44, 16, 0, Math.PI * 2);
    ctx.fillStyle = cssColor('--danger', '#dc2626');
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${label.length > 1 ? 20 : 26}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 44, 45);
  }

  return canvas.toDataURL('image/png');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
