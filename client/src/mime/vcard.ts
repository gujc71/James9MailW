/**
 * vCard(.vcf) 파싱 (USR-1.4 v-Card).
 *
 * v-Card 첨부는 파일로 내려받아 봐야 알 수 있는 게 아니라 **연락처 그 자체**다.
 * 썬더버드처럼 이름·메일·전화를 읽기 화면에 바로 펼쳐 보여 주려고, 워커가 파트를
 * 디코드하면서 여기서 구조로 바꾼다 (mime/parse.worker.ts → features/message/VCardBox.tsx).
 *
 * 다루는 것:
 *  - 접힌 줄(RFC 6350 3.2 — 줄바꿈 + 공백/탭)
 *  - vCard 2.1 의 QUOTED-PRINTABLE 값과 줄 끝 '=' 이어붙이기. 아웃룩 익스프레스 계열이
 *    한글 이름을 이렇게 싣는다. CHARSET=EUC-KR 이면 그 표로 되돌린다
 *  - 값 이스케이프(\n · \, · \; · \\)와 N · ADR 의 ';' 구분
 *  - PHOTO 의 base64/데이터 URI (이미지 형식만, SVG 는 뺀다)
 */

export interface VCardTel {
  /** 화면에서 번역할 갈래. 모르는 값은 tel 로 떨어진다 */
  kind: 'work' | 'home' | 'cell' | 'fax' | 'tel';
  value: string;
}

export interface VCardContact {
  /** FN, 없으면 N 을 맞춰 조립한 이름. 둘 다 없으면 첫 메일 주소 */
  name: string;
  org: string | null;
  title: string | null;
  emails: string[];
  tels: VCardTel[];
  addresses: string[];
  urls: string[];
  bday: string | null;
  note: string | null;
  /** <img src> 에 바로 넣을 data: URI */
  photo: string | null;
}

interface VCardProperty {
  name: string;
  params: Map<string, string[]>;
  /** 이스케이프까지 되돌린 값 — 한 덩이로 쓰는 속성(FN · EMAIL · NOTE…) 용 */
  value: string;
  /** 인코딩만 푼 값 — ';' 로 나뉘는 속성(N · ADR · ORG) 은 이쪽을 잘라 써야 이스케이프한 ';' 를 구분자로 오해하지 않는다 */
  raw: string;
}

/** 아바타로 그려 줄 이미지 형식. SVG 는 스크립트를 품을 수 있어 뺀다 */
const PHOTO_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp']);

/** 사진 한 장 상한(base64 글자 수). 넘으면 아바타 없이 기본 그림으로 간다 */
const MAX_PHOTO_CHARS = 2 * 1024 * 1024;

/**
 * .vcf 한 덩이를 연락처 목록으로 바꾼다. 한 파일에 여러 장이 들어 있을 수 있다.
 * 이름도 메일도 전화도 없는(= 보여 줄 게 없는) 카드는 버린다 — 이 함수가 빈 배열을
 * 주면 워커가 그 파트를 그냥 첨부로 남긴다.
 */
export function parseVCards(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  for (const card of splitCards(text)) {
    const contact = buildContact(card);
    if (contact) contacts.push(contact);
  }
  return contacts;
}

/** BEGIN:VCARD … END:VCARD 단위로 속성 줄을 나눈다 */
function splitCards(text: string): VCardProperty[][] {
  const cards: VCardProperty[][] = [];
  let current: VCardProperty[] | null = null;
  for (const line of unfold(text)) {
    const property = parseProperty(line);
    if (!property) continue;
    if (property.name === 'BEGIN') {
      if (property.value.toUpperCase() === 'VCARD') current = [];
      continue;
    }
    if (property.name === 'END') {
      if (current?.length) cards.push(current);
      current = null;
      continue;
    }
    current?.push(property);
  }
  if (current?.length) cards.push(current);
  return cards;
}

/**
 * 접힌 줄을 편다.
 *  1) RFC 6350 의 접기 — 줄바꿈 뒤 공백/탭 한 칸은 이음매다
 *  2) vCard 2.1 의 QUOTED-PRINTABLE 소프트 줄바꿈 — 줄 끝 '=' 뒤가 이음매다.
 *     이 이음매는 **QP 로 실린 줄에서만** 본다. base64 사진(PHOTO)도 패딩 '=' 로
 *     끝나므로, 무턱대고 이으면 뒤 속성이 사진 값에 딸려 들어간다
 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && previous.endsWith('=') && isQuotedPrintable(previous)) {
      lines[lines.length - 1] = previous.slice(0, -1) + line;
      continue;
    }
    if (line.trim() === '') continue;
    lines.push(line);
  }
  return lines.filter((line) => line.trim() !== '');
}

function isQuotedPrintable(line: string): boolean {
  const colon = findValueColon(line);
  return colon > 0 && /;\s*(ENCODING\s*=\s*)?QUOTED-PRINTABLE/i.test(line.slice(0, colon));
}

/** [group.]NAME[;param…]:value 한 줄 */
function parseProperty(line: string): VCardProperty | null {
  const colon = findValueColon(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);

  const segments = splitUnescaped(head, ';');
  // group. 접두사(item1.EMAIL 등)는 떼고 속성 이름만 본다
  const name = (segments.shift() ?? '').split('.').pop()!.trim().toUpperCase();
  if (!name) return null;

  const params = new Map<string, string[]>();
  for (const segment of segments) {
    const equals = segment.indexOf('=');
    // vCard 2.1 은 값만 적는다 (EMAIL;INTERNET;PREF:…) — TYPE 으로 본다
    const key = (equals < 0 ? 'TYPE' : segment.slice(0, equals)).trim().toUpperCase();
    const raw = equals < 0 ? segment : segment.slice(equals + 1);
    const values = splitUnescaped(raw, ',').map((value) => value.trim().replace(/^"|"$/g, ''));
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }

  const decoded = decodeValue(rawValue, params);
  return { name, params, value: unescapeText(decoded), raw: decoded };
}

/** 파라미터의 따옴표 안에 들어 있는 콜론은 값 구분자가 아니다 */
function findValueColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) return index;
  }
  return -1;
}

/** 이스케이프(\;)와 따옴표를 건너뛰며 자른다 */
function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '\\' && index + 1 < text.length) {
      buffer += char + text[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

/** ENCODING/CHARSET 을 풀고 \n · \, 이스케이프를 되돌린다 */
function decodeValue(raw: string, params: Map<string, string[]>): string {
  const encoding = (params.get('ENCODING')?.[0] ?? '').toUpperCase();
  let value = raw;
  if (encoding === 'QUOTED-PRINTABLE') {
    value = decodeQuotedPrintable(raw, params.get('CHARSET')?.[0] ?? 'utf-8');
  }
  // base64(B · BASE64) 는 PHOTO 쪽에서 원문 그대로 써야 하므로 여기서는 건드리지 않는다
  return value;
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_whole, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  );
}

/**
 * QUOTED-PRINTABLE 을 바이트로 되돌려 CHARSET 으로 읽는다.
 * 한글 이름이 =EC=9D=B4 처럼 실려 오는데, 이걸 글자로 그냥 두면 "ì´" 가 된다.
 */
function decodeQuotedPrintable(text: string, charset: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (char.charCodeAt(0) < 0x80) bytes.push(char.charCodeAt(0));
    // QP 자리에 그대로 실려 온 비ASCII 글자는 UTF-8 바이트로 돌려놓는다
    else for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
  }
  const buffer = new Uint8Array(bytes);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // TextDecoder 가 모르는 charset 이면 utf-8 로 내려간다 (2-12)
    return new TextDecoder().decode(buffer);
  }
}

function buildContact(properties: VCardProperty[]): VCardContact | null {
  const first = (name: string) => properties.find((p) => p.name === name)?.value.trim() || null;
  const all = (name: string) =>
    properties.filter((p) => p.name === name).map((p) => p.value.trim()).filter(Boolean);

  const emails = unique(all('EMAIL').map((value) => value.replace(/^mailto:/i, '')));
  const name = first('FN') ?? nameFromN(properties.find((p) => p.name === 'N')) ?? emails[0] ?? null;

  const tels: VCardTel[] = properties
    .filter((p) => p.name === 'TEL' && p.value.trim())
    .map((p) => ({ kind: telKind(p.params), value: p.value.trim() }));

  const addresses = properties
    .filter((p) => p.name === 'ADR')
    .map((p) => formatAddress(p.raw))
    .filter(Boolean);

  // ORG:회사;부서 — 회사 · 부서로 잇는다
  const orgProperty = properties.find((p) => p.name === 'ORG');
  const org = orgProperty
    ? splitUnescaped(orgProperty.raw, ';')
        .map((part) => unescapeText(part).trim())
        .filter(Boolean)
        .join(' · ')
    : null;

  // 보여 줄 게 아무것도 없으면 카드로 치지 않는다 (첨부로 남겨야 한다)
  if (!name && emails.length === 0 && tels.length === 0) return null;

  return {
    name: name ?? '',
    org: org || null,
    title: first('TITLE'),
    emails,
    tels,
    addresses,
    urls: unique(all('URL')),
    bday: first('BDAY'),
    note: first('NOTE'),
    photo: photoUri(properties.find((p) => p.name === 'PHOTO')),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * N:성;이름;중간;접두;접미 를 사람이 읽는 순서로 붙인다.
 * 한글·한자·가나 이름은 "성이름" 으로 붙여 쓰고, 그 밖은 "이름 성" 으로 둔다.
 */
function nameFromN(property: VCardProperty | undefined): string | null {
  if (!property) return null;
  const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitUnescaped(
    property.raw,
    ';',
  ).map((part) => unescapeText(part).trim());
  const parts = [family, given, middle, prefix, suffix].filter(Boolean);
  if (parts.length === 0) return null;
  if (/[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/.test(parts.join(''))) {
    return [prefix, family + given, suffix].filter(Boolean).join(' ').trim();
  }
  return [prefix, given, middle, family, suffix].filter(Boolean).join(' ').trim();
}

function telKind(params: Map<string, string[]>): VCardTel['kind'] {
  const types = (params.get('TYPE') ?? []).map((type) => type.toLowerCase());
  if (types.includes('cell') || types.includes('mobile')) return 'cell';
  if (types.includes('fax')) return 'fax';
  if (types.includes('work')) return 'work';
  if (types.includes('home')) return 'home';
  return 'tel';
}

/** ADR:사서함;추가;거리;도시;지역;우편번호;국가 → 한 줄 주소 */
function formatAddress(value: string): string {
  const parts = splitUnescaped(value, ';').map((part) => unescapeText(part).trim());
  const [pobox = '', extended = '', street = '', locality = '', region = '', postal = '', country = ''] =
    parts;
  return [street, extended, pobox, locality, region, postal, country].filter(Boolean).join(', ');
}

/** PHOTO 를 <img> 에 바로 넣을 data: URI 로. 못 믿을 형식이면 null */
function photoUri(property: VCardProperty | undefined): string | null {
  if (!property) return null;
  const raw = property.raw.trim();
  // vCard 4.0: PHOTO:data:image/jpeg;base64,…
  const inline = raw.match(/^data:image\/([a-z0-9+-]+);base64,[A-Za-z0-9+/=]+$/i);
  if (inline) {
    const type = inline[1]!.toLowerCase();
    return PHOTO_TYPES.has(type) && raw.length <= MAX_PHOTO_CHARS ? raw : null;
  }
  // vCard 3.0: PHOTO;ENCODING=b;TYPE=JPEG:<base64>. URL 로 적힌 원격 사진은 추적이 되므로 뺀다
  const encoding = (property.params.get('ENCODING')?.[0] ?? '').toUpperCase();
  if (encoding !== 'B' && encoding !== 'BASE64') return null;
  const type = (property.params.get('TYPE')?.[0] ?? 'jpeg').toLowerCase().replace(/^image\//, '');
  const base64 = raw.replace(/\s+/g, '');
  if (!PHOTO_TYPES.has(type) || !/^[A-Za-z0-9+/=]+$/.test(base64)) return null;
  if (base64.length > MAX_PHOTO_CHARS) return null;
  return `data:image/${type === 'jpg' ? 'jpeg' : type};base64,${base64}`;
}
