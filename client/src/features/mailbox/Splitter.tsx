/**
 * 목록과 읽기 영역 사이의 세로 손잡이. 끌어서 목록 너비를 바꾼다.
 *
 * 너비는 CSS 변수(--list-w)로 내려보낸다 — `.list-pane` 에 인라인 style 로 박으면 좁은
 * 화면에서 읽기 패널이 목록을 덮는 반응형 규칙(width: auto)을 인라인이 눌러 이긴다.
 * 변수로 두면 미디어 쿼리가 평소처럼 우선한다.
 *
 * 고른 너비는 정렬·대화 묶기와 같은 "이 기기에서 보는 방식" 이라 localStorage 에만 둔다.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../../i18n';

/** 목록이 한 줄을 읽을 수 있게 남는 최소치. 이 아래로는 보낸 사람과 제목이 다 잘린다 */
export const MIN_LIST_WIDTH = 280;
/** 읽기 영역에 남겨 두는 자리. 창이 좁으면 이 값이 최대치를 끌어내린다 */
const MIN_READ_WIDTH = 420;
const MAX_LIST_WIDTH = 900;
export const DEFAULT_LIST_WIDTH = 420;

const KEY = 'j9-list-width';

/**
 * 너비를 가둔다. `room` 은 목록이 쓸 수 있는 폭 — 창 너비에서 **목록 왼쪽 끝(사이드바)과
 * 읽기 영역 최소치를 뺀** 값이다. 모르면 창 너비로 어림잡고, 자리를 잰 뒤 (fit) 다시 가둔다.
 */
function clampWidth(width: number, room = MAX_LIST_WIDTH): number {
  const max = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, room));
  return Math.round(Math.min(max, Math.max(MIN_LIST_WIDTH, width)));
}

export function loadListWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_LIST_WIDTH;
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

export function saveListWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // 저장이 막힌 창에서는 이번 세션만 유지한다
  }
}

interface Props {
  width: number;
  onWidth: (width: number) => void;
}

export function Splitter({ width, onWidth }: Props) {
  const t = useT();
  const self = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** 누른 순간의 좌표와 너비. 움직인 거리만 더하므로 손잡이 두께·여백을 계산에 넣지 않아도 된다 */
  const from = useRef({ x: 0, width });

  /**
   * 목록이 실제로 쓸 수 있는 폭. 목록의 왼쪽 끝을 재서 뺀다 — 사이드바를 접었다 펴면
   * 그 자리가 달라지므로 상수로 둘 수 없다.
   */
  function room(): number {
    const pane = self.current?.parentElement?.querySelector('.list-pane');
    const left = pane ? pane.getBoundingClientRect().left : 0;
    return window.innerWidth - left - MIN_READ_WIDTH;
  }

  /**
   * 창을 줄이면 너비를 다시 가둔다. 목록은 flex-shrink: 0 이라, 넓혀 둔 폭을 그대로 두면
   * 창을 좁혔을 때 읽기 영역이 먼저 짜부라진다. 저장값(localStorage)은 건드리지 않는다 —
   * 창을 줄여 본 것 때문에 손으로 고른 폭이 지워지면 안 된다.
   *
   * 손잡이가 숨은 폭(읽기 패널이 목록을 덮는 반응형)에서는 그냥 둔다. 거기서는 목록이 화면을
   * 다 쓰므로 가둘 이유가 없고, 괜히 줄여 두면 창을 다시 넓혔을 때 좁아진 채로 뜬다.
   */
  useEffect(() => {
    function fit() {
      if (!self.current || self.current.offsetParent === null) return;
      const next = clampWidth(width, room());
      if (next !== width) onWidth(next);
    }
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [width, onWidth]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // 포인터를 손잡이에 붙여 둔다 — 빠르게 끌어 손잡이를 벗어나도 move 가 계속 온다
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    from.current = { x: event.clientX, width };
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onWidth(clampWidth(from.current.width + (event.clientX - from.current.x), room()));
  }

  function end() {
    if (!dragging) return;
    setDragging(false);
    saveListWidth(width);
  }

  function set(next: number) {
    const fit = clampWidth(next, room());
    onWidth(fit);
    saveListWidth(fit);
  }

  return (
    <div
      ref={self}
      className={`splitter ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('list.resize')}
      title={t('list.resizeHint')}
      tabIndex={0}
      aria-valuenow={width}
      aria-valuemin={MIN_LIST_WIDTH}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // 두 번 누르면 기본 너비로 되돌린다 — 끌어서 망친 폭을 되찾는 가장 짧은 길이다
      onDoubleClick={() => set(DEFAULT_LIST_WIDTH)}
      // 마우스를 못 쓰는 경우. 손잡이에 초점을 두고 ←→ 로 10px 씩 옮긴다
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0;
        if (!step) return;
        event.preventDefault();
        set(width + step);
      }}
    />
  );
}
