/** 캘린더 설정 (썬더버드 설정 > 캘린더): 일반(+ 외부에서 일정 관리) · 보기 · 알림 · 분류 */
import { useState } from 'react';
import type { Me } from '../../api/types';
import { Modal } from '../common/Modal';
import { showToast } from '../common/Toast';
import { useLocale, useT } from '../../i18n';
import { calApi, useInvalidate } from './api';
import { weekdayName } from './rrule';
import type { CalSettings, Category } from './types';
import { alarmLabel } from './ItemDialog';
import { CaldavSection } from './CaldavSection';

const ZONES_FALLBACK = ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles'];

function zones(current: string): string[] {
  try {
    return [...new Set([current, ...(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')])];
  } catch {
    return [...new Set([current, ...ZONES_FALLBACK])];
  }
}

export function CalSettingsDialog({
  settings,
  categories,
  me,
  onMeChanged,
  onClose,
}: {
  settings: CalSettings;
  categories: Category[];
  me: Me;
  onMeChanged: (me: Me) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const invalidate = useInvalidate();
  const [s, setS] = useState<CalSettings>(settings);
  const [cats, setCats] = useState<Category[]>(categories);
  const [newCat, setNewCat] = useState({ name: '', color: '#f59e0b' });
  const [tab, setTab] = useState<'general' | 'view' | 'alarm' | 'category'>('general');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<CalSettings>) => setS((prev) => ({ ...prev, ...patch }));
  const hours = Array.from({ length: 25 }, (_, h) => h);

  async function save() {
    if (s.dayEndHour <= s.dayStartHour) {
      showToast(t('cal.set.badHours'), 'error');
      return;
    }
    setBusy(true);
    try {
      await calApi.saveSettings(s);
      await calApi.saveCategories(cats);
      await invalidate();
      onClose();
    } catch (cause) {
      showToast((cause as Error).message, 'error');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('cal.set.title')}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <div className="settings-tabs cal-dlg-tabs">
        {(['general', 'view', 'alarm', 'category'] as const).map((key) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {t(`cal.set.tab.${key}` as const)}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="cal-form">
          <label>{t('cal.f.timezone')}</label>
          <select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {zones(s.timezone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <label>{t('cal.set.defaultLength')}</label>
          <div className="cal-inline">
            <input
              type="number"
              min={0}
              max={10080}
              step={15}
              style={{ width: 100 }}
              value={s.defaultLengthMin}
              onChange={(e) => set({ defaultLengthMin: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span>{t('cal.unit.min')}</span>
          </div>
          <label>{t('cal.set.defaultAlarm')}</label>
          <select value={s.defaultAlarmMin} onChange={(e) => set({ defaultAlarmMin: Number(e.target.value) })}>
            <option value={-1}>{t('cal.alarm.none')}</option>
            {[0, 5, 10, 15, 30, 60, 120, 1440].map((m) => (
              <option key={m} value={m}>
                {alarmLabel(t, { offsetMin: m, related: 'S' }, 'E')}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* 체크하는 즉시 저장한다. 아래 [저장] 과는 무관하다 */}
      {tab === 'general' && (
        <div className="cal-caldav">
          <CaldavSection me={me} onMeChanged={onMeChanged} />
        </div>
      )}

      {tab === 'view' && (
        <div className="cal-form">
          <label>{t('cal.set.weekStart')}</label>
          <select value={s.weekStart} onChange={(e) => set({ weekStart: Number(e.target.value) })}>
            {Array.from({ length: 7 }, (_, d) => (
              <option key={d} value={d}>
                {weekdayName(locale, d)}
              </option>
            ))}
          </select>
          <label>{t('cal.set.daysOff')}</label>
          <div className="cal-weekdays">
            {Array.from({ length: 7 }, (_, i) => (s.weekStart + i) % 7).map((d) => (
              <label key={d} className={`cal-day-toggle ${s.daysOff.includes(d) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={s.daysOff.includes(d)}
                  onChange={(e) => set({ daysOff: e.target.checked ? [...s.daysOff, d] : s.daysOff.filter((v) => v !== d) })}
                />
                {weekdayName(locale, d, 'short')}
              </label>
            ))}
          </div>
          <label>{t('cal.set.workHours')}</label>
          <div className="cal-inline">
            <select value={s.dayStartHour} onChange={(e) => set({ dayStartHour: Number(e.target.value) })}>
              {hours.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            ~
            <select value={s.dayEndHour} onChange={(e) => set({ dayEndHour: Number(e.target.value) })}>
              {hours.slice(1).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
          <label>{t('cal.set.visibleHours')}</label>
          <input
            type="number"
            min={1}
            max={24}
            style={{ width: 100 }}
            value={s.visibleHours}
            onChange={(e) => set({ visibleHours: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}
          />
          <label>{t('cal.set.multiweek')}</label>
          <div className="cal-inline">
            <select value={s.multiweekCount} onChange={(e) => set({ multiweekCount: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {t('cal.set.weeksN', { n })}
                </option>
              ))}
            </select>
            <span>{t('cal.set.prevWeeks')}</span>
            <select value={s.prevWeeks} onChange={(e) => set({ prevWeeks: Number(e.target.value) })}>
              {[0, 1, 2].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <label />
          <label className="checkbox">
            <input type="checkbox" checked={s.weekNumbers} onChange={(e) => set({ weekNumbers: e.target.checked })} />
            {t('cal.set.weekNumbers')}
          </label>
        </div>
      )}

      {tab === 'alarm' && (
        <div className="cal-stack">
          <label className="checkbox">
            <input type="checkbox" checked={s.alarmSound} onChange={(e) => set({ alarmSound: e.target.checked })} />
            {t('cal.set.alarmSound')}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={s.alarmPopup} onChange={(e) => set({ alarmPopup: e.target.checked })} />
            {t('cal.set.alarmPopup')}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={s.missedAlarms} onChange={(e) => set({ missedAlarms: e.target.checked })} />
            {t('cal.set.missedAlarms')}
          </label>
          <p className="hint">{t('cal.set.alarmHint')}</p>
        </div>
      )}

      {tab === 'category' && (
        <div>
          <ul className="cal-cat-list">
            {cats.map((c, i) => (
              <li key={c.name}>
                <input
                  type="color"
                  value={c.color ?? '#94a3b8'}
                  onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                />
                <span style={{ flex: 1 }}>{c.name}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => setCats(cats.map((x, j) => (j === i ? { ...x, color: null } : x)))}
                  disabled={!c.color}
                >
                  {t('cal.set.noColor')}
                </button>
                <button type="button" className="link danger" onClick={() => setCats(cats.filter((_, j) => j !== i))}>
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
          <div className="cal-inline">
            <input
              value={newCat.name}
              placeholder={t('cal.f.newCategory')}
              onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
              style={{ flex: 1 }}
            />
            <input type="color" value={newCat.color} onChange={(e) => setNewCat({ ...newCat, color: e.target.value })} />
            <button
              type="button"
              className="btn"
              disabled={!newCat.name.trim() || cats.some((c) => c.name.toLowerCase() === newCat.name.trim().toLowerCase())}
              onClick={() => {
                setCats([...cats, { name: newCat.name.trim().replace(/,/g, ' '), color: newCat.color }]);
                setNewCat({ ...newCat, name: '' });
              }}
            >
              {t('common.add')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
