/**
 * 오늘 패널 (오른쪽). 날짜를 넘기며 그날 · 다음 날 · 곧 있을 일정과 태스크를 본다.
 * 태스크는 체크로 완료하고, 맨 위 칸에 제목을 쳐서 바로 만든다.
 */
import { useMemo, useState } from 'react';
import { useLocale, useT } from '../../i18n';
import { useRange, useTasks } from './api';
import { useCal } from './context';
import { OccIcons } from './OccChip';
import type { Occurrence, TaskRow } from './types';
import { addDays, dateOf, fmtDayTitle, fmtShortDate, fmtTime } from './wall';
import { occursOn } from './MonthView';

const SOON_DAYS = 5;

export function priorityMark(priority: number): string {
  return priority >= 1 && priority <= 4 ? '!' : priority >= 6 ? '↓' : '';
}

/** 태스크 마감 상태: 지남 · 오늘 · 그 외 */
export function dueState(task: { due: string | null; completed: string | null }, today: string): 'overdue' | 'today' | '' {
  if (!task.due || task.completed) return '';
  const d = dateOf(task.due);
  return d < today ? 'overdue' : d === today ? 'today' : '';
}

export function TodayPane({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const [day, setDay] = useState(ctx.today);
  const [showCompleted, setShowCompleted] = useState(false);
  const [quick, setQuick] = useState('');
  const [open, setOpen] = useState({ events: true, tasks: true });
  const { data: occs } = useRange(day, addDays(day, SOON_DAYS + 2));
  const { data: tasks } = useTasks();

  const groups = useMemo(() => {
    const list = (occs ?? []).filter((o) => o.type === 'E' && ctx.calendarById.get(o.calendarId)?.visible);
    const on = (d: string) => list.filter((o) => occursOn(o, d));
    const soon: Occurrence[] = [];
    for (let i = 2; i <= SOON_DAYS + 1; i++) {
      for (const o of on(addDays(day, i))) if (!soon.some((s) => s.id === o.id)) soon.push(o);
    }
    return { today: on(day), tomorrow: on(addDays(day, 1)).filter((o) => !on(day).some((x) => x.id === o.id)), soon };
  }, [occs, day, ctx.calendarById]);

  const taskRows = useMemo(
    () =>
      (tasks ?? [])
        .filter((task) => ctx.calendarById.get(task.calendarId)?.visible)
        .filter((task) => showCompleted || !task.completed)
        .sort((a, b) => Number(Boolean(a.completed)) - Number(Boolean(b.completed)) || (a.due ?? '9999').localeCompare(b.due ?? '9999')),
    [tasks, showCompleted, ctx.calendarById],
  );

  const eventRow = (o: Occurrence, withDate: boolean) => (
    <li
      key={o.id}
      className={`cal-today-ev ${ctx.selectedId === o.id ? 'selected' : ''}`}
      onClick={() => ctx.actions.select(o)}
      onDoubleClick={() => ctx.actions.openOccurrence(o)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.actions.select(o);
        ctx.actions.occurrenceMenu(e, o);
      }}
      title={o.location ?? ''}
    >
      <span className="cal-dot" style={{ background: ctx.calendarById.get(o.calendarId)?.color }} />
      <span className="cal-today-when">
        {withDate ? `${fmtShortDate(locale, o.start)} ` : ''}
        {o.allDay ? '' : fmtTime(locale, o.start)}
      </span>
      <span className={`cal-today-title ${o.status === 'CANCELLED' ? 'struck' : ''}`}>
        <OccIcons occ={o} />
        {o.title}
      </span>
    </li>
  );

  const taskRow = (task: TaskRow) => (
    <li
      key={task.itemId}
      className={`cal-today-task ${dueState(task, ctx.today)} ${task.completed ? 'done' : ''}`}
      onDoubleClick={() => ctx.actions.openTask(task)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.actions.taskMenu(e, task);
      }}
    >
      <input
        type="checkbox"
        checked={Boolean(task.completed)}
        onChange={(e) => ctx.actions.toggleTask(task.itemId, e.target.checked)}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="cal-pri">{priorityMark(task.priority)}</span>
      <span className="cal-today-title">{task.title}</span>
      {task.due && <span className="cal-today-due">{fmtShortDate(locale, task.due)}</span>}
    </li>
  );

  return (
    <aside className="cal-today">
      <div className="cal-today-head">
        <strong>{t('cal.todayPane')}</strong>
        <button className="cal-icon-btn" title={t('common.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="cal-today-date">
        <button className="cal-icon-btn" onClick={() => setDay(addDays(day, -1))}>
          ‹
        </button>
        <button className="link" onClick={() => setDay(ctx.today)} title={t('cal.today')}>
          {fmtDayTitle(locale, day)}
        </button>
        <button className="cal-icon-btn" onClick={() => setDay(addDays(day, 1))}>
          ›
        </button>
      </div>

      <button className="cal-today-section" onClick={() => setOpen({ ...open, events: !open.events })}>
        {open.events ? '▾' : '▸'} {t('cal.events')}
      </button>
      {open.events && (
        <div className="cal-today-events">
          <div className="cal-today-group">{day === ctx.today ? t('cal.today') : fmtShortDate(locale, day)}</div>
          <ul>{groups.today.length ? groups.today.map((o) => eventRow(o, false)) : <li className="hint">{t('cal.noEvents')}</li>}</ul>
          <div className="cal-today-group">{t('cal.tomorrow')}</div>
          <ul>{groups.tomorrow.length ? groups.tomorrow.map((o) => eventRow(o, false)) : <li className="hint">{t('cal.noEvents')}</li>}</ul>
          <div className="cal-today-group">{t('cal.soon')}</div>
          <ul>{groups.soon.length ? groups.soon.map((o) => eventRow(o, true)) : <li className="hint">{t('cal.noEvents')}</li>}</ul>
        </div>
      )}

      <button className="cal-today-section" onClick={() => setOpen({ ...open, tasks: !open.tasks })}>
        {open.tasks ? '▾' : '▸'} {t('cal.tasks')}
      </button>
      {open.tasks && (
        <div className="cal-today-tasks">
          <label className="checkbox">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
            {t('cal.showCompletedTasks')}
          </label>
          <input
            className="cal-quick"
            value={quick}
            placeholder={t('cal.quickTask')}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && quick.trim()) {
                ctx.actions.quickAddTask(quick.trim());
                setQuick('');
              }
            }}
          />
          <ul>{taskRows.map(taskRow)}</ul>
          {!taskRows.length && <div className="hint">{t('cal.noTasks')}</div>}
        </div>
      )}
    </aside>
  );
}
