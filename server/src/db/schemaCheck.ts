/**
 * DB 스키마가 코드보다 뒤처졌을 때(server/sql 의 새 스크립트를 아직 안 돌렸을 때) 알아보기.
 *  - 요청 중: 없는 컬럼 · 표 오류를 "어느 SQL 을 돌리라" 는 안내로 바꾼다 (app.ts 오류 처리기)
 *  - 기동 시: 빠진 것을 로그에 한 번 남긴다 (checkSchema)
 */
import { sql } from 'kysely';
import { db } from './kysely.js';

/** 컬럼 · 표 이름 → 그것을 만드는 스크립트. 오류 문구에 이름이 들어 있으면 그 파일을 알려 준다 */
const SOURCES: [RegExp, string][] = [
  [/GU_ADDRESS_EMAIL|CONTACT_UID|CONTACT_KIND|VCARD_DATA|ORG_NAME|\bPHONE\b|CARDDAV_USE_YN/i, 'server/sql/05-carddav.sql'],
  [/CALDAV_USE_YN|EXTRA_PROPS/i, 'server/sql/04-caldav.sql'],
  // CAL_ITEM · GU_ADDRESS_BOOK 둘 다 DAV_NAME 을 04 · 05 에서 붙인다
  [/\bDAV_NAME\b/i, 'server/sql/04-caldav.sql, server/sql/05-carddav.sql'],
  [/\bCAL_/i, 'server/sql/03-calendar-tables.sql'],
  [/GU_RECENT_RECIPIENT/i, 'server/sql/01-gu-tables.sql'],
];

const SCHEMA_CODES = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE']);

/** 스키마가 뒤처져 난 오류면 돌려야 할 스크립트(모르면 'server/sql'), 아니면 null */
export function schemaHint(error: unknown): string | null {
  const e = error as { code?: string; sqlMessage?: string; message?: string };
  if (!e || !SCHEMA_CODES.has(e.code ?? '')) return null;
  const text = e.sqlMessage ?? e.message ?? '';
  return SOURCES.find(([re]) => re.test(text))?.[1] ?? 'server/sql';
}

/** 꼭 있어야 하는 컬럼 · 표. [표, 컬럼(없으면 표만 본다), 스크립트] */
const REQUIRED: [string, string | null, string][] = [
  ['GU_USER_SETTING', 'CALDAV_USE_YN', 'server/sql/04-caldav.sql'],
  ['GU_USER_SETTING', 'CARDDAV_USE_YN', 'server/sql/05-carddav.sql'],
  ['GU_ADDRESS_BOOK', 'CONTACT_UID', 'server/sql/05-carddav.sql'],
  ['GU_ADDRESS_EMAIL', null, 'server/sql/05-carddav.sql'],
];

/** 빠진 스크립트 목록 (중복 없이). DB 에 못 붙으면 빈 목록 — 그 오류는 다른 곳이 알린다 */
export async function checkSchema(): Promise<string[]> {
  const missing = new Set<string>();
  try {
    const rows = await sql<{ TABLE_NAME: string; COLUMN_NAME: string }>`
      SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('GU_USER_SETTING', 'GU_ADDRESS_BOOK', 'GU_ADDRESS_EMAIL')`.execute(db);
    const have = new Set(rows.rows.map((r) => `${r.TABLE_NAME.toUpperCase()}.${r.COLUMN_NAME.toUpperCase()}`));
    const tables = new Set(rows.rows.map((r) => r.TABLE_NAME.toUpperCase()));
    for (const [table, column, script] of REQUIRED) {
      const ok = column ? have.has(`${table}.${column}`) : tables.has(table);
      if (!ok) missing.add(script);
    }
  } catch {
    return [];
  }
  return [...missing].sort();
}
