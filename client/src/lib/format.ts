import { format, isToday, isThisYear } from 'date-fns';

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 목록 날짜: 오늘이면 시각, 올해면 월/일, 아니면 연/월/일 */
export function formatListDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (isToday(date)) return format(date, 'HH:mm');
  if (isThisYear(date)) return format(date, 'MM-dd');
  return format(date, 'yyyy-MM-dd');
}

export function formatFullDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : format(date, 'yyyy-MM-dd HH:mm');
}

/** "홍길동 <hong@x>" 또는 표시이름이 없으면 주소만 */
export function displayAddress(name: string | null, address: string | null): string {
  if (name && address) return `${name} <${address}>`;
  return address ?? name ?? '';
}

/** 이름이 있으면 이름만, 없으면 주소. 주소는 title 힌트로 따로 보여 준다 (ADM-5) */
export function displayNameOnly(name: string | null, address: string | null): string {
  return name?.trim() || address || '';
}
