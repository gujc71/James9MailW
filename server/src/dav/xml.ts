/**
 * WebDAV 공통 (RFC 4918) — CalDAV(routes/caldav.ts) · CardDAV(routes/carddav.ts) 가 같이 쓴다.
 * 요청 본문용 작은 XML 파서와 multistatus 응답 만들기.
 */

export const DAV = 'DAV:';
export const CAL = 'urn:ietf:params:xml:ns:caldav';
export const CARD = 'urn:ietf:params:xml:ns:carddav';
export const CS = 'http://calendarserver.org/ns/';
export const ICAL = 'http://apple.com/ns/ical/';
export const PREFIX: Record<string, string> = { [DAV]: 'd', [CAL]: 'c', [CARD]: 'card', [CS]: 'cs', [ICAL]: 'ic' };

// ------------------------------------------------------------------ XML 읽기

export interface XmlNode {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? Number.parseInt(k.slice(2), 16) : Number.parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/**
 * 요청 본문만 읽는 작은 XML 파서 (요소 · 속성 · 글자 · 이름공간). DTD 는 받지 않는다 —
 * 엔티티 확장 공격을 막을 일 자체를 없앤다. 형식이 틀리면 null.
 */
export function parseXml(source: string): XmlNode | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return null;
  const text = source.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const root: XmlNode = { ns: '', name: '#root', attrs: {}, children: [], text: '' };
  const stack: { node: XmlNode; scope: Record<string, string>; raw: string }[] = [{ node: root, scope: { xml: '' }, raw: '' }];
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = token.exec(text))) {
    if (m.index !== consumed) return null;
    consumed = token.lastIndex;
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) {
      top.node.text += m[1];
      continue;
    }
    if (m[6] !== undefined) {
      top.node.text += decodeEntities(m[6]);
      continue;
    }
    const closing = m[2] === '/';
    const raw = m[3]!;
    if (closing) {
      if (stack.length < 2 || top.raw !== raw) return null;
      stack.pop();
      continue;
    }
    const scope = { ...top.scope };
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(attrRe)) {
      const k = a[1]!;
      const value = decodeEntities(a[2] ?? a[3] ?? '');
      if (k === 'xmlns') scope[''] = value;
      else if (k.startsWith('xmlns:')) scope[k.slice(6)] = value;
      else attrs[k.includes(':') ? k.slice(k.indexOf(':') + 1) : k] = value;
    }
    const colon = raw.indexOf(':');
    const prefix = colon > 0 ? raw.slice(0, colon) : '';
    const node: XmlNode = {
      ns: scope[prefix] ?? '',
      name: colon > 0 ? raw.slice(colon + 1) : raw,
      attrs,
      children: [],
      text: '',
    };
    top.node.children.push(node);
    if (m[5] !== '/') stack.push({ node, scope, raw });
  }
  if (consumed !== text.length || stack.length !== 1) return null;
  return root.children[0] ?? null;
}

export const child = (node: XmlNode | null | undefined, ns: string, name: string) =>
  node?.children.find((c) => c.ns === ns && c.name === name) ?? null;
export const childrenOf = (node: XmlNode | null | undefined, ns: string, name: string) =>
  node?.children.filter((c) => c.ns === ns && c.name === name) ?? [];

// ------------------------------------------------------------------ XML 쓰기

export const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 속성 열쇠: "이름공간 이름" */
export const key = (ns: string, name: string) => `${ns} ${name}`;

export function element(propKey: string, inner: string): string {
  const space = propKey.indexOf(' ');
  const ns = propKey.slice(0, space);
  const name = propKey.slice(space + 1);
  const prefix = PREFIX[ns];
  const open = prefix ? `${prefix}:${name}` : `x:${name} xmlns:x="${escapeXml(ns)}"`;
  const close = prefix ? `${prefix}:${name}` : `x:${name}`;
  return inner ? `<${open}>${inner}</${close}>` : `<${open}/>`;
}

export const href = (path: string) => `<d:href>${escapeXml(path)}</d:href>`;

export function propstat(entries: [string, string][], status: string): string {
  if (!entries.length) return '';
  const props = entries.map(([k, v]) => element(k, v)).join('');
  return `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;
}

const NAMESPACES = Object.entries(PREFIX)
  .map(([uri, p]) => `xmlns:${p}="${uri}"`)
  .join(' ');

export function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NAMESPACES}>${responses.join('')}</d:multistatus>`;
}

export function errorBody(ns: string, condition: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:error ${NAMESPACES}>${element(key(ns, condition), '')}</d:error>`;
}

export const notFoundResponse = (path: string) => `<d:response>${href(path)}<d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

// ------------------------------------------------------------------ 경로 · 권한

export const enc = (segment: string) => encodeURIComponent(segment);

/** 경로 조각(디코딩한 값). 깨진 %xx 는 null */
export function segmentsOf(url: string): string[] | null {
  try {
    return url
      .split('?')[0]!
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * multiget 의 href 가 모음(base) 바로 아래 자원이면 그 이름. 절대 주소(https://host/dav/…)로도 온다
 */
export function memberName(hrefText: string, base: string): string | null {
  let path = hrefText.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* 그대로 둔다 */
    }
  }
  const segments = segmentsOf(path);
  const baseSegments = segmentsOf(base)!;
  if (!segments || segments.length !== baseSegments.length + 1) return null;
  if (!baseSegments.every((s, i) => s.toLowerCase() === segments[i]!.toLowerCase())) return null;
  return segments[segments.length - 1] ?? null;
}

export const PRIV_WRITE = ['read', 'write', 'write-properties', 'write-content', 'bind', 'unbind', 'read-current-user-privilege-set'];
export const PRIV_READ = ['read', 'read-current-user-privilege-set'];
export const privileges = (names: string[]) => names.map((n) => `<d:privilege><d:${n}/></d:privilege>`).join('');

/** 요청한 속성(prop) 목록. 비었거나 allprop · propname 이면 null = 전부 */
export function requested(node: XmlNode | null): string[] | null {
  const prop = child(node, DAV, 'prop');
  if (!prop) return null;
  return prop.children.map((c) => key(c.ns, c.name));
}

/**
 * 자원 하나의 응답. dataKey 를 요청했고 body 가 있으면 본문을 그 속성에 담는다
 * (calendar-data · address-data)
 */
export function describe(path: string, props: Map<string, string>, wanted: string[] | null, data?: { key: string; body: string }): string {
  const found: [string, string][] = [];
  const missing: [string, string][] = [];
  if (wanted === null) {
    found.push(...props);
  } else {
    for (const k of wanted) {
      if (data && k === data.key) found.push([k, escapeXml(data.body)]);
      else if (props.has(k)) found.push([k, props.get(k)!]);
      else missing.push([k, '']);
    }
  }
  return `<d:response>${href(path)}${propstat(found, '200 OK')}${propstat(missing, '404 Not Found')}</d:response>`;
}

/** If-Match: "a", "b" · * */
export function etagMatches(header: string | undefined, etag: string | null): boolean {
  if (header === undefined) return true;
  if (etag === null) return false;
  const tags = header.split(',').map((t) => t.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}
