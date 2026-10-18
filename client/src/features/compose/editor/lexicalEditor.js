/**
 * 메일 본문용 리치 텍스트 에디터.
 *  - Callout9(https://gujc71.github.io/test/Callout9.html)에서 쓰던 Lexical 기반 에디터를
 *    메일쓰기 본문 입력칸에 맞게 옮겨 온 것이다. 트리 노드 분할·마크다운 변환처럼
 *    문서 생성기에만 필요하던 기능은 덜어 내고, HTML 만 주고받는다.
 *  - 번들(public/vendor/lexical.bundle.js)은 window.LexicalBundle 로 네임스페이스를 노출한다.
 *    React 와 무관한 순수 DOM 코드이므로 래퍼(HtmlEditor.tsx)가 붙였다 떼는 식으로 쓴다.
 */

/* 인라인 스타일 중 에디터가 다루는 속성 (지우기·색 동기화 대상) */
const STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size'];

/* ── 본문에 박아 넣는 인라인 이미지 ────────────────
   붙여넣은 그림은 data: URI 로 본문에 들어가고, 발송할 때 서버(mime/build.ts 의
   inlineDataUrisToCid)가 cid: 인라인 파트로 바꿔 내보낸다. */
/* 이미지 한 장의 상한. 넘으면 줄여서 넣는다 */
const IMG_MAX_BYTES = 1024 * 1024;
/* 줄일 때 맞추는 한 변 길이 */
const IMG_MAX_SIDE = 1600;
/* 본문 전체 합계 상한. 서버 multipart fieldSize(server/src/app.ts) 와 짝을 맞춘다 */
const IMG_TOTAL_MAX = 6 * 1024 * 1024;
/* 본문에 넣는 종류. SVG 는 받는 쪽 메일 앱이 대개 그리지 않아 빼 둔다 */
const IMG_TYPE_RE = /^image\/(?!svg)/i;
/* 캔버스로 다시 그리면 첫 장만 남는 것들. 크면 줄이지 않고 거절한다 */
const IMG_ANIMATED_RE = /^image\/(gif|apng|avif)$/i;

/* data: URI 가 물고 있는 실제 바이트 수 (base64 네 글자가 3바이트) */
function dataUrlBytes(url){
  const at = url.indexOf(',');
  if (at < 0) return url.length;
  const b64 = url.slice(at + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - pad;
}

function readAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('파일을 읽지 못했습니다.'));
    fr.readAsDataURL(file);
  });
}

/* 캔버스로 다시 그려 IMG_MAX_BYTES 아래로 줄인다. 화면 캡처 PNG 는 JPEG 로 굳히면
   본문에서 차이가 보이지 않는데도 크기가 한 자리 수로 떨어진다. 투명한 자리는 흰색이
   된다 — JPEG 에 알파가 없어, 깔아 두지 않으면 검게 나온다. */
async function shrinkToDataUrl(file){
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, IMG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    for (let quality = 0.85; quality >= 0.5; quality -= 0.15, scale *= 0.8){
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const url = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(url) <= IMG_MAX_BYTES) return url;
    }
    return null;
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/* ── Lexical bundle loader ──────────────────────── */
/* vite 의 base 를 그대로 따른다 (public/vendor/ 에 그대로 실려 나간다) */
const BUNDLE_SRC = (import.meta.env?.BASE_URL || '/') + 'vendor/lexical.bundle.js';
let LEX = null;
let loading = null;

/* 번들을 한 번만 내려받는다. 두 번째 호출부터는 같은 Promise 를 돌려준다. */
export function ensureLexical(){
  if (LEX) return Promise.resolve(LEX);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    let el = document.querySelector('script[data-lexical-bundle]');
    if (!el){
      el = document.createElement('script');
      el.src = BUNDLE_SRC;
      el.async = true;
      el.dataset.lexicalBundle = '1';
      document.head.appendChild(el);
    }
    if (window.LexicalBundle) return resolve();
    el.addEventListener('load', () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('lexical.bundle.js 를 불러오지 못했습니다.')), { once: true });
  }).then(() => {
    const B = window.LexicalBundle;
    const NS = ['core','rich','list','code','link','html','table','hist','util','sel'];
    const missing = B ? NS.filter(k => !B[k]) : NS;
    if (!B || missing.length){
      throw new Error(B ? '번들에 없는 네임스페이스: ' + missing.join(', ')
                        : 'lexical.bundle.js 를 불러오지 못했습니다.');
    }
    defineExtraNodes(B);
    LEX = B;
    return B;
  }).catch(err => { loading = null; throw err; });
  return loading;
}

const LEX_THEME = {
  paragraph:'p', quote:'q',
  heading:{ h1:'h1', h2:'h2', h3:'h3', h4:'h4', h5:'h5', h6:'h6' },
  list:{ ul:'ul', ol:'ol', checklist:'cl', listitem:'li',
         listitemChecked:'li-x', listitemUnchecked:'li-o', nested:{ listitem:'li' } },
  text:{ bold:'b', italic:'i', underline:'u', strikethrough:'s', code:'code',
         subscript:'sub', superscript:'sup', highlight:'hl' },
  code:'code-block', link:'link',
  table:'tbl', tableRow:'tbl-r', tableCell:'tbl-c', tableCellHeader:'tbl-h',
  tableCellSelected:'sel-cell',
  /* Prism token names -> the short classes styled in the page's CSS */
  codeHighlight:{
    comment:'tk-c', prolog:'tk-c', doctype:'tk-c', cdata:'tk-c',
    punctuation:'tk-p', namespace:'tk-p',
    property:'tk-n', tag:'tk-k', boolean:'tk-n', number:'tk-n', constant:'tk-n',
    symbol:'tk-n', deleted:'tk-s', selector:'tk-s', 'attr-name':'tk-n',
    string:'tk-s', char:'tk-s', builtin:'tk-f', inserted:'tk-s',
    operator:'tk-o', entity:'tk-o', url:'tk-s', variable:'tk-n',
    atrule:'tk-k', 'attr-value':'tk-s', keyword:'tk-k', 'class-name':'tk-f',
    function:'tk-f', regex:'tk-s', important:'tk-k'
  }
};

/* 테마가 붙이는 클래스 이름 전부. 내보낼 때 이것만 골라 떼어 낸다. */
const THEME_CLASSES = new Set();
(function collect(o){
  for (const v of Object.values(o)){
    if (typeof v === 'string') THEME_CLASSES.add(v);
    else if (v) collect(v);
  }
})(LEX_THEME);

/* 메일로 나가는 HTML 에서 테마 클래스를 걷어 낸다. 받는 쪽에는 이 스타일시트가 없어서
   class="p" 같은 이름은 아무 일도 못 하고, 굵게·색·표 테두리처럼 눈에 보이는 것은 전부
   인라인 스타일로 따라간다. 체크 목록은 클래스가 아니라 __lexicallisttype 과 aria-checked
   로 남으므로 떼어 내도 그대로 살아 돌아온다. */
function stripThemeClasses(src){
  const doc = new DOMParser().parseFromString(src || '', 'text/html');
  for (const el of doc.body.querySelectorAll('[class]')){
    const keep = [...el.classList].filter(c => !THEME_CLASSES.has(c));
    if (keep.length) el.className = keep.join(' ');
    else el.removeAttribute('class');
  }
  return doc.body.innerHTML;
}

/* ── Extra nodes the bundle does not ship ──────────
   A horizontal rule is a leaf block with no children, so it is a DecoratorNode whose
   decoration is the <hr> itself. Without it every "---" in an opened markdown file was
   silently dropped on the way into the editor. */
let HorizontalRuleNode = null, $createHorizontalRuleNode = null, $isHorizontalRuleNode = null;
/* 번들에는 이미지 노드가 없다. 없는 채로 두면 Lexical 의 HTML import 가 <img> 를 통째로
   버려서, 붙여넣은 그림은 물론 답장 인용문에 섞인 인라인 이미지(quote.ts 가 cid: 를
   data: 로 바꿔 넣은 것)까지 조용히 사라진다. 글자 사이에 놓이므로 inline 이다. */
let ImageNode = null, $createImageNode = null;
function defineExtraNodes({ core }){
  if (HorizontalRuleNode) return;
  class HR extends core.DecoratorNode {
    static getType(){ return 'horizontalrule'; }
    static clone(n){ return new HR(n.__key); }
    static importJSON(){ return $createHorizontalRuleNode(); }
    static importDOM(){
      return { hr: () => ({ conversion: () => ({ node: $createHorizontalRuleNode() }), priority: 0 }) };
    }
    exportJSON(){ return { type:'horizontalrule', version:1 }; }
    exportDOM(){ return { element: document.createElement('hr') }; }
    createDOM(){ return document.createElement('hr'); }
    updateDOM(){ return false; }
    getTextContent(){ return '\n'; }
    isInline(){ return false; }
    decorate(){ return null; }
  }
  HorizontalRuleNode = HR;
  $createHorizontalRuleNode = () => core.$applyNodeReplacement(new HR());
  $isHorizontalRuleNode = n => n instanceof HR;

  class Img extends core.DecoratorNode {
    static getType(){ return 'image'; }
    static clone(n){ return new Img(n.__src, n.__alt, n.__width, n.__height, n.__key); }
    static importJSON(json){ return $createImageNode(json.src, json.altText, json.width, json.height); }
    static importDOM(){
      return { img: () => ({ conversion: el => {
        const src = el.getAttribute('src') || '';
        /* 받는 쪽에서 열릴 수 없는 주소(blob:, file:, 워드가 심어 둔 내부 경로)는
           들이지 않는다. 빈 액자만 남겨 보내는 것보다 낫다. */
        if (!/^(https?:|data:image\/|cid:)/i.test(src)) return null;
        return { node: $createImageNode(src, el.getAttribute('alt') || '',
                                        el.getAttribute('width') || '', el.getAttribute('height') || '') };
      }, priority: 0 }) };
    }
    constructor(src, alt, width, height, key){
      super(key);
      this.__src = src || '';
      this.__alt = alt || '';
      this.__width = width || '';
      this.__height = height || '';
    }
    exportJSON(){
      return { type:'image', version:1, src:this.__src, altText:this.__alt,
               width:this.__width, height:this.__height };
    }
    /* 나가는 HTML 에는 받는 쪽이 알아보는 것만 남긴다. max-width 는 좁은 화면에서
       본문 폭을 넘지 않게 하는 최소한의 보험이다. */
    exportDOM(){
      const el = document.createElement('img');
      el.setAttribute('src', this.__src);
      if (this.__alt) el.setAttribute('alt', this.__alt);
      if (this.__width) el.setAttribute('width', this.__width);
      if (this.__height) el.setAttribute('height', this.__height);
      el.setAttribute('style', 'max-width:100%;height:auto');
      return { element: el };
    }
    createDOM(){
      const el = document.createElement('img');
      el.src = this.__src;
      el.alt = this.__alt;
      if (this.__width) el.setAttribute('width', this.__width);
      if (this.__height) el.setAttribute('height', this.__height);
      /* 편집 중에 그림을 끌면 브라우저가 제 방식으로 옮겨 버린다 */
      el.draggable = false;
      return el;
    }
    updateDOM(prev){
      return prev.__src !== this.__src || prev.__alt !== this.__alt
          || prev.__width !== this.__width || prev.__height !== this.__height;
    }
    getSrc(){ return this.getLatest().__src; }
    /* 글자 수·단어 수에는 세지 않는다 */
    getTextContent(){ return ''; }
    isInline(){ return true; }
    decorate(){ return null; }
  }
  ImageNode = Img;
  $createImageNode = (src, alt, width, height) =>
    core.$applyNodeReplacement(new Img(src, alt, width, height));
}
/* ── Toolbar building blocks ──────────────────────── */
const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
/* "Bold" + "b" -> "Bold (Ctrl+B)", so every button advertises its shortcut */
const withKey = (title, keys) => keys ? `${title} (${keys})` : title;

/* Shared builder for the top toolbar. An item is either a ready-made element or
   [label, fn, title, opts]; a null fn draws a separator. */
function buildToolbar(bar, items){
  for (const item of items){
    if (item instanceof HTMLElement){ bar.appendChild(item); continue; }
    const [label, fn, title, opts] = item;
    if (!fn){ const s = document.createElement('div'); s.className = 'lx-sep'; bar.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'lx-tb'; b.type = 'button'; b.innerHTML = label;
    if (title) b.title = title;
    if (opts && opts.toggle) b.setAttribute('aria-pressed', 'false');
    if (opts && opts.label) b.setAttribute('aria-label', opts.label);
    else if (title) b.setAttribute('aria-label', title.replace(/\s*\([^)]*\)\s*$/, ''));
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
}
/* One tab stop for the whole toolbar, arrows to move inside it - the pattern screen
   readers and keyboard users expect from a toolbar, instead of 25 tab stops. */
function rovingToolbar(bar){
  bar.setAttribute('role', 'toolbar');
  const stops = () => [...bar.querySelectorAll('button,select,input,.lx-pick-btn')]
    .filter(el => !el.disabled && el.offsetParent !== null);
  const paint = active => stops().forEach(el => { el.tabIndex = el === active ? 0 : -1; });
  const first = () => { const s = stops(); if (s.length) paint(s[0]); };
  first();
  bar.addEventListener('focusin', e => { if (stops().includes(e.target)) paint(e.target); });
  bar.addEventListener('keydown', e => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1
              : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : 0;
    if (!dir) return;
    const s = stops();
    if (!s.length) return;
    const i = s.indexOf(document.activeElement);
    const next = dir === 'first' ? s[0] : dir === 'last' ? s[s.length - 1]
               : s[(Math.max(i, 0) + dir + s.length) % s.length];
    e.preventDefault(); paint(next); next.focus();
  });
  return { refresh: first };
}

/* Icons, drawn inline so they inherit the toolbar colour and stay crisp. */
const SVG = b => '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' + b + '</svg>';
const SVGL = b => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
const LIST_BARS = x => [3, 7.15, 11.3]
  .map(y => '<rect x="' + x + '" y="' + y + '" width="' + (15 - x) + '" height="1.7" rx=".85"/>').join('');
const LIST_ITEMS = [
  { value: '',   label: 'editor.listNone',
    icon: SVG('<rect x="1" y="3" width="14" height="1.7" rx=".85"/>' +
              '<rect x="1" y="7.15" width="14" height="1.7" rx=".85"/>' +
              '<rect x="1" y="11.3" width="9" height="1.7" rx=".85"/>') },
  { value: 'ul', label: 'editor.listBullet',
    icon: SVG([3.85, 8, 12.15].map(cy => '<circle cx="2.4" cy="' + cy + '" r="1.5"/>').join('') +
              LIST_BARS(6)) },
  { value: 'ol', label: 'editor.listNumber',
    icon: SVG([[5.9, '1'], [10.05, '2'], [14.2, '3']].map(([y, d]) =>
                '<text x="2.6" y="' + y + '" font-size="6.2" font-weight="700" text-anchor="middle"' +
                ' font-family="ui-monospace,monospace">' + d + '</text>').join('') +
              LIST_BARS(6)) },
  { value: 'check', label: 'editor.listCheck',
    icon: SVG([2.15, 6.3, 10.45].map(y =>
                '<rect x="1" y="' + y + '" width="3.6" height="3.6" rx=".9" fill="none" ' +
                'stroke="currentColor" stroke-width="1.2"/>').join('') + LIST_BARS(6.6)) }
];
const ALIGN_ITEMS = [
  { value: 'left',    label: 'editor.alignLeft',    icon: SVG(alignBars([15, 10, 15, 9], 1)) },
  { value: 'center',  label: 'editor.alignCenter',  icon: SVG(alignBars([14, 9, 14, 8], 'c')) },
  { value: 'right',   label: 'editor.alignRight',  icon: SVG(alignBars([15, 10, 15, 9], 'r')) },
  { value: 'justify', label: 'editor.alignJustify', icon: SVG(alignBars([14, 14, 14, 14], 1)) }
];
function alignBars(widths, mode){
  return widths.map((w, i) => {
    const x = mode === 'c' ? (16 - w) / 2 : mode === 'r' ? 15 - w : 1;
    return '<rect x="' + x + '" y="' + (2.4 + i * 3.4) + '" width="' + w + '" height="1.6" rx=".8"/>';
  }).join('');
}

const ICON = {
  undo:   SVGL('<path d="M3 8.2h6.6a3.2 3.2 0 1 1 0 6.4H6"/><path d="M5.6 5.4 3 8.2l2.6 2.8"/>'),
  redo:   SVGL('<path d="M13 8.2H6.4a3.2 3.2 0 1 0 0 6.4H10"/><path d="M10.4 5.4 13 8.2l-2.6 2.8"/>'),
  link:   SVGL('<path d="M6.7 9.3a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1"/>' +
               '<path d="M9.3 6.7a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1"/>'),
  unlink: SVGL('<path d="M6.7 9.3a2.6 2.6 0 0 0 2.2.7"/><path d="M9.3 6.7a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.1 4"/>' +
               '<path d="M10.6 5.9l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.4 1.4"/><path d="m2.4 2.4 11.2 11.2"/>'),
  image:  SVGL('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/>' +
               '<circle cx="5.5" cy="6.3" r="1.15"/><path d="m2.4 11.7 3.5-3.2 2.5 2.3 2.3-2.1 3.5 3"/>'),
  table:  SVGL('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2"/>' +
               '<path d="M1.8 6.3h12.4M1.8 9.8h12.4M6 2.8v10.4M10 2.8v10.4"/>'),
  hr:     SVG('<rect x="1" y="7.2" width="14" height="1.6" rx=".8"/>' +
              '<rect x="2.5" y="2.6" width="11" height="1.2" rx=".6" opacity=".35"/>' +
              '<rect x="2.5" y="12.2" width="11" height="1.2" rx=".6" opacity=".35"/>'),
  codeblk: SVGL('<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.3"/>' +
               '<path d="M6.2 6.4 4.4 8l1.8 1.6M9.8 6.4 11.6 8l-1.8 1.6"/>'),
  indent: SVG('<rect x="1" y="2.2" width="14" height="1.6" rx=".8"/>' +
              '<rect x="6" y="6" width="9" height="1.6" rx=".8"/>' +
              '<rect x="6" y="9.2" width="9" height="1.6" rx=".8"/>' +
              '<rect x="1" y="12.4" width="14" height="1.6" rx=".8"/>' +
              '<path d="M1 6.2 3.6 8.4 1 10.6z"/>'),
  outdent: SVG('<rect x="1" y="2.2" width="14" height="1.6" rx=".8"/>' +
              '<rect x="6" y="6" width="9" height="1.6" rx=".8"/>' +
              '<rect x="6" y="9.2" width="9" height="1.6" rx=".8"/>' +
              '<rect x="1" y="12.4" width="14" height="1.6" rx=".8"/>' +
              '<path d="M3.6 6.2 1 8.4l2.6 2.2z"/>'),
  find:   SVGL('<circle cx="7.1" cy="7.1" r="4.3"/><path d="m10.4 10.4 3.2 3.2"/>'),
  clear:  SVGL('<path d="M6.4 12.6h7.2"/><path d="M2.6 9.9 6.2 13.5 13.2 6.5 9.6 2.9z"/><path d="m5 6.1 3.6 3.6"/>'),

};

/* Toolbar dropdown that shows an icon beside each option - a native <select> renders
   only plain text in its <option>s. items: [{ value, label, icon }] */
function iconSelect(title, items, onPick, opt){
  const o = opt || {};
  const wrap = document.createElement('div');
  wrap.className = 'lx-pick'; wrap.title = title;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'lx-pick-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-label', title);
  btn.innerHTML = '<span class="lx-ico"></span><span class="lx-lbl' + (o.wide ? ' w' : '') + '"></span>' +
                  '<span class="lx-caret">▾</span>';
  const menu = document.createElement('div');
  menu.className = 'lx-pick-menu' + (o.wide ? ' wide' : '');
  menu.hidden = true; menu.setAttribute('role', 'listbox');
  wrap.append(btn, menu);

  let value = items[0].value;
  const opts = items.map(it => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'lx-pick-opt' + (it.kbd ? ' kbd' : '');
    el.setAttribute('role', 'option'); el.tabIndex = -1;
    if (it.kbd) el.dataset.kbd = it.kbd;
    if (it.style) el.style.cssText = it.style;
    el.innerHTML = '<span class="lx-ico">' + (it.icon || '') + '</span>' +
                   '<span class="lx-lbl">' + it.label + '</span>';
    el.addEventListener('click', () => { open(false); btn.focus(); set(it.value); onPick(it.value); });
    menu.appendChild(el);
    return el;
  });
  function set(v){
    const it = items.find(i => i.value === v) || items[0];
    value = it.value;
    btn.querySelector('.lx-ico').innerHTML = it.icon || '';
    btn.querySelector('.lx-lbl').textContent = it.label;
    opts.forEach((el, i) => {
      const on = items[i].value === value;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  /* Close on an outside click or Escape. The listeners only live while the menu is
     open, so a destroyed editor leaves nothing behind on document. */
  function onDocDown(e){ if (!wrap.contains(e.target)) open(false); }
  function onDocKey(e){
    if (e.key === 'Escape'){ e.stopPropagation(); open(false); btn.focus(); return; }
    if (!menu.contains(document.activeElement) && document.activeElement !== btn) return;
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault(); e.stopPropagation();
    const i = opts.indexOf(document.activeElement);
    const next = e.key === 'Home' ? opts[0] : e.key === 'End' ? opts[opts.length - 1]
               : opts[(Math.max(i, 0) + dir + opts.length) % opts.length];
    next.focus();
  }
  function open(on){
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    const bind = on ? 'addEventListener' : 'removeEventListener';
    document[bind]('mousedown', onDocDown, true);
    document[bind]('keydown', onDocKey, true);
    if (on) (opts.find(el => el.classList.contains('on')) || opts[0]).focus();
  }
  btn.addEventListener('click', () => open(menu.hidden));
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(true); }
  });
  /* keep the caret where it is, exactly like the plain toolbar buttons */
  wrap.addEventListener('mousedown', e => { if (e.target !== btn || menu.hidden) e.preventDefault(); });
  open(false); set(value);
  return { el: wrap, set, get: () => value, close: () => open(false) };
}
/* Bare URLs the auto-link transform picks up as they are typed */
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]/;
const prettyHtml = h => (h || '').replace(/></g, '>\n<');

/* "color"/"background-color"/"font-*" helpers shared by the editor and the MD converters */
function styleMap(css){
  const out = {};
  for (const part of (css || '').split(';')){
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase(), v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}
/* Double quotes would end the style="…" attribute mdText() writes it into, and a font
   stack is the one value that usually carries them. */
const styleText = m => Object.entries(m)
  .map(([k, v]) => k + ': ' + String(v).replace(/"/g, "'")).join('; ');
/* Only the properties that survive a markdown round trip, in a stable order */
function inlineStyle(el){
  const m = {};
  for (const p of STYLE_PROPS){ const v = el.style && el.style.getPropertyValue(p); if (v) m[p] = v.trim(); }
  return styleText(m);
}
/* input[type=color] only accepts #rrggbb, but the stored value may be rgb()/#rgb */
function toHex(v){
  const t = String(v || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return '#' + [...m[1]].map(c => c + c).join('').toLowerCase();
  m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return '#' + m[1].toLowerCase();
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  if (m) return '#' + m.slice(1, 4)
    .map(x => Math.max(0, Math.min(255, Math.round(+x))).toString(16).padStart(2, '0')).join('');
  return null;
}

/* Tableau 10 (2016), each column fading from a deep shade through the base colour
   (row 3) down to a pale tint */
const TABLEAU10 = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
                   '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const mixHex = (hex, to, t) => '#' + [1, 3, 5].map(i => {
  const a = parseInt(hex.slice(i, i + 2), 16);
  return Math.round(a + (to - a) * t).toString(16).padStart(2, '0');
}).join('');
/* hsv: h 0-360, s and v 0-1 - the custom picker's field is s across and v up */
function hsvToHex({ h, s, v }){
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [5, 3, 1].map(n => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('');
}
function hexToHsv(hex){
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) h = ((mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return { h, s: mx ? d / mx : 0, v: mx };
}
const PALETTE = [-.4, -.2, 0, .2, .4, .6, .8].flatMap(t =>
  TABLEAU10.map(c => t > 0 ? mixHex(c, 255, t) : t < 0 ? mixHex(c, 0, -t) : c));

/* Last ten colours picked, shared by the text and highlight pickers. Browser storage can
   be missing or throw, and then the row just stays empty. */
const RECENT_KEY = 'lx.recentColors';
function recentColors(){
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a.filter(c => /^#[0-9a-f]{6}$/.test(c)).slice(0, 10) : [];
  } catch(_){ return []; }
}
function pushRecent(hex){
  const list = [hex, ...recentColors().filter(c => c !== hex)].slice(0, 10);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch(_){}
}

const FONTS = [
  { value: '',                              label: 'editor.default' },
  { value: 'Malgun Gothic, sans-serif',     label: 'editor.fontMalgun' },
  { value: 'Noto Sans KR, sans-serif',      label: 'Noto Sans' },
  { value: 'Batang, serif',                 label: 'editor.fontBatang' },
  { value: 'Georgia, serif',                label: 'Georgia' },
  { value: 'Arial, Helvetica, sans-serif',  label: 'Arial' },
  { value: 'Consolas, ui-monospace, monospace', label: 'Consolas' }
];
const SIZES = ['', '11px', '12px', '13px', '14.5px', '16px', '18px', '22px', '28px', '36px'];
export function mountLexical(shell, opts){
  const { onChange = () => {}, placeholder = '' } = opts || {};
  /* 화면 문구. HtmlEditor 가 i18n 의 t 를 넘겨준다 (editor.* 키). 없으면 키를 그대로 보인다 */
  const T = (opts && opts.t) || (key => key);
  /* 목록 · 정렬 · 글꼴 라벨 중 'editor.' 로 시작하는 것만 키다 (나머지는 글꼴 이름 그대로) */
  const localized = items => items.map(i => ({ ...i, label: i.label.startsWith('editor.') ? T(i.label) : i.label }));
  const { core, rich, list, code, link, html, table, hist, util, sel } = LEX;

  const bar = document.createElement('div'); bar.className = 'lx-bar';
  const holder = document.createElement('div'); holder.className = 'lx-holder';
  const input = document.createElement('div');
  input.className = 'lx-input'; input.contentEditable = 'true';
  input.setAttribute('role','textbox'); input.setAttribute('aria-multiline','true');
  input.setAttribute('aria-label', T('editor.body'));
  input.spellcheck = true;                      // the browser's own spell checker, as elsewhere
  /* HTML source view: a gutter of line numbers beside the textarea */
  const srcWrap = document.createElement('div');
  srcWrap.className = 'lx-src'; srcWrap.hidden = true;
  const gutter = document.createElement('div'); gutter.className = 'lx-gutter'; gutter.setAttribute('aria-hidden','true');
  const source = document.createElement('textarea');
  source.className = 'lx-source'; source.spellcheck = false;
  source.setAttribute('aria-label', T('editor.htmlSource'));
  srcWrap.append(gutter, source);
  holder.append(input, srcWrap);
  /* 빈 본문에 걸쳐 두는 안내문 — contenteditable 에는 placeholder 속성이 없다 */
  const ph = document.createElement('div');
  ph.className = 'lx-ph'; ph.textContent = placeholder; ph.hidden = !placeholder;
  holder.appendChild(ph);
  /* Callout9 는 페이지 전체 토스트를 썼지만, 여기서는 에디터 안에서만 알린다 */
  const toastEl = document.createElement('div');
  toastEl.className = 'lx-toast'; toastEl.setAttribute('role', 'status');
  holder.appendChild(toastEl);
  let toastT = 0;
  function toast(msg, isErr){
    toastEl.textContent = msg;
    toastEl.className = 'lx-toast show' + (isErr ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.className = 'lx-toast' + (isErr ? ' err' : ''); },
                        isErr ? 4200 : 2200);
  }
  shell.append(bar, holder);

  /* Lexical's built-in <span> import drops inline color/background-color/font, so every HTML
     round-trip (save -> reopen, HTML source toggle) would wipe them. This override keeps
     them while still honouring the bold/italic/... styles the built-in one reads. */
  function convertStyledSpan(el){
    const st = el.style;
    const dec = (st.textDecoration || '').split(' ');
    const marks = [
      ['bold', st.fontWeight === 'bold' || +st.fontWeight >= 600],
      ['italic', st.fontStyle === 'italic'],
      ['strikethrough', dec.includes('line-through')],
      ['underline', dec.includes('underline')]
    ];
    const styles = styleMap(inlineStyle(el));
    return {
      node: null,
      forChild: child => {
        if (!core.$isTextNode(child)) return child;
        for (const [fmt, on] of marks) if (on && !child.hasFormat(fmt)) child.toggleFormat(fmt);
        const own = styleMap(child.getStyle());
        /* a nested span already set the property; the inner one wins */
        for (const [k, v] of Object.entries(styles)) if (!(k in own)) own[k] = v;
        child.setStyle(styleText(own));
        return child;
      }
    };
  }

  const editor = core.createEditor({
    namespace: 'callout9',
    theme: LEX_THEME,
    onError: e => console.error(e),
    html: { import: { span: () => ({ conversion: convertStyledSpan, priority: 1 }) } },
    nodes: [rich.HeadingNode, rich.QuoteNode, list.ListNode, list.ListItemNode,
            code.CodeNode, code.CodeHighlightNode, link.LinkNode, link.AutoLinkNode,
            table.TableNode, table.TableRowNode, table.TableCellNode, HorizontalRuleNode,
            ImageNode]
  });
  editor.setRootElement(input);

  const off = [];                                  // everything destroy() has to unwind
  off.push(rich.registerRichText(editor));
  off.push(hist.registerHistory(editor, hist.createEmptyHistoryState(), 300));
  /* Without this the INSERT_*_LIST_COMMAND dispatches below have no handler */
  off.push(list.registerList(editor));
  /* Prism is in the bundle; without this a code block stays unhighlighted plain text */
  off.push(code.registerCodeHighlighting(editor));
  off.push(registerLinks(editor));
  off.push(registerTables(editor));
  off.push(registerChecklist(editor));
  off.push(registerTabIndent(editor));
  off.push(registerMarkdownShortcuts(editor));
  off.push(registerPlainPaste(editor));
  off.push(registerImagePaste(editor));

  /* HTML -> editing state */
  function loadHtml(src){
    editor.update(() => {
      const dom = new DOMParser().parseFromString(src || '<p><br></p>', 'text/html');
      const parsed = html.$generateNodesFromDOM(editor, dom);
      const root = core.$getRoot();
      root.clear();
      for (const n of parsed){
        if (core.$isElementNode(n) || core.$isDecoratorNode(n)) root.append(n);
        else { const p = core.$createParagraphNode(); p.append(n); root.append(p); }
      }
      if (root.getChildrenSize() === 0) root.append(core.$createParagraphNode());
    }, { tag:'history-merge' });
  }
  /* Editing state -> HTML */
  function syncPlaceholder(){
    if (!placeholder) return;
    let empty = false;
    editor.getEditorState().read(() => {
      const root = core.$getRoot();
      const only = root.getFirstChild();
      empty = root.getChildrenSize() <= 1 && root.getTextContent().trim() === ''
              && (!only || !core.$isElementNode(only) || only.getChildrenSize() === 0);
    });
    ph.hidden = !empty || sourceMode;
  }
  function serializeHtml(){
    let out = '';
    editor.getEditorState().read(() => { out = html.$generateHtmlFromNodes(editor, null); });
    return stripThemeClasses(out);
  }

  loadHtml(opts.html || '');

  off.push(editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
    syncPlaceholder();
    if (tags.has('history-merge')) return;
    if (dirtyElements.size || dirtyLeaves.size) onChange();
  }));
  source.addEventListener('input', () => { onChange(); paintGutter(); });

  /* ── HTML source view ─────────────────────────────── */
  let sourceMode = false;
  const paintGutter = () => {
    const n = source.value.split('\n').length;
    gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  };
  function setSourceMode(on){
    sourceMode = on;
    srcWrap.hidden = !on;
    input.hidden  = on;
    ph.hidden = true;
    findBar.hidden = true;
    tbBtn.src.classList.toggle('on', on);
    tbBtn.src.setAttribute('aria-pressed', String(on));
    /* every rich-text control is meaningless while raw HTML is on screen */
    for (const el of bar.querySelectorAll('button,select,input,.lx-pick-btn'))
      if (el !== tbBtn.src) el.disabled = on;
    /* undo/redo answer to the history, not to this switch */
    if (!on){ tbBtn.undo.disabled = !canUndo; tbBtn.redo.disabled = !canRedo; }
    roving.refresh();
  }
  function toggleSource(){
    if (!sourceMode){
      source.value = prettyHtml(serializeHtml());
      paintGutter();
      setSourceMode(true);
      source.focus();
    } else {
      loadHtml(source.value);
      setSourceMode(false);
      syncPlaceholder();
      input.focus();
    }
  }
  /* Tab inserts a real tab instead of leaving the field, the way a code editor behaves */
  source.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value: v } = source;
    source.value = v.slice(0, a) + '  ' + v.slice(b);
    source.selectionStart = source.selectionEnd = a + 2;
    onChange(); paintGutter();
  });

  /* ── Links ────────────────────────────────────────── */
  function registerLinks(ed){
    const un = [
      ed.registerCommand(link.TOGGLE_LINK_COMMAND, payload => {
        link.$toggleLink(payload);
        return true;
      }, core.COMMAND_PRIORITY_EDITOR),
      /* Ctrl/⌘ + click opens the target, the way every editor with links behaves */
      ed.registerCommand(core.CLICK_COMMAND, e => {
        if (!(e.ctrlKey || e.metaKey)) return false;
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return false;
        window.open(a.getAttribute('href'), '_blank', 'noopener');
        return true;
      }, core.COMMAND_PRIORITY_LOW),
      /* Typing a bare URL turns it into a link, but only once a space closes the word -
         linkifying mid-word would swallow the characters still being typed. */
      ed.registerNodeTransform(core.TextNode, textNode => {
        if (!textNode.isSimpleText()) return;
        const parent = textNode.getParent();
        if (!parent || link.$isLinkNode(parent) || link.$isAutoLinkNode(parent)) return;
        if (code.$isCodeNode(parent) || textNode.hasFormat('code')) return;
        const text = textNode.getTextContent();
        const m = URL_RE.exec(text);
        if (!m || !/^\s/.test(text.slice(m.index + m[0].length))) return;
        const target = m[0];
        let mid = textNode;
        if (m.index > 0) mid = textNode.splitText(m.index)[1];
        if (mid.getTextContent().length > target.length) mid.splitText(target.length);
        const auto = link.$createAutoLinkNode(target.startsWith('www.') ? 'https://' + target : target);
        mid.replace(auto);
        auto.append(core.$createTextNode(target));
      })
    ];
    return () => un.forEach(f => f());
  }

  /* ── Tables ───────────────────────────────────────── */
  /* applyTableHandlers() is what gives a table drag-select across cells, Tab between
     cells, arrow-key exit and column resizing. It is per table element, so it is wired
     up as tables appear and torn down as they go. */
  function registerTables(ed){
    const live = new Map();
    const un = [
      ed.registerCommand(table.INSERT_TABLE_COMMAND, ({ rows, columns, includeHeaders }) => {
        const t = table.$createTableNodeWithDimensions(+rows, +columns, includeHeaders !== false);
        util.$insertNodeToNearestRoot(t);
        const first = t.getFirstDescendant();
        if (first) first.selectStart();
        return true;
      }, core.COMMAND_PRIORITY_EDITOR),
      ed.registerMutationListener(table.TableNode, muts => {
        const fresh = [];
        for (const [key, kind] of muts){
          if (kind === 'destroyed'){ live.get(key)?.(); live.delete(key); continue; }
          if (!live.has(key)) fresh.push(key);
        }
        if (!fresh.length) return;
        /* the node handle is read inside the editor state, the wiring happens outside it */
        const found = [];
        ed.getEditorState().read(() => {
          for (const key of fresh){
            const n = core.$getNodeByKey(key), el = ed.getElementByKey(key);
            if (n && el) found.push([key, n, el]);
          }
        });
        for (const [key, n, el] of found){
          try {
            const obs = table.applyTableHandlers(n, el, ed, true);
            live.set(key, () => { try { obs.removeListeners(); } catch(_){} });
          } catch(err){ console.warn('table handlers could not be attached', err); }
        }
      })
    ];
    return () => { un.forEach(f => f()); live.forEach(f => f()); live.clear(); };
  }
  const tableOp = fn => editor.update(() => {
    const s = core.$getSelection();
    if (!core.$isRangeSelection(s) && !table.$isTableSelection(s)) return;
    try { fn(); } catch(err){ toast(T('editor.tableOnly'), true); }
  });

  /* ── Checklist ────────────────────────────────────── */
  /* registerList() handles bullets and numbers; the check variant and the click-to-tick
     behaviour are the part the bundle leaves to the host. */
  function registerChecklist(ed){
    const un = [
      ed.registerCommand(list.INSERT_CHECK_LIST_COMMAND, () => {
        list.insertList(ed, 'check');
        return true;
      }, core.COMMAND_PRIORITY_LOW),
      ed.registerCommand(core.CLICK_COMMAND, e => {
        const li = e.target && e.target.closest && e.target.closest('li.li-o, li.li-x');
        if (!li) return false;
        /* only the marker toggles; clicking the label should place the caret */
        if (e.clientX > li.getBoundingClientRect().left) return false;
        const n = core.$getNearestNodeFromDOMNode(li);
        if (!list.$isListItemNode(n)) return false;
        n.toggleChecked();
        return true;
      }, core.COMMAND_PRIORITY_LOW)
    ];
    return () => un.forEach(f => f());
  }

  /* ── Tab indents, Shift+Tab outdents ──────────────── */
  function registerTabIndent(ed){
    return ed.registerCommand(core.KEY_TAB_COMMAND, e => {
      const s = core.$getSelection();
      if (!core.$isRangeSelection(s)) return false;
      /* inside a table Tab moves to the next cell - that handler runs first */
      if (util.$findMatchingParent(s.anchor.getNode(), n => table.$isTableCellNode(n))) return false;
      e.preventDefault();
      ed.dispatchCommand(e.shiftKey ? core.OUTDENT_CONTENT_COMMAND : core.INDENT_CONTENT_COMMAND, undefined);
      return true;
    }, core.COMMAND_PRIORITY_LOW);
  }

  /* ── Markdown shortcuts ───────────────────────────── */
  /* "# " turns the line into a heading, "- " into a bullet, "> " into a quote and so on -
     the typing rhythm anyone who writes markdown expects. Runs on the space that closes
     the marker, and Ctrl+Z right after puts the literal text back. */
  const BLOCK_SHORTCUTS = [
    [/^(#{1,6})$/,        (m, ed) => blockAt(() => rich.$createHeadingNode('h' + m[1].length))],
    [/^>$/,               ()      => blockAt(() => rich.$createQuoteNode())],
    [/^[-*+]$/,           (m, ed) => ed.dispatchCommand(list.INSERT_UNORDERED_LIST_COMMAND, undefined)],
    [/^\[[ xX]?\]$/,      (m, ed) => ed.dispatchCommand(list.INSERT_CHECK_LIST_COMMAND, undefined)],
    [/^\d{1,9}[.)]$/,     (m, ed) => ed.dispatchCommand(list.INSERT_ORDERED_LIST_COMMAND, undefined)]
  ];
  function registerMarkdownShortcuts(ed){
    const un = [
      ed.registerCommand(core.KEY_SPACE_COMMAND, () => {
        const s = core.$getSelection();
        if (!core.$isRangeSelection(s) || !s.isCollapsed()) return false;
        const n = s.anchor.getNode();
        if (!core.$isTextNode(n) || n.getIndexWithinParent() !== 0) return false;
        const block = n.getParent();
        if (!block || !core.$isParagraphNode(block)) return false;
        const head = n.getTextContent().slice(0, s.anchor.offset);
        for (const [re, run] of BLOCK_SHORTCUTS){
          const m = re.exec(head);
          if (!m) continue;
          n.spliceText(0, head.length, '', true);      // the marker itself is consumed
          run(m, ed);
          return true;
        }
        return false;
      }, core.COMMAND_PRIORITY_LOW),
      /* "```" or "---" on a line of its own, closed with Enter */
      ed.registerCommand(core.KEY_ENTER_COMMAND, e => {
        const s = core.$getSelection();
        if (!core.$isRangeSelection(s) || !s.isCollapsed()) return false;
        const block = s.anchor.getNode().getTopLevelElement();
        if (!block || !core.$isParagraphNode(block)) return false;
        const text = block.getTextContent();
        const fence = /^(`{3,}|~{3,})([A-Za-z0-9_+#-]*)$/.exec(text);
        if (fence){
          if (e) e.preventDefault();
          const c = code.$createCodeNode(fence[2] || undefined);
          block.replace(c);
          c.selectStart();
          return true;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)){
          if (e) e.preventDefault();
          const hr = $createHorizontalRuleNode(), p = core.$createParagraphNode();
          block.replace(hr);
          hr.insertAfter(p);            // the caret carries on below the rule, not at the end
          p.selectStart();
          return true;
        }
        return false;
      }, core.COMMAND_PRIORITY_LOW)
    ];
    return () => un.forEach(f => f());
  }

  /* ── Paste without formatting (Ctrl/⌘ + Shift + V) ── */
  function registerPlainPaste(ed){
    return ed.registerCommand(core.PASTE_COMMAND, e => {
      if (!plainPasteArmed) return false;
      plainPasteArmed = false;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text == null) return false;
      e.preventDefault();
      ed.update(() => {
        const s = core.$getSelection();
        if (core.$isRangeSelection(s)) s.insertRawText(text);
      });
      return true;
    }, core.COMMAND_PRIORITY_CRITICAL);
  }
  let plainPasteArmed = false, armT = 0;
  input.addEventListener('keydown', e => {
    if (!((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v')) return;
    plainPasteArmed = true;
    /* if the paste never arrives (the OS swallowed it, the clipboard was empty) the arming
       must not sit there and turn the next ordinary Ctrl+V into a plain one */
    clearTimeout(armT);
    armT = setTimeout(() => { plainPasteArmed = false; }, 1000);
  });

  /* ── 이미지 붙여넣기 ─────────────────────────────── */
  /* 클립보드에 그림이 담겨 오면 (화면 캡처, 웹페이지에서 이미지 복사, 탐색기에서 파일 복사)
     본문에 data: URI 로 박아 넣는다. 발송할 때 서버가 cid: 인라인 파트로 바꾼다.

     먼저 "이것은 그림 붙여넣기다" 를 가려낸다.
     글자와 함께 복사한 서식 있는 조각(문단 + 그림)은 HTML 쪽에 맡겨야 한다 — 그 안의
     <img> 는 이제 ImageNode 가 받는다. 그 갈림길은 클립보드에 글자가 함께 실려 있는지로
     보는데, 무엇을 "글자" 로 볼지가 까다롭다.
      - 화면 캡처: 파일 하나뿐, 글자 없음                       -> 그림
      - 브라우저·워드의 "이미지 복사": html 이 <img> 한 장뿐     -> 그림
      - 탐색기에서 파일 복사: text/plain 에 파일 이름·경로만     -> 그림
      - 문단을 긁어 복사: html·text 에 실제 글자                 -> HTML 쪽에 맡긴다
     text/plain 을 그냥 "글자 있음" 으로 세면 세 번째가 조용히 버려지고, 아예 보지 않으면
     네 번째에서 글자를 잃는다. 그래서 html 이 있으면 그 글자로, 없으면 text/plain 이
     파일 이름처럼 생겼는지로 가린다. */
  const FILE_NAME_RE = /^(?:[a-z]:[\\/]|[\\/]{1,2}|file:)?[^\r\n"]{0,260}\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i;
  function clipboardImages(dt){
    let files = Array.from(dt.files || []);
    if (!files.length && dt.items){
      /* files 를 채우지 않고 items 로만 주는 브라우저가 있다. 둘 다 이 자리에서
         (이벤트 처리 중에) 읽어야 하고, 나중에는 비어 버린다. */
      files = Array.from(dt.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile());
    }
    const images = files.filter(f => f && IMG_TYPE_RE.test(f.type));
    if (!images.length) return [];
    const markup = dt.getData('text/html') || '';
    if (markup){
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      return (doc.body.textContent || '').trim() ? [] : images;
    }
    const plain = (dt.getData('text/plain') || '').trim();
    if (plain && !FILE_NAME_RE.test(plain)) return [];
    return images;
  }

  function registerImagePaste(ed){
    return ed.registerCommand(core.PASTE_COMMAND, e => {
      if (plainPasteArmed) return false;              // Ctrl/⌘+Shift+V 는 평문 쪽이 맡는다
      const dt = e.clipboardData;
      if (!dt) return false;
      const files = clipboardImages(dt);
      if (!files.length) return false;
      e.preventDefault();
      /* Lexical 은 PASTE_COMMAND 를 editor.update() 안에서 쏜다. 그 안에서 상태를 읽거나
         고치면 엉키므로 이 업데이트가 끝난 뒤로 미룬다. 실패는 토스트로 드러낸다 —
         눌렀는데 아무 일도 없는 것이 제일 나쁘다. */
      defer(() => insertImageFiles(files));
      return true;
    }, core.COMMAND_PRIORITY_CRITICAL);
  }

  /* 이미지 삽입은 무슨 일이 있어도 조용히 죽지 않게 한다 */
  function defer(run){
    Promise.resolve().then(run).catch(err => {
      console.error('이미지를 본문에 넣지 못했습니다', err);
      toast(T('editor.imageFailed'), true);
    });
  }

  /* 지금 본문에 박혀 있는 인라인 이미지의 합계 바이트 */
  function inlineImageBytes(){
    let sum = 0;
    editor.getEditorState().read(() => {
      for (const n of core.$nodesOfType(ImageNode)){
        const src = n.getSrc();
        if (src.startsWith('data:')) sum += dataUrlBytes(src);
      }
    });
    return sum;
  }

  const asMb = bytes => Math.round(bytes / (1024 * 1024));

  /* 툴바 [이미지 넣기]. 클립보드가 어떤 모양으로 오든 상관없는 길을 하나 열어 둔다. */
  const filePick = document.createElement('input');
  filePick.type = 'file'; filePick.accept = 'image/*'; filePick.multiple = true;
  filePick.hidden = true;
  shell.appendChild(filePick);
  /* 파일 고르는 창이 뜨는 동안 편집 영역이 포커스를 잃으므로, 넣을 자리를 미리 붙잡아 둔다 */
  let pickRange = null;
  filePick.addEventListener('change', () => {
    const picked = Array.from(filePick.files || []).filter(f => IMG_TYPE_RE.test(f.type));
    const at = pickRange;
    filePick.value = '';                     // 같은 파일을 다시 골라도 change 가 오도록
    if (picked.length) defer(() => insertImageFiles(picked, at));
  });
  function askImage(){
    pickRange = editor.getEditorState().read(() => {
      const sel = core.$getSelection();
      return core.$isRangeSelection(sel) ? sel.clone() : null;
    });
    filePick.click();
  }

  /* 한 장씩 차례로 넣는다. 캔버스로 줄이는 사이에 본문이 달라질 수 있어 매번 그 시점의
     선택 위치에 꽂는다 — 여러 장을 붙여넣으면 넣은 순서대로 이어 붙는다. */
  async function insertImageFiles(files, at){
    let budget = IMG_TOTAL_MAX - inlineImageBytes();
    for (const file of files){
      const name = file.name || T('editor.imageName');
      let url = null;
      try {
        if (file.size <= IMG_MAX_BYTES) url = await readAsDataUrl(file);
        else if (!IMG_ANIMATED_RE.test(file.type)) url = await shrinkToDataUrl(file);
      } catch (err){
        console.warn('인라인 이미지를 만들지 못했습니다', err);
      }
      if (!url || !/^data:image\//i.test(url)){
        toast(T('editor.imageTooBig', { name }), true);
        continue;
      }
      const bytes = dataUrlBytes(url);
      if (bytes > budget){
        toast(T('editor.imageTotalTooBig', { mb: asMb(IMG_TOTAL_MAX) }), true);
        break;
      }
      budget -= bytes;
      editor.update(() => {
        /* 파일 선택 창을 거쳐 온 길은 포커스가 빠져 선택이 없을 수 있다 */
        if (at && !core.$isRangeSelection(core.$getSelection())) core.$setSelection(at.clone());
        const s = core.$getSelection();
        const node = $createImageNode(url, name);
        if (core.$isRangeSelection(s)){
          s.insertNodes([node]);
          /* 루트에 바로 떨어지면 문단으로 감싼다. 인라인 노드는 문단 없이 서지 못한다 */
          const parent = node.getParent();
          if (parent && core.$isRootOrShadowRoot(parent)) util.$wrapNodeInElement(node, core.$createParagraphNode);
        } else {
          const p = core.$createParagraphNode();
          p.append(node);
          core.$getRoot().append(p);
        }
      });
    }
  }

  /* ── Commands the toolbar drives ──────────────────── */
  const blockAt = factory => editor.update(() => {
    const s = core.$getSelection();
    if (core.$isRangeSelection(s)) sel.$setBlocksType(s, factory);
  });
  const fmt = f => { editor.dispatchCommand(core.FORMAT_TEXT_COMMAND, f); input.focus(); };
  const align = a => { editor.dispatchCommand(core.FORMAT_ELEMENT_COMMAND, a); input.focus(); };
  const cmd = (c, arg) => { editor.dispatchCommand(c, arg); input.focus(); };
  /* Quote is a toggle: pressing it inside a quote drops back to a plain paragraph,
     the same way the list picker turns a list off again. */
  const inQuote = () => {
    const s = core.$getSelection();
    return core.$isRangeSelection(s) && rich.$isQuoteNode(s.anchor.getNode().getTopLevelElement());
  };
  const inCode = () => {
    const s = core.$getSelection();
    return core.$isRangeSelection(s) && code.$isCodeNode(s.anchor.getNode().getTopLevelElement());
  };
  function toggleQuote(){
    let on = false;
    editor.getEditorState().read(() => { on = inQuote(); });
    blockAt(() => on ? core.$createParagraphNode() : rich.$createQuoteNode());
    input.focus();
  }
  function toggleCodeBlock(){
    let on = false;
    editor.getEditorState().read(() => { on = inCode(); });
    blockAt(() => on ? core.$createParagraphNode() : code.$createCodeNode());
    input.focus();
  }
  /* Strips every character format, the inline colour/font styles and the block type in
     one go - the ✕ button used to clear only the two colours. */
  function clearFormatting(){
    editor.update(() => {
      const s = core.$getSelection();
      if (!core.$isRangeSelection(s)) return;
      for (const f of ['bold','italic','underline','strikethrough','code','subscript','superscript','highlight'])
        if (s.hasFormat(f)) s.formatText(f);
      sel.$patchStyleText(s, Object.fromEntries(STYLE_PROPS.map(p => [p, null])));
      for (const n of s.getNodes()){
        if (core.$isTextNode(n)){ n.setFormat(0); n.setStyle(''); }
        const l = util.$findMatchingParent(n, p => link.$isLinkNode(p) || link.$isAutoLinkNode(p));
        if (l){ const kids = l.getChildren(); kids.forEach(k => l.insertBefore(k)); l.remove(); }
      }
    });
    /* a list or a quote is a block format too, so the block type goes back to Body */
    editor.dispatchCommand(list.REMOVE_LIST_COMMAND, undefined);
    blockAt(() => core.$createParagraphNode());
    input.focus();
  }

  /* ── Link editing popover ─────────────────────────── */
  const pop = document.createElement('div');
  pop.className = 'lx-link'; pop.hidden = true;
  const popIn = document.createElement('input');
  popIn.type = 'url'; popIn.placeholder = 'https://…'; popIn.spellcheck = false;
  popIn.setAttribute('aria-label', T('editor.linkTarget'));
  const popOk = document.createElement('button');
  popOk.className = 'lx-tbtn'; popOk.type = 'button'; popOk.textContent = '✓'; popOk.title = T('editor.linkApply');
  const popDel = document.createElement('button');
  popDel.className = 'lx-tbtn'; popDel.type = 'button'; popDel.innerHTML = ICON.unlink; popDel.title = T('editor.unlink');
  pop.append(popIn, popOk, popDel);
  holder.appendChild(pop);

  let popRange = null;                              // the selection the popover is editing
  function currentLink(){
    let href = null;
    editor.getEditorState().read(() => {
      const s = core.$getSelection();
      if (!core.$isRangeSelection(s)) return;
      const l = util.$findMatchingParent(s.anchor.getNode(), n => link.$isLinkNode(n) || link.$isAutoLinkNode(n));
      if (l) href = l.getURL();
    });
    return href;
  }
  function openLinkPop(){
    if (sourceMode) return;
    let empty = true;
    editor.getEditorState().read(() => {
      const s = core.$getSelection();
      empty = !core.$isRangeSelection(s) || (s.isCollapsed() && !currentLink());
    });
    if (empty){ toast(T('editor.linkNeedSelection'), true); return; }
    popRange = editor.getEditorState().read(() => {
      const s = core.$getSelection();
      return core.$isRangeSelection(s) ? s.clone() : null;
    });
    popIn.value = currentLink() || '';
    const r = window.getSelection();
    const box = r && r.rangeCount ? r.getRangeAt(0).getBoundingClientRect() : null;
    const host = holder.getBoundingClientRect();
    pop.hidden = false;
    pop.style.top  = ((box ? box.bottom - host.top : 60) + 6) + 'px';
    pop.style.left = Math.max(6, Math.min((box ? box.left - host.left : 20),
                                          holder.clientWidth - pop.offsetWidth - 6)) + 'px';
    popIn.focus(); popIn.select();
  }
  function applyLink(url){
    editor.update(() => {
      if (popRange) core.$setSelection(popRange.clone());
      editor.dispatchCommand(link.TOGGLE_LINK_COMMAND, url);
    });
    pop.hidden = true; input.focus();
  }
  popOk.addEventListener('click', () => {
    const v = popIn.value.trim();
    if (!v){ toast(T('editor.linkNeedUrl'), true); return; }
    applyLink(/^[a-z][\w+.-]*:|^[#/]/i.test(v) ? v : 'https://' + v);
  });
  popDel.addEventListener('click', () => applyLink(null));
  popIn.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); popOk.click(); }
    if (e.key === 'Escape'){ e.preventDefault(); pop.hidden = true; input.focus(); }
  });
  pop.addEventListener('mousedown', e => { if (e.target !== popIn) e.preventDefault(); });

  /* ── Find and replace ─────────────────────────────── */
  /* Works on the rendered text of the editable area: the hits are painted with the browser's
     own highlight ranges, and a replace re-runs through Lexical so it lands in the undo
     history like any other edit. */
  const findBar = document.createElement('div');
  findBar.className = 'lx-find'; findBar.hidden = true;
  findBar.innerHTML =
    '<input class="q" placeholder="' + T('editor.find') + '" aria-label="' + T('editor.find') + '">' +
    '<span class="lx-hits">0/0</span>' +
    '<button class="lx-btn" data-go="-1" title="' + T('editor.findPrev') + ' (Shift+Enter)">↑</button>' +
    '<button class="lx-btn" data-go="1" title="' + T('editor.findNext') + ' (Enter)">↓</button>' +
    '<input class="r" placeholder="' + T('editor.replaceWith') + '" aria-label="' + T('editor.replaceWith') + '">' +
    '<button class="lx-btn" data-act="one">' + T('editor.replace') + '</button>' +
    '<button class="lx-btn" data-act="all">' + T('editor.replaceAll') + '</button>' +
    '<label><input type="checkbox" class="cs">Aa</label>' +
    '<button class="lx-btn" data-act="close" title="' + T('editor.close') + ' (Esc)">✕</button>';
  holder.insertBefore(findBar, holder.firstChild);
  const fq = findBar.querySelector('.q'), fr = findBar.querySelector('.r'),
        fcs = findBar.querySelector('.cs'), fhits = findBar.querySelector('.lx-hits');
  let hits = [], hitAt = -1;

  /* Every text node in the editable area, with the running offset of its first character */
  function textRuns(){
    const runs = [];
    const walk = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let at = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()){
      runs.push({ node:n, at, len:n.nodeValue.length });
      at += n.nodeValue.length;
    }
    return { runs, text: runs.map(r => r.node.nodeValue).join('') };
  }
  function runFind(keepAt){
    const q = fq.value;
    hits = [];
    if (q){
      const { runs, text } = textRuns();
      const hay = fcs.checked ? text : text.toLowerCase();
      const needle = fcs.checked ? q : q.toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length))
        hits.push({ start:i, end:i + needle.length, runs });
    }
    hitAt = hits.length ? Math.min(keepAt === true ? Math.max(hitAt, 0) : 0, hits.length - 1) : -1;
    paintHits();
  }
  function rangeFor(hit){
    const pick = off => {
      const r = hit.runs.find(x => off >= x.at && off <= x.at + x.len);
      return r ? [r.node, off - r.at] : null;
    };
    const a = pick(hit.start), b = pick(hit.end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
    return r;
  }
  /* CSS Custom Highlight where the browser has it, and a plain selection otherwise */
  const HL = window.Highlight && CSS.highlights ? new Highlight() : null;
  if (HL) CSS.highlights.set('lx-hit', HL);
  function paintHits(){
    if (HL) HL.clear();
    fhits.textContent = (hits.length ? hitAt + 1 : 0) + '/' + hits.length;
    if (!hits.length) return;
    if (HL) for (const h of hits){ const r = rangeFor(h); if (r) HL.add(r); }
    const cur = rangeFor(hits[hitAt]);
    if (!cur) return;
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(cur);
    const el = cur.startContainer.parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block:'nearest' });
  }
  function step(d){
    if (!hits.length) return;
    hitAt = (hitAt + d + hits.length) % hits.length;
    paintHits();
  }
  function replaceOne(){
    if (hitAt < 0 || !hits[hitAt]) return;
    const r = rangeFor(hits[hitAt]);
    if (!r) return;
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    input.focus();
    editor.update(() => {
      const lex = core.$getSelection();
      if (core.$isRangeSelection(lex)) lex.insertText(fr.value);
    });
    setTimeout(() => runFind(true), 0);
  }
  /* Done inside the editor state rather than over DOM ranges: one undo step, and no stale
     node handles. A hit that straddles two runs (half of it bold, say) is left for
     Replace, which works off the live selection. */
  function replaceAll(){
    const q = fq.value;
    if (!q) return;
    const cs = fcs.checked;
    const needle = cs ? q : q.toLowerCase();
    let n = 0;
    editor.update(() => {
      for (const tn of core.$nodesOfType(core.TextNode)){
        if (!tn.isSimpleText()) continue;
        const t = tn.getTextContent();
        const hay = cs ? t : t.toLowerCase();
        if (!hay.includes(needle)) continue;
        let out = '', i = 0;
        for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + needle.length)){
          out += t.slice(i, k) + fr.value; i = k + needle.length; n++;
        }
        tn.setTextContent(out + t.slice(i));
      }
    }, { discrete:true });
    toast(n ? T('editor.replaced', { n }) : T('editor.nothingToReplace'), !n);
    setTimeout(() => runFind(), 0);
  }
  function openFind(on){
    if (on && sourceMode){ toast(T('editor.findInSource'), true); return; }
    findBar.hidden = !on;
    tbBtn.find.classList.toggle('on', on);
    tbBtn.find.setAttribute('aria-pressed', String(on));
    if (on){ fq.focus(); fq.select(); runFind(); }
    else { if (HL) HL.clear(); hits = []; input.focus(); }
  }
  fq.addEventListener('input', () => runFind());
  fcs.addEventListener('change', () => runFind());
  fq.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape'){ e.preventDefault(); openFind(false); }
  });
  fr.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape'){ e.preventDefault(); openFind(false); }
  });
  findBar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.go) step(+b.dataset.go);
    else if (b.dataset.act === 'one') replaceOne();
    else if (b.dataset.act === 'all') replaceAll();
    else if (b.dataset.act === 'close') openFind(false);
  });

  /* ── Table size picker ────────────────────────────── */
  function askTable(){
    const spec = prompt(T('editor.tablePrompt'), '3x3');
    if (spec == null) return;
    const m = /^\s*(\d{1,2})\s*[x*,\s]\s*(\d{1,2})\s*$/i.exec(spec);
    if (!m){ toast(T('editor.tableFormat'), true); return; }
    const [rows, cols] = [+m[1], +m[2]];
    if (rows < 1 || cols < 1 || rows > 50 || cols > 20){
      toast(T('editor.tableRange'), true); return;
    }
    cmd(table.INSERT_TABLE_COMMAND, { rows, columns: cols, includeHeaders: true });
  }

  /* ── Toolbar ──────────────────────────────────────── */
  /* Block type picker. A node body sits below the node's own heading in the generated
     document, so H1-H3 are rarely what a body wants - they are offered all the same, and
     shiftHeadings() moves the whole body under the node's heading level on export. */
  const blockSel = document.createElement('select');
  blockSel.className = 'lx-select';
  blockSel.title = T('editor.blockType');
  blockSel.setAttribute('aria-label', T('editor.blockType'));
  for (const [value, text] of [['p', T('editor.paragraph')], ['h1','H1'], ['h2','H2'], ['h3','H3'],
                               ['h4','H4'], ['h5','H5'], ['h6','H6'],
                               ['quote', T('editor.quote')], ['code', T('editor.code')]]){
    const o = document.createElement('option');
    o.value = value; o.textContent = text; blockSel.appendChild(o);
  }
  blockSel.addEventListener('change', () => {
    const v = blockSel.value;
    if (v === 'quote'){ blockAt(() => rich.$createQuoteNode()); }
    else if (v === 'code'){ blockAt(() => code.$createCodeNode()); }
    else blockAt(() => v === 'p' ? core.$createParagraphNode() : rich.$createHeadingNode(v));
    input.focus();
  });

  const listPick = iconSelect(T('editor.list'), localized(LIST_ITEMS), value => {
    const cmdFor = { ul: list.INSERT_UNORDERED_LIST_COMMAND,
                     ol: list.INSERT_ORDERED_LIST_COMMAND,
                     check: list.INSERT_CHECK_LIST_COMMAND }[value] || list.REMOVE_LIST_COMMAND;
    cmd(cmdFor, undefined);
  });
  const alignPick = iconSelect(T('editor.align'), localized(ALIGN_ITEMS), align);
  const fontPick = iconSelect(T('editor.font'), localized(FONTS).map(f => ({
    value: f.value, label: f.label, style: f.value ? 'font-family:' + f.value : ''
  })), v => { style({ 'font-family': v || null }); input.focus(); }, { wide:true });
  const sizePick = iconSelect(T('editor.fontSize'), SIZES.map(s => ({
    value: s, label: s || T('editor.default')
  })), v => { style({ 'font-size': v || null }); input.focus(); });

  /* Font / highlight colour. Applies to the selection, or to whatever is typed next
     when the caret is collapsed. */
  const style = props => editor.update(() => {
    const s = core.$getSelection();
    if (core.$isRangeSelection(s)) sel.$patchStyleText(s, props);
  });
  /* The palette: Tableau 10 down the columns, shades above the base row and tints below
     it, the last ten colours used, and a custom picker behind "다른 색" - our own rather
     than the OS one, which commits on close and has no confirm button to add. */
  function colorPicker(glyph, prop, fallback, title, noneLabel){
    const wrap = document.createElement('div');
    wrap.className = 'lx-pick'; wrap.title = title;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'lx-color';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-label', title);
    const ico = document.createElement('span'); ico.textContent = glyph;
    const swatch = document.createElement('span'); swatch.className = 'lx-swatch';
    swatch.style.background = fallback;
    btn.append(ico, swatch);
    const menu = document.createElement('div');
    menu.className = 'lx-pick-menu lx-cmenu'; menu.hidden = true;
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', title);
    wrap.append(btn, menu);

    const cell = hex => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lx-cell'; b.tabIndex = -1;
      b.dataset.color = hex; b.title = hex; b.setAttribute('aria-label', hex);
      b.style.background = hex;
      return b;
    };
    const head = text => {
      const h = document.createElement('div');
      h.className = 'lx-chead'; h.textContent = text;
      return h;
    };
    const none = document.createElement('button');
    none.type = 'button'; none.className = 'lx-pick-opt'; none.tabIndex = -1; none.dataset.color = '';
    none.innerHTML = '<span class="lx-nochip" aria-hidden="true"></span><span>' + noneLabel + '</span>';
    const grid = document.createElement('div');
    grid.className = 'lx-cgrid'; grid.append(...PALETTE.map(cell));
    const recent = document.createElement('div');
    recent.className = 'lx-cgrid';
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'lx-pick-opt lx-cmore'; more.tabIndex = -1; more.dataset.more = '1';
    more.textContent = T('editor.moreColors');
    const pal = document.createElement('div');
    pal.append(none, head(T('editor.standardColors')), grid, head(T('editor.recentColors')), recent, more);

    /* "다른 색": saturation/brightness field, hue slider, hex box, 취소/확인 */
    const custom = document.createElement('div');
    custom.className = 'lx-custom'; custom.hidden = true;
    custom.innerHTML =
      '<div class="lx-sv" role="presentation"><span class="lx-sv-dot"></span></div>' +
      '<input type="range" class="lx-hue" min="0" max="359" step="1" aria-label="' + T('editor.hue') + '">' +
      '<div class="lx-crow"><span class="lx-cprev"></span>' +
      '<input class="lx-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="' + T('editor.hex') + '"></div>' +
      '<div class="lx-cact"><button type="button" class="lx-btn" data-act="cancel">' + T('editor.cancel') + '</button>' +
      '<button type="button" class="lx-btn lx-btn-ok" data-act="ok">' + T('editor.ok') + '</button></div>';
    menu.append(pal, custom);
    const sv = custom.querySelector('.lx-sv'), dot = custom.querySelector('.lx-sv-dot');
    const hue = custom.querySelector('.lx-hue'), hexBox = custom.querySelector('.lx-hex');
    const prev = custom.querySelector('.lx-cprev');
    let hsv = { h: 0, s: 0, v: 0 };
    /* The caret leaves the editor once the hex box takes focus, so the selection is kept
       here and put back before the colour goes on. */
    let saved = null;

    function paintCustom(keepHex){
      const hex = hsvToHex(hsv);
      sv.style.background = 'linear-gradient(to top, #000, transparent), ' +
                            'linear-gradient(to right, #fff, hsl(' + hsv.h + ', 100%, 50%))';
      dot.style.left = (hsv.s * 100) + '%';
      dot.style.top = ((1 - hsv.v) * 100) + '%';
      hue.value = String(Math.round(hsv.h));
      prev.style.background = hex;
      if (!keepHex) hexBox.value = hex;
    }
    function showCustom(on){
      pal.hidden = on; custom.hidden = !on;
      if (on){
        editor.getEditorState().read(() => {
          const s = core.$getSelection();
          saved = core.$isRangeSelection(s) ? s.clone() : null;
        });
        hsv = hexToHsv(current || fallback);
        paintCustom();
      }
      place();
      (on ? hexBox : more).focus({ preventScroll: true });
      if (on) hexBox.select();
    }
    function svAt(e){
      const r = sv.getBoundingClientRect();
      hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      paintCustom();
    }
    sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); svAt(e); });
    sv.addEventListener('pointermove', e => { if (sv.hasPointerCapture(e.pointerId)) svAt(e); });
    hue.addEventListener('input', () => { hsv.h = +hue.value; paintCustom(); });
    hexBox.addEventListener('input', () => {
      const v = hexBox.value.trim();
      const hex = toHex(v.startsWith('#') ? v : '#' + v);
      hexBox.classList.toggle('bad', !hex);
      if (hex){ hsv = hexToHsv(hex); paintCustom(true); }
    });
    function confirmCustom(){
      const hex = hsvToHex(hsv);
      if (saved){
        const s = saved;
        editor.update(() => core.$setSelection(s.clone()));
      }
      open(false);
      apply(hex);
    }
    custom.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'ok') confirmCustom();
      else if (b.dataset.act === 'cancel') showCustom(false);
    });

    let current = '';
    function paintRecent(){
      const list = recentColors();
      recent.replaceChildren(...list.map(cell));
      if (!list.length){
        const e = document.createElement('span');
        e.className = 'lx-cempty'; e.textContent = T('editor.noRecent');
        recent.append(e);
      }
    }
    function apply(hex){
      style({ [prop]: hex || null });
      if (hex) pushRecent(hex);
      current = hex;
      swatch.style.background = hex || fallback;
      input.focus();
    }
    pal.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.more){ showCustom(true); return; }
      open(false);
      apply(b.dataset.color);
    });

    /* Arrows walk the grid in two dimensions; Up/Down leave a grid at its edge */
    function onDocDown(e){ if (!wrap.contains(e.target)) open(false); }
    function onDocKey(e){
      if (!custom.hidden){
        if (e.key === 'Escape'){ e.stopPropagation(); e.preventDefault(); showCustom(false); return; }
        if (e.key === 'Enter' && e.target === hexBox){ e.preventDefault(); e.stopPropagation(); confirmCustom(); return; }
        /* arrows belong to the slider and the hex box here, not to the toolbar */
        if (/^(Arrow|Home$|End$)/.test(e.key) && custom.contains(e.target)) e.stopPropagation();
        return;
      }
      if (e.key === 'Escape'){ e.stopPropagation(); open(false); btn.focus(); return; }
      const items = [...pal.querySelectorAll('button')];
      const at = document.activeElement;
      const i = items.indexOf(at);
      if (i < 0) return;
      let j;
      if (e.key === 'ArrowRight') j = i + 1;
      else if (e.key === 'ArrowLeft') j = i - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        const d = e.key === 'ArrowDown' ? 1 : -1;
        const v = items[i + d * 10];
        j = at.classList.contains('lx-cell') && v && v.parentElement === at.parentElement ? i + d * 10 : i + d;
      }
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = items.length - 1;
      else return;
      e.preventDefault(); e.stopPropagation();
      items[(j + items.length) % items.length].focus();
    }
    /* The palette is taller than a short editor, whose root clips (overflow: hidden), so it
       is fixed to the viewport beside the button. (0,0) is measured first because a
       transformed ancestor would move the fixed origin away from the viewport corner. */
    function place(){
      menu.style.left = menu.style.top = '0px';
      const o = menu.getBoundingClientRect(), r = btn.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;
      let x = r.left, y = r.bottom + 4;
      if (x + w > innerWidth - 8) x = Math.max(8, innerWidth - 8 - w);
      if (y + h > innerHeight - 8 && r.top - 4 - h >= 8) y = r.top - 4 - h;
      menu.style.left = (x - o.left) + 'px';
      menu.style.top = (y - o.top) + 'px';
    }
    const onMove = e => { if (!menu.contains(e.target)) open(false); };
    function open(on){
      if (on){
        paintRecent();
        for (const b of menu.querySelectorAll('.lx-cell')) b.classList.toggle('on', b.dataset.color === current);
      }
      pal.hidden = false; custom.hidden = true; saved = null;
      menu.hidden = !on;
      if (on) place();
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      const bind = on ? 'addEventListener' : 'removeEventListener';
      document[bind]('mousedown', onDocDown, true);
      document[bind]('keydown', onDocKey, true);
      /* a fixed menu would drift away from its button, so any scroll or resize closes it */
      window[bind]('scroll', onMove, true);
      window[bind]('resize', onMove);
      if (on) (grid.querySelector('.lx-cell.on') || grid.firstChild).focus({ preventScroll: true });
    }
    btn.addEventListener('click', () => open(menu.hidden));
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(true); }
    });
    /* keep the caret where it is, exactly like the plain toolbar buttons - except in the
       custom picker's own inputs, which need the focus and the drag */
    wrap.addEventListener('mousedown', e => {
      if (e.target.closest('input')) return;
      if (!btn.contains(e.target) || menu.hidden) e.preventDefault();
    });
    open(false);
    return {
      el: wrap,
      close: () => open(false),
      sync(value){
        swatch.style.background = value || fallback;
        current = toHex(value) || '';
      }
    };
  }
  const fgPick = colorPicker('A', 'color', '#151922', T('editor.textColor'), T('editor.auto'));
  const bgPick = colorPicker('▨', 'background-color', '#ffe58a', T('editor.highlight'), T('editor.none'));

  buildToolbar(bar, [
    [ICON.undo, () => cmd(core.UNDO_COMMAND, undefined), withKey(T('editor.undo'), MOD + '+Z')],
    [ICON.redo, () => cmd(core.REDO_COMMAND, undefined), withKey(T('editor.redo'), MOD + '+Shift+Z')],
    ['|', null],
    blockSel,
    fontPick.el,
    sizePick.el,
    ['|', null],
    ['<b>B</b>', () => fmt('bold'), withKey(T('editor.bold'), MOD + '+B'), { toggle:true }],
    ['<i>I</i>', () => fmt('italic'), withKey(T('editor.italic'), MOD + '+I'), { toggle:true }],
    ['<u>U</u>', () => fmt('underline'), withKey(T('editor.underline'), MOD + '+U'), { toggle:true }],
    ['<s>S</s>', () => fmt('strikethrough'), T('editor.strike'), { toggle:true }],
    ['X<sup>2</sup>', () => fmt('superscript'), T('editor.superscript'), { toggle:true }],
    ['X<sub>2</sub>', () => fmt('subscript'), T('editor.subscript'), { toggle:true }],
    ['&lt;/&gt;', () => fmt('code'), T('editor.inlineCode'), { toggle:true }],
    ['|', null],
    fgPick.el,
    bgPick.el,
    [ICON.clear, clearFormatting, T('editor.clearFormat')],
    ['|', null],
    listPick.el,
    alignPick.el,
    [ICON.outdent, () => cmd(core.OUTDENT_CONTENT_COMMAND, undefined), withKey(T('editor.outdent'), 'Shift+Tab')],
    [ICON.indent, () => cmd(core.INDENT_CONTENT_COMMAND, undefined), withKey(T('editor.indent'), 'Tab')],
    ['❝', toggleQuote, T('editor.quote'), { toggle:true, label: T('editor.quote') }],
    [ICON.codeblk, toggleCodeBlock, T('editor.codeBlock'), { toggle:true }],
    ['|', null],
    [ICON.link, openLinkPop, withKey(T('editor.link'), MOD + '+K')],
    [ICON.image, askImage, T('editor.insertImage')],
    [ICON.table, askTable, T('editor.insertTable')],
    [ICON.hr, () => editor.update(() => {
       const s = core.$getSelection();
       if (core.$isRangeSelection(s)) util.$insertNodeToNearestRoot($createHorizontalRuleNode());
       input.focus();
     }), T('editor.hr')],
    ['|', null],
    [ICON.find, () => openFind(findBar.hidden), withKey(T('editor.findReplace'), MOD + '+F'), { toggle:true }],
    ['HTML', toggleSource, T('editor.viewSource'), { toggle:true }]
  ]);
  const byTitle = key => bar.querySelector('.lx-tb[title^="' + T(key) + '"]');
  const tbBtn = {
    bold: byTitle('editor.bold'), italic: byTitle('editor.italic'), underline: byTitle('editor.underline'),
    strike: byTitle('editor.strike'), sup: byTitle('editor.superscript'), sub: byTitle('editor.subscript'),
    code: byTitle('editor.inlineCode'), quote: byTitle('editor.quote'), codeblk: byTitle('editor.codeBlock'),
    link: byTitle('editor.link'), find: byTitle('editor.findReplace'), src: byTitle('editor.viewSource'),
    undo: byTitle('editor.undo'), redo: byTitle('editor.redo')
  };

  const roving = rovingToolbar(bar);

  /* ── Keeping the toolbar in step with the caret ───── */
  const setOn = (btn, on) => {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(!!on));
  };
  function syncToolbar(){
    editor.getEditorState().read(() => {
      const s = core.$getSelection();
      if (!core.$isRangeSelection(s)) return;
      const top = s.anchor.getNode().getTopLevelElement();
      const tag = top && rich.$isHeadingNode(top) ? top.getTag()
                : top && rich.$isQuoteNode(top)   ? 'quote'
                : top && code.$isCodeNode(top)    ? 'code' : 'p';
      blockSel.value = [...blockSel.options].some(o => o.value === tag) ? tag : 'p';

      const ln = util.$getNearestNodeOfType(s.anchor.getNode(), list.ListNode);
      const lt = ln && ln.getListType();
      listPick.set(lt === 'number' ? 'ol' : lt === 'bullet' ? 'ul' : lt === 'check' ? 'check' : '');

      const el = top && core.$isElementNode(top) ? top : null;
      alignPick.set(el ? (['', 'left', 'center', 'right', 'justify'][el.getFormat()] || 'left') : 'left');

      fgPick.sync(sel.$getSelectionStyleValueForProperty(s, 'color', ''));
      bgPick.sync(sel.$getSelectionStyleValueForProperty(s, 'background-color', ''));
      const fam = sel.$getSelectionStyleValueForProperty(s, 'font-family', '');
      fontPick.set(FONTS.some(f => f.value === fam) ? fam : '');
      const sz = sel.$getSelectionStyleValueForProperty(s, 'font-size', '');
      sizePick.set(SIZES.includes(sz) ? sz : '');

      /* every character format now lights up, not just the two that were easy to miss */
      setOn(tbBtn.bold, s.hasFormat('bold'));
      setOn(tbBtn.italic, s.hasFormat('italic'));
      setOn(tbBtn.underline, s.hasFormat('underline'));
      setOn(tbBtn.strike, s.hasFormat('strikethrough'));
      setOn(tbBtn.sup, s.hasFormat('superscript'));
      setOn(tbBtn.sub, s.hasFormat('subscript'));
      setOn(tbBtn.code, s.hasFormat('code'));
      setOn(tbBtn.quote, tag === 'quote');
      setOn(tbBtn.codeblk, tag === 'code');
      setOn(tbBtn.link, !!util.$findMatchingParent(s.anchor.getNode(),
        n => link.$isLinkNode(n) || link.$isAutoLinkNode(n)));
    });
  }
  /* One rAF per burst: the toolbar sync used to run on every keystroke's update, which is
     the wrong amount of work for a long document. */
  let pending = 0;
  const scheduleSync = () => {
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; syncToolbar(); });
  };
  off.push(editor.registerUpdateListener(scheduleSync));
  off.push(editor.registerCommand(core.SELECTION_CHANGE_COMMAND, () => { scheduleSync(); return false; },
                                  core.COMMAND_PRIORITY_LOW));
  let canUndo = false, canRedo = false;
  off.push(editor.registerCommand(core.CAN_UNDO_COMMAND, can => {
    canUndo = can; if (!sourceMode) tbBtn.undo.disabled = !can;
    return false;
  }, core.COMMAND_PRIORITY_CRITICAL));
  off.push(editor.registerCommand(core.CAN_REDO_COMMAND, can => {
    canRedo = can; if (!sourceMode) tbBtn.redo.disabled = !can;
    return false;
  }, core.COMMAND_PRIORITY_CRITICAL));
  tbBtn.undo.disabled = tbBtn.redo.disabled = true;
  syncToolbar(); syncPlaceholder();

  /* Shortcuts the browser does not hand to Lexical on its own */
  function onKey(e){
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'k'){ e.preventDefault(); openLinkPop(); }
    else if (k === 'f'){ e.preventDefault(); openFind(true); }
    else if (k === 'h'){ e.preventDefault(); openFind(true); fr.focus(); }
    else if (k === '\\'){ e.preventDefault(); clearFormatting(); }
  }
  shell.addEventListener('keydown', onKey);
  shell.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !findBar.hidden){ e.preventDefault(); openFind(false); }
  });

  const getHtml = () => sourceMode ? source.value : serializeHtml();
  return {
    getHtml,
    setHtml(next){
      if (sourceMode) toggleSource();
      loadHtml(next || '');
      syncPlaceholder();
    },
    focus: () => input.focus(),
    destroy(){
      if (pending) cancelAnimationFrame(pending);
      clearTimeout(toastT);
      if (HL) HL.clear();
      listPick.close(); alignPick.close(); fontPick.close(); sizePick.close();
      fgPick.close(); bgPick.close();
      off.forEach(f => { try { f(); } catch(_){} });
      editor.setRootElement(null);
    }
  };
}
