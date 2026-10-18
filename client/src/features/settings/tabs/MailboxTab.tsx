/**
 * USR-16 편지함 관리: 추가(선택 편지함 하위) · 체크 일괄 삭제 · 계층형 목록 · [설정 ▾](모두 읽음 · 모두 삭제).
 * 기본 편지함은 삭제·이름변경이 막힌다. 드래그 순서 변경은 서버에 순서 변경 API 가 없어 제공하지 않는다.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Mailbox } from '../../../api/types';
import { formatBytes } from '../../../lib/format';
import { buildTree, flattenTree } from '../../../lib/mailboxTree';
import { Menu } from '../../common/Menu';
import { Modal } from '../../common/Modal';
import { useT } from '../../../i18n';

export function MailboxTab({ mailboxes, onChanged }: { mailboxes: Mailbox[]; onChanged: () => void }) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const rows = useMemo(() => flattenTree(buildTree(mailboxes)), [mailboxes]);
  // 기본(시스템) 편지함은 선택 대상에서 제외한다 — 헤드 체크박스는 개인 편지함만 토글한다.
  const personalIds = useMemo(() => rows.filter((r) => !r.box.isSystem).map((r) => r.box.id), [rows]);
  const allChecked = personalIds.length > 0 && personalIds.every((id) => selected.has(id));
  const someChecked = personalIds.some((id) => selected.has(id));

  async function run(action: () => Promise<unknown>) {
    setMsg(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.failed'));
    }
  }

  async function removeSelected() {
    const targets = rows.filter((r) => selected.has(r.box.id) && !r.box.isSystem);
    if (targets.length === 0) {
      setMsg(t('mailboxTab.selectPersonal'));
      return;
    }
    if (!confirm(t('mailboxTab.confirmDelete', { names: targets.map((r) => r.box.displayName).join(', ') })))
      return;
    await run(async () => {
      for (const t of targets) await api.del(`/api/mailboxes/${t.box.id}`);
      setSelected(new Set());
    });
  }

  return (
    <div className="tab">
      <h2>{t('settings.mailbox')}</h2>
      <div className="toolbar right">
        <button
          className="primary"
          onClick={() => {
            const first = [...selected][0];
            setParentId(first ?? '');
            setName('');
            setAddOpen(true);
          }}
        >
          {t('mailboxTab.add')}
        </button>
        <button className="danger tb" onClick={removeSelected} disabled={selected.size === 0}>
          {t('common.delete')}
        </button>
      </div>
      {msg && <div className="error">{msg}</div>}

      <table className="grid">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                title={t('mailboxTab.selectAll')}
                aria-label={t('mailboxTab.selectAll')}
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = !allChecked && someChecked;
                }}
                disabled={personalIds.length === 0}
                onChange={(e) => setSelected(e.target.checked ? new Set(personalIds) : new Set())}
              />
            </th>
            <th>{t('mailboxTab.box')}</th>
            <th>{t('mailboxTab.usedSize')}</th>
            <th>{t('mailboxTab.mailCount')}</th>
            <th>{t('mailboxTab.unseenCount')}</th>
            <th>{t('mailboxTab.settings')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ box, depth }) => (
            <tr key={box.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(box.id)}
                  disabled={box.isSystem}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      next.has(box.id) ? next.delete(box.id) : next.add(box.id);
                      return next;
                    })
                  }
                />
              </td>
              <td style={{ paddingLeft: 8 + depth * 18 }}>
                {depth > 0 && '┗ '}
                {box.displayName}
              </td>
              <td>{formatBytes(box.size)}</td>
              <td>{box.messageCount}</td>
              <td>{box.unseenCount}</td>
              <td>
                <Menu
                  label={`${t('mailboxTab.settings')} ▾`}
                  buttonClassName="tb"
                  items={[
                    {
                      label: t('sidebar.markAllRead'),
                      onClick: () => void run(() => api.post(`/api/mailboxes/${box.id}/read-all`)),
                    },
                    {
                      label: t('mailboxTab.deleteAll'),
                      danger: true,
                      onClick: () => {
                        if (confirm(t('mailboxTab.confirmEmpty', { box: box.displayName })))
                          void run(() => api.post(`/api/mailboxes/${box.id}/empty`));
                      },
                    },
                    {
                      label: t('mailboxTab.rename'),
                      disabled: box.isSystem,
                      onClick: () => {
                        const n = prompt(t('mailboxTab.promptNewName'), box.displayName);
                        if (n && n !== box.displayName) void run(() => api.put(`/api/mailboxes/${box.id}`, { name: n }));
                      },
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t('mailboxTab.note')}</p>

      {addOpen && (
        <Modal
          title={t('mailboxTab.addTitle')}
          onClose={() => setAddOpen(false)}
          width={400}
          footer={
            <>
              <button
                className="primary"
                disabled={!name.trim()}
                onClick={() =>
                  run(async () => {
                    await api.post('/api/mailboxes', { name: name.trim(), parentId: parentId || null });
                    setAddOpen(false);
                  })
                }
              >
                {t('common.save')}
              </button>
              <button className="btn" onClick={() => setAddOpen(false)}>{t('common.cancel')}</button>
            </>
          }
        >
          <div className="form-row">
            <label>{t('mailboxTab.boxName')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="form-row">
            <label>{t('mailboxTab.parentBox')}</label>
            <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t('mailboxTab.topLevel')}</option>
              {rows.map(({ box, depth }) => (
                <option key={box.id} value={box.id}>
                  {' '.repeat(depth * 3)}
                  {box.displayName}
                </option>
              ))}
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}
