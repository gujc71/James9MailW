/**
 * USR-18 외부메일: 계정 목록 · 추가/수정 팝업(USR-18.1) · 실행 · 체크 일괄 삭제 · 실행 이력 팝업.
 * 비밀번호는 목록에 표시하지 않고, 포트는 번호 + 보안 구분(평문/SSL)을 병기한다.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Mailbox } from '../../../api/types';
import { formatFullDate } from '../../../lib/format';
import { MailboxPicker } from '../../common/MailboxPicker';
import { Modal } from '../../common/Modal';
import { useT } from '../../../i18n';

interface ExternalAccount {
  externalId: number;
  externalName: string;
  serverHost: string;
  serverPort: number;
  protocol: 'POP3' | 'IMAP';
  securityType: 'PLAIN' | 'SSL';
  loginId: string;
  targetMailboxId: string;
  lastRunAt: string | null;
}

interface RunLog {
  logId: number;
  startTime: string | null;
  endTime: string | null;
  mailCount: number;
  runStatus: string;
  errorMsg: string | null;
}

type Form = Omit<ExternalAccount, 'externalId' | 'lastRunAt'> & { loginPasswd: string };

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function emptyForm(mailboxes: Mailbox[]): Form {
  return {
    externalName: '',
    serverHost: '',
    serverPort: 143,
    protocol: 'IMAP',
    securityType: 'PLAIN',
    loginId: '',
    loginPasswd: '',
    targetMailboxId: mailboxes.find((b) => b.role === 'INBOX')?.id ?? mailboxes[0]?.id ?? '',
  };
}

export function ExternalMailTab({ mailboxes }: { mailboxes: Mailbox[] }) {
  const t = useT();
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);
  const [logsOf, setLogsOf] = useState<ExternalAccount | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => api.get<ExternalAccount[]>('/api/external-mail').then(setAccounts);
  useEffect(() => {
    void load();
  }, []);

  const mailboxName = (id: string) => mailboxes.find((b) => b.id === id)?.displayName ?? '-';

  async function run(account: ExternalAccount) {
    setMsg(t('external.fetching', { name: account.externalName }));
    try {
      const res = await api.post<{ stored: number; errors: string[] }>(`/api/external-mail/${account.externalId}/run`);
      setMsg(
        t('external.fetched', { name: account.externalName, n: res.stored }) +
          (res.errors.length ? t('external.errorCount', { n: res.errors.length }) : ''),
      );
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('external.runFailed'));
    }
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    if (!confirm(t('external.confirmDeleteN', { n: selected.size }))) return;
    for (const id of selected) await api.del(`/api/external-mail/${id}`).catch(() => undefined);
    setSelected(new Set());
    await load();
  }

  return (
    <div className="tab">
      <h2>{t('settings.external')}</h2>
      <p className="hint">{t('external.description')}</p>
      <div className="toolbar right">
        <button className="primary" onClick={() => setEditing({ id: null, form: emptyForm(mailboxes) })}>
          {t('common.add')}
        </button>
        <button className="danger tb" disabled={selected.size === 0} onClick={removeSelected}>
          {t('common.delete')}
        </button>
      </div>
      {msg && <div className="info">{msg}</div>}

      <table className="grid">
        <thead>
          <tr>
            <th></th>
            <th>{t('external.no')}</th>
            <th>{t('common.name')}</th>
            <th>{t('external.server')}</th>
            <th>{t('external.loginId')}</th>
            <th>{t('external.protocol')}</th>
            <th>{t('external.port')}</th>
            <th>{t('upload.targetBox')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a, i) => (
            <tr key={a.externalId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(a.externalId)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      next.has(a.externalId) ? next.delete(a.externalId) : next.add(a.externalId);
                      return next;
                    })
                  }
                />
              </td>
              <td>{i + 1}</td>
              <td>
                <button
                  className="link"
                  onClick={() =>
                    setEditing({
                      id: a.externalId,
                      form: { ...a, loginPasswd: '' },
                    })
                  }
                >
                  {a.externalName}
                </button>
              </td>
              <td>{a.serverHost}</td>
              <td>{a.loginId}</td>
              <td>{a.protocol}</td>
              <td>
                {a.serverPort} ({a.securityType === 'SSL' ? 'SSL' : t('external.plain')})
              </td>
              <td>{mailboxName(a.targetMailboxId)}</td>
              <td>
                <button className="link" onClick={() => run(a)}>
                  {t('external.run')}
                </button>
                <button className="link" onClick={() => setEditing({ id: a.externalId, form: { ...a, loginPasswd: '' } })}>
                  {t('common.edit')}
                </button>
                <button
                  className="link danger"
                  onClick={() => {
                    if (confirm(t('external.confirmDelete', { name: a.externalName })))
                      void api.del(`/api/external-mail/${a.externalId}`).then(load);
                  }}
                >
                  {t('common.delete')}
                </button>
                <button className="link" onClick={() => setLogsOf(a)}>
                  {t('external.logs')}
                </button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr>
              <td colSpan={9} className="hint">
                {t('external.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <AccountModal
          id={editing.id}
          initial={editing.form}
          mailboxes={mailboxes}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {logsOf && <LogsModal account={logsOf} onClose={() => setLogsOf(null)} />}
    </div>
  );
}

function AccountModal({
  id,
  initial,
  mailboxes,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: Form;
  mailboxes: Mailbox[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<Form>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mailboxName = mailboxes.find((b) => b.id === form.targetMailboxId)?.displayName ?? '';

  function setProtocol(protocol: 'POP3' | 'IMAP', securityType = form.securityType) {
    // POP3 110/995, IMAP 143/993 을 기본으로 채운다
    const port = protocol === 'POP3' ? (securityType === 'SSL' ? 995 : 110) : securityType === 'SSL' ? 993 : 143;
    setForm({ ...form, protocol, securityType, serverPort: port });
  }

  async function save() {
    setError(null);
    if (!form.externalName.trim()) return setError(t('external.needName'));
    if (!HOST_RE.test(form.serverHost.trim())) return setError(t('external.badHost'));
    if (!form.loginId.trim()) return setError(t('external.needLoginId'));
    if (!id && !form.loginPasswd) return setError(t('external.needPassword'));
    if (!Number.isInteger(form.serverPort) || form.serverPort < 1 || form.serverPort > 65535)
      return setError(t('external.badPort'));
    if (!form.targetMailboxId) return setError(t('external.needBox'));
    try {
      const body = { ...form, serverHost: form.serverHost.trim(), loginPasswd: form.loginPasswd || undefined };
      if (id) await api.put(`/api/external-mail/${id}`, body);
      else await api.post('/api/external-mail', body);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  return (
    <Modal
      title={t('external.accountTitle')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      <p className="hint">{t('external.accountHint')}</p>
      <div className="form-row">
        <label>{t('external.nameLabel')}</label>
        <input value={form.externalName} onChange={(e) => setForm({ ...form, externalName: e.target.value })} />
      </div>
      <div className="form-row">
        <label>{t('external.serverLabel')}</label>
        <input
          placeholder={t('external.serverPlaceholder')}
          value={form.serverHost}
          onChange={(e) => setForm({ ...form, serverHost: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label>{t('external.idLabel')}</label>
        <input value={form.loginId} onChange={(e) => setForm({ ...form, loginId: e.target.value })} />
      </div>
      <div className="form-row">
        <label>{t('external.pwLabel')}</label>
        <input
          type="password"
          value={form.loginPasswd}
          placeholder={id ? t('external.pwOnlyChange') : ''}
          onChange={(e) => setForm({ ...form, loginPasswd: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label>{t('external.protocolLabel')}</label>
        <select value={form.protocol} onChange={(e) => setProtocol(e.target.value as 'POP3' | 'IMAP')}>
          <option value="IMAP">IMAP</option>
          <option value="POP3">POP3</option>
        </select>
      </div>
      <div className="form-row">
        <label>{t('external.portLabel')}</label>
        <input
          type="number"
          min={1}
          max={65535}
          value={form.serverPort}
          onChange={(e) => setForm({ ...form, serverPort: Number(e.target.value) })}
        />
        <select
          value={form.securityType}
          onChange={(e) => setProtocol(form.protocol, e.target.value as 'PLAIN' | 'SSL')}
        >
          <option value="PLAIN">{t('external.plain')}</option>
          <option value="SSL">SSL</option>
        </select>
      </div>
      <div className="form-row">
        <label>{t('external.boxLabel')}</label>
        <input value={mailboxName} readOnly placeholder={t('external.pickBox')} />
        <button className="tb" onClick={() => setPickerOpen(true)}>
          ▤
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {pickerOpen && (
        <MailboxPicker
          mailboxes={mailboxes}
          title={t('upload.pickBoxTitle')}
          onPick={(box) => {
            setForm({ ...form, targetMailboxId: box.id });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Modal>
  );
}

function LogsModal({ account, onClose }: { account: ExternalAccount; onClose: () => void }) {
  const t = useT();
  const [logs, setLogs] = useState<RunLog[] | null>(null);
  useEffect(() => {
    void api.get<RunLog[]>(`/api/external-mail/${account.externalId}/logs`).then(setLogs);
  }, [account.externalId]);
  return (
    <Modal
      title={t('external.logsTitle', { name: account.externalName })}
      onClose={onClose}
      width={560}
      footer={<button className="btn" onClick={onClose}>{t('common.close')}</button>}
    >
      {!logs && <div className="list-status">{t('common.loading')}</div>}
      {logs && (
        <table className="grid">
          <thead>
            <tr>
              <th>{t('external.no')}</th>
              <th>{t('external.startTime')}</th>
              <th>{t('external.endTime')}</th>
              <th>{t('external.mailCount')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={l.logId}>
                <td>{i + 1}</td>
                <td>{formatFullDate(l.startTime)}</td>
                <td>{formatFullDate(l.endTime)}</td>
                <td>{l.mailCount}</td>
                <td title={l.errorMsg ?? undefined}>{l.runStatus}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  {t('external.noLogs')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
