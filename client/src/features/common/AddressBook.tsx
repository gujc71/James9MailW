/**
 * 주소록 팝업 (POPUP-3). 검색, 연락처 빠른 추가·수정(이름 · 대표 메일)·삭제,
 * 50건씩 무한 스크롤(오류 시 [더보기]). onPick 이 있으면 [확인] 으로 선택한 주소를 부모창에 넘긴다.
 * 그룹을 고르면 멤버 전부로 풀어서 넘긴다. 상세 필드 · 그룹 편집은 개인 환경설정 > 주소록에서 한다.
 */
import { useCallback, useEffect, useState, type UIEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { AddressBookEntry, Recipient } from '../../api/types';
import { Modal } from './Modal';
import { useT } from '../../i18n';

const PAGE = 50;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function formatContact(entry: { contactName: string | null; mailAddress: string | null }): string {
  const address = entry.mailAddress ?? '';
  return entry.contactName ? `${entry.contactName} <${address}>` : address;
}

/** 고른 행들 → 받는 사람 문자열. 그룹은 서버에서 멤버로 풀고, 메일 없는 연락처는 뺀다 */
export async function pickedAddresses(rows: AddressBookEntry[]): Promise<string[]> {
  const groups = rows.filter((r) => r.kind === 'G').map((r) => r.addressId);
  const members = groups.length ? await api.post<Recipient[]>('/api/addresses/expand', { ids: groups }) : [];
  const list = [
    ...rows.filter((r) => r.kind === 'I' && r.mailAddress),
    ...members.map((m) => ({ contactName: m.name, mailAddress: m.address })),
  ];
  const seen = new Set<string>();
  return list
    .filter((r) => {
      const key = (r.mailAddress ?? '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(formatContact);
}

interface Editing {
  addressId: number | null;
  contactName: string;
  mailAddress: string;
}

export function AddressBook({
  onPick,
  onClose,
}: {
  onPick?: (addresses: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<AddressBookEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (applied) qs.set('keyword', applied);
        const page = await api.get<AddressBookEntry[]>(`/api/addresses?${qs}`);
        setRows((prev) => (offset === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : t('addressbook.loadFailed'));
        setHasMore(true);
      } finally {
        setLoading(false);
      }
    },
    [applied],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  async function saveContact() {
    if (!editing) return;
    if (!EMAIL_RE.test(editing.mailAddress)) {
      setError(t('addressbook.invalidEmail'));
      return;
    }
    try {
      if (editing.addressId) {
        await api.put(`/api/addresses/${editing.addressId}`, {
          contactName: editing.contactName || null,
          mailAddress: editing.mailAddress,
        });
      } else {
        await api.post('/api/addresses', {
          contactName: editing.contactName || null,
          mailAddress: editing.mailAddress,
        });
      }
      setEditing(null);
      await load(0);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  async function remove(entry: AddressBookEntry) {
    if (!confirm(t('addressbook.confirmDelete', { address: entry.contactName ?? entry.mailAddress ?? '' }))) return;
    await api.del(`/api/addresses/${entry.addressId}`).catch(() => undefined);
    await load(0);
  }

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    if (loading || !hasMore || error) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void load(rows.length);
  }

  return (
    <Modal
      title={t('addressbook.title')}
      onClose={onClose}
      width={600}
      footer={
        <>
          {onPick && (
            <button
              className="primary"
              disabled={selected.size === 0}
              onClick={() => {
                pickedAddresses(rows.filter((r) => selected.has(r.addressId)))
                  .then(onPick)
                  .catch((cause) => setError(cause instanceof ApiError ? cause.message : t('addressbook.loadFailed')));
              }}
            >
              {t('common.confirm')}
            </button>
          )}
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      <div className="ab-toolbar">
        <div className="search">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setApplied(keyword)}
            placeholder={t('addressbook.searchPlaceholder')}
          />
          <button className="btn" type="button" onClick={() => setApplied(keyword)}>
            {t('common.search')}
          </button>
        </div>
        <button
          type="button"
          className="link"
          onClick={() => setEditing({ addressId: null, contactName: '', mailAddress: '' })}
        >
          {t('addressbook.addContact')}
        </button>
      </div>

      {editing && (
        <div className="ab-edit">
          <input
            placeholder={t('addressbook.namePlaceholder')}
            value={editing.contactName}
            onChange={(e) => setEditing({ ...editing, contactName: e.target.value })}
          />
          <input
            placeholder={t('addressbook.emailPlaceholder')}
            value={editing.mailAddress}
            onChange={(e) => setEditing({ ...editing, mailAddress: e.target.value })}
          />
          <button type="button" className="primary" onClick={saveContact}>
            {t('common.save')}
          </button>
          <button className="btn" type="button" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="ab-list" onScroll={onScroll}>
        <table className="grid">
          <thead>
            <tr>
              {onPick && <th></th>}
              <th>{t('common.name')}</th>
              <th>{t('addressbook.emailColumn')}</th>
              <th>{t('addressbook.manage')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.addressId}>
                {onPick && (
                  <td>
                    <input
                      type="checkbox"
                      disabled={entry.kind === 'I' && !entry.mailAddress}
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
                )}
                <td>
                  {entry.kind === 'G' && <span className="ab-badge">{t('addressbook.groupBadge')}</span>}
                  {entry.contactName ?? '-'}
                </td>
                <td>{entry.kind === 'G' ? <span className="hint">{t('addressbook.groupHint')}</span> : (entry.mailAddress ?? '-')}</td>
                <td>
                  {entry.kind === 'I' && (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setEditing({
                        addressId: entry.addressId,
                        contactName: entry.contactName ?? '',
                        mailAddress: entry.mailAddress ?? '',
                      })
                    }
                  >
                    {t('common.edit')}
                  </button>
                  )}
                  <button type="button" className="link danger" onClick={() => remove(entry)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={onPick ? 4 : 3} className="hint">
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
      </div>
    </Modal>
  );
}
