/**
 * 발송 본문 HTML 정화.
 *
 * 읽기 쪽 정화는 서버에서 하지 않는다 (브라우저 sandbox iframe + CSP 가 방어선).
 * 다만 **발송**은 다르다: 에디터 출력이라도 조작할 수 있고, 그 결과를 받는 쪽은
 * 우리 사용자가 아니다. 수신자 보호를 위해 여기서 한 번 정화한다
 * (webmail-issues.md 3-1).
 */
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const window = new JSDOM('').window;
const purify = createDOMPurify(window as unknown as Window & typeof globalThis);

/** 에디터가 넣는 인라인 이미지(data: URI)는 남긴다. build.ts 가 cid: 파트로 바꾼다 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function sanitizeOutgoingHtml(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
    ADD_ATTR: ['target'],
  });
}

/** 텍스트 파트 자동 생성용. HTML 을 아주 단순한 평문으로 내린다 */
export function htmlToText(html: string): string {
  // 호출마다 new JSDOM 을 만들면 창 하나를 통째로 띄운다. 정화용 창의 빈 문서를 빌려 쓴다
  // (jsdom 은 스크립트를 실행하지 않으므로 innerHTML 로 넣어도 안전하다)
  const body = window.document.implementation.createHTMLDocument('').body;
  body.innerHTML = html;
  for (const br of Array.from(body.querySelectorAll('br'))) br.replaceWith('\n');
  for (const block of Array.from(body.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,h5,h6'))) {
    block.append('\n');
  }
  return (body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
