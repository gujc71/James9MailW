/**
 * USR-17 서명관리.
 *  - 서명 사용 여부 · 기본 서명
 *  - 서명 등록 · 수정 · 삭제
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Me, Signature, UserSetting } from '../../../api/types';
import { SignatureEditor, type SignatureDraft } from './SignatureEditor';
import { useT } from '../../../i18n';

/**
 * 목록에 한 줄로 보여 줄 서명 내용. 태그를 걷어 내고 공백을 눌러 한 줄로 만든다 —
 * 서명은 HTML 이라 원본을 그대로 칸에 넣으면 표가 무너진다.
 */
function summarize(html: string): string {
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

/** 편집 중인 서명. null 이면 새로 쓰는 것, undefined 면 팝업이 닫혀 있다 */
type Editing = Signature | null;

export function SignatureTab({ me, onMeChanged }: { me: Me; onMeChanged: (me: Me) => void }) {
  const t = useT();
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [setting, setSetting] = useState<UserSetting>(me.setting);
  const [defaultSignature, setDefaultSignature] = useState<number | ''>('');
  const [msg, setMsg] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | undefined>(undefined);

  const load = () =>
    api.get<Signature[]>('/api/signatures').then((list) => {
      setSignatures(list);
      setDefaultSignature(list.find((s) => s.isDefault)?.signatureId ?? '');
    });
  useEffect(() => {
    void load();
  }, []);


  async function saveSettings() {
    setMsg(null);
    try {
      const saved = await api.put<UserSetting>('/api/me/setting', {
        personalSignYn: setting.personalSignYn,
      });
      // 기본 서명은 하나뿐이다 — 내리고 올리는 일은 서버가 한 번에 한다
      await api.put('/api/signatures/default', {
        signatureId: defaultSignature === '' ? null : defaultSignature,
      });
      const next = { ...me, setting: { ...me.setting, ...(saved ?? setting) } };
      onMeChanged(next);
      setSetting(next.setting);
      await load();
      setMsg(t('common.saved'));
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  /** 팝업의 저장. 성공하면 null, 실패하면 팝업에 띄울 문구를 돌려준다 */
  async function saveSignature(draft: SignatureDraft): Promise<string | null> {
    setMsg(null);
    try {
      if (editing) {
        await api.put(`/api/signatures/${editing.signatureId}`, {
          name: draft.name,
          content: draft.content,
        });
      } else {
        await api.post('/api/signatures', draft);
      }
      await load();
      setEditing(undefined);
      return null;
    } catch (cause) {
      return cause instanceof ApiError ? cause.message : t('signature.saveFailed');
    }
  }

  async function removeSignature(target: Signature) {
    if (!window.confirm(t('signature.confirmDelete', { name: target.name }))) return;
    setMsg(null);
    try {
      await api.del(`/api/signatures/${target.signatureId}`);
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  const radio = (label: string, checked: boolean, onChange: () => void) => (
    <label className="checkbox">
      <input type="radio" checked={checked} onChange={onChange} />
      {label}
    </label>
  );

  return (
    <div className="tab">
      <h2>{t('settings.signature')}</h2>

      <div className="form-row">
        <label>{t('signature.personalSign')}</label>
        {radio(t('common.use'), setting.personalSignYn, () => setSetting({ ...setting, personalSignYn: true }))}
        {radio(t('common.notUse'), !setting.personalSignYn, () => setSetting({ ...setting, personalSignYn: false }))}
      </div>
      <div className="form-row">
        <label>{t('signature.defaultPersonal')}</label>
        <select
          value={defaultSignature}
          disabled={!setting.personalSignYn}
          onChange={(e) => setDefaultSignature(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">{t('signature.noneSelected')}</option>
          {signatures.map((s) => (
            <option key={s.signatureId} value={s.signatureId}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {msg && <div className="info">{msg}</div>}
      <div className="modal-actions left">
        <button className="primary" onClick={saveSettings}>
          {t('common.save')}
        </button>
        <button className="btn"
          onClick={() => {
            setSetting(me.setting);
            void load();
          }}
        >
          {t('common.cancel')}
        </button>
      </div>

      <h3>{t('signature.list')}</h3>
      <div className="toolbar right">
        <span className="hint">{t('rules.total', { n: signatures.length })}</span>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setMsg(null);
            setEditing(null);
          }}
        >
          {t('signature.add')}
        </button>
      </div>

      {signatures.length === 0 ? (
        <p className="hint">{t('signature.empty')}</p>
      ) : (
        <table className="grid sig-grid">
          <thead>
            <tr>
              <th style={{ width: 200 }}>{t('common.name')}</th>
              <th>{t('signature.content')}</th>
              <th style={{ width: 64 }}>{t('signature.defaultCol')}</th>
              <th style={{ width: 84 }} />
            </tr>
          </thead>
          <tbody>
            {signatures.map((sig) => (
              <tr
                key={sig.signatureId}
                className="clickable"
                title={t('rules.clickToEdit')}
                onClick={() => {
                  setMsg(null);
                  setEditing(sig);
                }}
              >
                <td>{sig.name}</td>
                <td className="sig-preview">
                  {summarize(sig.content) || <span className="hint">{t('common.none')}</span>}
                </td>
                <td>{sig.isDefault && <span className="tag large">{t('signature.defaultCol')}</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="link danger" onClick={() => void removeSignature(sig)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing !== undefined && (
        <SignatureEditor
          key={editing?.signatureId ?? 0}
          signature={editing}
          placeholder={t('signature.editorPlaceholder', {
            name: me.displayName ?? '',
            user: me.userName,
          })}
          onSave={saveSignature}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
