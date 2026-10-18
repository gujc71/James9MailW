/**
 * 태스크 탭 (썬더버드 태스크). 필터 · 검색 · 빠른 추가 · 열 정렬, 아래에 고른 태스크의 자세한 내용.
 */
import { useMemo, useState } from 'react';
import { useLocale, useT, type MessageKey } from '../../i18n';
import { useTasks } from './api';
import { useCal } from './context';
import type { TaskRow } from './types';
import { addDays, dateOf, fmtDateTime } from './wall';
import { dueState, priorityMark } from './TodayPane';

export type TaskFilter = 'all' | 'today' | 'next7' | 'notStarted' | 'overdue' | 'completed' | 'incomplete';

export const TASK_FILTERS: [TaskFilter, MessageKey][] = [
  ['all', 'cal.tf.all'],
  ['today', 'cal.tf.today'],
  ['next7', 'cal.tf.next7'],
  ['notStarted', 'cal.tf.notStarted'],
  ['overdue', 'cal.tf.overdue'],
  ['completed', 'cal.tf.completed'],
  ['incomplete', 'cal.tf.incomplete'],
];

type Col = 'title' | 'priority' | 'start' | 'due' | 'completed' | 'percent' | 'category' | 'calendar' | 'status';

export function filterTasks(tasks: TaskRow[], filter: TaskFilter, today: string): TaskRow[] {
  return tasks.filter((task) => {
    const due = task.due ? dateOf(task.due) : null;
    const start = task.start ? dateOf(task.start) : null;
    switch (filter) {
      case 'today':
        return !task.completed && ((due !== null && due <= today) || (start !== null && start <= today && (!due || due >= today)));
      case 'next7':
        return !task.completed && ((due !== null && due < addDays(today, 7)) || (start !== null && start < addDays(today, 7)));
      case 'notStarted':
        return !task.completed && start !== null && start > today;
      case 'overdue':
        return !task.completed && due !== null && due < today;
      case 'completed':
        return Boolean(task.completed);
      case 'incomplete':
        return !task.completed;
      default:
        return true;
    }
  });
}

export function statusText(t: ReturnType<typeof useT>, status: string | null): string {
  switch (status) {
    case 'NEEDS-ACTION':
      return t('cal.st.needsAction');
    case 'IN-PROCESS':
      return t('cal.st.inProcess');
    case 'COMPLETED':
      return t('cal.st.completed');
    case 'CANCELLED':
      return t('cal.st.cancelled');
    default:
      return '';
  }
}

export function TasksView({ filter }: { filter: TaskFilter }) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const { data, isLoading } = useTasks();
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState('');
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: 'due', desc: false });
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = filterTasks(
      (data ?? []).filter((task) => ctx.calendarById.get(task.calendarId)?.visible),
      filter,
      ctx.today,
    ).filter((task) => !needle || [task.title, task.description ?? '', task.categories.join(' ')].some((v) => v.toLowerCase().includes(needle)));
    const key = (task: TaskRow): string | number => {
      switch (sort.col) {
        case 'title':
          return task.title.toLowerCase();
        case 'priority':
          return task.priority === 0 ? 5 : task.priority;
        case 'start':
          return task.start ?? '9999';
        case 'completed':
          return task.completed ?? '9999';
        case 'percent':
          return task.percent;
        case 'category':
          return task.categories.join(',');
        case 'calendar':
          return ctx.calendarById.get(task.calendarId)?.name ?? '';
        case 'status':
          return task.status ?? '';
        default:
          return task.due ?? '9999';
      }
    };
    return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (sort.desc ? -1 : 1));
  }, [data, filter, q, sort, ctx.today, ctx.calendarById]);

  const current = rows.find((r) => r.itemId === selected) ?? null;
  const header = (col: Col, label: MessageKey) => (
    <th className="sortable" onClick={() => setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: false }))}>
      {t(label)}
      {sort.col === col ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  return (
    <div className="cal-tasks">
      <div className="cal-tasks-bar">
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
          style={{ flex: 2 }}
        />
        <input type="search" value={q} placeholder={t('common.search')} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </div>
      <div className="cal-tasks-table">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              {header('priority', 'cal.f.priorityShort')}
              {header('title', 'common.subject')}
              {header('start', 'cal.f.start')}
              {header('due', 'cal.f.due')}
              {header('completed', 'cal.f.completedAt')}
              {header('percent', 'cal.f.percent')}
              {header('category', 'cal.f.category')}
              {header('calendar', 'cal.f.calendar')}
              {header('status', 'common.status')}
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => (
              <tr
                key={task.itemId}
                className={`${selected === task.itemId ? 'selected' : ''} ${dueState(task, ctx.today)} ${task.completed ? 'done' : ''}`}
                onClick={() => setSelected(task.itemId)}
                onDoubleClick={() => ctx.actions.openTask(task)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(task.itemId);
                  ctx.actions.taskMenu(e, task);
                }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={Boolean(task.completed)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => ctx.actions.toggleTask(task.itemId, e.target.checked)}
                  />
                </td>
                <td className="cal-pri">{priorityMark(task.priority)}</td>
                <td>
                  <span className="cal-dot" style={{ background: ctx.calendarById.get(task.calendarId)?.color }} />
                  {task.title}
                  {task.recurring && <span className="cal-ic"> ↻</span>}
                  {task.hasAlarm && <span className="cal-ic"> ⏰</span>}
                </td>
                <td>{task.start ? fmtDateTime(locale, task.start) : ''}</td>
                <td>{task.due ? fmtDateTime(locale, task.due) : ''}</td>
                <td>{task.completed ? new Date(task.completed).toLocaleDateString(locale) : ''}</td>
                <td>
                  <span className="cal-progress">
                    <span style={{ width: `${task.percent}%` }} />
                  </span>
                  {task.percent}%
                </td>
                <td>{task.categories.join(', ')}</td>
                <td>{ctx.calendarById.get(task.calendarId)?.name}</td>
                <td>{statusText(t, task.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="hint cal-uf-empty">{isLoading ? t('common.loading') : t('cal.noTasks')}</div>}
      </div>
      <div className="cal-task-detail">
        {current ? (
          <>
            <div className="cal-task-detail-head">
              <strong>{current.title}</strong>
              <span className="cal-task-detail-actions">
                <button className="btn" onClick={() => ctx.actions.toggleTask(current.itemId, !current.completed)}>
                  {current.completed ? t('cal.markIncomplete') : t('cal.markComplete')}
                </button>
                <button className="btn" onClick={() => ctx.actions.openTask(current)}>
                  {t('common.edit')}
                </button>
              </span>
            </div>
            <dl className="cal-detail-grid">
              <dt>{t('cal.f.priority')}</dt>
              <dd>{current.priority === 1 ? t('cal.pri.high') : current.priority === 5 ? t('cal.pri.normal') : current.priority === 9 ? t('cal.pri.low') : t('cal.pri.none')}</dd>
              <dt>{t('common.status')}</dt>
              <dd>
                {statusText(t, current.status)} {current.percent ? `(${current.percent}%)` : ''}
              </dd>
              {current.start && (
                <>
                  <dt>{t('cal.f.start')}</dt>
                  <dd>{fmtDateTime(locale, current.start)}</dd>
                </>
              )}
              {current.due && (
                <>
                  <dt>{t('cal.f.due')}</dt>
                  <dd>{fmtDateTime(locale, current.due)}</dd>
                </>
              )}
              {current.categories.length > 0 && (
                <>
                  <dt>{t('cal.f.category')}</dt>
                  <dd>{current.categories.join(', ')}</dd>
                </>
              )}
              {current.location && (
                <>
                  <dt>{t('cal.f.location')}</dt>
                  <dd>{current.location}</dd>
                </>
              )}
            </dl>
            {current.description && <pre className="cal-task-desc">{current.description}</pre>}
          </>
        ) : (
          <span className="hint">{t('cal.pickTask')}</span>
        )}
      </div>
    </div>
  );
}
