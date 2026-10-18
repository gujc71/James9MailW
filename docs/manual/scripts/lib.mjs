// 매뉴얼 캡처 공용 도우미. MANUAL_LOCALE=ko|en 으로 화면 언어 · 샘플 데이터 · 저장 폴더가 바뀐다
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dict } from './i18n.mjs';
import { DATA } from './data.mjs';

export const BASE = process.env.MANUAL_WEB_URL ?? 'http://localhost:5173/';
export const PASSWORD = process.env.MANUAL_PASSWORD ?? 'TEST1234';
export const LOCALE = process.env.MANUAL_LOCALE === 'en' ? 'en' : 'ko';
export const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../${LOCALE}/images`);
fs.mkdirSync(OUT, { recursive: true });

/** 샘플 데이터 (data.mjs) */
export const D = DATA[LOCALE];

/** i18n 키 → 지금 언어의 화면 문구 */
export function t(key) {
  const value = dict[LOCALE][key];
  if (value === undefined) throw new Error(`i18n key not found: ${key}`);
  return value;
}

/** 화면 문구와 글자가 정확히 같은 것만 맞춘다 ('답장' 이 '전체답장' 에 걸리지 않게) */
export function exact(key) {
  const escaped = t(key).replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
  return new RegExp('^\\s*' + escaped + '\\s*$');
}

export async function open(user) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: LOCALE === 'en' ? 'en-US' : 'ko-KR',
    timezoneId: 'Asia/Seoul',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: LOCALE === 'en' ? 'English' : '한글' }).click();
  if (user) await login(page, user);
  return { browser, context, page };
}

export async function login(page, user) {
  await page.locator('input[autocomplete=username]').fill(`${user}@example.com`);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
}

export async function go(page, hash, wait = 1500) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(wait);
}

/** 사이드 메뉴의 기본 편지함. title 에 원래 폴더 이름(INBOX · Sent …)이 들어 있어 언어와 상관없다 */
export function mailbox(page, role) {
  return page.locator(`ul.tree button.mbox[title="${role}"]`).first();
}

/** 화면 위에 번호 표시(①②…)를 얹는다. targets: [locator, label, pos][] */
export async function mark(page, targets) {
  for (const [loc, label, pos = 'tl'] of targets) {
    const box = await loc.first().boundingBox().catch(() => null);
    if (!box) { console.warn('  mark miss:', label); continue; }
    await page.evaluate(({ box, label, pos }) => {
      const outline = document.createElement('div');
      outline.className = '__mk';
      Object.assign(outline.style, {
        position: 'fixed', left: Math.max(1, box.x - 3) + 'px', top: Math.max(1, box.y - 3) + 'px',
        width: box.width + 6 + 'px', height: box.height + 6 + 'px',
        border: '2px solid #e11d48', borderRadius: '6px', zIndex: 2147483646, pointerEvents: 'none',
      });
      const badge = document.createElement('div');
      badge.className = '__mk';
      badge.textContent = label;
      const bx = pos.includes('r') ? box.x + box.width - 4 : box.x - 14;
      const by = pos.includes('b') ? box.y + box.height - 4 : box.y - 14;
      Object.assign(badge.style, {
        position: 'fixed', left: Math.max(2, Math.min(innerWidth - 26, bx)) + 'px', top: Math.max(2, Math.min(innerHeight - 24, by)) + 'px', minWidth: '22px', height: '22px',
        padding: '0 4px', boxSizing: 'border-box',
        borderRadius: '11px', background: '#e11d48', color: '#fff', font: 'bold 13px/22px sans-serif',
        textAlign: 'center', zIndex: 2147483647, pointerEvents: 'none', boxShadow: '0 1px 3px rgba(0,0,0,.4)',
      });
      document.body.append(outline, badge);
    }, { box, label: String(label), pos });
  }
}

export async function unmark(page) {
  await page.evaluate(() => document.querySelectorAll('.__mk').forEach((n) => n.remove()));
}

/** 전체 화면 또는 locator 영역을 저장한다. 표시는 저장 후 지운다 */
export async function shot(page, name, { el, pad = 8, full = false } = {}) {
  const file = path.join(OUT, `${name}.png`);
  if (el) {
    const box = await el.first().boundingBox();
    if (!box) { console.warn('  shot miss:', name); await unmark(page); return; }
    const vp = page.viewportSize();
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    const clip = { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(vp.height - y, box.height + pad * 2) };
    await page.screenshot({ path: file, clip });
  } else {
    await page.screenshot({ path: file, fullPage: full });
  }
  console.log('  shot', name);
  await unmark(page);
}

/** 단계 하나가 실패해도 나머지 캡처는 계속한다 */
export async function step(name, fn) {
  try { await fn(); } catch (e) { console.warn(`! ${name}: ${e.message.split('\n')[0]}`); }
}

export async function closeModals(page) {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
}
