/**
 * Sieve 스크립트 -> SieveModel 역파싱 (web.md 8.2).
 *
 * 웹이 생성하는 Sieve 는 generate.ts 의 부분집합으로 한정하므로 역파싱이 가능하다.
 * Sieve 문법으로 표현할 수 없는 화면 값(화면구분·정렬순서·사용여부·규칙명·기간)은
 * 규칙 앞 마커 주석 한 줄에서 읽는다.
 *
 * ManageSieve 로 사용자가 직접 편집하면 이 역파싱이 깨지므로 managesieveserver 는
 * 영구 비활성으로 둔다 (5-4).
 */
import {
  EMPTY_MODEL,
  VACATION_HTML_TAG,
  type ConditionField,
  type Rule,
  type RuleCondition,
  type SieveModel,
  type VacationRule,
} from './model.js';

/**
 * 마커 줄. 화면구분까지 함께 봐서 본문 글줄과 헷갈리지 않게 한다 — 중지 규칙은 블록 전체가
 * 주석이므로, 여러 줄인 부재중 본문에 "@rule ..." 로 시작하는 줄이 있으면 마커로 읽힐 수 있다.
 */
const MARKER_RE = /^#\s*@rule\s+((?:FILTER|VACATION|REJECT|FORWARD)\|.*)$/;

/** 주석 줄에 base64 로 실어 둔 부재중 본문 HTML. 중지 규칙은 앞의 # 가 떨어진 뒤에 온다 */
const VACATION_HTML_RE = new RegExp('^#?\\s*' + VACATION_HTML_TAG + '\\s+([A-Za-z0-9+/=]*)', 'm');

/** @vacation-html 주석이 없던 때(평문 본문)의 스크립트를 에디터가 읽을 HTML 로 올린다 */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

function unquote(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** "a" 또는 ["a", "b"] 를 배열로 */
function parseValueList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]!));
  }
  const single = /"((?:[^"\\]|\\.)*)"/.exec(trimmed);
  return single ? [unquote(single[1]!)] : [];
}

interface TestPattern {
  re: RegExp;
  field: ConditionField;
  /** 값 목록이 없는 테스트(HAS_ATTACH) */
  valueless?: boolean;
}

const TEST_PATTERNS: TestPattern[] = [
  { re: /^header\s+:contains\s+"Content-Type"\s+"multipart\/mixed"$/i, field: 'HAS_ATTACH', valueless: true },
  { re: /^header\s+:contains\s+"Subject"\s+(.+)$/i, field: 'SUBJECT' },
  { re: /^header\s+:is\s+"Subject"\s+(.+)$/i, field: 'SUBJECT_IS' },
  { re: /^header\s+:contains\s+"From"\s+(.+)$/i, field: 'FROM_NAME' },
  { re: /^address\s+:is\s+:all\s+"From"\s+(.+)$/i, field: 'FROM' },
  { re: /^address\s+:is\s+:domain\s+"From"\s+(.+)$/i, field: 'FROM_DOMAIN' },
  { re: /^address\s+:is\s+:all\s+"To"\s+(.+)$/i, field: 'TO' },
  { re: /^address\s+:is\s+:domain\s+"To"\s+(.+)$/i, field: 'TO_DOMAIN' },
];

function parseTest(raw: string): RuleCondition | null {
  const test = raw.trim().replace(/,$/, '');
  for (const pattern of TEST_PATTERNS) {
    const match = pattern.re.exec(test);
    if (!match) continue;
    if (pattern.valueless) return { field: pattern.field, values: [] };
    return { field: pattern.field, values: parseValueList(match[1]!) };
  }
  return null;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      current += char;
      if (char === '\\') {
        current += input[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
    } else if (char === '(' || char === '[') {
      depth += 1;
      current += char;
    } else if (char === ')' || char === ']') {
      depth -= 1;
      current += char;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseConditions(testExpression: string): RuleCondition[] {
  const expression = testExpression.trim();
  if (expression === 'true') return [];
  const allof = /^allof\s*\(([\s\S]*)\)$/i.exec(expression);
  const tests = allof ? splitTopLevel(allof[1]!) : [expression];
  return tests.map(parseTest).filter((c): c is RuleCondition => Boolean(c));
}

/**
 * 스팸 편지함 이름 (repositories/mailboxes.ts SYSTEM_MAILBOXES). 기본 편지함이라 이름이
 * 바뀌지 않는다 — 수신거부 규칙의 "스팸함에 저장" 을 되살리는 열쇠로 쓸 수 있다.
 */
const SPAM_MAILBOX = 'Spam';

/**
 * 규칙 블록의 처리(action)를 읽는다.
 *
 * `SPAM` 과 `FILEINTO` 는 Sieve 로는 똑같이 `fileinto` 라 스크립트만 봐서는 구분되지 않는다.
 * 그대로 두면 수신거부 화면에서 "스팸함에 저장" 으로 만든 규칙을 다시 열었을 때 처리 선택이
 * "휴지통으로 이동" 으로 잡힌다 (RuleEditor 의 rejectAction 은 SPAM 이 아니면 TRASH 로 본다).
 * 구분이 실제로 있는 수신거부 화면에 한해, 대상이 스팸 편지함이면 SPAM 으로 되돌린다.
 */
function parseAction(body: string, screen: string): Rule['action'] | null {
  const fileinto = /fileinto\s+"((?:[^"\\]|\\.)*)"/.exec(body);
  if (fileinto) {
    const mailboxName = unquote(fileinto[1]!);
    if (screen === 'REJECT' && mailboxName === SPAM_MAILBOX) return { type: 'SPAM', mailboxName };
    return { type: 'FILEINTO', mailboxName };
  }
  const redirect = /redirect\s+"((?:[^"\\]|\\.)*)"/.exec(body);
  if (redirect) {
    return {
      type: 'FORWARD',
      address: unquote(redirect[1]!),
      keepCopy: /(^|\s)keep\s*;/.test(body),
    };
  }
  if (/(^|\s)discard\s*;/.test(body)) return { type: 'DELETE' };
  return null;
}

/** 주석 처리된 중지 규칙은 각 줄의 "# " 을 떼고 읽는다 */
function stripComment(line: string): string {
  return line.replace(/^#\s?/, '');
}

export function parseSieve(script: string): SieveModel {
  if (!script?.trim()) return { ...EMPTY_MODEL, filters: [], rejects: [], forwards: [] };

  const model: SieveModel = { filters: [], rejects: [], forwards: [], vacation: null };
  const lines = script.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const markerMatch = MARKER_RE.exec(lines[i]!.trim());
    if (!markerMatch) continue;

    const fields = markerMatch[1]!.split('|');
    const screen = (fields[0] ?? '').trim();
    const order = Number.parseInt(fields[1] ?? '0', 10) || 0;
    const enabled = (fields[2] ?? 'Y').trim().toUpperCase() === 'Y';
    const name = (fields[3] ?? '').trim();
    const startDate = (fields[4] ?? '').trim() || null;
    const endDate = (fields[5] ?? '').trim() || null;

    // 마커 다음 줄부터 다음 마커 전까지가 규칙 블록이다
    const block: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (MARKER_RE.test(line.trim())) break;
      block.push(enabled ? line : stripComment(line));
    }
    i = j - 1;
    const body = block.join('\n');

    if (screen === 'VACATION') {
      // 회신 본문은 :mime 덩어리(HTML 회신)일 수도, 옛 스크립트의 평문 인자일 수도 있어
      // 문장에서는 일수와 제목까지만 읽는다
      const vacationMatch = /vacation\s+:days\s+(\d+)\s+:subject\s+"((?:[^"\\]|\\.)*)"/.exec(body);
      const htmlMatch = VACATION_HTML_RE.exec(body);
      // @vacation-html 주석이 없던 때의 스크립트: 제목 다음에 오는 평문이 본문이었다
      const legacyReason = /:subject\s+"(?:[^"\\]|\\.)*"\s+"((?:[^"\\]|\\.)*)"/.exec(body);
      const vacation: VacationRule = {
        enabled,
        name,
        order,
        subject: vacationMatch ? unquote(vacationMatch[2]!) : '부재중 자동 회신',
        // 본문은 에디터가 만든 HTML 이다. 문장에 실린 MIME 덩어리는 base64 사본이라
        // 주석 줄의 원본을 본다 (model.ts 의 VACATION_HTML_TAG)
        body: htmlMatch
          ? Buffer.from(htmlMatch[1]!, 'base64').toString('utf8')
          : textToHtml(legacyReason ? unquote(legacyReason[1]!) : ''),
        days: vacationMatch ? Number.parseInt(vacationMatch[1]!, 10) : 3,
        startDate,
        endDate,
      };
      model.vacation = vacation;
      continue;
    }

    const ifMatch = /if\s+([\s\S]*?)\s*\{([\s\S]*?)\}/.exec(body);
    if (!ifMatch) continue;
    const action = parseAction(ifMatch[2]!, screen);
    if (!action) continue;

    const rule: Rule = {
      screen: screen === 'REJECT' ? 'REJECT' : screen === 'FORWARD' ? 'FORWARD' : 'FILTER',
      order,
      enabled,
      name,
      conditions: parseConditions(ifMatch[1]!),
      action,
      startDate,
      endDate,
    };

    if (rule.screen === 'REJECT') model.rejects.push(rule);
    else if (rule.screen === 'FORWARD') model.forwards.push(rule);
    else model.filters.push(rule);
  }

  return model;
}
