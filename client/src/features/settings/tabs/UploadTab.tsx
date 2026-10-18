/** USR-22 메일 업로드 (EML 다건 업로드). [추가] 팝업에서 파일·저장 편지함(POPUP-1)을 고른다 */
import { useEffect, useState } from 'react';
import { api } from '../../../api/client';
import type { Mailbox } from '../../../api/types';
import { formatFullDate } from '../../../lib/format';
import { MailboxPicker } from '../../common/MailboxPicker';
import { Modal } from '../../common/Modal';
import { useT } from '../../../i18n';

interface UploadHistory {
  uploadId: number;
  mailboxName: string;
  fileCount: number;
  doneCount: number;
  runStatus: string;
  runDate: string | null;
}

export function UploadTab({ mailboxes }: { mailboxes: Mailbox[] }) {
  const t = useT();
  const [history, setHistory] = useState<UploadHistory[]>([]);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Mailbox | null>(mailboxes.find((b) => b.role === 'INBOX') ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<UploadHistory[]>('/api/messages/upload/history').then(setHistory);
  useEffect(() => {
    void load();
  }, []);

  async function run() {
    if (!files || files.length === 0 || !target) return;
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.set('mailboxId', target.id);
      for (const file of Array.from(files)) form.append('files', file, file.name);
      const res = await api.form<{ fileCount: number; doneCount: number }>('/api/messages/upload', form);
      setMsg(t('upload.savedCount', { done: res.doneCount, total: res.fileCount }));
      setOpen(false);
      setFiles(null);
      await load();
    } catch (cause) {
      setMsg((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tab">
      <h2>{t('settings.upload')}</h2>
      <p className="hint">{t('upload.description')}</p>
      <div className="toolbar right">
        <button className="primary" onClick={() => setOpen(true)}>
          {t('common.add')}
        </button>
      </div>
      {msg && <div className="info">{msg}</div>}

      <table className="grid">
        <thead>
          <tr>
            <th>{t('upload.no')}</th>
            <th>{t('upload.runDate')}</th>
            <th>{t('upload.fileCount')}</th>
            <th>{t('mailboxTab.box')}</th>
            <th>{t('upload.doneCount')}</th>
            <th>{t('common.status')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => (
            <tr key={h.uploadId}>
              <td>{i + 1}</td>
              <td>{formatFullDate(h.runDate)}</td>
              <td>{h.fileCount}</td>
              <td>{h.mailboxName}</td>
              <td>{h.doneCount}</td>
              <td>{h.runStatus}</td>
              <td>
                <button
                  className="link danger"
                  onClick={() => {
                    if (confirm(t('upload.confirmDeleteHistory')))
                      void api.del(`/api/messages/upload/${h.uploadId}`).then(load);
                  }}
                >
                  {t('common.delete')}
                </button>
              </td>
            </tr>
          ))}
          {history.length === 0 && (
            <tr>
              <td colSpan={7} className="hint">
                {t('upload.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {open && (
        <Modal
          title={t('settings.upload')}
          onClose={() => setOpen(false)}
          width={460}
          footer={
            <>
              <button className="primary" disabled={busy || !files?.length || !target} onClick={run}>
                {t('upload.run')}
              </button>
              <button className="btn" onClick={() => setOpen(false)}>{t('common.close')}</button>
            </>
          }
        >
          <div className="form-row">
            <label>{t('upload.files')}</label>
            <input type="file" multiple accept=".eml,message/rfc822" onChange={(e) => setFiles(e.target.files)} />
          </div>
          <div className="form-row">
            <label>{t('upload.targetBox')}</label>
            <input value={target?.displayName ?? ''} readOnly placeholder={t('upload.pickBox')} />
            <button
              className="tb icon"
              onClick={() => setPickerOpen(true)}
              title={t('upload.browseBox')}
              aria-label={t('upload.browseBox')}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <line x1="9.9" y1="9.9" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {files && <p className="hint">{t('upload.filesSelected', { n: files.length })}</p>}
        </Modal>
      )}
      {pickerOpen && (
        <MailboxPicker
          mailboxes={mailboxes}
          title={t('upload.pickBoxTitle')}
          onPick={(box) => {
            setTarget(box);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
