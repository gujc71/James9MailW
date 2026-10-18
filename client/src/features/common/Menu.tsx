/** 드롭다운 메뉴 (기타 · 이 사람을 · 편지함 ⋯ 옵션 · 관리자 옵션)
 *  목록은 body 로 포털 렌더 + fixed 배치라 표/스크롤 영역(overflow) 에 잘리지 않고,
 *  아래 공간이 부족하면 버튼 위쪽으로 뒤집힌다. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

const GAP = 6;
const EDGE = 8;

export function Menu({
  label,
  items,
  className,
  buttonClassName,
  align = 'left',
  title,
}: {
  label: ReactNode;
  items: MenuItem[];
  className?: string;
  buttonClassName?: string;
  align?: 'left' | 'right';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const btn = btnRef.current;
      const list = listRef.current;
      if (!btn || !list) return;
      const r = btn.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = list;
      const left = Math.min(Math.max(EDGE, align === 'right' ? r.right - w : r.left), window.innerWidth - w - EDGE);
      let top = r.bottom + GAP;
      if (top + h > window.innerHeight - EDGE) {
        top = r.top - GAP - h >= EDGE ? r.top - GAP - h : Math.max(EDGE, window.innerHeight - EDGE - h);
      }
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (!btnRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const scrolled = (event: Event) => {
      // 목록 자체의 스크롤은 무시하고, 바깥 영역이 스크롤되면 어긋난 위치로 남지 않게 닫는다.
      if (!listRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [open]);

  return (
    <div className={`menu ${open ? 'open' : ''} ${className ?? ''}`}>
      <button
        type="button"
        ref={btnRef}
        title={title}
        className={buttonClassName ?? 'menu-btn'}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <ul
            ref={listRef}
            className="menu-list"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {items.map((item, index) => (
              <li key={index}>
                <button
                  type="button"
                  disabled={item.disabled}
                  className={item.danger ? 'danger' : ''}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
