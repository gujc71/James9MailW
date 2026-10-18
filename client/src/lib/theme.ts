/**
 * 사이트 강조색 (ADM-2 사이트 기본 설정).
 *
 * styles.css 의 --accent* 는 :root 에 기본값(인디고)으로 박아 두고, 관리자가 고른 색은
 * 여기서 document.documentElement 에 같은 이름의 변수를 얹어 덮어쓴다. CSS 쪽에 색 계산
 * (color-mix 등)을 두지 않은 건 저장된 아홉 색을 그대로 올리기만 하면 되기 때문이다.
 *
 * 반투명 계열(--ring, --sh-accent, 목록 hover 배경 등)은 accent 한 색에서 알파만 바꿔
 * 쓰므로 관리자 항목이 없다. 대신 --accent-rgb 를 함께 얹어 CSS 가 rgb(var(--accent-rgb) / .06)
 * 로 꺼내 쓴다.
 *
 * 로그인 화면도 --accent-grad 를 쓰므로 세션 전에 색을 알아야 한다. 그래서
 *   ① localStorage 에 담아 둔 값으로 먼저 칠하고(새로고침 때 기본 보라가 번쩍이지 않게)
 *   ② 공개 엔드포인트 /api/site/theme 로 받은 값으로 다시 칠한다.
 */
import type { SiteTheme, ThemeKey } from '../api/types';
import { contrastOnWhiteText, fromHsl, mix, toHsl, toRgb } from './color';
import { redrawIcon } from './notify';

export type { SiteTheme, ThemeKey };

/**
 * 각 항목이 얹히는 CSS 변수 이름. Record<ThemeKey, …> 라서 항목을 하나 빠뜨리면 컴파일이
 * 막힌다 — THEME_KEYS 는 여기서 뽑으므로 목록이 따로 낡을 일이 없다.
 */
const CSS_VAR: Record<ThemeKey, string> = {
  accent: '--accent',
  accentHover: '--accent-hover',
  accentText: '--accent-text',
  accentPale: '--accent-pale',
  accentSoft: '--accent-soft',
  accentSoft2: '--accent-soft-2',
  gradFrom: '--accent-grad-from',
  gradTo: '--accent-grad-to',
  syntaxField: '--syntax-field',
};

export const THEME_KEYS = Object.keys(CSS_VAR) as ThemeKey[];

/** styles.css :root 의 현재 값. 서버 THEME_DEFAULT (repositories/gu.ts) 와 같아야 한다 */
export const THEME_DEFAULT: SiteTheme = {
  accent: '#4f46e5',
  accentHover: '#4338ca',
  accentText: '#3f37c9',
  accentPale: '#f4f1fe',
  accentSoft: '#eef0fe',
  accentSoft2: '#e4e7fd',
  gradFrom: '#5b53ea',
  gradTo: '#7c5cf0',
  syntaxField: '#4a4ec2',
};

const STORE_KEY = 'j9-theme';
const HEX_RE = /^#[0-9a-f]{6}$/;

/**
 * 기준색 하나에서 나머지 여덟 색을 만든다 (관리자 화면의 "기준색에서 자동 계산").
 * 비율은 현재 팔레트(#4f46e5 계열)에서 역산한 값이다 — 기준색을 그대로 두고 누르면
 * 지금 화면과 거의 같은 색이 나온다.
 */
export function deriveTheme(accent: string): SiteTheme {
  const [h, s, l] = toHsl(accent);
  return {
    accent,
    accentHover: mix(accent, 0, 0.88),
    accentText: mix(accent, 0, 0.87),
    accentPale: mix(accent, 255, 0.06),
    accentSoft: mix(accent, 255, 0.09),
    accentSoft2: mix(accent, 255, 0.15),
    gradFrom: mix(accent, 255, 0.94),
    gradTo: fromHsl(h + 10, s + 0.07, l + 0.07),
    syntaxField: fromHsl(h - 5, s * 0.67, l - 0.06),
  };
}

/**
 * primary 버튼과 그라데이션 로고는 --accent 위에 흰 글자를 얹는다. 대비가 4.5:1 아래로
 * 내려가면 글자가 묻히므로 관리자 화면이 경고를 띄운다 (색을 막지는 않는다).
 */
export function isTooLightForWhiteText(accent: string): boolean {
  return contrastOnWhiteText(accent) < 4.5;
}

// ------------------------------------------------------------------ 적용 · 캐시

/** 알 수 없는 항목·형식이 깨진 값은 기본값으로 되돌린다 */
export function normalizeTheme(raw: unknown): SiteTheme {
  const theme = { ...THEME_DEFAULT };
  if (!raw || typeof raw !== 'object') return theme;
  for (const key of THEME_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && HEX_RE.test(value)) theme[key] = value;
  }
  return theme;
}

/**
 * 기본값과 같은 항목은 변수를 지운다 — :root 값이 그대로 쓰이게 두면 나중에 기본
 * 팔레트를 바꿀 때 손댄 적 없는 항목이 따라온다.
 */
export function applyTheme(theme: SiteTheme): void {
  const root = document.documentElement.style;
  for (const key of THEME_KEYS) {
    if (theme[key] === THEME_DEFAULT[key]) root.removeProperty(CSS_VAR[key]);
    else root.setProperty(CSS_VAR[key], theme[key]);
  }
  // 반투명 파생용. rgb(var(--accent-rgb) / .22) 꼴로 쓴다
  if (theme.accent === THEME_DEFAULT.accent) root.removeProperty('--accent-rgb');
  else root.setProperty('--accent-rgb', toRgb(theme.accent).join(' '));
  // 파비콘은 캔버스로 그리므로 CSS 가 알아서 따라오지 않는다
  redrawIcon();
}

/** 새로고침 때 기본 보라가 번쩍이지 않게 지난번 색을 먼저 칠한다 */
export function applyCachedTheme(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) applyTheme(normalizeTheme(JSON.parse(raw)));
  } catch {
    // 시크릿 창 등에서 localStorage 가 막혀 있으면 기본 색으로 둔다
  }
}

export function cacheTheme(theme: SiteTheme): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(theme));
  } catch {
    // 저장 못 해도 화면은 이미 칠해져 있다
  }
}

/** 받아온 색을 화면에 칠하고 다음 부팅용으로 담아 둔다 */
export function adoptSiteTheme(raw: unknown): void {
  const theme = normalizeTheme(raw);
  applyTheme(theme);
  cacheTheme(theme);
}
