/** 편지함 선택 팝업 (POPUP-1). 기본 → 개인 순, 계층 표시. 임시 보관함은 제외한다 */
import { useMemo, useState } from 'react';
import type { Mailbox } from '../../api/types';
import { buildTree, flattenTree } from '../../lib/mailboxTree';
import { Modal } from './Modal';
import { useT } from '../../i18n';

const DEFAULT_EXCLUDE = ['Drafts'];

export function MailboxPicker({
  mailboxes,
  title,
  excludeRoles = DEFAULT_EXCLUDE,
  excludeIds,
  onPick,
  onClose,
}: {
  mailboxes: Mailbox[];
  title?: string;
  excludeRoles?: string[];
  excludeIds?: string[];
  onPick: (box: Mailbox) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Mailbox | null>(null);
  const rows = useMemo(
    () =>
      flattenTree(buildTree(mailboxes)).filter(
        (n) => !excludeRoles.includes(n.box.role) && !(excludeIds ?? []).includes(n.box.id),
      ),
    [mailboxes, excludeRoles, excludeIds],
  );

  return (
    <Modal
      title={title ?? t('picker.title')}
      onClose={onClose}
      width={380}
      footer={
        <>
          <button className="primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
            {t('common.select')}
          </button>
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      <p className="hint">{t('picker.hint')}</p>
      <ul className="picker-list">
        {rows.map(({ box, depth }) => (
          <li key={box.id}>
            <button
              type="button"
              className={selected?.id === box.id ? 'active' : ''}
              style={{ paddingLeft: 12 + depth * 16 }}
              onClick={() => setSelected(box)}
              onDoubleClick={() => onPick(box)}
            >
              {depth > 0 && '┗ '}
              {box.displayName}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
