/**
 * 자동분류(USR-16) · 부재중(USR-19) · 수신거부(USR-20) · 포워딩(USR-21) 공용 타입.
 * 네 화면이 한 Sieve 스크립트로 저장되므로 모델은 네 화면이 공유한다.
 */
import { t, type MessageKey } from '../../../i18n';

export type Field =
  | 'SUBJECT'
  | 'SUBJECT_IS'
  | 'TO'
  | 'TO_DOMAIN'
  | 'FROM_NAME'
  | 'FROM'
  | 'FROM_DOMAIN'
  | 'HAS_ATTACH';

export interface Condition {
  field: Field;
  values: string[];
}

export type Action =
  | { type: 'FILEINTO'; mailboxName: string }
  | { type: 'SPAM'; mailboxName: string }
  | { type: 'DELETE' }
  | { type: 'FORWARD'; address: string; keepCopy: boolean };

export interface Rule {
  screen: 'FILTER' | 'REJECT' | 'FORWARD';
  order: number;
  enabled: boolean;
  name: string;
  conditions: Condition[];
  action: Action;
  startDate?: string | null;
  endDate?: string | null;
}

export interface Vacation {
  enabled: boolean;
  name: string;
  order: number;
  subject: string;
  /** 메일쓰기와 같은 에디터로 쓴 HTML. 회신 메일은 HTML + 평문 대안으로 나간다 */
  body: string;
  days: number;
  startDate: string | null;
  endDate: string | null;
}

export interface Model {
  filters: Rule[];
  rejects: Rule[];
  forwards: Rule[];
  vacation: Vacation | null;
  activatedAt: string | null;
}

/** 조건 선택 목록에 나오는 순서 */
export const FIELDS: Field[] = [
  'SUBJECT',
  'SUBJECT_IS',
  'TO',
  'TO_DOMAIN',
  'FROM_NAME',
  'FROM',
  'FROM_DOMAIN',
  'HAS_ATTACH',
];

/** 규칙 목록 필드명 → 화면 라벨 */
export function fieldLabel(field: Field): string {
  return t(`rules.field.${field}` as MessageKey);
}

/** 목록 행에 보여줄 조건 요약 (조건 없음 = 모든 메일) */
export function describeConditions(rule: Rule): string {
  if (rule.conditions.length === 0) return t('rules.allIncoming');
  return rule.conditions
    .map((cond) => {
      if (cond.field === 'HAS_ATTACH') return fieldLabel('HAS_ATTACH');
      const values = cond.values.filter(Boolean).join(', ');
      return `${fieldLabel(cond.field)} ${values || t('rules.noValue')}`;
    })
    .join(' · ');
}

/** 목록 행에 보여줄 처리 요약. 편지함은 표시 이름으로 바꿔 준다 */
export function describeAction(action: Action, mailboxes: { name: string; displayName: string }[]): string {
  const boxLabel = (name: string) => mailboxes.find((b) => b.name === name)?.displayName ?? name;
  switch (action.type) {
    case 'FILEINTO':
    case 'SPAM':
      return t('rules.fileInto', { box: boxLabel(action.mailboxName) });
    case 'DELETE':
      return t('rules.purge');
    case 'FORWARD':
      return (
        t('rules.forwardTo', { address: action.address || t('common.noAddress') }) +
        (action.keepCopy ? t('rules.keepCopySuffix') : '')
      );
  }
}

/** 목록 행에 보여줄 기간 요약 */
export function describePeriod(rule: Rule): string {
  if (!rule.startDate && !rule.endDate) return t('common.unlimited');
  return `${rule.startDate ?? ''} ~ ${rule.endDate ?? ''}`;
}
