/**
 * 색 계산. DOM 을 건드리지 않는 순수 함수만 둔다 — 화면에 얹는 일은 lib/theme.ts 가 맡는다.
 * hex 는 늘 '#rrggbb' 소문자 7자리로 주고받는다.
 */

export type Rgb = [number, number, number];

export function toRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

/** keep 만큼 기준색을 남기고 나머지를 target 으로 채운다 (진하게=0, 연하게=255) */
export function mix(hex: string, target: 0 | 255, keep: number): string {
  const [r, g, b] = toRgb(hex);
  const rest = 1 - keep;
  return toHex([r * keep + target * rest, g * keep + target * rest, b * keep + target * rest]);
}

/** h 는 0~360, s·l 은 0~1 */
export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/**
 * 흰 글자를 얹었을 때 읽히는 색인지 본다 (WCAG 상대휘도 기준 대비 4.5:1).
 * 관리자가 노란색처럼 밝은 색을 기준색으로 고르면 primary 버튼의 흰 글자가 사라진다.
 */
export function contrastOnWhiteText(hex: string): number {
  const lum = toRgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Rgb;
  const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return 1.05 / (l + 0.05);
}
