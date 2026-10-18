/** 팝업창 타이틀 행 드래그 이동. 헤더의 onMouseDown 에 startDrag 를, 창에 style 을 건다 */
import { useRef, useState, type CSSProperties, type MouseEvent } from 'react';

export function useDragMove() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  function startDrag(event: MouseEvent) {
    // 닫기 버튼 등 헤더 안의 컨트롤은 끌기 대상이 아니다
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, a')) return;
    event.preventDefault();
    drag.current = { sx: event.clientX, sy: event.clientY, ox: pos.x, oy: pos.y };
    const move = (ev: globalThis.MouseEvent) => {
      if (!drag.current) return;
      setPos({
        x: drag.current.ox + ev.clientX - drag.current.sx,
        y: drag.current.oy + ev.clientY - drag.current.sy,
      });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  const style: CSSProperties | undefined =
    pos.x || pos.y ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined;

  return { startDrag, style };
}
