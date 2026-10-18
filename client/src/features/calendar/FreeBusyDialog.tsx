/**
 * 참석자 일정 확인 (썬더버드 "참석자 초대" 창의 Free/Busy 격자).
 * 같은 서버 사용자의 바쁜 시간만 보인다. 격자를 누르면 그 시각으로 일정을 옮긴다(길이는 그대로).
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../common/Modal';
import { useLocale, useT } from '../../i18n';
import { calApi } from './api';
import type { FreeBusy } from './types';
import { addDays, atMinutes, dateOf, fmtDayTitle, fmtHour, minutesOfDay, ms } from './wall';

const SLOT = 30;

export function FreeBusyDialog({
  emails,
  start,
  end,
  dayStartHour,
  dayEndHour,
  onPick,
  onClose,
}: {
  emails: string[];
  start: string;
  end: string;
  dayStartHour: number;
  dayEndHour: number;
  onPick: (start: string, end: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [day, setDay] = useState(dateOf(start));
  const [range, setRange] = useState({ start, end });
  const [data, setData] = useState<FreeBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const length = ms(end) - ms(start);
  const fromHour = Math.max(0, Math.min(dayStartHour, 8) - 1);
  const toHour = Math.min(24, Math.max(dayEndHour, 18) + 1);
  const slots = useMemo(() => {
    const list: number[] = [];
    for (let m = fromHour * 60; m < toHour * 60; m += SLOT) list.push(m);
    return list;
  }, [fromHour, toHour]);

  useEffect(() => {
    let alive = true;
    setData(null);
    calApi
      .freeBusy(emails, day, addDays(day, 1))
      .then((res) => alive && setData(res))
      .catch((cause: Error) => alive && setError(cause.message));
    return () => {
      alive = false;
    };
  }, [emails, day]);

  const busyAt = (email: string, slot: number): 'busy' | 'tentative' | null => {
    const blocks = data?.[email.toLowerCase()]?.busy ?? [];
    const s = atMinutes(day, slot);
    const e = atMinutes(day, slot + SLOT);
    let state: 'busy' | 'tentative' | null = null;
    for (const b of blocks) {
      const bs = b.start.length === 10 ? `${b.start}T00:00` : b.start;
      const be = b.end.length === 10 ? `${b.end}T00:00` : b.end;
      if (ms(bs) < ms(e) && ms(be) > ms(s)) {
        if (!b.tentative) return 'busy';
        state = 'tentative';
      }
    }
    return state;
  };
  const inRange = (slot: number) => {
    const s = ms(atMinutes(day, slot));
    return s < ms(range.end) && s + SLOT * 60_000 > ms(range.start);
  };

  return (
    <Modal
      title={t('cal.fb.title')}
      onClose={onClose}
      width={Math.min(980, 220 + slots.length * 22)}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {t('cal.fb.hint')}
          </span>
          <button className="primary" onClick={() => onPick(range.start, range.end)}>
            {t('common.confirm')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      <div className="cal-fb-nav">
        <button className="tb" onClick={() => setDay(addDays(day, -1))}>
          ‹
        </button>
        <strong>{fmtDayTitle(locale, day)}</strong>
        <button className="tb" onClick={() => setDay(addDays(day, 1))}>
          ›
        </button>
        <span className="cal-fb-legend">
          <i className="busy" /> {t('cal.fb.busy')} <i className="tentative" /> {t('cal.fb.tentative')}{' '}
          <i className="unknown" /> {t('cal.fb.unknown')}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="cal-fb-grid" style={{ gridTemplateColumns: `200px repeat(${slots.length}, 22px)` }}>
        <div />
        {slots.map((slot) => (
          <div key={slot} className="cal-fb-hour">
            {slot % 60 === 0 ? fmtHour(locale, slot / 60) : ''}
          </div>
        ))}
        {emails.map((email) => {
          const known = data?.[email.toLowerCase()]?.known;
          return (
            <div key={email} style={{ display: 'contents' }}>
              <div className="cal-fb-who" title={email}>
                {email}
              </div>
              {slots.map((slot) => {
                const state = busyAt(email, slot);
                return (
                  <button
                    key={slot}
                    type="button"
                    className={`cal-fb-cell ${data && known === false ? 'unknown' : state ?? ''} ${inRange(slot) ? 'picked' : ''} ${
                      slot % 60 === 0 ? 'hour' : ''
                    }`}
                    onClick={() => {
                      const s = atMinutes(day, slot);
                      setRange({ start: s, end: atMinutes(day, minutesOfDay(s) + length / 60_000) });
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {!data && !error && <div className="hint">{t('common.loading')}</div>}
    </Modal>
  );
}
