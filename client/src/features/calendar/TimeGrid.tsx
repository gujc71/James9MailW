/**
 * 일별 · 주별 보기 (시간 격자).
 *  - 빈 곳을 끌면 그 범위로 새 일정, 두 번 누르면 그 시각에 기본 길이로 새 일정
 *  - 일정을 끌면 옮기고(다른 날로도), 위 · 아래 끝을 끌면 길이를 바꾼다. 15분 단위로 맞춘다
 *  - 겹치는 일정은 나란히 나눠 그린다. 근무 시간 밖과 휴무일은 음영, 지금 시각에 빨간 선
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocale, useT } from '../../i18n';
import { chipStyle, isWritable, useCal } from './context';
import { OccChip, OccIcons, dragging, occTooltip } from './OccChip';
import { occursOn, sortForDay } from './MonthView';
import type { Occurrence } from './types';
import { DAY_MS, MIN, addDays, atMinutes, daysBetween, dateOf, fmtHour, fmtShortDate, fmtTime, fmtWeekdayLong, minutesOfDay, ms, nowIn, weekNumber, weekdayOf } from './wall';

const SNAP = 15;

interface Segment {
  occ: Occurrence;
  top: number;
  bottom: number;
  col: number;
  cols: number;
  startsHere: boolean;
  endsHere: boolean;
}

/** 하루 칸 안의 조각들. 겹치는 묶음마다 열을 나눈다 */
function layoutDay(day: string, list: Occurrence[]): Segment[] {
  const dayStart = ms(day);
  const dayEnd = dayStart + DAY_MS;
  const raw = list
    .map((occ) => {
      const s = ms(occ.start);
      const e = occ.type === 'T' ? s + 30 * MIN : Math.max(ms(occ.end), s + SNAP * MIN);
      return { occ, s: Math.max(s, dayStart), e: Math.min(e, dayEnd), startsHere: s >= dayStart, endsHere: e <= dayEnd };
    })
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const out: Segment[] = [];
  let cluster: (Segment & { s: number; e: number })[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const seg of cluster) out.push({ ...seg, cols });
    cluster = [];
  };
  for (const r of raw) {
    if (r.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.e > r.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({
      occ: r.occ,
      s: r.s,
      e: r.e,
      top: (r.s - dayStart) / MIN,
      bottom: (r.e - dayStart) / MIN,
      col,
      cols: 1,
      startsHere: r.startsHere,
      endsHere: r.endsHere,
    });
    clusterEnd = Math.max(clusterEnd, r.e);
  }
  if (cluster.length) flush();
  return out;
}

type Drag =
  | { kind: 'create'; dayIndex: number; anchor: number; current: number; moved: boolean }
  | {
      kind: 'move' | 'resize-start' | 'resize-end';
      occ: Occurrence;
      grab: number;
      dayIndex: number;
      originDay: number;
      startMin: number;
      endMin: number;
      moved: boolean;
      x: number;
      y: number;
    };

export function TimeGrid({ days, occurrences }: { days: string[]; occurrences: Occurrence[] }) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const { dayStartHour, dayEndHour, visibleHours, daysOff, weekNumbers } = ctx.boot.settings;
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [hourH, setHourH] = useState(48);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [now, setNow] = useState(() => nowIn(ctx.boot.settings.timezone));
  const [allDayDrop, setAllDayDrop] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(nowIn(ctx.boot.settings.timezone)), 60_000);
    return () => window.clearInterval(id);
  }, [ctx.boot.settings.timezone]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setHourH(Math.max(32, Math.floor(el.clientHeight / Math.max(1, visibleHours))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visibleHours]);

  // 처음 열 때 근무 시작 시각으로 내려 둔다
  const firstDay = days[0];
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, dayStartHour * hourH - 4);
  }, [firstDay, days.length, dayStartHour, hourH]);

  const allDay = useMemo(
    () => days.map((d) => sortForDay(occurrences.filter((o) => (o.allDay || (o.type === 'T' && o.start.length === 10)) && occursOn(o, d)))),
    [days, occurrences],
  );
  const timed = useMemo(
    () => days.map((d) => layoutDay(d, occurrences.filter((o) => !o.allDay && o.start.length > 10))),
    [days, occurrences],
  );

  const pxPerMin = hourH / 60;
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;

  /** 포인터 위치 → (날 칸, 분) */
  function locate(clientX: number, clientY: number): { dayIndex: number; minute: number } {
    const cols = colsRef.current;
    if (!cols) return { dayIndex: 0, minute: 0 };
    const rect = cols.getBoundingClientRect();
    const width = rect.width / days.length;
    const dayIndex = Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / width)));
    const minute = Math.max(0, Math.min(24 * 60, (clientY - rect.top) / pxPerMin));
    return { dayIndex, minute };
  }

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const { dayIndex, minute } = locate(e.clientX, e.clientY);
      if (current.kind === 'create') {
        const next = snap(minute);
        setDrag({ ...current, current: next, dayIndex, moved: current.moved || next !== current.anchor });
        return;
      }
      const length = current.endMin - current.startMin;
      const movedFar = Math.abs(e.clientX - current.x) > 3 || Math.abs(e.clientY - current.y) > 3;
      if (current.kind === 'move') {
        const start = snap(minute - current.grab);
        setDrag({ ...current, dayIndex, startMin: start, endMin: start + length, moved: current.moved || movedFar });
      } else if (current.kind === 'resize-end') {
        const end = Math.max(current.startMin + SNAP, snap(minute));
        setDrag({ ...current, endMin: end, moved: current.moved || movedFar });
      } else {
        const start = Math.min(current.endMin - SNAP, snap(minute));
        setDrag({ ...current, startMin: start, moved: current.moved || movedFar });
      }
    };
    const up = () => {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;
      if (current.kind === 'create') {
        const day = days[current.dayIndex]!;
        if (!current.moved) {
          ctx.actions.selectDate(day, atMinutes(day, current.anchor).slice(11));
          return;
        }
        const a = Math.min(current.anchor, current.current);
        const b = Math.max(current.anchor, current.current);
        ctx.actions.openNew({ start: atMinutes(day, a), end: atMinutes(day, Math.max(b, a + SNAP)) });
        return;
      }
      if (!current.moved) {
        ctx.actions.select(current.occ);
        return;
      }
      const shift = current.dayIndex - current.originDay;
      const base = days[current.originDay]!;
      const startDay = addDays(base, shift);
      const occ = current.occ;
      // 여러 날에 걸친 일정은 끝을 원래 길이 그대로 민다
      const originalStart = ms(occ.start);
      const startWall = atMinutes(startDay, current.startMin);
      const endWall =
        current.kind === 'move'
          ? atMinutes(startDay, current.startMin + Math.max(SNAP, (ms(occ.end) - originalStart) / MIN))
          : atMinutes(startDay, current.endMin);
      const fixedStart = current.kind === 'resize-end' ? occ.start : startWall;
      const fixedEnd = current.kind === 'resize-start' ? occ.end : endWall;
      ctx.actions.moveOccurrence(occ, fixedStart, occ.type === 'E' ? fixedEnd : null, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  function startCreate(e: ReactPointerEvent, dayIndex: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.cal-ev')) return;
    const { minute } = locate(e.clientX, e.clientY);
    const anchor = Math.floor(minute / SNAP) * SNAP;
    setDrag({ kind: 'create', dayIndex, anchor, current: anchor + SNAP * 2, moved: false });
  }

  function startEventDrag(e: ReactPointerEvent, seg: Segment, dayIndex: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const occ = seg.occ;
    if (!isWritable(occ, ctx)) {
      ctx.actions.select(occ);
      return;
    }
    const target = e.target as HTMLElement;
    const kind = target.dataset.handle === 'top' ? 'resize-start' : target.dataset.handle === 'bottom' ? 'resize-end' : 'move';
    const { minute } = locate(e.clientX, e.clientY);
    const startMin = minutesOfDay(occ.start) + daysBetween(days[dayIndex]!, dateOf(occ.start)) * 1440;
    const endMin = startMin + (occ.type === 'T' ? 30 : (ms(occ.end) - ms(occ.start)) / MIN);
    setDrag({ kind, occ, grab: minute - startMin, dayIndex, originDay: dayIndex, startMin, endMin, moved: false, x: e.clientX, y: e.clientY });
  }

  const nowMin = minutesOfDay(now);
  const nowDay = dateOf(now);

  return (
    <div className={`cal-tg ${drag ? 'dragging' : ''}`}>
      <div className="cal-tg-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div className="cal-tg-gutter">{weekNumbers && days[0] ? t('cal.weekN', { n: weekNumber(days[0], ctx.boot.settings.weekStart) }) : ''}</div>
        {days.map((d) => (
          <button
            key={d}
            className={`cal-tg-dayhead ${d === ctx.today ? 'today' : ''} ${daysOff.includes(weekdayOf(d)) ? 'off' : ''} ${
              d === ctx.selectedDate ? 'selected' : ''
            }`}
            onClick={() => ctx.actions.goToDate(d, 'day')}
          >
            <span>{fmtWeekdayLong(locale, d)}</span>
            <strong>{fmtShortDate(locale, d)}</strong>
          </button>
        ))}
      </div>
      <div className="cal-tg-allday" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div className="cal-tg-gutter">{t('cal.f.allDay')}</div>
        {days.map((d, i) => (
          <div
            key={d}
            className={`cal-tg-allday-cell ${daysOff.includes(weekdayOf(d)) ? 'off' : ''} ${allDayDrop === d ? 'drop' : ''}`}
            onDoubleClick={() => ctx.actions.openNew({ start: d, allDay: true })}
            onContextMenu={(e) => {
              e.preventDefault();
              ctx.actions.selectDate(d);
              ctx.actions.slotMenu(e, d);
            }}
            onDragOver={(e) => {
              if (!dragging.occ) return;
              e.preventDefault();
              setAllDayDrop(d);
            }}
            onDragLeave={() => setAllDayDrop((v) => (v === d ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              setAllDayDrop(null);
              const occ = dragging.occ;
              dragging.occ = null;
              if (!occ) return;
              const delta = daysBetween(dateOf(occ.start), d);
              if (!delta) return;
              ctx.actions.moveOccurrence(occ, addDays(occ.start, delta), occ.type === 'E' ? addDays(occ.end, delta) : null, true);
            }}
          >
            {allDay[i]!.map((occ) => (
              <OccChip key={occ.id} occ={occ} day={d} />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-tg-scroll" ref={scrollRef}>
        <div className="cal-tg-body" style={{ height: hourH * 24, gridTemplateColumns: `56px 1fr` }}>
          <div className="cal-tg-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ height: hourH }}>
                {h ? fmtHour(locale, h) : ''}
              </div>
            ))}
          </div>
          <div className="cal-tg-cols" ref={colsRef} style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
            {days.map((d, dayIndex) => (
              <div
                key={d}
                data-day={d}
                className={`cal-tg-col ${daysOff.includes(weekdayOf(d)) ? 'off' : ''} ${d === ctx.today ? 'today' : ''}`}
                style={{
                  backgroundSize: `100% ${hourH}px`,
                  ['--work-top' as string]: `${dayStartHour * hourH}px`,
                  ['--work-bottom' as string]: `${dayEndHour * hourH}px`,
                }}
                onPointerDown={(e) => startCreate(e, dayIndex)}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest('.cal-ev')) return;
                  const { minute } = locate(e.clientX, e.clientY);
                  ctx.actions.openNew({ start: atMinutes(d, Math.floor(minute / 30) * 30) });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const { minute } = locate(e.clientX, e.clientY);
                  const time = atMinutes(d, Math.floor(minute / 30) * 30).slice(11);
                  ctx.actions.selectDate(d, time);
                  ctx.actions.slotMenu(e, d, time);
                }}
              >
                <div className="cal-tg-offhours" />
                {timed[dayIndex]!.map((seg) => {
                  const hidden = drag && drag.kind !== 'create' && drag.occ.id === seg.occ.id && drag.moved;
                  return (
                    <EventBlock
                      key={`${seg.occ.id}|${d}`}
                      seg={seg}
                      pxPerMin={pxPerMin}
                      faded={Boolean(hidden)}
                      onPointerDown={(e) => startEventDrag(e, seg, dayIndex)}
                    />
                  );
                })}
                {drag?.kind === 'create' && drag.dayIndex === dayIndex && drag.moved && (
                  <div
                    className="cal-tg-select"
                    style={{
                      top: Math.min(drag.anchor, drag.current) * pxPerMin,
                      height: Math.max(SNAP, Math.abs(drag.current - drag.anchor)) * pxPerMin,
                    }}
                  >
                    {fmtTime(locale, atMinutes(d, Math.min(drag.anchor, drag.current)))} ~{' '}
                    {fmtTime(locale, atMinutes(d, Math.max(drag.anchor, drag.current)))}
                  </div>
                )}
                {drag && drag.kind !== 'create' && drag.moved && drag.dayIndex === dayIndex && (
                  <div
                    className="cal-ev ghost"
                    style={{
                      top: drag.startMin * pxPerMin,
                      height: Math.max(SNAP, drag.endMin - drag.startMin) * pxPerMin,
                      left: 2,
                      right: 2,
                      ...chipStyle(drag.occ, ctx),
                    }}
                  >
                    <span className="cal-ev-time">
                      {fmtTime(locale, atMinutes(d, drag.startMin))} ~ {fmtTime(locale, atMinutes(d, drag.endMin))}
                    </span>
                    <span className="cal-ev-title">{drag.occ.title}</span>
                  </div>
                )}
                {d === nowDay && <div className="cal-tg-now" style={{ top: nowMin * pxPerMin }} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EventBlock({
  seg,
  pxPerMin,
  faded,
  onPointerDown,
}: {
  seg: Segment;
  pxPerMin: number;
  faded: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const locale = useLocale();
  const ctx = useCal();
  const occ = seg.occ;
  const height = Math.max(18, (seg.bottom - seg.top) * pxPerMin - 1);
  const width = 100 / seg.cols;
  const writable = isWritable(occ, ctx);
  return (
    <div
      className={`cal-ev ${ctx.selectedId === occ.id ? 'selected' : ''} ${occ.status === 'CANCELLED' || occ.completed ? 'struck' : ''} ${
        occ.status === 'TENTATIVE' ? 'tentative' : ''
      } ${occ.transp === 'TRANSPARENT' ? 'free' : ''} ${occ.type === 'T' ? 'task' : ''} ${faded ? 'faded' : ''}`}
      style={{
        top: seg.top * pxPerMin,
        height,
        left: `calc(${seg.col * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
        ...chipStyle(occ, ctx),
      }}
      title={occTooltip(occ, locale, ctx.calendarById.get(occ.calendarId)?.name)}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        ctx.actions.openOccurrence(occ);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.actions.select(occ);
        ctx.actions.occurrenceMenu(e, occ);
      }}
    >
      {writable && occ.type === 'E' && seg.startsHere && <div className="cal-ev-handle top" data-handle="top" />}
      <div className="cal-ev-inner">
        <span className="cal-ev-time">
          {seg.startsHere ? fmtTime(locale, occ.start) : '…'}
          {occ.type === 'E' && height > 30 ? ` ~ ${seg.endsHere ? fmtTime(locale, occ.end) : '…'}` : ''}
        </span>
        <span className="cal-ev-title">
          <OccIcons occ={occ} />
          {occ.title}
        </span>
        {occ.location && height > 50 && <span className="cal-ev-loc">{occ.location}</span>}
      </div>
      {writable && occ.type === 'E' && seg.endsHere && <div className="cal-ev-handle bottom" data-handle="bottom" />}
    </div>
  );
}
