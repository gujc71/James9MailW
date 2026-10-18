// client/src/i18n.ts 의 ko · en 사전을 읽어, 키로 화면 문구를 찾는다.
// 캡처 스크립트가 화면 문구를 직접 적지 않고 키로 찾게 해서 한글 · 영어 화면을 같은 스크립트로 찍는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../client/src/i18n.ts');

function parse(block) {
  const map = {};
  for (const m of block.matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
    map[m[1]] = m[2].replace(/\\(.)/g, '$1');
  }
  return map;
}

const text = fs.readFileSync(SRC, 'utf8');
const koStart = text.indexOf('const ko = {');
const enStart = text.indexOf('const en: Record');
const enEnd = text.indexOf('const dict');
export const dict = { ko: parse(text.slice(koStart, enStart)), en: parse(text.slice(enStart, enEnd)) };
