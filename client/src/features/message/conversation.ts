/**
 * 원문 하나에서 **주고받은 메일들**을 뽑아낸다 (feature-gap 2-2 — 대화 보기).
 *
 * 목록의 통수 배지를 누르면 쓰는 길이다. 답장은 원문을 인용해 쌓이므로, 마지막 한 통의
 * 본문 안에 그 대화가 통째로 들어 있다 — 그걸 단계별로 갈라 발송자 · 시간 · 본문으로 되돌린다.
 *
 * **HTML 파트를 본다.** 인용 단계는 `<blockquote>` 중첩에만 남아 있고, text/plain 파트는
 * 우리 에디터가 `>` 인용 부호도 들여쓰기도 남기지 않아 본문 · 인용 · 서명이 평평한 한
 * 덩어리가 된다. HTML 이 없는 메일만 평문 쪽으로 내려가 머리말 줄로 가른다.
 *
 * **서명은 떼어 내 버린다.** 오간 말을 훑는 자리에서 "홍길동 드림 · 02-000-0000" 이 통마다
 * 되풀이되면 정작 한 줄짜리 본문이 묻힌다. 서명인 줄 아는 길은 둘이다 — 우리가 보낸 메일은
 * `div.j9-signature`, 그 밖의 메일은 `<hr>` 아래. 둘 다 아닌 서명(그냥 줄바꿈 뒤에 쓴 이름)은
 * 가려낼 수 없어 본문에 남는다. 글자만 보고 "이건 서명이다" 를 찍는 것은 본문을 잘라먹는다.
 *
 * 발송자 · 시간의 출처가 단계마다 다르다는 점이 이 기능의 한계다. 0단계(이 메일 자신)는
 * From · Date 헤더라 시간대까지 정확하지만, 인용된 단계는 보낸 사람의 메일 앱이 적어 둔
 * 머리말 문자열이 전부다 — 시간대도 초도 없다. 화면이 그 둘을 구분해 보여 줄 수 있도록
 * `exact` 로 표시해 둔다. 쓸 수 있는 원본이 서버에 있으면(같은 대화의 다른 메일) 그쪽이
 * 늘 정확하다.
 */
import DOMPurify from 'dompurify';
import type { ParsedMail } from '../../mime/parser';
import { formatFullDate } from '../../lib/format';

export interface ConversationEntry {
  /** 인용 깊이. 0 이 이 메일 자신이고, 클수록 오래된 메일이다 */
  depth: number;
  /** 표시이름. 머리말에 이름 없이 주소만 적혀 있으면 null */
  name: string | null;
  /**
   * 보낸 주소. 화면이 이것으로 **내가 보낸 메일인지** 가리고(계정 · 알리아스와 맞춰 본다)
   * 같은 대화의 다른 메일에서 **프로필 사진**을 찾는다. 머리말을 못 읽은 단계는 null
   */
  address: string | null;
  /** 0단계는 Date 헤더, 그 아래는 인용 머리말에 적힌 표기 그대로 */
  date: string | null;
  /** 발송자 · 시간을 헤더에서 읽었는가. 거짓이면 인용문에서 긁은 값이다 */
  exact: boolean;
  /** 본문. 인용 머리말과 서명은 빠져 있다 */
  body: string;
  /** 서명 구분선(`<hr>`) 아래에 있던 줄들 */
  signature: string | null;
}

/**
 * 인용 머리말 한 줄 — 답장을 쓴 메일 앱이 "누가 언제 보낸 글을 인용한다" 고 적어 둔 줄이다.
 *
 * 우리 앱이 붙이는 머리말(`quote.replyHead`)은 ko · en 둘 다 이 꼴이고
 *   `2026-10-02 21:22, 테스트 <user1@example.com> 님이 작성:`
 *   `On 2026-10-02 21:23, 관리자 <admin@example.com> wrote:`
 * 지메일 · 썬더버드는 쉼표 없이 날짜와 이름을 잇는다
 *   `On Fri, Oct 2, 2026 at 9:23 PM 이름 <주소> wrote:`
 *
 * 그래서 식 하나로 가르지 않는다. 주소를 먼저 떼고, 남은 앞부분에서 **마지막 시각**
 * (`9:23`·`21:22`)을 찾아 거기까지를 날짜로 본다 — 쉼표로 가르면 `Fri, Oct 2` 만
 * 날짜가 되고 연도와 시각이 이름 쪽으로 넘어간다.
 *
 * 아웃룩의 `From:/Sent:` 블록처럼 이 꼴을 벗어나는 머리말은 못 읽는다. 그 단계는 발송자 ·
 * 시간이 null 로 남고 본문만 보여 준다 — 틀린 이름을 적어 두는 것보다 낫다.
 */
const INTRO_TAIL = /\s*(?:wrote:|님이\s*작성:|작성:)\s*$/;
const ADDRESS = /<([^<>\s]+@[^<>\s]+)>/;
/** 시각. 한국어 메일 앱이 앞에 붙이는 오전 · 오후와 영문 AM · PM 까지 한 덩이로 본다 */
const TIME = /\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|am|pm))?/g;

interface Intro {
  name: string | null;
  address: string;
  date: string | null;
}

function matchIntro(line: string): Intro | null {
  if (!INTRO_TAIL.test(line)) return null;
  // 영문 머리말의 `On` 은 날짜가 아니라 문장 조각이다. 날짜 자리에 그대로 남기지 않는다
  const head = line.replace(INTRO_TAIL, '').replace(/^On\s+/, '');
  const address = ADDRESS.exec(head);
  if (!address) return null;

  const prefix = head.slice(0, address.index).trim();
  let date: string | null = null;
  let name = prefix;

  // 마지막 시각까지가 날짜, 그 뒤가 이름이다
  const times = [...prefix.matchAll(TIME)];
  const last = times[times.length - 1];
  if (last) {
    const end = last.index! + last[0].length;
    date = prefix.slice(0, end).replace(/[\s,]+$/, '').trim();
    name = prefix.slice(end);
  } else {
    // 시각이 없으면 쉼표 하나를 경계로 본다. 그것도 없으면 전부 이름으로 둔다
    const comma = prefix.lastIndexOf(',');
    if (comma > 0) {
      date = prefix.slice(0, comma).trim();
      name = prefix.slice(comma + 1);
    }
  }

  return {
    name: name.replace(/^[\s,]+|[\s,]+$/g, '') || null,
    address: address[1]!,
    date: date || null,
  };
}

/**
 * 우리 웹메일이 서명을 감싸는 class (server/src/services/compose.ts 의 `j9-signature`).
 * 메일을 보낼 때 본문 맨 끝에 이 `<div>` 로 붙으므로, 구분선이 없어도 서명인 줄 안다.
 */
const SIGNATURE_CLASS = 'j9-signature';

interface Line {
  text: string;
  /** 서명 구분선(또는 서명 블록) 안인가 */
  signature: boolean;
}

interface Level {
  lines: Line[];
  children: Level[];
}

/** 빈 줄은 하나까지만 남긴다 — 에디터가 넣은 `<p><br></p>` 가 줄줄이 쌓여 있다 */
function squeeze(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    if (!line.text && (out.length === 0 || !out[out.length - 1]!.text)) continue;
    out.push(line);
  }
  while (out.length && !out[out.length - 1]!.text) out.pop();
  return out;
}

/** 블록 하나의 글자. `<br>` 과 블록 끝을 줄바꿈으로 바꾼 뒤 태그를 떼어 낸다 */
function blockLines(element: Element): string[] {
  const html = element.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre)>/gi, '\n');
  const text = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? '';
  // NBSP 는 빈 줄 판정을 망친다 — 에디터가 빈 문단을 그것으로 채워 두는 경우가 있다
  return text.split('\n').map((line) => line.replace(/\u00a0/g, ' ').trim());
}

/**
 * HTML 을 인용 단계의 나무로 바꾼다. `<blockquote>` 가 한 단계고, `<hr>` 아래는 서명이다.
 *
 * 인용 블록이 `<div class="gmail_quote">` 처럼 한 겹 싸여 오는 경우가 있어, 자식 안에
 * blockquote · hr 이 들어 있으면 그 자식을 **같은 단계로 펴서** 내려간다.
 */
function walk(root: Element): Level {
  const level: Level = { lines: [], children: [] };
  let signature = false;

  const visit = (parent: Element) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? '').replace(/\u00a0/g, ' ').trim();
        if (text) level.lines.push({ text, signature });
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (tag === 'blockquote') {
        level.children.push(walk(element));
      } else if (element.classList.contains(SIGNATURE_CLASS)) {
        // 우리가 보낸 메일의 서명 (server/src/services/compose.ts 가 이 class 로 감싼다).
        // 구분선 없이 본문 끝에 붙으므로 <hr> 만 보면 서명이 본문으로 섞여 들어온다
        for (const text of blockLines(element)) level.lines.push({ text, signature: true });
      } else if (tag === 'hr') {
        signature = true;
      } else if (element.querySelector('blockquote, hr')) {
        visit(element);
      } else {
        for (const text of blockLines(element)) level.lines.push({ text, signature });
      }
    }
  };

  visit(root);
  level.lines = squeeze(level.lines);
  return level;
}

/** 한 단계를 메일 한 통으로. 머리말 줄은 본문에서 빼고 **바로 아래 인용 블록**의 머리로 쓴다 */
function flatten(
  level: Level,
  depth: number,
  who: { name: string | null; address: string | null },
  date: string | null,
  out: ConversationEntry[],
): void {
  const body: string[] = [];
  const signature: string[] = [];
  const intros: Intro[] = [];

  for (const line of level.lines) {
    if (line.signature) {
      signature.push(line.text);
      continue;
    }
    const intro = matchIntro(line.text);
    if (intro) intros.push(intro);
    else body.push(line.text);
  }

  out.push({
    depth,
    name: who.name,
    address: who.address,
    date,
    exact: depth === 0,
    body: body.join('\n').trim(),
    signature: signature.join('\n').trim() || null,
  });

  level.children.forEach((child, index) => {
    const intro = intros[index];
    flatten(child, depth + 1, { name: intro?.name ?? null, address: intro?.address ?? null }, intro?.date ?? null, out);
  });
}

/**
 * 평문만 있는 메일. 머리말 줄이 나올 때마다 한 단계 깊어진다 — 인용 부호가 없으면
 * 그 줄 말고는 경계를 알 길이 없다. `>` 가 붙어 있으면 그 개수를 깊이로 믿는다.
 */
function fromText(
  text: string,
  who: { name: string | null; address: string | null },
  date: string | null,
): ConversationEntry[] {
  const entries: ConversationEntry[] = [
    { depth: 0, name: who.name, address: who.address, date, exact: true, body: '', signature: null },
  ];
  const body: string[][] = [[]];
  let depth = 0;

  for (const raw of text.split(/\r?\n/)) {
    const marks = /^(\s*>+\s*)/.exec(raw);
    const line = (marks ? raw.slice(marks[1]!.length) : raw).trim();
    const quoteDepth = marks ? (marks[1]!.match(/>/g) ?? []).length : depth;
    const intro = matchIntro(line);
    if (intro) {
      depth = quoteDepth + 1;
      entries.push({
        depth,
        name: intro.name,
        address: intro.address,
        date: intro.date,
        exact: false,
        body: '',
        signature: null,
      });
      body.push([]);
      continue;
    }
    body[body.length - 1]!.push(line);
  }

  return entries.map((entry, index) => ({
    ...entry,
    body: squeeze(body[index]!.map((line) => ({ text: line, signature: false })))
      .map((line) => line.text)
      .join('\n'),
  }));
}

/**
 * 원문 한 통 → 주고받은 메일들. 첫 항목이 이 메일 자신이고 뒤로 갈수록 오래된 메일이다.
 * 인용된 것이 없으면 항목 하나만 돌아온다.
 */
export function parseConversation(mail: ParsedMail): ConversationEntry[] {
  const who = { name: mail.from?.name || null, address: mail.from?.address ?? null };
  const date = formatFullDate(mail.date);

  if (!mail.html) return fromText(mail.text ?? '', who, date || null);

  // 글자만 긁어 쓰므로 문서에 꽂지 않지만, 남이 보낸 HTML 을 DOM 으로 세우는 길은
  // 읽기 화면과 같은 정화를 한 번 거치게 해 둔다 (features/message/quote.ts 와 같은 설정)
  const clean = DOMPurify.sanitize(mail.html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcdoc'],
  });
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');

  const out: ConversationEntry[] = [];
  flatten(walk(doc.body), 0, who, date || null, out);
  return out;
}
