/** USR-14 개인 정보 관리: 이름·사진 변경 + 비밀번호 변경(팝업) */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Me } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { useT } from '../../../i18n';
import { loadClearOnLogout, saveClearOnLogout } from '../../../lib/localCache';
import { AVATAR_PX, resizeImage } from '../../../lib/image';

/** 서버 상한은 1MB (store/photos.ts). 크기는 lib/image.ts 의 AVATAR_PX */
const PHOTO_MAX_BYTES = 1024 * 1024;

export function ProfileTab({ me, onMeChanged }: { me: Me; onMeChanged: (me: Me) => void }) {
  const t = useT();
  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 저장 버튼을 누를 때 반영한다. null 은 변경 없음, 'remove' 는 삭제 */
  const [pending, setPending] = useState<Blob | 'remove' | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 이 PC 에만 적용되는 값이라 [저장] 과 무관하게 누르는 즉시 반영한다 (lib/localCache.ts) */
  const [clearCache, setClearCache] = useState(() => loadClearOnLogout(me.userName));

  function toggleClearCache(next: boolean) {
    setClearCache(next);
    saveClearOnLogout(me.userName, next);
    setErr(null);
    setMsg(t(next ? 'profile.cacheClearOn' : 'profile.cacheClearOff'));
  }

  // 미리보기 blob URL 은 교체·언마운트 때 반드시 되돌려준다
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function showPreview(blob: Blob | null) {
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return blob ? URL.createObjectURL(blob) : null;
    });
  }

  async function pickPhoto(file: File | undefined) {
    setMsg(null);
    setErr(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErr(t('profile.imageOnly'));
      return;
    }
    try {
      const blob = await resizeImage(file, { width: AVATAR_PX, height: AVATAR_PX, cover: true });
      if (blob.size > PHOTO_MAX_BYTES) {
        setErr(t('profile.photoTooBig'));
        return;
      }
      setPending(blob);
      showPreview(blob);
    } catch {
      setErr(t('profile.photoUnreadable'));
    }
  }

  function removePhoto() {
    setMsg(null);
    setErr(null);
    setPending('remove');
    showPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function reset() {
    setDisplayName(me.displayName ?? '');
    setPending(null);
    showPreview(null);
    setMsg(null);
    setErr(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function save() {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      // 빈 이름은 null 로 보내 아이디가 대신 보이게 한다 (빈 문자열이면 표시가 비어 버린다)
      const name = displayName.trim() || null;
      await api.put('/api/me/profile', { displayName: name });
      let photo = me.photo;
      if (pending === 'remove') {
        await api.del('/api/me/photo');
        photo = null;
      } else if (pending) {
        const form = new FormData();
        form.append('photo', pending, 'photo');
        photo = (await api.form<{ photo: string }>('/api/me/photo', form)).photo;
      }
      setPending(null);
      showPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      setDisplayName(name ?? '');
      onMeChanged({ ...me, displayName: name, photo });
      setMsg(t('profile.saved'));
    } catch (cause) {
      setErr(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  // 미리보기 > 저장된 사진 > 이름 첫 글자
  const shown = previewUrl ?? (pending === 'remove' ? null : me.photo);
  const initial = (displayName || me.userName).charAt(0).toUpperCase();

  return (
    <div className="tab">
      <h2>{t('settings.profile')}</h2>
      <div className="form-row">
        <label>{t('profile.userId')}</label>
        <input value={me.userName} readOnly />
        <button className="link" onClick={() => setPwOpen(true)}>
          {t('profile.changePassword')}
        </button>
      </div>
      <div className="form-row">
        <label>{t('common.name')}</label>
        <input value={displayName} maxLength={30} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('profile.photo')}</label>
        <div className="photo-edit">
          {shown ? (
            <img className="photo-preview" src={shown} alt={t('profile.photoAlt')} />
          ) : (
            <span className="photo-preview empty" aria-hidden>
              {initial}
            </span>
          )}
          <div className="photo-buttons">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => void pickPhoto(e.target.files?.[0])}
            />
            <button className="btn" onClick={() => fileRef.current?.click()}>{t('profile.choosePhoto')}</button>
            <button className="btn" onClick={removePhoto} disabled={!shown}>
              {t('common.delete')}
            </button>
            <p className="hint">{t('profile.photoHint', { px: AVATAR_PX })}</p>
          </div>
        </div>
      </div>
      <div className="form-row">
        <label>{t('profile.localCache')}</label>
        <div className="local-cache">
          <label className="checkbox">
            <input
              type="checkbox"
              data-testid="clear-cache-on-logout"
              checked={clearCache}
              onChange={(e) => toggleClearCache(e.target.checked)}
            />
            {t('profile.clearCacheOnLogout')}
          </label>
          <p className="hint">{t('profile.cacheHintSpeed')}</p>
          <p className="hint warn">{t('profile.cacheHintPublic')}</p>
        </div>
      </div>
      {msg && <div className="info">{msg}</div>}
      {err && <div className="error">{err}</div>}
      <div className="modal-actions left">
        <button className="primary" onClick={save} disabled={saving}>
          {t('common.save')}
        </button>
        <button className="btn" onClick={reset} disabled={saving}>
          {t('common.cancel')}
        </button>
      </div>

      {pwOpen && <PasswordModal me={me} onClose={() => setPwOpen(false)} />}
    </div>
  );
}

function PasswordModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const t = useT();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setMsg(null);
    if (next !== confirmPw) {
      setMsg(t('profile.pwMismatch'));
      return;
    }
    const specials = (next.match(/[^A-Za-z0-9]/g) ?? []).length;
    if (next.length < me.site.passwordMinLen || specials < me.site.passwordMinSpec) {
      setMsg(t('profile.pwPolicy', { len: me.site.passwordMinLen, spec: me.site.passwordMinSpec }));
      return;
    }
    try {
      await api.put('/api/me/password', { currentPassword: cur, newPassword: next });
      alert(t('profile.pwChanged'));
      onClose();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('profile.changeFailed'));
    }
  }

  return (
    <Modal
      title={t('profile.changePasswordTitle')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('profile.currentPw')}</label>
        <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      </div>
      <div className="form-row">
        <label>{t('profile.newPw')}</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="form-row">
        <label>{t('profile.confirmPw')}</label>
        <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
      </div>
      <p className="hint">
        {t('profile.pwPolicyNote', { len: me.site.passwordMinLen, spec: me.site.passwordMinSpec })}
      </p>
      {msg && <div className="error">{msg}</div>}
    </Modal>
  );
}
