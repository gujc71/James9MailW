/** mysql2 가 돌려주는 값을 다루는 잡기술 */

/** BIT(1) 은 Buffer<[0|1]> 로 온다 */
export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  return false;
}

/** DATETIME 을 ISO 문자열로. 컬럼이 비어 있으면 null */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return new Date(value.replace(' ', 'T')).toISOString();
  return null;
}

/** MAIL_IS_* 여섯 컬럼을 IMAP 플래그 배열로 */
export function toFlags(row: {
  MAIL_IS_SEEN: unknown;
  MAIL_IS_ANSWERED: unknown;
  MAIL_IS_FLAGGED: unknown;
  MAIL_IS_DRAFT: unknown;
  MAIL_IS_DELETED: unknown;
  MAIL_IS_RECENT: unknown;
}): string[] {
  const flags: string[] = [];
  if (toBool(row.MAIL_IS_SEEN)) flags.push('\\Seen');
  if (toBool(row.MAIL_IS_ANSWERED)) flags.push('\\Answered');
  if (toBool(row.MAIL_IS_FLAGGED)) flags.push('\\Flagged');
  if (toBool(row.MAIL_IS_DRAFT)) flags.push('\\Draft');
  if (toBool(row.MAIL_IS_DELETED)) flags.push('\\Deleted');
  if (toBool(row.MAIL_IS_RECENT)) flags.push('\\Recent');
  return flags;
}

/** LIKE 패턴 특수문자(역슬래시 % _)를 글자 그대로 찾도록 막는다 */
export function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => '\\' + ch);
}
