/**
 * 월별 · 여러 주 보기. 주마다 한 줄, 첫 칸에 주 번호, 휴무일 음영, 오늘 배지, 달이 바뀌는 날은 "10월 1일".
 * 칸이 넘치면 "+N" 을 눌러 그날 일별 보기로 간다. 일정은 끌어서 다른 날로 옮긴다 (Ctrl 을 누르면 복사).
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useT } from '../../i18n';
import { useCal } from './context';
import { OccChip, dragging } from './OccChip';
import type { Occurrence } from './types';
import { addDays, daysBetween, dateOf, fmtShortDate, fmtWeekdayLong, ms, weekNumber, weekdayOf } from './wall';

const CHIP_H = 20;
const HEAD_H = 24;

export function occursOn(occ: Occurrence, day: string): boolean {
  if (occ.type === 'T') return dateOf(occ.start) === day;
  if (occ.allDay) return occ.start <= day && occ.end > day;
  const s = dateOf(occ.start);
  // 자정에 끝나는 일정은 다음 날 칸에 걸치지 않는다
  const lastDay = ms(occ.end) > ms(occ.start) && occ.end.endsWith('T00:00') ? addDays(dateOf(occ.end), -1) : dateOf(occ.end);
  return s <= day && lastDay >= day;
}

export function sortForDay(list: Occurrence[]): Occurrence[] {
  return [...list].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.type !== b.type) return a.type === 'E' ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title);
  });
}

export function MonthView({
  start,
  weeks,
  month,
  occurrences,
  workdaysOnly,
}: {
  start: string;
  weeks: number;
  /** 'YYYY-MM' — 다른 달 날짜를 흐리게. 여러 주 보기는 null */
  month: string | null;
  occurrences: Occurrence[];
  workdaysOnly: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const { daysOff, weekNumbers } = ctx.boot.settings;
  const gridRef = useRef<HTMLDivElement>(null);
  const [maxChips, setMaxChips] = useState(4);
  const [dropDay, setDropDay] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const rowH = (el.clientHeight - 28) / weeks;
      setMaxChips(Math.max(1, Math.floor((rowH - HEAD_H - 4) / CHIP_H)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);

  const columns = useMemo(() => {
    const all = Array.from({ length: 7 }, (_, i) => i);
    return workdaysOnly ? all.filter((i) => !daysOff.includes(weekdayOf(addDays(start, i)))) : all;
  }, [start, workdaysOnly, daysOff]);

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    const last = addDays(start, weeks * 7);
    for (const occ of occurrences) {
      let d = occ.start.slice(0, 10) < start ? start : occ.start.slice(0, 10);
      for (let i = 0; i < 60 && d < last; i++, d = addDays(d, 1)) {
        if (!occursOn(occ, d)) {
          if (d > dateOf(occ.end)) break;
          continue;
        }
        if (!map.has(d)) map.set(d, []);
        map.get(d)!.push(occ);
      }
    }
    for (const [d, list] of map) map.set(d, sortForDay(list));
    return map;
  }, [occurrences, start, weeks]);

  function drop(day: string, copy: boolean) {
    const occ = dragging.occ;
    dragging.occ = null;
    setDropDay(null);
    if (!occ) return;
    const delta = daysBetween(dateOf(occ.start), day);
    if (!delta && !copy) return;
    const shift = (v: string) => addDays(v.slice(0, 10), delta) + v.slice(10);
    if (copy || dragging.copy) {
      ctx.actions.copyTo(occ, day);
      return;
    }
    ctx.actions.moveOccurrence(occ, shift(occ.start), occ.type === 'E' ? shift(occ.end) : null, occ.allDay);
  }

  return (
    <div className={`cal-month ${weekNumbers ? 'with-weeks' : ''}`} ref={gridRef}>
      <div className="cal-month-head" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
        {columns.map((i) => {
          const d = addDays(start, i);
          const wd = weekdayOf(d);
          return (
            <div key={i} className={`cal-month-wd ${daysOff.includes(wd) ? 'off' : ''} ${weekdayOf(ctx.today) === wd ? 'is-today' : ''}`}>
              {fmtWeekdayLong(locale, d)}
            </div>
          );
        })}
      </div>
      <div className="cal-month-body" style={{ gridTemplateRows: `repeat(${weeks}, 1fr)` }}>
        {Array.from({ length: weeks }, (_, w) => (
          <div key={w} className="cal-month-row" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
            {columns.map((i, ci) => {
              const day = addDays(start, w * 7 + i);
              const list = byDay.get(day) ?? [];
              const overflow = list.length > maxChips;
              const shown = overflow ? list.slice(0, maxChips - 1) : list;
              const outside = month !== null && day.slice(0, 7) !== month;
              const firstOfMonth = day.endsWith('-01') || (w === 0 && ci === 0);
              return (
                <div
                  key={day}
                  className={`cal-month-cell ${daysOff.includes(weekdayOf(day)) ? 'off' : ''} ${outside ? 'outside' : ''} ${
                    day === ctx.selectedDate ? 'selected' : ''
                  } ${dropDay === day ? 'drop' : ''}`}
                  onClick={() => ctx.actions.selectDate(day)}
                  onDoubleClick={() => ctx.actions.openNew({ start: day })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    ctx.actions.selectDate(day);
                    ctx.actions.slotMenu(e, day);
                  }}
                  onDragOver={(e) => {
                    if (!dragging.occ) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
                    if (dropDay !== day) setDropDay(day);
                  }}
                  onDragLeave={() => setDropDay((v) => (v === day ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(day, e.ctrlKey || e.altKey);
                  }}
                >
                  <div className="cal-month-date">
                    {weekNumbers && ci === 0 && <span className="cal-weekno">{t('cal.weekN', { n: weekNumber(day, ctx.boot.settings.weekStart) })}</span>}
                    <button
                      className={`cal-date-label ${day === ctx.today ? 'today' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        ctx.actions.goToDate(day, 'day');
                      }}
                    >
                      {firstOfMonth ? fmtShortDate(locale, day) : t('cal.dayN', { n: Number(day.slice(8, 10)) })}
                    </button>
                  </div>
                  <div className="cal-month-chips">
                    {shown.map((occ) => (
                      <OccChip key={occ.id} occ={occ} day={day} />
                    ))}
                    {overflow && (
                      <button
                        className="cal-more"
                        onClick={(e) => {
                          e.stopPropagation();
                          ctx.actions.goToDate(day, 'day');
                        }}
                      >
                        {t('cal.moreN', { n: list.length - shown.length })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
