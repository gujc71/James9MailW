/**
 * 사이드 편지함 트리 + 용량 표시 (USR-3).
 *  - 편지함 이름에 마우스를 올리면 우측 끝에 "⋯" 옵션 메뉴 (추가 · 수정 · 모두읽음 · 편지함 관리 · 비우기)
 *  - 목록에서 끌어온 메일을 편지함 위에 놓으면 이동 (전체 · 임시 보관함으로는 불가)
 */
import { useMemo, useState, type DragEvent } from 'react';
import type { Mailbox, Usage } from '../../api/types';
import { formatBytes } from '../../lib/format';
import { buildTree, type TreeNode } from '../../lib/mailboxTree';
import { Menu } from '../common/Menu';
import { MailboxIcon } from './MailboxIcon';
import { useT } from '../../i18n';
import type { MessageRef } from './useMessageList';

export const DRAG_MIME = 'application/x-j9-uids';

export interface MailboxAction {
  type: 'add' | 'rename' | 'readAll' | 'manage' | 'empty';
  box: Mailbox;
}

interface Props {
  mailboxes: Mailbox[];
  usage: Usage | null;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onAction?: (action: MailboxAction) => void;
  onDropMessages?: (target: Mailbox, refs: MessageRef[]) => void;
}

function Node({
  node,
  activeId,
  onSelect,
  onAction,
  onDropMessages,
}: {
  node: TreeNode;
  activeId: string | null;
  onSelect: (id: string) => void;
  onAction?: (action: MailboxAction) => void;
  onDropMessages?: Props['onDropMessages'];
}) {
  const t = useT();
  const [over, setOver] = useState(false);
  const box = node.box;
  const droppable = box.role !== 'Drafts' && Boolean(onDropMessages);

  function onDragOver(event: DragEvent) {
    if (!droppable || !event.dataTransfer.types.includes(DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!over) setOver(true);
  }

  function onDrop(event: DragEvent) {
    setOver(false);
    if (!droppable) return;
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    try {
      const payload = JSON.parse(raw) as { refs: MessageRef[] };
      // 이미 이 편지함에 있는 메일은 옮길 필요가 없다
      const refs = (payload.refs ?? []).filter((r) => r.mailboxId !== box.id);
      if (refs.length) onDropMessages?.(box, refs);
    } catch {
      // 잘못된 드래그 데이터는 무시
    }
  }

  const items = [
    { label: t('sidebar.addBox'), onClick: () => onAction?.({ type: 'add', box }) },
    { label: t('sidebar.renameBox'), onClick: () => onAction?.({ type: 'rename', box }), disabled: box.isSystem },
    { label: t('sidebar.markAllRead'), onClick: () => onAction?.({ type: 'readAll', box }) },
    { label: t('sidebar.manageBoxes'), onClick: () => onAction?.({ type: 'manage', box }) },
    { label: t('sidebar.empty'), onClick: () => onAction?.({ type: 'empty', box }), danger: true },
  ];

  return (
    <li>
      <div
        className={`mbox-row ${over ? 'drop-over' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <button
          className={`mbox ${activeId === box.id ? 'active' : ''}`}
          onClick={() => onSelect(box.id)}
          title={box.name}
        >
          <MailboxIcon role={box.role} />
          <span className="mbox-name">{box.displayName}</span>
          {box.unseenCount > 0 && <span className="unseen">{box.unseenCount}</span>}
        </button>
        {onAction && <Menu label="⋯" items={items} className="mbox-menu" buttonClassName="mbox-more" align="right" title={t('sidebar.boxOptions')} />}
      </div>
      {node.children.length > 0 && (
        <ul className="subtree">
          {node.children.map((child) => (
            <Node
              key={child.box.id}
              node={child}
              activeId={activeId}
              onSelect={onSelect}
              onAction={onAction}
              onDropMessages={onDropMessages}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({
  mailboxes,
  usage,
  activeId,
  onSelect,
  onAction,
  onDropMessages,
}: Props) {
  const t = useT();
  const tree = useMemo(() => buildTree(mailboxes), [mailboxes]);
  const usedPct = usage && usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <aside className="sidebar">
      <nav>
        <button
          className={`mbox all ${activeId === null ? 'active' : ''}`}
          onClick={() => onSelect(null)}
        >
          <MailboxIcon role={null} />
          <span className="mbox-name">{t('sidebar.allMail')}</span>
        </button>
        <ul className="tree">
          {tree.map((node) => (
            <Node
              key={node.box.id}
              node={node}
              activeId={activeId}
              onSelect={onSelect}
              onAction={onAction}
              onDropMessages={onDropMessages}
            />
          ))}
        </ul>
      </nav>
      <div className="usage">
        {usage && (
          <>
            <div className="usage-bar">
              <span style={{ width: `${usedPct}%` }} />
            </div>
            <div className="usage-text">
              {formatBytes(usage.used)} / {usage.unlimited || usage.limit === null ? 'UNLIMIT' : formatBytes(usage.limit)}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
