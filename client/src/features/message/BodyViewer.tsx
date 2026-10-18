/**
 * 본문 렌더링 (webmail-architecture.md 3.7, webmail-issues.md 2-4).
 *
 * 서버 정화가 없으므로 본문 HTML 은 반드시 sandbox iframe 안에서만 그린다.
 *  - allow-scripts 는 높이 측정용 최소한만, allow-same-origin 은 금지(opaque origin)
 *  - iframe 내부 CSP 로 원격 이미지 차단(img-src data:), 스크립트는 우리 것만(nonce)
 *  - DOMPurify 브라우저 빌드로 1차 정화
 *  - cid: 인라인 이미지는 파싱한 파트를 data: URI 로 치환 (blob: 은 opaque origin 에서
 *    열리지 않는다 — mime/dataUri.ts 주석 참고)
 *  - 원격 이미지는 기본 차단, 사용자가 허용하면 CSP 에 https: 를 추가해 다시 그린다
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { ParsedMail } from '../../mime/parser';
import { useT } from '../../i18n';

interface Props {
  mail: ParsedMail;
  /** cid -> blob URL 매핑 */
  cidUrls: Map<string, string>;
}

function buildSrcDoc(html: string, allowRemoteImages: boolean, nonce: string): string {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcdoc'],
    ADD_ATTR: ['target'],
  });

  // 인라인 이미지는 data:, 첨부 미리보기는 없다. blob: 은 이 안에서 열리지 않으므로 뺀다.
  const imgSrc = allowRemoteImages ? 'data: https:' : 'data:';
  // script-src 'none' 이면 아래 높이 재기 스크립트까지 막혀 본문이 200px 에 잘린 채 남는다.
  // 볼 때마다 새로 뽑는 nonce 를 우리 스크립트에만 달아, 정화를 빠져나온 메일 쪽
  // 스크립트는 그대로 막으면서 우리 것만 돌린다.
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  // 외부 링크는 새 탭 + noopener. 높이는 내부에서 재어 postMessage 로 알린다.
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <base target="_blank">
    <style>
      html,body{margin:0;padding:12px;font-family:system-ui,'Malgun Gothic',sans-serif;
        font-size:14px;line-height:1.6;color:#111;word-break:break-word;overflow-x:auto}
      a{color:#2563eb}
      img{max-width:100%;height:auto}
    </style></head><body>${clean}
    <script nonce="${nonce}">
      (function(){
        document.querySelectorAll('a[href]').forEach(function(a){a.rel='noopener noreferrer';});
        function report(){parent.postMessage({type:'j9-height',height:document.body.scrollHeight},'*');}
        report(); window.addEventListener('load',report);
        new ResizeObserver(report).observe(document.body);
      })();
    <\/script></body></html>`;
}

export function BodyViewer({ mail, cidUrls }: Props) {
  const t = useT();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const [allowRemote, setAllowRemote] = useState(false);

  // 이 화면을 보는 동안만 쓰는 값. 메일 HTML 은 이 값을 알 수 없다
  const nonce = useMemo(() => Math.random().toString(36).slice(2) + Date.now().toString(36), []);

  // cid: 참조를 인라인 파트의 data: URI 로 치환한 본문
  const html = useMemo(() => {
    const source = mail.html ?? (mail.text ? `<pre style="white-space:pre-wrap">${escapeHtml(mail.text)}</pre>` : '');
    if (!source || !/cid:/i.test(source)) return source;
    // 문자열을 바꿔치기하지 않고 DOM 으로 맞춘다 — cid 를 적는 모양(대소문자, <> 감싸기)이
    // 보내는 메일 앱마다 달라서 그대로 비교하면 놓친다.
    const byId = new Map<string, string>();
    for (const [cid, url] of cidUrls) byId.set(cid.replace(/[<>]/g, '').toLowerCase(), url);
    const doc = new DOMParser().parseFromString(source, 'text/html');
    for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
      const src = img.getAttribute('src') ?? '';
      if (!/^cid:/i.test(src)) continue;
      const found = byId.get(src.slice(4).replace(/[<>]/g, '').toLowerCase());
      // 가리키는 파트가 없으면(상한을 넘겨 첨부로 내려갔거나 원본에 없다) 깨진 액자를 남기지 않는다
      if (found) img.setAttribute('src', found);
      else img.remove();
    }
    return doc.body.innerHTML;
  }, [mail, cidUrls]);

  const hasRemoteImages = useMemo(() => /<img[^>]+src=["']https?:/i.test(mail.html ?? ''), [mail.html]);
  const srcDoc = useMemo(() => buildSrcDoc(html, allowRemote, nonce), [html, allowRemote, nonce]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'j9-height') {
        setHeight(Math.min(Math.max(Number(event.data.height) + 24, 120), 20000));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="body-frame">
      {hasRemoteImages && !allowRemote && (
        <div className="remote-banner">
          {t('read.remoteBlocked')}
          <button className="btn" onClick={() => setAllowRemote(true)}>{t('read.showImages')}</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="mail-body"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ width: '100%', border: 'none', flex: 1, minHeight: height }}
      />
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
