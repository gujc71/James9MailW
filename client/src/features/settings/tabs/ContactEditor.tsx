/**
 * 연락처 상세 편집 (개인 환경설정 > 주소록). 썬더버드 연락처 카드와 같은 갈래를 고친다:
 * 사진 · 이름(표시 · 성 · 이름 · 별명) · 메일 · 전화 · 회사(부서 · 직함) · 주소 · 생일 · 메모.
 * 화면에 없는 vCard 속성(웹 페이지 URL 등)은 받은 값을 그대로 돌려보내므로 서버가 원문에 남겨 둔다.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { ContactAddress, ContactDetail, ContactFields, ContactTyped } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { EMAIL_RE } from '../../common/AddressBook';
import { useT, type MessageKey } from '../../../i18n';
import { AVATAR_PX, blobToDataUrl, resizeImage } from '../../../lib/image';

export const EMPTY_CONTACT: ContactFields = {
  kind: 'individual',
  displayName: '',
  familyName: '',
  givenName: '',
  nickname: '',
  emails: [],
  phones: [],
  org: '',
  department: '',
  title: '',
  addresses: [],
  birthday: '',
  urls: [],
  note: '',
  photo: null,
  members: [],
};

const EMAIL_TYPES = ['other', 'work', 'home'] as const;
const PHONE_TYPES = ['cell', 'work', 'home', 'fax', 'pager', 'other'] as const;
const ADDRESS_TYPES = ['work', 'home', 'other'] as const;

const typeLabel = (type: string): MessageKey => `addressbook.type.${type}` as MessageKey;

function TypedList({
  label,
  items,
  types,
  inputType,
  onChange,
  addLabel,
}: {
  label: string;
  items: ContactTyped[];
  types: readonly string[];
  inputType: 'email' | 'tel';
  onChange: (items: ContactTyped[]) => void;
  addLabel: string;
}) {
  const t = useT();
  return (
    <div className="form-row ce-list">
      <label>{label}</label>
      <div className="ce-items">
        {items.map((item, i) => (
          <div className="ce-item" key={i}>
            <select
              value={types.includes(item.type) ? item.type : 'other'}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
            >
              {types.map((type) => (
                <option key={type} value={type}>
                  {t(typeLabel(type))}
                </option>
              ))}
            </select>
            <input
              type={inputType}
              value={item.value}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            {inputType === 'email' && i === 0 && items.length > 1 && <span className="hint">{t('addressbook.primary')}</span>}
            <button type="button" className="link danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              {t('common.delete')}
            </button>
          </div>
        ))}
        <button type="button" className="link" onClick={() => onChange([...items, { type: types[0]!, value: '' }])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

export function ContactEditor({
  addressId,
  initial,
  onClose,
  onSaved,
}: {
  addressId: number | null;
  /** 새 연락처의 처음 값 (예: 읽기 화면에서 보낸 사람을 주소록에 넣을 때) */
  initial?: Partial<ContactFields>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [fields, setFields] = useState<ContactFields | null>(addressId === null ? { ...EMPTY_CONTACT, ...initial } : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addressId === null) return;
    let alive = true;
    api
      .get<ContactDetail>(`/api/addresses/${addressId}`)
      .then((detail) => alive && setFields({ ...EMPTY_CONTACT, ...detail.fields }))
      .catch((cause) => alive && setError(cause instanceof ApiError ? cause.message : t('addressbook.loadFailed')));
    return () => {
      alive = false;
    };
  }, [addressId]);

  const set = <K extends keyof ContactFields>(k: K, v: ContactFields[K]) => setFields((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!fields) return;
    const emails = fields.emails.map((e) => ({ ...e, value: e.value.trim() })).filter((e) => e.value);
    const bad = emails.find((e) => !EMAIL_RE.test(e.value));
    if (bad) {
      setError(t('addressbook.invalidEmailValue', { address: bad.value }));
      return;
    }
    if (fields.birthday && !/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(fields.birthday.trim())) {
      setError(t('addressbook.invalidBirthday'));
      return;
    }
    if (!fields.displayName.trim() && !fields.familyName.trim() && !fields.givenName.trim() && !emails.length && !fields.phones.some((p) => p.value.trim())) {
      setError(t('addressbook.contactEmpty'));
      return;
    }
    setBusy(true);
    setError(null);
    const payload: ContactFields = {
      ...fields,
      emails,
      phones: fields.phones.filter((p) => p.value.trim()),
      birthday: fields.birthday.trim(),
    };
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
    const label = fields.displayName || fields.emails[0]?.value || '';
    if (!confirm(t('addressbook.confirmDelete', { address: label }))) return;
    try {
      await api.del(`/api/addresses/${addressId}`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const blob = await resizeImage(file, { width: AVATAR_PX, height: AVATAR_PX, cover: true });
      // vCard PHOTO 로 실을 수 있는 형식만 (원본이 이미 작아 그대로 돌아온 BMP 따위는 뺀다)
      if (!/^image\/(jpeg|png|gif|webp)$/.test(blob.type)) throw new Error('unsupported');
      set('photo', await blobToDataUrl(blob));
    } catch {
      setError(t('addressbook.photoFailed'));
    }
  }

  const setAddress = (i: number, patch: Partial<ContactAddress>) =>
    set(
      'addresses',
      fields!.addresses.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    );

  return (
    <Modal
      title={addressId === null ? t('addressbook.newContact') : t('addressbook.editContact')}
      onClose={onClose}
      width={720}
      className="contact-editor"
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
        <div className="ce-form">
          <div className="ce-head">
            <div className="ce-photo">
              {fields.photo ? <img src={fields.photo} alt="" /> : <span aria-hidden>{(fields.displayName || fields.givenName || '?').slice(0, 1)}</span>}
            </div>
            <div className="ce-photo-actions">
              <button type="button" className="link" onClick={() => photoRef.current?.click()}>
                {t('addressbook.photoChange')}
              </button>
              {fields.photo && (
                <button type="button" className="link danger" onClick={() => set('photo', null)}>
                  {t('addressbook.photoRemove')}
                </button>
              )}
              <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => void pickPhoto(e.target.files?.[0])} />
            </div>
          </div>

          <div className="form-row">
            <label>{t('addressbook.displayName')}</label>
            <input value={fields.displayName} onChange={(e) => set('displayName', e.target.value)} maxLength={200} />
          </div>
          <div className="form-row">
            <label>{t('addressbook.familyName')}</label>
            <input value={fields.familyName} onChange={(e) => set('familyName', e.target.value)} maxLength={100} />
            <label className="inline-label">{t('addressbook.givenName')}</label>
            <input value={fields.givenName} onChange={(e) => set('givenName', e.target.value)} maxLength={100} />
          </div>
          <div className="form-row">
            <label>{t('addressbook.nickname')}</label>
            <input value={fields.nickname} onChange={(e) => set('nickname', e.target.value)} maxLength={100} />
          </div>

          <TypedList
            label={t('addressbook.emails')}
            items={fields.emails}
            types={EMAIL_TYPES}
            inputType="email"
            onChange={(v) => set('emails', v)}
            addLabel={t('addressbook.addEmail')}
          />
          <TypedList
            label={t('addressbook.phones')}
            items={fields.phones}
            types={PHONE_TYPES}
            inputType="tel"
            onChange={(v) => set('phones', v)}
            addLabel={t('addressbook.addPhone')}
          />

          <div className="form-row">
            <label>{t('addressbook.org')}</label>
            <input value={fields.org} onChange={(e) => set('org', e.target.value)} maxLength={200} />
          </div>
          <div className="form-row">
            <label>{t('addressbook.department')}</label>
            <input value={fields.department} onChange={(e) => set('department', e.target.value)} maxLength={200} />
            <label className="inline-label">{t('addressbook.jobTitle')}</label>
            <input value={fields.title} onChange={(e) => set('title', e.target.value)} maxLength={200} />
          </div>

          <div className="form-row ce-list">
            <label>{t('addressbook.addresses')}</label>
            <div className="ce-items">
              {fields.addresses.map((a, i) => (
                <div className="ce-address" key={i}>
                  <div className="ce-item">
                    <select value={a.type} onChange={(e) => setAddress(i, { type: e.target.value })}>
                      {ADDRESS_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(typeLabel(type))}
                        </option>
                      ))}
                    </select>
                    <input placeholder={t('addressbook.street')} value={a.street} onChange={(e) => setAddress(i, { street: e.target.value })} />
                    <button type="button" className="link danger" onClick={() => set('addresses', fields.addresses.filter((_, j) => j !== i))}>
                      {t('common.delete')}
                    </button>
                  </div>
                  <div className="ce-item">
                    <input placeholder={t('addressbook.extended')} value={a.extended} onChange={(e) => setAddress(i, { extended: e.target.value })} />
                    <input placeholder={t('addressbook.locality')} value={a.locality} onChange={(e) => setAddress(i, { locality: e.target.value })} />
                    <input placeholder={t('addressbook.region')} value={a.region} onChange={(e) => setAddress(i, { region: e.target.value })} />
                    <input placeholder={t('addressbook.postalCode')} value={a.postalCode} onChange={(e) => setAddress(i, { postalCode: e.target.value })} />
                    <input placeholder={t('addressbook.country')} value={a.country} onChange={(e) => setAddress(i, { country: e.target.value })} />
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="link"
                onClick={() =>
                  set('addresses', [
                    ...fields.addresses,
                    { type: 'work', poBox: '', extended: '', street: '', locality: '', region: '', postalCode: '', country: '' },
                  ])
                }
              >
                {t('addressbook.addAddress')}
              </button>
            </div>
          </div>

          <div className="form-row">
            <label>{t('addressbook.birthday')}</label>
            <input
              value={fields.birthday}
              placeholder="YYYY-MM-DD"
              onChange={(e) => set('birthday', e.target.value)}
              maxLength={10}
              className="ce-short"
            />
            <span className="hint">{t('addressbook.birthdayHint')}</span>
          </div>
          <div className="form-row">
            <label>{t('addressbook.note')}</label>
            <textarea rows={4} value={fields.note} onChange={(e) => set('note', e.target.value)} maxLength={10000} />
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
