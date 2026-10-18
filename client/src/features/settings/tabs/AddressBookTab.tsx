/**
 * 개인 환경설정 > 주소록. 연락처 · 그룹 목록, 상세 편집(ContactEditor) · 그룹 편집(GroupEditor),
 * 선택 삭제, vCard · CSV 가져오기 · 내보내기, 외부 프로그램 연결(CardDAV, CarddavSection).
 *
 * 연락처 한 건 = vCard 한 장이다. 썬더버드에서 넣은 사진 · 기타 속성은 화면에 없어도 서버가
 * 원문에 그대로 남겨 두므로(server/src/contacts/vcard.ts mergeFields) 여기서 고쳐도 사라지지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { AddressBookEntry, Me } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { showToast } from '../../common/Toast';
import { useT } from '../../../i18n';
import { ContactEditor } from './ContactEditor';
import { GroupEditor } from './GroupEditor';
import { CarddavSection } from './CarddavSection';

const PAGE = 100;

type KindFilter = '' | 'I' | 'G';

type Editing = { kind: 'I' | 'G'; addressId: number | null };

export function AddressBookTab({ me, onMeChanged }: { me: Me; onMeChanged: (me: Me) => void }) {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [rows, setRows] = useState<AddressBookEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (applied) qs.set('keyword', applied);
        if (kind) qs.set('kind', kind);
        const page = await api.get<AddressBookEntry[]>(`/api/addresses?${qs}`);
        setRows((prev) => (offset === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE);
        if (offset === 0) setSelected(new Set());
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : t('addressbook.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [applied, kind],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  async function removeSelected() {
    if (selected.size === 0) return;
    if (!confirm(t('addressbook.confirmDeleteN', { n: selected.size }))) return;
    try {
      await api.post('/api/addresses/delete', { ids: [...selected] });
      await load(0);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.addressId));

  return (
    <div className="tab addressbook-tab">
      <h2>{t('settings.addressbook')}</h2>
      <p className="hint">{t('addressbook.tabDescription')}</p>

      <CarddavSection me={me} onMeChanged={onMeChanged} />

      <div className="toolbar">
        <div className="search">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setApplied(keyword.trim())}
            placeholder={t('addressbook.searchDetail')}
          />
          <button className="btn" type="button" onClick={() => setApplied(keyword.trim())}>
            {t('common.search')}
          </button>
          <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label={t('addressbook.kindFilter')}>
            <option value="">{t('common.all')}</option>
            <option value="I">{t('addressbook.contacts')}</option>
            <option value="G">{t('addressbook.groups')}</option>
          </select>
        </div>
        <button className="primary" type="button" onClick={() => setEditing({ kind: 'I', addressId: null })}>
          {t('addressbook.newContact')}
        </button>
        <button className="btn" type="button" onClick={() => setEditing({ kind: 'G', addressId: null })}>
          {t('addressbook.newGroup')}
        </button>
        <button className="btn" type="button" onClick={() => setImportOpen(true)}>
          {t('addressbook.import')}
        </button>
        <a className="btn" href="/api/addresses/export?format=vcf" download="contacts.vcf">
          {t('addressbook.exportVcf')}
        </a>
        <a className="btn" href="/api/addresses/export?format=csv" download="contacts.csv">
          {t('addressbook.exportCsv')}
        </a>
        <button className="danger tb" type="button" disabled={selected.size === 0} onClick={removeSelected}>
          {t('common.delete')}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <table className="grid ab-grid" data-testid="addressbook-grid">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label={t('addressbook.selectAll')}
                checked={allChecked}
                onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.addressId)))}
              />
            </th>
            <th>{t('common.name')}</th>
            <th>{t('addressbook.emailColumn')}</th>
            <th>{t('addressbook.orgColumn')}</th>
            <th>{t('addressbook.phoneColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={entry.addressId} className="clickable" onClick={() => setEditing({ kind: entry.kind, addressId: entry.addressId })}>
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(entry.addressId)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      next.has(entry.addressId) ? next.delete(entry.addressId) : next.add(entry.addressId);
                      return next;
                    })
                  }
                />
              </td>
              <td>
                {entry.kind === 'G' && <span className="ab-badge">{t('addressbook.groupBadge')}</span>}
                {entry.contactName ?? <span className="hint">{t('addressbook.noName')}</span>}
              </td>
              <td>{entry.kind === 'G' ? <span className="hint">{t('addressbook.groupHint')}</span> : (entry.mailAddress ?? '-')}</td>
              <td>{entry.org ?? ''}</td>
              <td>{entry.phone ?? ''}</td>
            </tr>
          ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                {t('addressbook.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {loading && <div className="list-status">{t('common.loading')}</div>}
      {!loading && hasMore && (
        <button type="button" className="more" onClick={() => load(rows.length)}>
          {t('common.more')}
        </button>
      )}

      {editing?.kind === 'I' && (
        <ContactEditor
          addressId={editing.addressId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load(0);
          }}
        />
      )}
      {editing?.kind === 'G' && (
        <GroupEditor
          addressId={editing.addressId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load(0);
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            void load(0);
          }}
        />
      )}
    </div>
  );
}

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 파일 고르기 → 서버가 글자셋(UTF-8 · CP949)과 형식을 가려 읽는다 */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(t('addressbook.importTooLarge'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = toBase64(await file.arrayBuffer());
      const result = await api.post<ImportResult>('/api/addresses/import', { fileName: file.name, data, overwrite });
      showToast(t('addressbook.importDone', { ...result }));
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('addressbook.import')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="primary" disabled={!file || busy} onClick={run}>
            {busy ? t('common.loading') : t('addressbook.importRun')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <p className="hint">{t('addressbook.importHint')}</p>
      <div className="form-row">
        <label>{t('addressbook.importFile')}</label>
        <input ref={fileRef} type="file" accept=".vcf,.vcard,.csv,.txt,.tab,text/vcard,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="form-row">
        <label>{t('addressbook.importDuplicate')}</label>
        <label className="checkbox">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          {t('addressbook.importOverwrite')}
        </label>
      </div>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
