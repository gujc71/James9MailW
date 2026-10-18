/**
 * 화면 네 개(자동분류 USR-16 · 부재중 USR-19 · 수신거부 USR-20 · 포워딩 USR-21)의
 * 규칙 모델. 사용자당 활성 스크립트 한 개에 모아 생성한다 (web.md 8.1).
 *
 * webmail-issues.md 에 따라 반영한 결정:
 *  - 5-2: 자동분류 액션에서 REPLY(vacation) 를 뺀다. vacation 은 스크립트에 한 번만
 *    쓸 수 있어 부재중과 같이 있으면 실행 오류로 배달이 실패한다.
 *  - 5-3: DELIVERED_TO(envelope "to") 조건을 뺀다. James 의 SieveMailAdapter 는
 *    봉투 수신자 중 첫 번째 하나만 돌려주므로 다중 수신 메일에서 틀린 값과 비교된다.
 *  - 5-6: 수신거부 액션은 discard 로 고정한다. reject 는 스팸에 backscatter 를 만든다.
 *  - 5-8: 포워딩은 JAMES_RECIPIENT_REWRITE 가 아니라 Sieve redirect(+keep) 하나로 통일한다.
 *    사본 보관(keep)이 실제로 남으려면 James 쪽이 gu.mailet.Sieve 여야 한다 (generate.ts 참고).
 *    RRT 는 Sieve 보다 먼저 실행돼 자동분류·부재중이 로컬에서 돌지 않게 만든다.
 *  - 5-9: HAS_ATTACH 는 근사값이라 "정확하지 않음" 안내와 함께만 제공한다.
 */

export type ScreenKind = 'FILTER' | 'VACATION' | 'REJECT' | 'FORWARD';

/** POPUP-2 의 조건 항목 */
export type ConditionField =
  | 'SUBJECT' // 메일 제목에 (contains)
  | 'SUBJECT_IS' // 메일 제목이 (is)
  | 'TO' // 수신 주소가
  | 'TO_DOMAIN' // 수신 도메인이
  | 'FROM_NAME' // 발송자 이름에 (근사: header contains From)
  | 'FROM' // 발송 주소가
  | 'FROM_DOMAIN' // 발송 도메인이
  | 'HAS_ATTACH'; // 첨부파일이 있는 메일 (근사)

export interface RuleCondition {
  field: ConditionField;
  /** 콤마로 나눈 값들. 한 행 안에서는 OR, 행끼리는 AND */
  values: string[];
}

export type RuleAction =
  | { type: 'FILEINTO'; mailboxName: string }
  | { type: 'DELETE' } // discard
  | { type: 'FORWARD'; address: string; keepCopy: boolean }
  | { type: 'SPAM'; mailboxName: string };

export interface Rule {
  screen: ScreenKind;
  order: number;
  enabled: boolean;
  /** 규칙명. 마커에 들어가므로 | 와 개행을 막는다 (5-4) */
  name: string;
  conditions: RuleCondition[];
  action: RuleAction;
  /** 포워딩·부재중 기간 */
  startDate?: string | null;
  endDate?: string | null;
}

export interface VacationRule {
  enabled: boolean;
  name: string;
  order: number;
  subject: string;
  /** 메일쓰기와 같은 에디터가 만든 HTML. 회신은 HTML + 평문 대안 (VACATION_HTML_TAG 참고) */
  body: string;
  days: number;
  startDate: string | null;
  endDate: string | null;
}

export interface SieveModel {
  filters: Rule[];
  rejects: Rule[];
  forwards: Rule[];
  vacation: VacationRule | null;
}

export const EMPTY_MODEL: SieveModel = { filters: [], rejects: [], forwards: [], vacation: null };

/**
 * 부재중 본문 HTML 을 실어 두는 주석 줄의 태그.
 *
 * 본문은 메일쓰기와 같은 에디터가 만든 HTML 이고, 회신은 RFC 5230 의 :mime 으로
 * HTML + 평문 대안(multipart/alternative)을 함께 보낸다. 다만 그 MIME 덩어리는 base64 로
 * 굳은 사본이라 되읽기에 쓰기 나쁘다. 화면이 다시 편집할 HTML 원본은 마커 옆 주석 한 줄에
 * base64 로 남긴다 (따옴표·개행이 없어 스크립트를 망치지 않는다).
 *
 * :mime 은 james9Mail 의 VacationReply 포크를 전제로 한다 — 업스트림 3.9.0 은 MimeMultipart
 * 에 Content-Type 을 "mixed" 로 넘겨 회신 자체가 깨지고, From 헤더도 넣지 않는다
 * (james9-app/src/main/java/org/apache/james/transport/mailets/jsieve/VacationReply.java).
 */
export const VACATION_HTML_TAG = '@vacation-html';

/** 규칙명에 마커 구분자나 개행이 들어가면 역파싱이 깨진다 (5-4) */
export function sanitizeRuleName(name: string): string {
  return name.replace(/[|\r\n]/g, ' ').trim().slice(0, 80) || '이름 없음';
}

