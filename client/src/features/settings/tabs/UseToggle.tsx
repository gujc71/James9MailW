/** "사용 / 사용 안 함" 라디오. 개인 환경설정(GU_USER_SETTING)의 *_USE_YN 을 바로 저장한다 */
import { useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Me, UserSetting } from '../../../api/types';
import { useT } from '../../../i18n';

type ToggleKey = 'rejectUseYn' | 'forwardUseYn' | 'vacationUseYn';

export function UseToggle({
  label,
  me,
  settingKey,
  onMeChanged,
}: {
  label: string;
  me: Me;
  settingKey: ToggleKey;
  onMeChanged: (me: Me) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const value = me.setting[settingKey];

  async function change(next: boolean) {
    setError(null);
    try {
      await api.put('/api/me/setting', { [settingKey]: next });
      const setting: UserSetting = { ...me.setting, [settingKey]: next };
      onMeChanged({ ...me, setting });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  return (
    <div className="form-row">
      <label>{label}</label>
      <label className="checkbox">
        <input type="radio" checked={value} onChange={() => change(true)} />
        {t('common.use')}
      </label>
      <label className="checkbox">
        <input type="radio" checked={!value} onChange={() => change(false)} />
        {t('common.notUse')}
      </label>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
