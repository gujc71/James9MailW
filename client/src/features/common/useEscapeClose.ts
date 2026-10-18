/** 팝업창 ESC 닫기. 창이 겹쳐 있으면 맨 위 창 하나만 닫는다 */
import { useEffect, useRef } from 'react';

const stack: symbol[] = [];

export function useEscapeClose(onClose: () => void, enabled = true) {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol('popup');
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      // 안쪽 입력(주소 제안 목록 등)이 먼저 처리했거나 한글 조합 중이면 건드리지 않는다
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (stack[stack.length - 1] !== id) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [enabled]);
}
