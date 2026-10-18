/**
 * vCard (RFC 6350 4.0 · RFC 2426 3.0 · 2.1) 읽기 · 쓰기. 주소록 한 행 = vCard 한 장이다.
 *
 *  - 원문을 속성 줄 단위로 나눠 둔다. 화면에서 고친 갈래(이름 · 메일 · 전화 …)만 다시 쓰고
 *    나머지 줄(X-MOZ-…, CATEGORIES, 원격 사진 등)은 그대로 둔다 → mergeFields.
 *    고치지 않은 갈래는 원래 줄을 그대로 돌려줘 파라미터(PREF · LABEL …)도 잃지 않는다.
 *  - 2.1 카드(QUOTED-PRINTABLE · CHARSET)는 읽을 수만 있다. 가져오기에서는 4.0 으로 새로 쓴다.
 *  - 그룹은 4.0 KIND:group + MEMBER, 3.0 은 애플식 X-ADDRESSBOOKSERVER-KIND · -MEMBER 둘 다 읽는다.
 */
import { randomUUID } from 'node:crypto';

export interface VProp {
  /** item1.EMAIL 의 item1 */
  group: string | null;
  /** 대문자 */
  name: string;
  /** 키는 대문자, 값은 따옴표를 벗긴 원래 값 */
  params: [string, string[]][];
  /** 이스케이프가 남은 값 (QP 는 풀었다) */
  value: string;
  /** 펼친 원래 줄. 고치지 않은 속성은 이것을 그대로 다시 쓴다 */
  line: string;
}

export interface VCard {
  version: string;
  props: VProp[];
}

export interface ContactTyped {
  /** EMAIL: work · home · other / TEL: cell · work · home · fax · pager · other */
  type: string;
  value: string;
}

export interface ContactAddress {
  type: string;
  poBox: string;
  extended: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface ContactFields {
  kind: 'individual' | 'group';
  displayName: string;
  familyName: string;
  givenName: string;
  nickname: string;
  emails: ContactTyped[];
  phones: ContactTyped[];
  org: string;
  department: string;
  title: string;
  addresses: ContactAddress[];
  /** YYYY-MM-DD, 해를 모르면 --MM-DD */
  birthday: string;
  urls: string[];
  note: string;
  /** data:image/…;base64,… (웹에서 보여 줄 수 있는 것만). 원격 주소 사진은 null 로 보이고 원문에 남는다 */
  photo: string | null;
  /** 그룹 멤버. 연락처 UID, 또는 'mailto:주소' */
  members: string[];
}

export const EMPTY_FIELDS: ContactFields = {
  kind: 'individual',
  displayName: '',
  familyName: '',
  givenName: '',
  nickname: '',
  emails: [],
  phones: [],
  org: '',
  department: '',
  title: '',
  addresses: [],
  birthday: '',
  urls: [],
  note: '',
  photo: null,
  members: [],
};

const PRODID = '-//james9Mail//Webmail//KO';
const PHOTO_TYPES = new Set(['jpeg', 'png', 'gif', 'webp']);

// ------------------------------------------------------------------ 읽기

/** 원문을 카드 단위 원문으로 자른다 (가져오기 · PUT 검사용) */
export function splitCardTexts(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD\s*$/i.test(line)) {
      current = [line];
      continue;
    }
    if (!current) continue;
    current.push(line);
    if (/^END:VCARD\s*$/i.test(line)) {
      out.push(current.join('\r\n') + '\r\n');
      current = null;
    }
  }
  return out;
}

/** 줄 펴기. 2.1 의 QP 소프트 줄바꿈(줄 끝 '=')은 QP 로 실린 줄에서만 잇는다 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && previous.endsWith('=') && isQuotedPrintable(previous)) {
      lines[lines.length - 1] = previous.slice(0, -1) + line;
      continue;
    }
    if (line.trim() !== '') lines.push(line);
  }
  return lines;
}

function isQuotedPrintable(line: string): boolean {
  const colon = valueColon(line);
  return colon > 0 && /;\s*(ENCODING\s*=\s*)?QUOTED-PRINTABLE/i.test(line.slice(0, colon));
}

/** 파라미터 따옴표 안의 콜론은 값 구분자가 아니다 */
function valueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) return i;
  }
  return -1;
}

/** 이스케이프(\;)와 따옴표를 건너뛰며 자른다 */
export function splitEscaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) {
      buffer += c + text[i + 1];
      i += 1;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === separator && !quoted) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += c;
  }
  parts.push(buffer);
  return parts;
}

export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;:\\])/g, (_w, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function decodeQuotedPrintable(text: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
}

function parseLine(line: string): VProp | null {
  const colon = valueColon(line);
  if (colon < 0) return null;
  const segments = splitEscaped(line.slice(0, colon), ';');
  const head = (segments.shift() ?? '').trim();
  const dot = head.lastIndexOf('.');
  const name = (dot >= 0 ? head.slice(dot + 1) : head).toUpperCase();
  if (!name) return null;
  const params: [string, string[]][] = [];
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    // 2.1 은 값만 적는다 (EMAIL;INTERNET;PREF:…) — TYPE 으로 본다
    const k = (eq < 0 ? 'TYPE' : segment.slice(0, eq)).trim().toUpperCase();
    const raw = eq < 0 ? segment : segment.slice(eq + 1);
    const values = splitEscaped(raw, ',').map((v) => v.trim().replace(/^"|"$/g, ''));
    const found = params.find(([key]) => key === k);
    if (found) found[1].push(...values);
    else params.push([k, values]);
  }
  let value = line.slice(colon + 1);
  const encoding = (paramOf(params, 'ENCODING')[0] ?? '').toUpperCase();
  if (encoding === 'QUOTED-PRINTABLE') value = decodeQuotedPrintable(value, paramOf(params, 'CHARSET')[0] ?? 'utf-8');
  return { group: dot >= 0 ? head.slice(0, dot) : null, name, params, value, line };
}

function paramOf(params: [string, string[]][], name: string): string[] {
  return params.find(([k]) => k === name)?.[1] ?? [];
}

const typesOf = (p: VProp) => paramOf(p.params, 'TYPE').flatMap((t) => t.toLowerCase().split(','));

/** 카드 한 장. BEGIN/END 가 없으면 null */
export function parseCard(text: string): VCard | null {
  const props: VProp[] = [];
  let version = '';
  let depth = 0;
  let seen = false;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VCARD') {
      depth += 1;
      seen = true;
      continue;
    }
    if (prop.name === 'END' && prop.value.trim().toUpperCase() === 'VCARD') {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (prop.name === 'VERSION') {
      version = prop.value.trim();
      continue;
    }
    props.push(prop);
  }
  if (!seen) return null;
  return { version: version || '3.0', props };
}

export function uidOf(card: VCard): string | null {
  const raw = card.props.find((p) => p.name === 'UID')?.value.trim();
  if (!raw) return null;
  return unescapeText(raw).replace(/^urn:uuid:/i, '');
}

function isGroupCard(card: VCard): boolean {
  return card.props.some(
    (p) => (p.name === 'KIND' || p.name === 'X-ADDRESSBOOKSERVER-KIND') && p.value.trim().toLowerCase() === 'group',
  );
}

function emailType(p: VProp): string {
  const types = typesOf(p);
  if (types.includes('work')) return 'work';
  if (types.includes('home')) return 'home';
  return 'other';
}

function telType(p: VProp): string {
  const types = typesOf(p);
  if (types.includes('cell') || types.includes('mobile')) return 'cell';
  if (types.includes('fax')) return 'fax';
  if (types.includes('pager')) return 'pager';
  if (types.includes('work')) return 'work';
  if (types.includes('home')) return 'home';
  return 'other';
}

function isPref(p: VProp): boolean {
  return paramOf(p.params, 'PREF').length > 0 || typesOf(p).includes('pref');
}

/** BDAY → YYYY-MM-DD · --MM-DD. 모르는 모양은 빈 값 (원문에는 남는다) */
function normalizeBirthday(raw: string): string {
  const v = raw.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return `--${m[1]}-${m[2]}`;
  return '';
}

function photoOf(p: VProp | undefined): string | null {
  if (!p) return null;
  const raw = p.value.trim();
  const inline = /^data:image\/([a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (inline) {
    const type = inline[1]!.toLowerCase().replace('jpg', 'jpeg');
    return PHOTO_TYPES.has(type) ? `data:image/${type};base64,${inline[2]!.replace(/\s+/g, '')}` : null;
  }
  const encoding = (paramOf(p.params, 'ENCODING')[0] ?? '').toUpperCase();
  if (encoding !== 'B' && encoding !== 'BASE64') return null;
  const type = (paramOf(p.params, 'TYPE')[0] ?? 'jpeg').toLowerCase().replace(/^image\//, '').replace('jpg', 'jpeg');
  const base64 = raw.replace(/\s+/g, '');
  if (!PHOTO_TYPES.has(type) || !/^[A-Za-z0-9+/=]+$/.test(base64)) return null;
  return `data:image/${type};base64,${base64}`;
}

function memberRef(raw: string): string {
  const v = unescapeText(raw.trim());
  if (/^urn:uuid:/i.test(v)) return v.slice(9);
  if (/^mailto:/i.test(v)) return `mailto:${v.slice(7)}`;
  return v;
}

const components = (p: VProp | undefined) => (p ? splitEscaped(p.value, ';').map((c) => unescapeText(c).trim()) : []);
const textOf = (p: VProp | undefined) => (p ? unescapeText(p.value).trim() : '');

/** 화면용 필드. 고칠 수 있는 갈래만 뽑는다 */
export function fieldsOf(card: VCard): ContactFields {
  const first = (name: string) => card.props.find((p) => p.name === name);
  const all = (name: string) => card.props.filter((p) => p.name === name);
  const n = components(first('N'));
  const org = components(first('ORG'));

  // PREF 가 붙은 것을 앞에 둔다 (대표 메일 · 대표 전화)
  const ordered = (list: VProp[]) => [...list.filter(isPref), ...list.filter((p) => !isPref(p))];
  const emails = ordered(all('EMAIL'))
    .map((p) => ({ type: emailType(p), value: textOf(p).replace(/^mailto:/i, '') }))
    .filter((e) => e.value);
  const phones = ordered(all('TEL'))
    .map((p) => ({ type: telType(p), value: textOf(p).replace(/^tel:/i, '') }))
    .filter((e) => e.value);
  const addresses = all('ADR').map((p) => {
    const [poBox = '', extended = '', street = '', locality = '', region = '', postalCode = '', country = ''] = components(p);
    const types = typesOf(p);
    return {
      type: types.includes('work') ? 'work' : types.includes('home') ? 'home' : 'other',
      poBox,
      extended,
      street,
      locality,
      region,
      postalCode,
      country,
    };
  });
  const members = [
    ...all('MEMBER').map((p) => memberRef(p.value)),
    ...all('X-ADDRESSBOOKSERVER-MEMBER').map((p) => memberRef(p.value)),
  ].filter(Boolean);

  return {
    kind: isGroupCard(card) ? 'group' : 'individual',
    displayName: textOf(first('FN')),
    familyName: n[0] ?? '',
    givenName: n[1] ?? '',
    nickname: textOf(first('NICKNAME')),
    emails,
    phones,
    org: org[0] ?? '',
    department: org.slice(1).filter(Boolean).join(' '),
    title: textOf(first('TITLE')),
    addresses,
    birthday: normalizeBirthday(first('BDAY')?.value ?? ''),
    urls: all('URL').map(textOf).filter(Boolean),
    note: textOf(first('NOTE')),
    photo: photoOf(first('PHOTO')),
    members: [...new Set(members)],
  };
}

const HAN_RE = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/;

/** 성 · 이름을 사람이 읽는 순서로. 한글 · 한자 · 가나는 붙여 쓴다 */
export function joinName(family: string, given: string): string {
  const f = family.trim();
  const g = given.trim();
  if (!f || !g) return f || g;
  return HAN_RE.test(f + g) ? `${f}${g}` : `${g} ${f}`;
}

/** 목록 · 검색용 값 */
export interface ContactIndex {
  kind: 'I' | 'G';
  name: string | null;
  emails: string[];
  org: string | null;
  phone: string | null;
}

export function indexOf(fields: ContactFields): ContactIndex {
  const emails = [...new Set(fields.emails.map((e) => e.value.trim()).filter((e) => e.includes('@')))];
  const lower = new Set(emails.map((e) => e.toLowerCase()));
  // FN 이 메일 주소 그대로면 이름이 없는 것으로 본다 — 자동완성이 "a@b <a@b>" 로 보이지 않게
  let name = fields.displayName.trim();
  if (!name || lower.has(name.toLowerCase())) name = joinName(fields.familyName, fields.givenName) || fields.nickname.trim();
  return {
    kind: fields.kind === 'group' ? 'G' : 'I',
    name: name ? name.slice(0, 100) : null,
    emails: emails.map((e) => e.slice(0, 255)),
    org: [fields.org, fields.department].filter(Boolean).join(' ').slice(0, 255) || null,
    phone: fields.phones[0]?.value.slice(0, 100) || null,
  };
}

// ------------------------------------------------------------------ 쓰기

/** 75 바이트로 접는다. UTF-8 글자 중간에서 자르지 않는다 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      limit = 74; // 이어지는 줄 앞의 공백 한 칸
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function serialize(version: string, lines: string[]): string {
  return ['BEGIN:VCARD', `VERSION:${version}`, ...lines, 'END:VCARD'].map(foldLine).join('\r\n') + '\r\n';
}

/** 화면 필드를 갈래별로 나눈 것. 갈래 하나 = 속성 이름 몇 개 */
type Part = 'FN' | 'N' | 'NICKNAME' | 'EMAIL' | 'TEL' | 'ORG' | 'TITLE' | 'ADR' | 'BDAY' | 'URL' | 'NOTE' | 'PHOTO' | 'KIND';

const PART_PROPS: Record<Part, string[]> = {
  FN: ['FN'],
  N: ['N'],
  NICKNAME: ['NICKNAME'],
  EMAIL: ['EMAIL'],
  TEL: ['TEL'],
  ORG: ['ORG'],
  TITLE: ['TITLE'],
  ADR: ['ADR'],
  BDAY: ['BDAY'],
  URL: ['URL'],
  NOTE: ['NOTE'],
  PHOTO: ['PHOTO'],
  KIND: ['KIND', 'MEMBER', 'X-ADDRESSBOOKSERVER-KIND', 'X-ADDRESSBOOKSERVER-MEMBER'],
};

const PARTS = Object.keys(PART_PROPS) as Part[];

function partValue(fields: ContactFields, part: Part): unknown {
  switch (part) {
    case 'FN':
      return fields.displayName.trim();
    case 'N':
      return [fields.familyName.trim(), fields.givenName.trim()];
    case 'NICKNAME':
      return fields.nickname.trim();
    case 'EMAIL':
      return fields.emails.map((e) => [e.type, e.value.trim()]).filter(([, v]) => v);
    case 'TEL':
      return fields.phones.map((e) => [e.type, e.value.trim()]).filter(([, v]) => v);
    case 'ORG':
      return [fields.org.trim(), fields.department.trim()];
    case 'TITLE':
      return fields.title.trim();
    case 'ADR':
      return fields.addresses
        .map((a) => [a.type, a.poBox, a.extended, a.street, a.locality, a.region, a.postalCode, a.country].map((v) => v.trim()))
        .filter((a) => a.slice(1).some(Boolean));
    case 'BDAY':
      return fields.birthday.trim();
    case 'URL':
      return fields.urls.map((u) => u.trim()).filter(Boolean);
    case 'NOTE':
      return fields.note.trim();
    case 'PHOTO':
      return fields.photo ?? null;
    case 'KIND':
      return [fields.kind, fields.kind === 'group' ? fields.members : []];
  }
}

const v4 = (version: string) => version.startsWith('4');

/** 갈래 하나를 새로 쓴 줄들 (접기 전) */
function partLines(fields: ContactFields, part: Part, version: string, old: VProp[]): string[] {
  const four = v4(version);
  switch (part) {
    case 'FN': {
      // FN 은 필수다. 비었으면 이름 → 대표 메일로 채운다
      const fn =
        fields.displayName.trim() ||
        joinName(fields.familyName, fields.givenName) ||
        fields.nickname.trim() ||
        fields.emails[0]?.value.trim() ||
        '';
      return [`FN:${escapeText(fn)}`];
    }
    case 'N': {
      // 중간 이름 · 접두 · 접미는 화면에 없으니 원래 값을 지킨다
      const rest = components(old.find((p) => p.name === 'N')).slice(2, 5);
      while (rest.length < 3) rest.push('');
      const family = fields.familyName.trim();
      const given = fields.givenName.trim();
      if (!family && !given && !rest.some(Boolean) && four) return [];
      return [`N:${[family, given, ...rest].map(escapeText).join(';')}`];
    }
    case 'NICKNAME':
      return fields.nickname.trim() ? [`NICKNAME:${escapeText(fields.nickname.trim())}`] : [];
    case 'EMAIL':
      return fields.emails
        .filter((e) => e.value.trim())
        .map((e, i) => {
          const types = e.type === 'work' || e.type === 'home' ? [e.type] : [];
          if (four) {
            const params = [...(types.length ? [`TYPE=${types[0]}`] : []), ...(i === 0 ? ['PREF=1'] : [])];
            return `EMAIL${params.map((p) => `;${p}`).join('')}:${e.value.trim()}`;
          }
          const t3 = ['INTERNET', ...types.map((t) => t.toUpperCase()), ...(i === 0 ? ['PREF'] : [])];
          return `EMAIL;TYPE=${t3.join(',')}:${e.value.trim()}`;
        });
    case 'TEL':
      return fields.phones
        .filter((e) => e.value.trim())
        .map((e) => {
          const type = e.type === 'other' || !e.type ? '' : e.type;
          const typed = four ? type : type.toUpperCase();
          return `TEL${typed ? `;TYPE=${typed}` : ''}:${e.value.trim().replace(/[\r\n]/g, ' ')}`;
        });
    case 'ORG':
      if (!fields.org.trim() && !fields.department.trim()) return [];
      return [`ORG:${escapeText(fields.org.trim())}${fields.department.trim() ? `;${escapeText(fields.department.trim())}` : ''}`];
    case 'TITLE':
      return fields.title.trim() ? [`TITLE:${escapeText(fields.title.trim())}`] : [];
    case 'ADR':
      return fields.addresses
        .filter((a) => [a.poBox, a.extended, a.street, a.locality, a.region, a.postalCode, a.country].some((v) => v.trim()))
        .map((a) => {
          const type = a.type === 'work' || a.type === 'home' ? (four ? a.type : a.type.toUpperCase()) : '';
          const value = [a.poBox, a.extended, a.street, a.locality, a.region, a.postalCode, a.country]
            .map((v) => escapeText(v.trim()))
            .join(';');
          return `ADR${type ? `;TYPE=${type}` : ''}:${value}`;
        });
    case 'BDAY': {
      const b = fields.birthday.trim();
      const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
      if (full) return [four ? `BDAY;VALUE=DATE:${full[1]}${full[2]}${full[3]}` : `BDAY:${b}`];
      const partial = /^--(\d{2})-(\d{2})$/.exec(b);
      if (partial && four) return [`BDAY;VALUE=DATE:--${partial[1]}${partial[2]}`];
      return [];
    }
    case 'URL':
      return fields.urls.map((u) => u.trim()).filter(Boolean).map((u) => `URL:${u}`);
    case 'NOTE':
      return fields.note.trim() ? [`NOTE:${escapeText(fields.note.trim())}`] : [];
    case 'PHOTO': {
      const m = fields.photo ? /^data:image\/([a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(fields.photo) : null;
      if (!m || !PHOTO_TYPES.has(m[1]!)) return [];
      return [four ? `PHOTO:${fields.photo}` : `PHOTO;ENCODING=b;TYPE=${m[1]!.toUpperCase()}:${m[2]}`];
    }
    case 'KIND': {
      if (fields.kind !== 'group') return [];
      const refs = fields.members.map((m) => (/^mailto:/i.test(m) ? m : `urn:uuid:${m}`));
      if (four) return ['KIND:group', ...refs.map((r) => `MEMBER:${r}`)];
      return ['X-ADDRESSBOOKSERVER-KIND:group', ...refs.map((r) => `X-ADDRESSBOOKSERVER-MEMBER:${r}`)];
    }
  }
}

/** 원래 줄을 다시 쓴다. 그룹 접두사(item1.)도 살아 있다 */
const keepLine = (p: VProp) => p.line;

/**
 * 화면에서 고친 필드를 원문에 얹는다. 바뀐 갈래만 다시 쓰고 나머지 줄은 그대로 둔다.
 * 원문이 없으면(새 연락처) 4.0 으로 새로 만든다. 그룹은 썬더버드 · 애플과 맞도록 3.0 으로 만든다.
 */
export function mergeFields(original: VCard | null, fields: ContactFields, uid: string): string {
  if (!original) {
    const version = fields.kind === 'group' ? '3.0' : '4.0';
    const lines = [`PRODID:${PRODID}`, `UID:${uid}`];
    for (const part of PARTS) lines.push(...partLines(fields, part, version, []));
    // 3.0 은 N 이 필수다
    if (!v4(version) && !lines.some((l) => l.startsWith('N:'))) lines.push('N:;;;;');
    return serialize(version, lines);
  }
  const before = fieldsOf(original);
  const changed = new Set(PARTS.filter((part) => JSON.stringify(partValue(before, part)) !== JSON.stringify(partValue(fields, part))));
  const lines: string[] = [];
  const written = new Set<Part>();
  const partOfProp = (name: string) => PARTS.find((part) => PART_PROPS[part].includes(name));
  for (const prop of original.props) {
    const part = partOfProp(prop.name);
    if (!part || !changed.has(part)) {
      lines.push(keepLine(prop));
      continue;
    }
    // 바뀐 갈래는 처음 나온 자리에 새 줄을 한 번에 넣는다
    if (!written.has(part)) {
      lines.push(...partLines(fields, part, original.version, original.props));
      written.add(part);
    }
  }
  for (const part of changed) {
    if (!written.has(part)) lines.push(...partLines(fields, part, original.version, original.props));
  }
  if (!original.props.some((p) => p.name === 'UID')) lines.unshift(`UID:${uid}`);
  return serialize(original.version, lines);
}

/** 원문에 UID 가 없으면 넣는다 (가져오기 · 외부 프로그램이 UID 없이 보낸 카드) */
export function ensureUid(card: VCard, uid: string): string {
  const lines = card.props.map(keepLine);
  if (!card.props.some((p) => p.name === 'UID')) lines.unshift(`UID:${uid}`);
  return serialize(card.version, lines);
}

/** 예전 행(원문 없음)을 카드로 */
export function simpleCard(uid: string, name: string | null, address: string | null): string {
  return mergeFields(
    null,
    { ...EMPTY_FIELDS, displayName: name ?? '', emails: address ? [{ type: 'other', value: address }] : [] },
    uid,
  );
}

export function newUid(): string {
  return randomUUID();
}
