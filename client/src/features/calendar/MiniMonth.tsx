/** 왼쪽 미니 달력. 월 · 연 따로 넘기기, 오늘로, 주 번호, 일정 있는 날은 굵게 */
import { useMemo, useState, useEffect } from 'react';
import { useLocale, useT } from '../../i18n';
import { useRange } from './api';
import { useCal } from './context';
import { addDays, addMonths, dateOf, startOfMonth, startOfWeek, weekNumber, weekdayOf } from './wall';
import { weekdayName } from './rrule';

export function MiniMonth({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const { weekStart, weekNumbers, daysOff } = ctx.boot.settings;
  const [month, setMonth] = useState(startOfMonth(date));
  useEffect(() => setMonth(startOfMonth(date)), [date]);

  const first = startOfWeek(month, weekStart);
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(first, i)), [first]);
  const { data } = useRange(first, addDays(first, 42));
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const occ of data ?? []) {
      if (!ctx.calendarById.get(occ.calendarId)?.visible || occ.type !== 'E') continue;
      let d = dateOf(occ.start);
      const last = occ.allDay ? addDays(occ.end, -1) : dateOf(occ.end);
      for (let i = 0; i < 42 && d <= last; i++, d = addDays(d, 1)) set.add(d);
    }
    return set;
  }, [data, ctx.calendarById]);

  const year = Number(month.slice(0, 4));
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}T00:00:00Z`));

  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <button className="cal-icon-btn" title={t('cal.today')} onClick={() => onPick(ctx.today)}>
          ◉
        </button>
        <span className="cal-mini-nav">
          <button className="cal-icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label={t('cal.prevMonth')}>
            ‹
          </button>
          <strong>{monthLabel}</strong>
          <button className="cal-icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label={t('cal.nextMonth')}>
            ›
          </button>
        </span>
        <span className="cal-mini-nav">
          <button className="cal-icon-btn" onClick={() => setMonth(addMonths(month, -12))} aria-label={t('cal.prevYear')}>
            ‹
          </button>
          <strong>{year}</strong>
          <button className="cal-icon-btn" onClick={() => setMonth(addMonths(month, 12))} aria-label={t('cal.nextYear')}>
            ›
          </button>
        </span>
      </div>
      <div className={`cal-mini-grid ${weekNumbers ? 'with-weeks' : ''}`}>
        {weekNumbers && <span />}
        {Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7).map((wd) => (
          <span key={wd} className={`cal-mini-wd ${daysOff.includes(wd) ? 'off' : ''}`}>
            {weekdayName(locale, wd, 'narrow')}
          </span>
        ))}
        {days.map((d, i) => (
          <MiniCell
            key={d}
            d={d}
            week={weekNumbers && i % 7 === 0 ? weekNumber(d, weekStart) : null}
            outside={d.slice(0, 7) !== month.slice(0, 7)}
            today={d === ctx.today}
            selected={d === dateOf(date)}
            busy={busy.has(d)}
            off={daysOff.includes(weekdayOf(d))}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

function MiniCell(props: {
  d: string;
  week: number | null;
  outside: boolean;
  today: boolean;
  selected: boolean;
  busy: boolean;
  off: boolean;
  onPick: (d: string) => void;
}) {
  return (
    <>
      {props.week !== null && <span className="cal-mini-week">{props.week}</span>}
      <button
        className={`cal-mini-day ${props.outside ? 'outside' : ''} ${props.today ? 'today' : ''} ${props.selected ? 'selected' : ''} ${
          props.busy ? 'busy' : ''
        } ${props.off ? 'off' : ''}`}
        onClick={() => props.onPick(props.d)}
      >
        {Number(props.d.slice(8, 10))}
      </button>
    </>
  );
}
