/** 공통 팝업창 (POPUP-0). 타이틀 행 드래그로 이동, X · ESC 로 닫기, 넘치는 내용은 스크롤 */
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useDragMove } from './useDragMove';
import { useEscapeClose } from './useEscapeClose';

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
}) {
  const t = useT();
  useEscapeClose(onClose);
  const { startDrag, style } = useDragMove();

  return (
    <div className="modal-backdrop">
      <div
        className={`modal ${className ?? ''}`}
        style={{ width, ...style }}
      >
        <div className="modal-head" onMouseDown={startDrag}>
          <h3>{title}</h3>
          <button type="button" className="x" onClick={onClose} title={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-content">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}
