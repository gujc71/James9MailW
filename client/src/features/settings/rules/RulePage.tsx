/**
 * 규칙 화면 네 장(자동분류 · 부재중 · 수신거부 · 포워딩)의 공통 껍데기.
 * 제목 · 안내문구 · 저장 결과를 같은 자리에 둔다.
 *
 * 목록형 세 화면(자동분류 · 수신거부 · 포워딩)은 행 단위로 저장하므로 onSave 를 넘기지 않고,
 * 화면 전체가 한 건인 부재중만 아래쪽 저장 버튼을 쓴다.
 */
import type { ReactNode } from 'react';
import { useT } from '../../../i18n';

export function RulePage({
  title,
  notes,
  msg,
  onSave,
  children,
}: {
  title: string;
  notes: string[];
  msg: string | null;
  onSave?: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="tab rules">
      <h2>{title}</h2>
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      <section>{children}</section>
      {msg && <div className="info">{msg}</div>}
      {onSave && (
        <div className="tab-actions">
          <button className="primary" onClick={onSave}>
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}
