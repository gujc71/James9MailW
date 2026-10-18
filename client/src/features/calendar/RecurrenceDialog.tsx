/** 반복 사용자 정의 (썬더버드 "반복 편집" 대화상자) */
import { useState } from 'react';
import { Modal } from '../common/Modal';
import { useLocale, useT } from '../../i18n';
import { NTH_KEYS, describeRule, formatModel, monthName, parseModel, weekdayName, type Freq, type RuleModel } from './rrule';

export function RecurrenceDialog({
  rrule,
  startDate,
  allDay,
  weekStart,
  onSave,
  onClose,
}: {
  rrule: string | null;
  startDate: string;
  allDay: boolean;
  weekStart: number;
  onSave: (rrule: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [m, setM] = useState<RuleModel>(() => parseModel(rrule, startDate));
  const set = (patch: Partial<RuleModel>) => setM((prev) => ({ ...prev, ...patch }));
  const weekdays = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const preview = formatModel(m, allDay);
  const unitKey = { DAILY: 'cal.rule.unitDay', WEEKLY: 'cal.rule.unitWeek', MONTHLY: 'cal.rule.unitMonth', YEARLY: 'cal.rule.unitYear' } as const;

  const nthPicker = (
    <>
      <select value={m.nth} onChange={(e) => set({ nth: Number(e.target.value) })}>
        {[1, 2, 3, 4, 5, -1].map((n) => (
          <option key={n} value={n}>
            {t(NTH_KEYS[n]!)}
          </option>
        ))}
      </select>
      <select value={m.nthWeekday} onChange={(e) => set({ nthWeekday: Number(e.target.value) })}>
        {weekdays.map((d) => (
          <option key={d} value={d}>
            {weekdayName(locale, d)}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <Modal
      title={t('cal.repeat.editTitle')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button
            className="primary"
            disabled={m.freq === 'WEEKLY' && m.weekdays.length === 0}
            onClick={() => onSave(preview)}
          >
            {t('common.confirm')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <div className="cal-form">
        <label>{t('cal.repeat.label')}</label>
        <div className="cal-inline">
          <select value={m.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
            <option value="DAILY">{t('cal.rule.freqDaily')}</option>
            <option value="WEEKLY">{t('cal.rule.freqWeekly')}</option>
            <option value="MONTHLY">{t('cal.rule.freqMonthly')}</option>
            <option value="YEARLY">{t('cal.rule.freqYearly')}</option>
          </select>
        </div>

        <label>{t('cal.rule.every')}</label>
        <div className="cal-inline">
          <input
            type="number"
            min={1}
            max={999}
            value={m.interval}
            onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
            style={{ width: 80 }}
          />
          <span>{t(unitKey[m.freq])}</span>
        </div>

        {m.freq === 'WEEKLY' && (
          <>
            <label>{t('cal.rule.onDays')}</label>
            <div className="cal-weekdays">
              {weekdays.map((d) => (
                <label key={d} className={`cal-day-toggle ${m.weekdays.includes(d) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={m.weekdays.includes(d)}
                    onChange={(e) =>
                      set({ weekdays: e.target.checked ? [...m.weekdays, d] : m.weekdays.filter((v) => v !== d) })
                    }
                  />
                  {weekdayName(locale, d, 'short')}
                </label>
              ))}
            </div>
          </>
        )}

        {(m.freq === 'MONTHLY' || m.freq === 'YEARLY') && (
          <>
            {m.freq === 'YEARLY' && (
              <>
                <label>{t('cal.rule.inMonth')}</label>
                <div className="cal-inline">
                  <select value={m.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                      <option key={mo} value={mo}>
                        {monthName(locale, mo)}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <label>{t('cal.rule.onWhich')}</label>
            <div className="cal-stack">
              <label className="checkbox">
                <input type="radio" checked={m.monthlyMode === 'day'} onChange={() => set({ monthlyMode: 'day' })} />
                <select
                  value={m.monthDay}
                  disabled={m.monthlyMode !== 'day'}
                  onChange={(e) => set({ monthDay: Number(e.target.value) })}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {t('cal.rule.dayN', { n: d })}
                    </option>
                  ))}
                  {m.freq === 'MONTHLY' && <option value={-1}>{t('cal.rule.lastDay')}</option>}
                </select>
              </label>
              <label className="checkbox">
                <input type="radio" checked={m.monthlyMode === 'nth'} onChange={() => set({ monthlyMode: 'nth' })} />
                <span className={m.monthlyMode !== 'nth' ? 'cal-dim' : ''}>{nthPicker}</span>
              </label>
            </div>
          </>
        )}

        <label>{t('cal.rule.ends')}</label>
        <div className="cal-stack">
          <label className="checkbox">
            <input type="radio" checked={m.end === 'never'} onChange={() => set({ end: 'never' })} />
            {t('cal.rule.never')}
          </label>
          <label className="checkbox">
            <input type="radio" checked={m.end === 'count'} onChange={() => set({ end: 'count' })} />
            <input
              type="number"
              min={1}
              max={9999}
              value={m.count}
              disabled={m.end !== 'count'}
              onChange={(e) => set({ count: Math.max(1, Number(e.target.value) || 1) })}
              style={{ width: 80 }}
            />
            {t('cal.rule.occurrences')}
          </label>
          <label className="checkbox">
            <input type="radio" checked={m.end === 'until'} onChange={() => set({ end: 'until' })} />
            {t('cal.rule.untilLabel')}
            <input
              type="date"
              value={m.until}
              min={startDate}
              disabled={m.end !== 'until'}
              onChange={(e) => set({ until: e.target.value || startDate })}
            />
          </label>
        </div>
      </div>
      <p className="hint cal-rule-preview">{describeRule(preview, startDate, locale)}</p>
    </Modal>
  );
}
