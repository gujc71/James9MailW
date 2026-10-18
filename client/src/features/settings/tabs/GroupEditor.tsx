/**
 * 그룹(배포 리스트) 편집 (개인 환경설정 > 주소록). 이름과 멤버를 고친다.
 * 멤버는 주소록 연락처(UID 로 가리킨다) 또는 주소록에 없는 메일 주소(mailto:)다.
 * 메일쓰기 · 일정 참석자에서 그룹 이름을 치거나 주소록 팝업에서 그룹을 고르면 멤버 전부가 들어간다.
 * 썬더버드의 CardDAV 주소록은 메일링 리스트를 지원하지 않아 그룹은 웹에서만 쓴다.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { AddressBookEntry, ContactDetail, ContactFields, GroupMember } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { EMAIL_RE } from '../../common/AddressBook';
import { useT } from '../../../i18n';
import { EMPTY_CONTACT } from './ContactEditor';

/** 화면에서 다루는 멤버 한 줄 */
interface Row {
  /** 저장할 값: 연락처 UID 또는 mailto:주소 */
  ref: string;
  name: string | null;
  address: string | null;
  missing?: boolean;
}

function rowOf(member: GroupMember): Row {
  if ('addressId' in member) return { ref: member.uid, name: member.contactName, address: member.mailAddress };
  if ('missing' in member) return { ref: member.uid, name: null, address: null, missing: true };
  return { ref: `mailto:${member.address}`, name: null, address: member.address };
}

export function GroupEditor({ addressId, onClose, onSaved }: { addressId: number | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [fields, setFields] = useState<ContactFields | null>(addressId === null ? { ...EMPTY_CONTACT, kind: 'group' } : null);
  const [members, setMembers] = useState<Row[]>([]);
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<AddressBookEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (addressId === null) return;
    let alive = true;
    api
      .get<ContactDetail>(`/api/addresses/${addressId}`)
      .then((detail) => {
        if (!alive) return;
        setFields({ ...EMPTY_CONTACT, ...detail.fields });
        setMembers(detail.members.map(rowOf));
      })
      .catch((cause) => alive && setError(cause instanceof ApiError ? cause.message : t('addressbook.loadFailed')));
    return () => {
      alive = false;
    };
  }, [addressId]);

  // 멤버로 넣을 연락처 찾기 (그룹 · 메일 없는 연락처는 뺀다)
  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setFound([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .get<AddressBookEntry[]>(`/api/addresses?${new URLSearchParams({ keyword: q, kind: 'I', limit: '20', offset: '0' })}`)
        .then((rows) => alive && setFound(rows.filter((r) => r.mailAddress)))
        .catch(() => alive && setFound([]));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [keyword]);

  const has = (ref: string) => members.some((m) => m.ref.toLowerCase() === ref.toLowerCase());

  function addContact(entry: AddressBookEntry) {
    if (!has(entry.uid)) setMembers((prev) => [...prev, { ref: entry.uid, name: entry.contactName, address: entry.mailAddress }]);
    setKeyword('');
  }

  /** 주소록에 없는 주소를 그대로 멤버로 넣는다 */
  function addTyped() {
    const address = keyword.trim();
    if (!EMAIL_RE.test(address)) {
      setError(t('addressbook.invalidEmailValue', { address }));
      return;
    }
    setError(null);
    if (!has(`mailto:${address}`)) setMembers((prev) => [...prev, { ref: `mailto:${address}`, name: null, address }]);
    setKeyword('');
  }

  async function save() {
    if (!fields) return;
    if (!fields.displayName.trim()) {
      setError(t('addressbook.groupNameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    const payload: ContactFields = { ...fields, kind: 'group', members: members.map((m) => m.ref) };
    try {
      if (addressId === null) await api.post('/api/addresses', { fields: payload });
      else await api.put(`/api/addresses/${addressId}`, { fields: payload });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (addressId === null || !fields) return;
    if (!confirm(t('addressbook.confirmDeleteGroup', { name: fields.displayName }))) return;
    try {
      await api.del(`/api/addresses/${addressId}`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  return (
    <Modal
      title={addressId === null ? t('addressbook.newGroup') : t('addressbook.editGroup')}
      onClose={onClose}
      width={600}
      footer={
        <>
          {addressId !== null && (
            <button type="button" className="danger tb ce-delete" onClick={remove}>
              {t('common.delete')}
            </button>
          )}
          <button type="button" className="primary" disabled={!fields || busy} onClick={save}>
            {t('common.save')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      {!fields ? (
        error ? <div className="error">{error}</div> : <div className="list-status">{t('common.loading')}</div>
      ) : (
        <>
          <div className="form-row">
            <label>{t('addressbook.groupName')}</label>
            <input
              value={fields.displayName}
              onChange={(e) => setFields({ ...fields, displayName: e.target.value })}
              maxLength={100}
              autoFocus={addressId === null}
            />
          </div>
          <div className="form-row">
            <label>{t('addressbook.note')}</label>
            <textarea rows={2} value={fields.note} onChange={(e) => setFields({ ...fields, note: e.target.value })} maxLength={10000} />
          </div>

          <div className="form-row">
            <label>{t('addressbook.addMember')}</label>
            <div className="ge-search">
              <input
                value={keyword}
                placeholder={t('addressbook.memberSearch')}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (found[0]) addContact(found[0]);
                  else addTyped();
                }}
              />
              {keyword.trim() && (
                <ul className="suggest ge-found" role="listbox">
                  {found.map((entry) => (
                    <li
                      key={entry.addressId}
                      className="suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addContact(entry);
                      }}
                    >
                      {entry.contactName && <span className="suggest-name">{entry.contactName}</span>}
                      <span className="suggest-addr">{entry.mailAddress}</span>
                    </li>
                  ))}
                  {EMAIL_RE.test(keyword.trim()) && (
                    <li
                      className="suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addTyped();
                      }}
                    >
                      <span className="suggest-addr">{t('addressbook.addTypedAddress', { address: keyword.trim() })}</span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>

          <h4 className="ge-title">{t('addressbook.membersCount', { count: members.length })}</h4>
          <div className="ab-list">
            <table className="grid">
              <tbody>
                {members.map((m) => (
                  <tr key={m.ref}>
                    <td>{m.missing ? <span className="hint">{t('addressbook.memberMissing')}</span> : (m.name ?? '-')}</td>
                    <td>{m.address ?? '-'}</td>
                    <td className="ge-remove">
                      <button type="button" className="link danger" onClick={() => setMembers((prev) => prev.filter((x) => x.ref !== m.ref))}>
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={3} className="hint">
                      {t('addressbook.noMembers')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </Modal>
  );
}
