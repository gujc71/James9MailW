/** lexicalEditor.js 는 Callout9 에서 옮겨 온 순수 DOM 코드라 JS 그대로 두고, 타입만 여기에 적는다. */

export interface LexicalMountOptions {
  /** 처음 채워 넣을 본문 HTML */
  html?: string;
  /** 본문이 비었을 때 겹쳐 보일 안내문 */
  placeholder?: string;
  /** 사용자가 본문을 고칠 때마다 불린다 (값은 getHtml() 으로 읽는다) */
  onChange?: () => void;
  /** 툴바 · 안내 문구 번역 (i18n 의 editor.* 키). 없으면 키를 그대로 보인다 */
  t?: (key: string, params?: Record<string, string | number>) => string;
}

export interface LexicalEditorInstance {
  /** 현재 본문 HTML (HTML 소스 보기 중이면 그 원문) */
  getHtml(): string;
  /** 본문을 통째로 갈아끼운다 */
  setHtml(html: string): void;
  focus(): void;
  /** 리스너·타이머를 모두 풀고 편집 영역을 놓아준다 */
  destroy(): void;
}

/** public/vendor/lexical.bundle.js 를 한 번만 내려받는다. 실패하면 reject 된다. */
export function ensureLexical(): Promise<unknown>;

/** ensureLexical() 이 끝난 뒤에만 부를 것. shell 안에 툴바와 편집 영역을 그린다. */
export function mountLexical(shell: HTMLElement, opts: LexicalMountOptions): LexicalEditorInstance;
