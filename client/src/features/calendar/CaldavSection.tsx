/**
 * 캘린더 설정 > 일반 > 외부에서 일정 관리 (CalDAV, server/src/routes/caldav.ts).
 * 체크하면 바로 저장하고(GU_USER_SETTING.CALDAV_USE_YN) 썬더버드 연결 방법을 팝업으로 띄운다.
 * 켜 둔 동안은 [사용법 보기] 로 다시 열 수 있다.
 * 끄면 서버가 /dav/ 접속을 비밀번호가 맞아도 막는다.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Me } from '../../api/types';
import { useT } from '../../i18n';
import { showToast } from '../common/Toast';
import { Modal } from '../common/Modal';

interface CaldavInfo {
  serverUrl: string;
  davUrl: string;
  userName: string;
  calendars: { name: string; color: string; readonly: boolean; url: string }[];
}

export function CaldavSection({ me, onMeChanged }: { me: Me; onMeChanged: (me: Me) => void }) {
  const t = useT();
  const enabled = me.setting.caldavUseYn;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  async function change(next: boolean) {
    setError(null);
    setSaving(true);
    // 체크 표시는 먼저 바꾸고, 저장이 실패하면 되돌린다
    onMeChanged({ ...me, setting: { ...me.setting, caldavUseYn: next } });
    setGuideOpen(next);
    try {
      await api.put('/api/me/setting', { caldavUseYn: next });
    } catch (cause) {
      onMeChanged({ ...me, setting: { ...me.setting, caldavUseYn: !next } });
      setGuideOpen(false);
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-row">
      <label>{t('caldav.title')}</label>
      <div className="local-cache">
        <label className="checkbox">
          <input
            type="checkbox"
            data-testid="caldav-use"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void change(e.target.checked)}
          />
          {t('caldav.use')}
        </label>
        <p className="hint">{t('caldav.hint')}</p>
        {enabled && (
          <button type="button" className="link caldav-open" data-testid="caldav-guide-open" onClick={() => setGuideOpen(true)}>
            {t('caldav.showGuide')}
          </button>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {guideOpen && enabled && (
        <Modal
          title={t('caldav.guideTitle')}
          onClose={() => setGuideOpen(false)}
          width={680}
          footer={
            <button type="button" className="primary" onClick={() => setGuideOpen(false)}>
              {t('common.close')}
            </button>
          }
        >
          <CaldavGuide />
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

function CaldavGuide() {
  const t = useT();
  const [info, setInfo] = useState<CaldavInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<CaldavInfo>('/api/me/caldav')
      .then((res) => alive && setInfo(res))
      .catch((cause) => alive && setError(cause instanceof ApiError ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!info) return null;

  return (
    <div className="caldav-guide" data-testid="caldav-guide">
      <p>{t('caldav.intro')}</p>

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
      </dl>

      <h4>{t('caldav.tbTitle')}</h4>
      <ol>
        <li>{t('caldav.tbStep1')}</li>
        <li>{t('caldav.tbStep2')}</li>
        <li>{t('caldav.tbStep3')}</li>
        <li>{t('caldav.tbStep4')}</li>
        <li>{t('caldav.tbStep5')}</li>
      </ol>

      {info.calendars.length > 0 && (
        <>
          <h4>{t('caldav.calendarsTitle')}</h4>
          <p className="hint">{t('caldav.calendarsHint')}</p>
          <ul className="caldav-calendars">
            {info.calendars.map((c) => (
              <li key={c.url}>
                <span className="caldav-name">
                  <span className="caldav-dot" style={{ background: c.color }} aria-hidden />
                  {c.name}
                  {c.readonly && <span className="hint"> ({t('caldav.readonly')})</span>}
                </span>
                <CopyField value={c.url} />
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{t('caldav.notesTitle')}</h4>
      <ul>
        <li>{t('caldav.noteInvite')}</li>
        <li>{t('caldav.noteCalendars')}</li>
        <li>{t('caldav.noteReadonly')}</li>
        <li>{t('caldav.noteOther')}</li>
      </ul>
      {!info.serverUrl.startsWith('https:') && <p className="hint warn">{t('caldav.noteHttps')}</p>}
    </div>
  );
}
