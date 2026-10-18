/**
 * 새 캘린더 · 캘린더 속성 (썬더버드 "새 캘린더" 마법사 + "속성").
 * 내 컴퓨터(로컬) 또는 네트워크(.ics 구독). 속성에서는 색 · 이름 · 알림 · 읽기 전용 · 기본 캘린더 · 게시 · 가져오기/내보내기.
 */
import { useRef, useState } from 'react';
import { Modal } from '../common/Modal';
import { showToast } from '../common/Toast';
import { useT } from '../../i18n';
import { calApi, useInvalidate } from './api';
import type { CalendarInfo } from './types';

const COLORS = ['#3b82f6', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#64748b', '#14b8a6', '#a16207'];

export function CalendarDialog({ calendar, onClose }: { calendar: CalendarInfo | null; onClose: () => void }) {
  const t = useT();
  const invalidate = useInvalidate();
  const isNew = !calendar;
  const [type, setType] = useState<'LOCAL' | 'ICS'>(calendar?.type ?? 'LOCAL');
  const [name, setName] = useState(calendar?.name ?? '');
  const [color, setColor] = useState(calendar?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]!);
  const [sourceUrl, setSourceUrl] = useState(calendar?.sourceUrl ?? '');
  const [refreshMin, setRefreshMin] = useState(calendar?.refreshMin ?? 60);
  const [alarm, setAlarm] = useState(calendar?.alarm ?? true);
  const [readonly, setReadonly] = useState(calendar?.readonly ?? false);
  const [isDefault, setIsDefault] = useState(calendar?.isDefault ?? false);
  const [feedUrl, setFeedUrl] = useState(calendar?.feedUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError(t('cal.calDlg.needName'));
      return;
    }
    if (type === 'ICS' && !sourceUrl.trim()) {
      setError(t('cal.calDlg.needUrl'));
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        await calApi.createCalendar({ name: name.trim(), color, type, sourceUrl: sourceUrl.trim() || undefined, refreshMin, alarm });
      } else {
        await calApi.updateCalendar(calendar.calendarId, {
          name: name.trim(),
          color,
          alarm,
          refreshMin,
          ...(calendar.type === 'LOCAL' ? { readonly } : {}),
          ...(isDefault && !calendar.isDefault ? { isDefault: true } : {}),
          ...(calendar.type === 'ICS' && sourceUrl !== calendar.sourceUrl ? { sourceUrl } : {}),
        });
      }
      await invalidate();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function togglePublish(enabled: boolean) {
    if (!calendar) return;
    try {
      const res = await calApi.publish(calendar.calendarId, enabled);
      setFeedUrl(res.feedUrl);
      await invalidate();
    } catch (cause) {
      showToast((cause as Error).message, 'error');
    }
  }

  async function importFile(file: File) {
    if (!calendar) return;
    try {
      const res = await calApi.importIcs(calendar.calendarId, await file.text());
      showToast(t('cal.imported', { n: res.imported }));
      await invalidate();
    } catch (cause) {
      showToast((cause as Error).message, 'error');
    }
  }

  return (
    <Modal
      title={isNew ? t('cal.calDlg.newTitle') : t('cal.calDlg.propsTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {isNew ? t('cal.calDlg.create') : t('common.save')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <div className="cal-form">
        {isNew && (
          <>
            <label>{t('cal.calDlg.location')}</label>
            <div className="cal-stack">
              <label className="checkbox">
                <input type="radio" checked={type === 'LOCAL'} onChange={() => setType('LOCAL')} />
                {t('cal.calDlg.local')}
              </label>
              <label className="checkbox">
                <input type="radio" checked={type === 'ICS'} onChange={() => setType('ICS')} />
                {t('cal.calDlg.network')}
              </label>
            </div>
          </>
        )}
        <label>{t('common.name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('cal.calDlg.color')}</label>
        <div className="cal-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cal-swatch ${c === color ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={c}
            />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        {type === 'ICS' && (
          <>
            <label>{t('cal.calDlg.url')}</label>
            <input value={sourceUrl} placeholder="https://… .ics / webcal://…" onChange={(e) => setSourceUrl(e.target.value)} />
            <label>{t('cal.calDlg.refresh')}</label>
            <div className="cal-inline">
              <select value={refreshMin} onChange={(e) => setRefreshMin(Number(e.target.value))}>
                {[5, 15, 30, 60, 120, 240, 720, 1440].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? t('cal.calDlg.everyMin', { n: m }) : t('cal.calDlg.everyHour', { n: m / 60 })}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <label />
        <div className="cal-stack">
          <label className="checkbox">
            <input type="checkbox" checked={alarm} onChange={(e) => setAlarm(e.target.checked)} />
            {t('cal.calDlg.showAlarms')}
          </label>
          {!isNew && calendar.type === 'LOCAL' && (
            <label className="checkbox">
              <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} />
              {t('cal.calDlg.readonly')}
            </label>
          )}
          {!isNew && !calendar.readonly && (
            <label className="checkbox">
              <input type="checkbox" checked={isDefault} disabled={calendar.isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              {t('cal.calDlg.default')}
            </label>
          )}
        </div>
        {!isNew && calendar.type === 'ICS' && (
          <>
            <label>{t('cal.calDlg.lastSync')}</label>
            <div className="cal-stack">
              <span>{calendar.lastSync ? new Date(calendar.lastSync).toLocaleString() : '—'}</span>
              {calendar.syncError && <span className="error">{calendar.syncError}</span>}
            </div>
          </>
        )}
      </div>

      {!isNew && (
        <div className="cal-section">
          <h4>{t('cal.calDlg.publish')}</h4>
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(feedUrl)} onChange={(e) => void togglePublish(e.target.checked)} />
            {t('cal.calDlg.publishOn')}
          </label>
          {feedUrl && (
            <div className="cal-inline">
              <input readOnly value={feedUrl} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(feedUrl).then(() => showToast(t('cal.copied')));
                }}
              >
                {t('common.copy')}
              </button>
            </div>
          )}
          <p className="hint">{t('cal.calDlg.publishHint')}</p>

          <h4>{t('cal.calDlg.importExport')}</h4>
          <div className="cal-inline">
            <a className="btn" href={calApi.exportUrl(calendar.calendarId)}>
              {t('cal.export')}
            </a>
            {!calendar.readonly && (
              <>
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  {t('cal.import')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".ics,text/calendar"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importFile(file);
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
