/**
 * 메일 본문용 리치 텍스트 입력칸.
 *  - 실제 에디터는 lexicalEditor.js (Callout9 에서 옮겨 온 Lexical 기반 순수 DOM 코드) 가 그린다.
 *    React 는 빈 <div> 하나만 내주고 — 그 안은 React 가 건드리지 않는다 — 마운트·해제와
 *    값 주고받기만 맡는다.
 *  - 값은 HTML 문자열이다. 처음 한 번만 initialHtml 로 채우고, 그 뒤로는 에디터가 원본을 쥔다.
 *    (타이핑마다 받은 값을 되돌려 주면 커서가 앞으로 튄다.) 바깥에서 본문을 갈아끼울 때는
 *    ref.setHtml() 을 쓴다.
 *  - onChange 는 잠시 묶어서 올린다. 글자 하나마다 문서 전체를 HTML 로 굳히는 건 긴 본문에서
 *    아까운 일이라, 저장 직전 같은 정확한 값이 필요한 자리는 ref.getHtml() 로 읽는다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ensureLexical, mountLexical, type LexicalEditorInstance } from './lexicalEditor.js';
import './editor.css';
import { t, type MessageKey } from '../../../i18n';

/** onChange 를 묶어 두는 시간 (ms) */
const CHANGE_DELAY = 200;

export interface HtmlEditorHandle {
  /** 지금 이 순간의 본문 HTML */
  getHtml(): string;
  /** 본문을 통째로 갈아끼운다 */
  setHtml(html: string): void;
  focus(): void;
}

export const HtmlEditor = forwardRef<HtmlEditorHandle, {
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
}>(function HtmlEditor({ initialHtml, onChange, placeholder }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<LexicalEditorInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 마운트는 한 번뿐이므로 처음 값과 그때그때의 콜백은 ref 로 들고 있는다.
  const seedRef = useRef(initialHtml);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const placeholderRef = useRef(placeholder);

  useEffect(() => {
    let dead = false;
    let timer = 0;
    ensureLexical()
      .then(() => {
        if (dead || !hostRef.current) return;
        editorRef.current = mountLexical(hostRef.current, {
          html: seedRef.current,
          placeholder: placeholderRef.current,
          // 툴바 문구는 마운트할 때의 언어로 그린다 (lexicalEditor.js 는 i18n 을 모른다)
          t: (key, params) => t(key as MessageKey, params),
          onChange: () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              if (!dead && editorRef.current) changeRef.current(editorRef.current.getHtml());
            }, CHANGE_DELAY);
          },
        });
        setReady(true);
      })
      .catch((cause: unknown) => {
        // 원인 문구(lexicalEditor.js 의 Error)는 번역되지 않으므로 콘솔에만 남긴다
        console.error(cause);
        if (!dead) setError(t('editor.loadFailed'));
      });
    return () => {
      dead = true;
      window.clearTimeout(timer);
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    getHtml: () => editorRef.current?.getHtml() ?? seedRef.current,
    setHtml: (html: string) => {
      seedRef.current = html;
      editorRef.current?.setHtml(html);
    },
    focus: () => editorRef.current?.focus(),
  }), []);

  return (
    <div className="lx-shell">
      <div className="lx-mount" ref={hostRef} />
      {!ready && (
        <div className={'lx-loading' + (error ? ' err' : '')} role={error ? 'alert' : 'status'}>
          {error ?? t('editor.loading')}
        </div>
      )}
    </div>
  );
});
