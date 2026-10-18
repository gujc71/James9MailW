/**
 * 마우스 오른쪽 메뉴 (썬더버드 캘린더의 빈 칸 · 일정 메뉴). 누른 자리에 뜨고, 화면 밖으로 넘치면 안쪽으로 당긴다.
 * 하위 메뉴(분류 · 상태 · 캘린더 이동)는 항목에 마우스를 올리면 옆으로 펼친다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface CtxItem {
  label?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  children?: CtxItem[];
}

export interface CtxState {
  x: number;
  y: number;
  items: CtxItem[];
}

function MenuList({ items, x, y, onClose, depth }: { items: CtxItem[]; x: number; y: number; onClose: () => void; depth: number }) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = x + w > window.innerWidth - 8 ? Math.max(8, depth ? x - w * 2 : window.innerWidth - w - 8) : x;
    const top = y + h > window.innerHeight - 8 ? Math.max(8, window.innerHeight - h - 8) : y;
    setPos({ left, top, ready: true });
  }, [x, y, depth]);

  return (
    <>
      <ul
        ref={ref}
        className="cal-ctx"
        role="menu"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) =>
          item.separator ? (
            <li key={index} className="cal-ctx-sep" role="separator" />
          ) : (
            <li key={index}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`${item.danger ? 'danger' : ''} ${open?.index === index ? 'open' : ''}`}
                onMouseEnter={(e) => {
                  if (item.children && !item.disabled) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpen({ index, x: r.right - 2, y: r.top - 4 });
                  } else setOpen(null);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.children) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setOpen({ index, x: r.right - 2, y: r.top - 4 });
                    return;
                  }
                  onClose();
                  item.onClick?.();
                }}
              >
                <span className="cal-ctx-check">{item.checked ? '✓' : ''}</span>
                <span className="cal-ctx-label">{item.label}</span>
                {item.shortcut && <span className="cal-ctx-key">{item.shortcut}</span>}
                {item.children && <span className="cal-ctx-key">▸</span>}
              </button>
            </li>
          ),
        )}
      </ul>
      {open && items[open.index]?.children && (
        <MenuList items={items[open.index]!.children!} x={open.x} y={open.y} onClose={onClose} depth={depth + 1} />
      )}
    </>
  );
}

export function ContextMenu({ state, onClose }: { state: CtxState | null; onClose: () => void }) {
  useEffect(() => {
    if (!state) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('.cal-ctx')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [state, onClose]);
  if (!state) return null;
  return createPortal(<MenuList items={state.items} x={state.x} y={state.y} onClose={onClose} depth={0} />, document.body);
}
