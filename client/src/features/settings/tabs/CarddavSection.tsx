/**
 * 개인 환경설정 > 주소록 > 외부에서 주소록 관리 (CardDAV, server/src/routes/carddav.ts).
 * 체크하면 바로 저장하고(GU_USER_SETTING.CARDDAV_USE_YN) 썬더버드 연결 방법을 팝업으로 띄운다.
 * 켜 둔 동안은 [사용법 보기] 로 다시 열 수 있다. 끄면 서버가 /dav/addressbooks/ 를 막는다.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Me } from '../../../api/types';
import { useT } from '../../../i18n';
import { showToast } from '../../common/Toast';
import { Modal } from '../../common/Modal';

interface CarddavInfo {
  serverUrl: string;
  davUrl: string;
  userName: string;
  addressbookUrl: string;
}

export function CarddavSection({ me, onMeChanged }: { me: Me; onMeChanged: (me: Me) => void }) {
  const t = useT();
  const enabled = me.setting.carddavUseYn;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  async function change(next: boolean) {
    setError(null);
    setSaving(true);
    // 체크 표시는 먼저 바꾸고, 저장이 실패하면 되돌린다
    onMeChanged({ ...me, setting: { ...me.setting, carddavUseYn: next } });
    setGuideOpen(next);
    try {
      await api.put('/api/me/setting', { carddavUseYn: next });
    } catch (cause) {
      onMeChanged({ ...me, setting: { ...me.setting, carddavUseYn: !next } });
      setGuideOpen(false);
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-row">
      <label>{t('carddav.title')}</label>
      <div className="local-cache">
        <label className="checkbox">
          <input
            type="checkbox"
            data-testid="carddav-use"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void change(e.target.checked)}
          />
          {t('carddav.use')}
        </label>
        <p className="hint">{t('carddav.hint')}</p>
        {enabled && (
          <button type="button" className="link caldav-open" data-testid="carddav-guide-open" onClick={() => setGuideOpen(true)}>
            {t('caldav.showGuide')}
          </button>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {guideOpen && enabled && (
        <Modal
          title={t('carddav.guideTitle')}
          onClose={() => setGuideOpen(false)}
          width={680}
          footer={
            <button type="button" className="primary" onClick={() => setGuideOpen(false)}>
              {t('common.close')}
            </button>
          }
        >
          <CarddavGuide />
        </Modal>
      )}
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const t = useT();
  return (
    <div className="caldav-copy">
      <input readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn"
        onClick={() => void navigator.clipboard?.writeText(value).then(() => showToast(t('cal.copied')))}
      >
        {t('common.copy')}
      </button>
    </div>
  );
}

function CarddavGuide() {
  const t = useT();
  const [info, setInfo] = useState<CarddavInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<CarddavInfo>('/api/me/carddav')
      .then((res) => alive && setInfo(res))
      .catch((cause) => alive && setError(cause instanceof ApiError ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!info) return null;

  return (
    <div className="caldav-guide" data-testid="carddav-guide">
      <p>{t('carddav.intro')}</p>
      <dl>
        <dt>{t('caldav.serverUrl')}</dt>
        <dd>
          <CopyField value={info.serverUrl} />
        </dd>
        <dt>{t('caldav.userName')}</dt>
        <dd>
          <CopyField value={info.userName} />
        </dd>
        <dt>{t('caldav.password')}</dt>
        <dd>{t('caldav.passwordValue')}</dd>
        <dt>{t('carddav.addressbookUrl')}</dt>
        <dd>
          <CopyField value={info.addressbookUrl} />
        </dd>
      </dl>

      <h4>{t('caldav.tbTitle')}</h4>
      <ol>
        <li>{t('carddav.tbStep1')}</li>
        <li>{t('carddav.tbStep2')}</li>
        <li>{t('carddav.tbStep3')}</li>
        <li>{t('carddav.tbStep4')}</li>
      </ol>

      <h4>{t('caldav.notesTitle')}</h4>
      <ul>
        <li>{t('carddav.noteGroups')}</li>
        <li>{t('carddav.noteCollected')}</li>
        <li>{t('carddav.noteSync')}</li>
        <li>{t('carddav.noteOther')}</li>
      </ul>
      {!info.serverUrl.startsWith('https:') && <p className="hint warn">{t('caldav.noteHttps')}</p>}
    </div>
  );
}
