/**
 * SieveModel -> Sieve 스크립트 문자열 (web.md 8.2 의 마커 주석 방식).
 *
 * 마커 필드: 화면구분 | 정렬순서 | 사용여부 | 규칙명 [| 시작일 | 종료일]
 * 사용 중지(N) 규칙은 지우지 않고 블록 전체를 # 로 주석 처리해 보존한다.
 *
 * 기간은 마커에 적어 두는 메모가 아니라 currentdate 테스트로 스크립트 안에 들어간다. 그래서
 * 기간이 지난 규칙은 James 가 메일을 받는 그 순간부터 건너뛴다 — 웹이 스크립트를 다시 만들어
 * 줄 필요가 없다. currentdate 는 jSieve 에 없는 확장이라 이 스크립트는 james9-app 의
 * gu.jsieve.CurrentDate 와 함께 배포되어야 한다 (require 가 풀리지 않으면 규칙 전체가 죽는다).
 */
import { htmlToText } from '../mime/sanitize.js';
import {
  sanitizeRuleName,
  VACATION_HTML_TAG,
  type Rule,
  type RuleCondition,
  type SieveModel,
} from './model.js';

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 부재중 본문 HTML 원본을 실어 두는 주석 한 줄 (model.ts 의 VACATION_HTML_TAG 설명 참고) */
function vacationHtmlComment(html: string): string {
  return `# ${VACATION_HTML_TAG} ${Buffer.from(html, 'utf8').toString('base64')}`;
}

/** MIME 파트 경계. tspecials 가 없는 토큰이라 따옴표를 붙일 필요가 없다 */
const MIME_BOUNDARY = 'vacation9mailpart';

/** base64 를 RFC 2045 의 줄 길이(76자)로 끊는다 */
function base64Lines(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return (encoded.match(/.{1,76}/g) ?? ['']).join('\n');
}

/**
 * vacation :mime 으로 실어 보낼 회신 본문 (RFC 5230).
 *
 * HTML 과 함께 평문 대안을 담은 multipart/alternative 다. 본문 파트는 base64 로 굳혀서
 * 따옴표·역슬래시·8비트 문자가 Sieve 문자열과 SMTP 어디에도 걸리지 않게 한다.
 */
function vacationMimeEntity(html: string, text: string): string {
  const part = (type: string, content: string) =>
    [
      `--${MIME_BOUNDARY}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(content),
    ].join('\n');
  return [
    `Content-Type: multipart/alternative; boundary=${MIME_BOUNDARY}`,
    '',
    part('text/plain', text),
    part('text/html', html),
    `--${MIME_BOUNDARY}--`,
    '',
  ].join('\n');
}

function valueList(values: string[]): string {
  const cleaned = values.map((v) => v.trim()).filter(Boolean);
  if (cleaned.length === 1) return quote(cleaned[0]!);
  return `[${cleaned.map(quote).join(', ')}]`;
}

/** 한 조건 행 -> 하나의 Sieve 테스트. 행 안의 여러 값은 OR 로 묶인다 */
function conditionToTest(condition: RuleCondition): string | null {
  const values = condition.values.map((v) => v.trim()).filter(Boolean);
  switch (condition.field) {
    case 'SUBJECT':
      return values.length ? `header :contains "Subject" ${valueList(values)}` : null;
    case 'SUBJECT_IS':
      return values.length ? `header :is "Subject" ${valueList(values)}` : null;
    case 'FROM':
      return values.length ? `address :is :all "From" ${valueList(values)}` : null;
    case 'FROM_DOMAIN':
      return values.length ? `address :is :domain "From" ${valueList(values)}` : null;
    case 'FROM_NAME':
      // jSieve 에 variables/regex 가 없어 정확히 표현할 수 없다. 근사값이다 (5-9)
      return values.length ? `header :contains "From" ${valueList(values)}` : null;
    case 'TO':
      return values.length ? `address :is :all "To" ${valueList(values)}` : null;
    case 'TO_DOMAIN':
      return values.length ? `address :is :domain "To" ${valueList(values)}` : null;
    case 'HAS_ATTACH':
      // 서명 메일·인라인 전용 메일을 오탐한다. 화면에 "정확하지 않음" 을 안내한다 (5-9)
      return `header :contains "Content-Type" "multipart/mixed"`;
    default:
      return null;
  }
}

function conditionsToTest(conditions: RuleCondition[]): string[] {
  return conditions.map(conditionToTest).filter((t): t is string => Boolean(t));
}

/**
 * 기간을 Sieve 테스트로 (RFC 5260 currentdate + RFC 5231 relational).
 *
 * 날짜 경계는 James 가 도는 서버의 시간대로 판정한다 — :zone 을 적지 않으면 RFC 5260 이
 * 그렇게 정하고, 그래야 사용자가 고른 날짜가 사용자의 달력 그대로가 된다.
 * currentdate 는 jSieve 에 없어 james9-app 의 gu.jsieve.CurrentDate 가 채운다.
 */
function periodTests(period: { startDate?: string | null; endDate?: string | null }): string[] {
  const tests: string[] = [];
  if (period.startDate) tests.push(`currentdate :value "ge" "date" ${quote(period.startDate)}`);
  if (period.endDate) tests.push(`currentdate :value "le" "date" ${quote(period.endDate)}`);
  return tests;
}

/** 기간 테스트를 쓰는 스크립트가 require 에 적어야 하는 확장 이름 */
const PERIOD_REQUIRES = ['date', 'relational'];

/** 테스트 여러 개를 if 한 줄로. 하나도 없으면 무조건 참이다 */
function toTest(tests: string[]): string {
  if (tests.length === 0) return 'true';
  if (tests.length === 1) return tests[0]!;
  return `allof (${tests.join(',\n          ')})`;
}

function actionToStatements(rule: Rule): string[] {
  switch (rule.action.type) {
    case 'FILEINTO':
    case 'SPAM':
      // fileinto 대상은 MAILBOX_ID 가 아니라 편지함 이름이다 (INBOX.하위폴더, 구분자 .)
      return [`fileinto ${quote(rule.action.mailboxName)};`, 'stop;'];
    case 'DELETE':
      // 수신거부는 discard 로 고정한다. reject 는 backscatter 를 만든다 (5-6)
      return ['discard;', 'stop;'];
    case 'FORWARD': {
      const statements = [`redirect ${quote(rule.action.address)};`];
      // RRT 포워딩과 달리 Sieve redirect 는 keep 을 붙여야 로컬 사본이 남는다 (5-8).
      // 이 keep 이 실제로 배달되는지는 James 쪽에 달려 있다 — 기본 Sieve 메일릿의
      // redirect 는 사본을 보낸 뒤 그 수신자를 메일에서 빼고, 로컬 배달은 수신자 목록을
      // 보고 돌기 때문에 keep 이 지정한 편지함을 아무도 읽지 않는다. james9Mail 의
      // gu.mailet.Sieve 가 편지함을 지정받은 수신자를 되돌려 놓는다 (mailetcontainer.xml).
      if (rule.action.keepCopy) statements.push('keep;');
      statements.push('stop;');
      return statements;
    }
    default:
      return ['stop;'];
  }
}

function marker(rule: Rule): string {
  const base = [
    rule.screen,
    String(rule.order),
    rule.enabled ? 'Y' : 'N',
    sanitizeRuleName(rule.name),
  ];
  if (rule.startDate || rule.endDate) base.push(rule.startDate ?? '', rule.endDate ?? '');
  return `# @rule ${base.join('|')}`;
}

function renderRule(rule: Rule): string {
  const body = [
    `if ${toTest([...conditionsToTest(rule.conditions), ...periodTests(rule)])} {`,
    ...actionToStatements(rule).map((s) => `  ${s}`),
    '}',
  ].join('\n');

  if (!rule.enabled) {
    // 중지 규칙은 블록 전체를 주석으로 보존한다 (web.md 8.2)
    return [marker(rule), ...body.split('\n').map((line) => `# ${line}`)].join('\n');
  }
  return [marker(rule), body].join('\n');
}

export interface GenerateOptions {
  /** 스크립트 주인의 메일 주소. 자기 자신이 보낸 메일에는 부재중 회신을 하지 않는다 */
  ownerAddress?: string | null;
}

/**
 * 스크립트 전체를 다시 만든다.
 */
export function generateSieve(model: SieveModel, options: GenerateOptions = {}): string {
  const { ownerAddress = null } = options;
  const lines: string[] = [];
  const requires = new Set<string>();

  const activeRules = [...model.rejects, ...model.filters, ...model.forwards].sort(
    (a, b) => a.order - b.order,
  );

  for (const rule of activeRules) {
    if (rule.action.type === 'FILEINTO' || rule.action.type === 'SPAM') requires.add('fileinto');
    // 중지 규칙은 블록 전체가 주석이라 그 테스트는 스크립트에 살아 있지 않다
    if (rule.enabled && periodTests(rule).length > 0) {
      for (const name of PERIOD_REQUIRES) requires.add(name);
    }
  }

  const vacation = model.vacation;
  const vacationActive = Boolean(vacation?.enabled);
  if (vacationActive) requires.add('vacation');
  if (vacationActive && vacation && periodTests(vacation).length > 0) {
    for (const name of PERIOD_REQUIRES) requires.add(name);
  }

  if (requires.size > 0) {
    lines.push(`require [${[...requires].sort().map((r) => `"${r}"`).join(', ')}];`, '');
  }

  // 수신거부 -> 자동분류 -> 포워딩 순. 앞선 규칙이 stop 하면 뒤는 실행되지 않는다.
  for (const rule of activeRules) {
    lines.push(renderRule(rule), '');
  }

  if (vacation) {
    const markerLine =
      `# @rule VACATION|${vacation.order}|${vacation.enabled ? 'Y' : 'N'}|` +
      `${sanitizeRuleName(vacation.name)}|${vacation.startDate ?? ''}|${vacation.endDate ?? ''}`;
    lines.push(markerLine);
    // 에디터가 만든 HTML 원본은 주석 줄에 남긴다. 회신에 실어 보내는 MIME 덩어리는
    // base64 로 굳은 사본이라 되읽기에 쓰지 않는다
    if (vacation.body.trim()) lines.push(vacationHtmlComment(vacation.body));
    const reason = htmlToText(vacation.body);
    // 본문이 있으면 HTML 로 회신한다 (:mime). 빈 본문은 실어 보낼 것이 없으니 평문 인자로 둔다
    const replyArgument = vacation.body.trim()
      ? `:mime ${quote(vacationMimeEntity(vacation.body, reason))}`
      : quote(reason);
    const statement =
      `vacation :days ${vacation.days} :subject ${quote(vacation.subject)} ${replyArgument};`;
    const self = (ownerAddress ?? '').trim();
    const guards = [
      // 자기 자신이 보낸 메일(내게쓰기 등)에는 회신하지 않는다. vacation 의 기본 억제 규칙은
      // 발신자가 본인인 경우를 걸러 주지 않으므로 From 이 본인이면 아예 실행하지 않는다.
      ...(self ? [`not address :is :all "From" ${quote(self)}`] : []),
      // 부재중 기간도 규칙과 같은 자리에서 판정한다
      ...periodTests(vacation),
    ];
    const block =
      guards.length > 0 ? [`if ${toTest(guards)} {`, `  ${statement}`, '}'] : [statement];
    // MIME 덩어리(와 평문)에는 줄바꿈이 들어 있다. 주석 처리는 줄 단위라 물리적 줄로 펴 놓는다
    const scriptLines = block.flatMap((line) => line.split('\n'));
    // 사용을 끈 부재중은 지우지 않고 주석으로 보존한다. 기간은 위의 currentdate 가 본다
    lines.push(...(vacationActive ? scriptLines : scriptLines.map((line) => `# ${line}`)), '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * SCRIPT_CONTENT 용량 확인용 (5-1).
 * JPASieveScript.SCRIPT_CONTENT 는 @Lob 으로 MEDIUMTEXT 이고, 한계는 글자 수가 아니라
 * 16,777,215 바이트다. 규칙명이 한글이면 한 글자가 3바이트라 바이트로 재야 한다.
 */
export const SCRIPT_BYTE_LIMIT = 16_777_215;
