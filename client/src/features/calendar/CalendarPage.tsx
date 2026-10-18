/**
 * 캘린더 화면 (썬더버드 캘린더 · 태스크 탭). #/calendar · #/calendar/tasks
 *
 *   ┌ 툴바: 동기화 · 이벤트 · 태스크 · 편집 · 삭제 · 인쇄 · 가져오기 · 내보내기 · 설정 ─ 캘린더/태스크 · 오늘 패널
 *   ├ 왼쪽: 새 이벤트 · 미니 달력 · (태스크 필터) · 캘린더 목록
 *   ├ 가운데: 이벤트 목록(Unifinder) + 보기(일 · 주 · 여러 주 · 월)  /  태스크 목록
 *   └ 오른쪽: 오늘 패널
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useT } from '../../i18n';
import type { Me } from '../../api/types';
import { goTo } from '../../lib/hashRoute';
import { Modal } from '../common/Modal';
import { Menu } from '../common/Menu';
import { showToast } from '../common/Toast';
import { calApi, downloadText, invalidateCalendar, useBootstrap, useRange } from './api';
import { CalContext, isWritable, type CalActions, type CalContextValue, type NewSeed } from './context';
import { ContextMenu, type CtxItem, type CtxState } from './ContextMenu';
import { MiniMonth } from './MiniMonth';
import { CalendarList } from './CalendarList';
import { MonthView } from './MonthView';
import { TimeGrid } from './TimeGrid';
import { Unifinder } from './Unifinder';
import { TodayPane } from './TodayPane';
import { TasksView, TASK_FILTERS, type TaskFilter } from './TasksView';
import { ItemDialog, type DialogTarget } from './ItemDialog';
import { CalSettingsDialog } from './CalSettingsDialog';
import { handToCompose, takeCalendarFocus, takeCalendarSeed } from './bridge';
import type { Bootstrap, ItemDetail, ItemInput, Occurrence, Scope, ViewKind } from './types';
import {
  addDays,
  addMinutes,
  addMonths,
  dateOf,
  daysBetween,
  fmtDayTitle,
  fmtMonthTitle,
  fmtShortDate,
  isDateOnly,
  fmtDate,
  weekNumber,
  ms,
  nowIn,
  startOfMonth,
  startOfWeek,
  timeOf,
  todayIn,
  weekdayOf,
} from './wall';
import './calendar.css';

const PREFS = 'j9-cal-view';

interface ViewPrefs {
  view: ViewKind;
  workdaysOnly: boolean;
  showTasks: boolean;
  showCompleted: boolean;
  unifinder: boolean;
  todayPane: boolean;
}

function loadPrefs(): ViewPrefs {
  const base: ViewPrefs = { view: 'month', workdaysOnly: false, showTasks: true, showCompleted: false, unifinder: true, todayPane: true };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') };
  } catch {
    return base;
  }
}

type ScopeAsk = { kind: 'edit' | 'delete' | 'move'; following: boolean; resolve: (scope: Scope | null) => void };
type Clip = { occ: Occurrence; detail: ItemDetail; cut: boolean };

/** 저장된 항목 → 대화상자 입력값 */
function toInput(d: ItemDetail): ItemInput {
  return {
    type: d.type,
    calendarId: d.calendarId,
    title: d.title,
    location: d.location ?? '',
    description: d.description ?? '',
    url: d.url ?? '',
    allDay: d.allDay,
    tzid: d.tzid,
    start: d.start,
    end: d.end,
    due: d.due,
    status: d.status,
    priority: d.priority,
    privacy: d.privacy,
    transp: d.transp,
    percent: d.percent,
    completed: d.completed,
    rrule: d.rrule,
    categories: d.categories,
    alarms: d.alarms.map(({ offsetMin, related }) => ({ offsetMin, related })),
    attendees: d.attendees,
    attachments: d.attachments,
  };
}

function shiftWall(value: string | null, delta: number): string | null {
  if (!value) return null;
  return isDateOnly(value) ? addDays(value, Math.round(delta / 86_400_000)) : addMinutes(value, Math.round(delta / 60_000));
}

export function CalendarPage({ tab, me, onMeChanged }: { tab: 'calendar' | 'tasks'; me: Me; onMeChanged: (me: Me) => void }) {
  const { data: boot, error } = useBootstrap();
  const t = useT();
  if (error) return <div className="cal-page cal-loading error">{(error as Error).message}</div>;
  if (!boot) return <div className="cal-page cal-loading">{t('common.loading')}</div>;
  return <CalendarScreen boot={boot} tab={tab} me={me} onMeChanged={onMeChanged} />;
}

function CalendarScreen({
  boot,
  tab,
  me,
  onMeChanged,
}: {
  boot: Bootstrap;
  tab: 'calendar' | 'tasks';
  me: Me;
  onMeChanged: (me: Me) => void;
}) {
  const userName = me.userName;
  const t = useT();
  const locale = useLocale();
  const client = useQueryClient();
  const settings = boot.settings;
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);
  const [today, setToday] = useState(() => todayIn(settings.timezone));
  const [date, setDate] = useState(today);
  const [slotTime, setSlotTime] = useState<string | null>(null);
  const [selected, setSelected] = useState<Occurrence | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('incomplete');
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [scopeAsk, setScopeAsk] = useState<ScopeAsk | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const view = prefs.view;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {
      // 저장하지 못해도 이번 화면에는 그대로 쓴다
    }
  }, [prefs]);
  const setPref = <K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]) => setPrefs((p) => ({ ...p, [key]: value }));

  // 자정이 지나면 오늘이 바뀐다
  useEffect(() => {
    const id = window.setInterval(() => setToday(todayIn(settings.timezone)), 60_000);
    return () => window.clearInterval(id);
  }, [settings.timezone]);

  const calendarById = useMemo(() => new Map(boot.calendars.map((c) => [c.calendarId, c])), [boot.calendars]);
  const categoryColor = useMemo(() => new Map(boot.categories.map((c) => [c.name, c.color])), [boot.categories]);
  const defaultCal = boot.calendars.find((c) => c.isDefault && !c.readonly) ?? boot.calendars.find((c) => !c.readonly) ?? null;

  // ---------------------------------------------------------------- 보기 범위

  const range = useMemo(() => {
    switch (view) {
      case 'day':
        return { from: date, to: addDays(date, 1), weeks: 0 };
      case 'week': {
        const from = startOfWeek(date, settings.weekStart);
        return { from, to: addDays(from, 7), weeks: 1 };
      }
      case 'multiweek': {
        const from = addDays(startOfWeek(date, settings.weekStart), -7 * settings.prevWeeks);
        return { from, to: addDays(from, 7 * settings.multiweekCount), weeks: settings.multiweekCount };
      }
      case 'month': {
        const first = startOfMonth(date);
        const from = startOfWeek(first, settings.weekStart);
        const last = addDays(addMonths(first, 1), -1);
        const weeks = Math.ceil((daysBetween(from, last) + 1) / 7);
        return { from, to: addDays(from, weeks * 7), weeks };
      }
    }
  }, [view, date, settings.weekStart, settings.prevWeeks, settings.multiweekCount]);

  const { data: raw } = useRange(range.from, range.to);
  const occurrences = useMemo(
    () =>
      (raw ?? []).filter(
        (o) =>
          calendarById.get(o.calendarId)?.visible &&
          (o.type === 'E' || (prefs.showTasks && (prefs.showCompleted || !o.completed))),
      ),
    [raw, calendarById, prefs.showTasks, prefs.showCompleted],
  );

  const days = useMemo(() => {
    const count = view === 'day' ? 1 : 7;
    const list = Array.from({ length: count }, (_, i) => addDays(range.from, i));
    return prefs.workdaysOnly && view === 'week' ? list.filter((d) => !settings.daysOff.includes(weekdayOf(d))) : list;
  }, [view, range.from, prefs.workdaysOnly, settings.daysOff]);

  function step(direction: 1 | -1) {
    setDate((d) => (view === 'day' ? addDays(d, direction) : view === 'month' ? addMonths(d, direction) : addDays(d, 7 * direction)));
  }

  const title =
    view === 'day'
      ? fmtDayTitle(locale, date)
      : view === 'month'
        ? fmtMonthTitle(locale, date)
        : `${fmtDate(locale, range.from)} – ${fmtDate(locale, addDays(range.to, -1))}`;
  const weekLabel =
    range.weeks > 1
      ? t('cal.weekRange', { a: weekNumber(range.from, settings.weekStart), b: weekNumber(addDays(range.to, -1), settings.weekStart) })
      : t('cal.weekN', { n: weekNumber(date, settings.weekStart) });

  // ---------------------------------------------------------------- 메일에서 넘어온 일감

  const actionsRef = useRef<CalActions | null>(null);
  useEffect(() => {
    const seed = takeCalendarSeed();
    if (seed) actionsRef.current?.openNew({ type: seed.type, title: seed.title, description: seed.description, start: today });
    const focus = () => {
      const target = takeCalendarFocus();
      if (target) {
        setDate(target.date);
        setSelected(null);
      }
    };
    focus();
    window.addEventListener('j9-cal-focus', focus);
    return () => window.removeEventListener('j9-cal-focus', focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- 동작

  const refresh = useCallback(() => invalidateCalendar(client), [client]);
  const toastWarnings = (warnings: string[] | undefined) => warnings?.forEach((w) => showToast(w, 'error'));
  const fail = (cause: unknown) => showToast((cause as Error).message || t('common.actionFailed'), 'error');

  const askScope = (kind: ScopeAsk['kind'], following: boolean) =>
    new Promise<Scope | null>((resolve) => setScopeAsk({ kind, following, resolve }));

  const isMine = (organizer: string | null) => !organizer || organizer.toLowerCase() === userName.toLowerCase();

  function newInput(seed: NewSeed = {}): ItemInput {
    const type = seed.type ?? 'E';
    const day = seed.start ? dateOf(seed.start) : date;
    const allDay = seed.allDay ?? false;
    let start = seed.start && !isDateOnly(seed.start) ? seed.start : null;
    if (!start && !allDay) {
      const now = nowIn(settings.timezone);
      const time = slotTime && day === date ? slotTime : null;
      if (time) start = `${day}T${time}`;
      else if (day === dateOf(now)) start = `${day}T${String(Math.min(23, Number(now.slice(11, 13)) + 1)).padStart(2, '0')}:00`;
      else start = `${day}T${String(settings.dayStartHour).padStart(2, '0')}:00`;
    }
    const startWall = allDay ? day : start!;
    const end = seed.end ?? (allDay ? addDays(day, 1) : addMinutes(startWall, settings.defaultLengthMin));
    return {
      type,
      calendarId: defaultCal?.calendarId ?? boot.calendars[0]?.calendarId ?? 0,
      title: seed.title ?? '',
      location: '',
      description: seed.description ?? '',
      url: '',
      allDay,
      tzid: settings.timezone,
      start: type === 'E' ? startWall : null,
      end: type === 'E' ? end : null,
      // 칸에서 만든 태스크는 그 칸을 기한으로 둔다. 빠른 추가 · 툴바는 날짜 없이 만든다
      due: type === 'T' && seed.start ? startWall : null,
      status: null,
      priority: 0,
      privacy: 'PUBLIC',
      transp: allDay ? 'TRANSPARENT' : 'OPAQUE',
      percent: 0,
      completed: null,
      rrule: null,
      categories: [],
      alarms: settings.defaultAlarmMin >= 0 && type === 'E' ? [{ offsetMin: settings.defaultAlarmMin, related: 'S' }] : [],
      attendees: [],
      attachments: [],
    };
  }

  async function openDetail(itemId: string, occ: Occurrence | null, scopeHint?: Scope) {
    let scope: Scope = scopeHint ?? 'all';
    if (!scopeHint && occ?.recurring) {
      const picked = await askScope('edit', !occ.exception);
      if (!picked) return;
      scope = picked;
    }
    try {
      let detail = await calApi.item(itemId);
      if (scope === 'all' && detail.parentId) detail = await calApi.item(detail.parentId);
      const initial = toInput(detail);
      if (scope !== 'all' && !detail.parentId && occ?.occurrence) {
        // 이 회차(또는 이후)를 고친다: 원본 값에 이 회차의 시각을 얹는다
        const base = detail.start ?? detail.due;
        const delta = base ? ms(occ.occurrence) - ms(base) : 0;
        initial.start = shiftWall(detail.start, delta);
        initial.end = shiftWall(detail.end, delta);
        initial.due = shiftWall(detail.due, delta);
        if (scope === 'this') initial.rrule = null;
      }
      setDialog({
        mode: 'edit',
        itemId: scope === 'all' ? detail.itemId : itemId,
        scope,
        occurrence: occ?.occurrence ?? null,
        initial,
        isOrganizer: detail.isOrganizer,
        organizer: detail.organizer,
      });
    } catch (cause) {
      fail(cause);
    }
  }

  async function removeOccurrence(occ: { itemId: string; occurrence: string | null; recurring: boolean; exception: boolean; title: string; attendees: number; organizer: string | null; calendarId: number }) {
    if (!isWritable(occ, ctxValue)) {
      showToast(t('cal.readonlyNote'), 'error');
      return;
    }
    let scope: Scope = 'all';
    if (occ.recurring) {
      const picked = await askScope('delete', true);
      if (!picked) return;
      scope = picked;
    } else if (!confirm(t('cal.confirmDelete', { title: occ.title || t('cal.newEventTitle') }))) return;
    const notify = occ.attendees > 0 && isMine(occ.organizer) && confirm(t('cal.askNotifyCancel'));
    try {
      const res = await calApi.remove(occ.itemId, scope, occ.occurrence, notify);
      toastWarnings(res.warnings);
      setSelected(null);
      await refresh();
    } catch (cause) {
      fail(cause);
    }
  }

  async function paste(day: string, time?: string | null, from: Clip | null = clip) {
    if (!from) return;
    const { occ, detail, cut } = from;
    const input = toInput(detail);
    const target = calendarById.get(detail.calendarId);
    if (!target || target.readonly) input.calendarId = defaultCal?.calendarId ?? input.calendarId;
    // 붙여 넣은 것은 한 회차짜리 새 일정이다. 시각은 화면 시간대로 맞춘다
    input.rrule = null;
    input.tzid = settings.timezone;
    const length = ms(occ.end) - ms(occ.start);
    const startWall = occ.allDay ? day : `${day}T${time ?? timeOf(occ.start)}`;
    if (input.type === 'E') {
      input.start = startWall;
      input.end = occ.allDay ? addDays(day, Math.max(1, Math.round(length / 86_400_000))) : addMinutes(startWall, length / 60_000);
    } else {
      input.start = detail.start ? startWall : null;
      input.due = detail.due ? startWall : null;
    }
    try {
      await calApi.create(input, false);
      if (cut) {
        await calApi.remove(occ.itemId, occ.recurring && !occ.exception ? 'this' : 'all', occ.occurrence, false);
        setClip(null);
      }
      await refresh();
    } catch (cause) {
      fail(cause);
    }
  }

  async function copyOrCut(occ: Occurrence, cut: boolean) {
    if (cut && !isWritable(occ, ctxValue)) {
      showToast(t('cal.readonlyNote'), 'error');
      return;
    }
    try {
      setClip({ occ, detail: await calApi.item(occ.itemId), cut });
      showToast(t(cut ? 'cal.cutDone' : 'cal.copyDone'));
    } catch (cause) {
      fail(cause);
    }
  }

  async function quick(occ: { itemId: string; calendarId: number }, patch: Parameters<typeof calApi.quick>[1]) {
    if (!isWritable(occ, ctxValue) && patch.calendarId === undefined) {
      showToast(t('cal.readonlyNote'), 'error');
      return;
    }
    try {
      await calApi.quick(occ.itemId, patch);
      await refresh();
    } catch (cause) {
      fail(cause);
    }
  }

  async function mailAttendees(itemId: string) {
    try {
      const detail = await calApi.item(itemId);
      const to = detail.attendees.map((a) => a.email).filter((e) => e.toLowerCase() !== userName.toLowerCase());
      if (detail.organizer && !isMine(detail.organizer)) to.unshift(detail.organizer);
      handToCompose({ to: [...new Set(to)].join(', '), subject: detail.title });
      goTo('mail');
    } catch (cause) {
      fail(cause);
    }
  }

  async function exportItems(itemIds: string[], name: string) {
    try {
      downloadText(`${name || 'calendar'}.ics`, await calApi.exportItems(itemIds));
    } catch (cause) {
      fail(cause);
    }
  }

  function categoryMenu(target: { itemId: string; calendarId: number; categories: string[] }): CtxItem[] {
    const names = [...new Set([...boot.categories.map((c) => c.name), ...target.categories])];
    return [
      ...names.map((name) => ({
        label: name,
        checked: target.categories.includes(name),
        onClick: () =>
          void quick(target, {
            categories: target.categories.includes(name) ? target.categories.filter((c) => c !== name) : [...target.categories, name],
          }),
      })),
      ...(names.length ? [{ separator: true } as CtxItem] : []),
      { label: t('cal.ctx.noCategory'), onClick: () => void quick(target, { categories: [] }), disabled: !target.categories.length },
    ];
  }

  function calendarMenu(target: { itemId: string; calendarId: number }): CtxItem[] {
    return boot.calendars
      .filter((c) => !c.readonly)
      .map((c) => ({
        label: c.name,
        checked: c.calendarId === target.calendarId,
        disabled: c.calendarId === target.calendarId,
        onClick: () => void quick(target, { calendarId: c.calendarId }),
      }));
  }

  function taskMenuItems(task: { itemId: string; calendarId: number; categories: string[]; percent: number; priority: number; completed: boolean }): CtxItem[] {
    return [
      { label: t(task.completed ? 'cal.markIncomplete' : 'cal.markComplete'), onClick: () => void quick(task, { completed: !task.completed }) },
      {
        label: t('cal.ctx.progress'),
        children: [0, 25, 50, 75, 100].map((p) => ({ label: `${p}%`, checked: task.percent === p, onClick: () => void quick(task, { percent: p }) })),
      },
      {
        label: t('cal.f.priority'),
        children: (
          [
            [0, 'cal.pri.none'],
            [9, 'cal.pri.low'],
            [5, 'cal.pri.normal'],
            [1, 'cal.pri.high'],
          ] as const
        ).map(([p, key]) => ({ label: t(key), checked: task.priority === p, onClick: () => void quick(task, { priority: p }) })),
      },
    ];
  }

  const actions: CalActions = {
    openNew(seed) {
      if (!defaultCal) {
        showToast(t('cal.noWritable'), 'error');
        return;
      }
      setDialog({ mode: 'new', scope: 'all', occurrence: null, initial: newInput(seed), isOrganizer: true, organizer: null });
    },
    openOccurrence(occ) {
      void openDetail(occ.itemId, occ);
    },
    openTask(task) {
      void openDetail(task.itemId, null, 'all');
    },
    deleteOccurrence(occ) {
      void removeOccurrence(occ);
    },
    copyTo(occ, day) {
      void calApi
        .item(occ.itemId)
        .then((detail) => paste(day, null, { occ, detail, cut: false }))
        .catch(fail);
    },
    async moveOccurrence(occ, start, end, allDay) {
      if (!isWritable(occ, ctxValue)) {
        showToast(t('cal.readonlyNote'), 'error');
        return;
      }
      let scope: Scope = 'all';
      if (occ.recurring && !occ.exception) {
        if (allDay !== occ.allDay) scope = 'this';
        else {
          const picked = await askScope('move', false);
          if (!picked) return;
          scope = picked;
        }
      }
      const notify = occ.type === 'E' && occ.attendees > 0 && isMine(occ.organizer) && confirm(t('cal.askNotifyUpdate'));
      try {
        const res = await calApi.move(occ.itemId, { start, end, allDay, scope, occurrence: occ.occurrence, notify });
        toastWarnings(res.warnings);
        await refresh();
      } catch (cause) {
        fail(cause);
      }
    },
    occurrenceMenu(e, occ) {
      const writable = isWritable(occ, ctxValue);
      const items: CtxItem[] = [
        { label: t('cal.ctx.open'), shortcut: 'Enter', onClick: () => actions.openOccurrence(occ) },
        { separator: true },
        { label: t('cal.ctx.cut'), shortcut: 'Ctrl+X', disabled: !writable, onClick: () => void copyOrCut(occ, true) },
        { label: t('cal.ctx.copy'), shortcut: 'Ctrl+C', onClick: () => void copyOrCut(occ, false) },
        { label: t('common.delete'), shortcut: 'Del', danger: true, disabled: !writable, onClick: () => void removeOccurrence(occ) },
        { separator: true },
        { label: t('cal.f.category'), disabled: !writable, children: categoryMenu(occ) },
      ];
      if (occ.type === 'E') {
        items.push({
          label: t('common.status'),
          disabled: !writable,
          children: (
            [
              [null, 'cal.st.none'],
              ['TENTATIVE', 'cal.st.tentative'],
              ['CONFIRMED', 'cal.st.confirmed'],
              ['CANCELLED', 'cal.st.cancelled'],
            ] as const
          ).map(([status, key]) => ({ label: t(key), checked: occ.status === status, onClick: () => void quick(occ, { status }) })),
        });
      } else if (writable) {
        items.push(...taskMenuItems(occ));
      }
      items.push(
        {
          label: t('cal.f.privacy'),
          disabled: !writable,
          children: (
            [
              ['PUBLIC', 'cal.priv.public'],
              ['CONFIDENTIAL', 'cal.priv.confidential'],
              ['PRIVATE', 'cal.priv.private'],
            ] as const
          ).map(([privacy, key]) => ({ label: t(key), checked: occ.privacy === privacy, onClick: () => void quick(occ, { privacy }) })),
        },
        { label: t('cal.ctx.moveTo'), disabled: !writable, children: calendarMenu(occ) },
        { separator: true },
        ...(occ.attendees > 0 ? [{ label: t('cal.ctx.mailAttendees'), onClick: () => void mailAttendees(occ.itemId) }] : []),
        { label: t('cal.ctx.exportItem'), onClick: () => void exportItems([occ.itemId], occ.title) },
      );
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    slotMenu(e, day, time) {
      const prevKey = view === 'day' ? 'cal.ctx.prevDay' : view === 'month' ? 'cal.ctx.prevMonth' : 'cal.ctx.prevWeek';
      const nextKey = view === 'day' ? 'cal.ctx.nextDay' : view === 'month' ? 'cal.ctx.nextMonth' : 'cal.ctx.nextWeek';
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: t('cal.newEvent'), shortcut: 'Ctrl+I', onClick: () => actions.openNew({ start: time ? `${day}T${time}` : day }) },
          { label: t('cal.newTask'), shortcut: 'Ctrl+D', onClick: () => actions.openNew({ type: 'T', start: day }) },
          { separator: true },
          { label: t(prevKey), onClick: () => step(-1) },
          { label: t(nextKey), onClick: () => step(1) },
          { separator: true },
          { label: t('cal.ctx.cut'), shortcut: 'Ctrl+X', disabled: true },
          { label: t('cal.ctx.copy'), shortcut: 'Ctrl+C', disabled: true },
          { label: t('cal.ctx.paste'), shortcut: 'Ctrl+V', disabled: !clip, onClick: () => void paste(day, time) },
        ],
      });
    },
    taskMenu(e, task) {
      const writable = isWritable(task, ctxValue);
      const asOcc = { ...task, completed: Boolean(task.completed) };
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: t('cal.ctx.open'), onClick: () => actions.openTask(task) },
          { separator: true },
          ...(writable ? taskMenuItems(asOcc) : []),
          { label: t('cal.f.category'), disabled: !writable, children: categoryMenu(task) },
          { label: t('cal.ctx.moveTo'), disabled: !writable, children: calendarMenu(task) },
          { separator: true },
          { label: t('cal.ctx.exportItem'), onClick: () => void exportItems([task.itemId], task.title) },
          {
            label: t('common.delete'),
            danger: true,
            disabled: !writable,
            onClick: () =>
              void removeOccurrence({
                itemId: task.itemId,
                occurrence: null,
                recurring: false,
                exception: false,
                title: task.title,
                attendees: 0,
                organizer: null,
                calendarId: task.calendarId,
              }),
          },
        ],
      });
    },
    select(occ) {
      setSelected(occ);
      if (occ) setDate(dateOf(occ.start));
    },
    selectDate(day, time) {
      setDate(day);
      setSlotTime(time ?? null);
      setSelected(null);
    },
    goToDate(day, nextView) {
      setDate(day);
      if (nextView) setPref('view', nextView);
    },
    toggleTask(itemId, completed) {
      const cal = (raw ?? []).find((o) => o.itemId === itemId)?.calendarId;
      void quick({ itemId, calendarId: cal ?? defaultCal?.calendarId ?? 0 }, { completed });
    },
    quickAddTask(title) {
      if (!defaultCal) return;
      const input = newInput({ type: 'T', title });
      input.due = null;
      void calApi
        .create(input, false)
        .then(refresh)
        .catch(fail);
    },
  };
  actionsRef.current = actions;

  const ctxValue: CalContextValue = {
    boot,
    userName,
    calendarById,
    categoryColor,
    today,
    selectedId: selected?.id ?? null,
    selectedDate: date,
    actions,
  };

  // ---------------------------------------------------------------- 단축키

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || scopeAsk || settingsOpen || document.querySelector('.modal-backdrop')) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const a = actionsRef.current!;
      if (ctrl && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        a.openNew({ start: date });
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        a.openNew({ type: 'T' });
      } else if (ctrl && e.key === 'PageUp') {
        e.preventDefault();
        step(-1);
      } else if (ctrl && e.key === 'PageDown') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'F11') {
        e.preventDefault();
        setPref('todayPane', !prefs.todayPane);
      } else if (ctrl && e.key.toLowerCase() === 'c' && selected) {
        void copyOrCut(selected, false);
      } else if (ctrl && e.key.toLowerCase() === 'x' && selected) {
        void copyOrCut(selected, true);
      } else if (ctrl && e.key.toLowerCase() === 'v' && clip) {
        void paste(date, slotTime);
      } else if (e.key === 'Delete' && selected) {
        a.deleteOccurrence(selected);
      } else if (e.key === 'Enter' && selected) {
        a.openOccurrence(selected);
      } else if (!ctrl && tab === 'calendar' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const vertical = view === 'month' || view === 'multiweek' ? 7 : 1;
        const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -vertical : vertical;
        setDate((d) => addDays(d, delta));
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- 툴바 동작

  async function syncAll() {
    const subs = boot.calendars.filter((c) => c.type === 'ICS');
    for (const cal of subs) await calApi.refreshCalendar(cal.calendarId).catch((cause: Error) => showToast(`${cal.name}: ${cause.message}`, 'error'));
    await refresh();
    showToast(t('cal.synced'));
  }

  async function importFile(file: File) {
    if (!defaultCal) return;
    if (!confirm(t('cal.importInto', { name: defaultCal.name }))) return;
    try {
      const res = await calApi.importIcs(defaultCal.calendarId, await file.text());
      showToast(t('cal.imported', { n: res.imported }));
      await refresh();
    } catch (cause) {
      fail(cause);
    }
  }

  const menuOpen = useCallback((e: MouseEvent, items: CtxItem[]) => setCtxMenu({ x: e.clientX, y: e.clientY, items }), []);

  const isTasks = tab === 'tasks';

  return (
    <CalContext.Provider value={ctxValue}>
      <div className={`cal-page ${prefs.todayPane ? 'with-today' : ''}`}>
        <div className="cal-toolbar">
          <button className="tb" onClick={() => void syncAll()} title={t('cal.sync')}>
            ⟳ {t('cal.sync')}
          </button>
          <button className="tb" onClick={() => actions.openNew({ start: date })} title="Ctrl+I">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zm13 8H4v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9zM7 12h3v3H7v-3zm5 0h3v3h-3v-3z" />
            </svg>
            {t('cal.event')}
          </button>
          <button className="tb" onClick={() => actions.openNew({ type: 'T' })} title="Ctrl+D">
            ☑ {t('cal.task')}
          </button>
          <button className="tb" disabled={!selected} onClick={() => selected && actions.openOccurrence(selected)}>
            ✎ {t('common.edit')}
          </button>
          <button className="tb" disabled={!selected || !isWritable(selected, ctxValue)} onClick={() => selected && actions.deleteOccurrence(selected)}>
            🗑 {t('common.delete')}
          </button>
          <span className="cal-toolbar-sep" />
          <button className="tb" onClick={() => window.print()} title="Ctrl+P">
            🖶 {t('cal.print')}
          </button>
          <button className="tb" onClick={() => importRef.current?.click()}>
            {t('cal.import')}
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".ics,text/calendar"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = '';
            }}
          />
          <Menu
            label={`${t('cal.export')} ▾`}
            buttonClassName="tb"
            items={boot.calendars.map((c) => ({ label: c.name, onClick: () => window.location.assign(calApi.exportUrl(c.calendarId)) }))}
          />
          <button className="tb" onClick={() => setSettingsOpen(true)}>
            ⚙ {t('cal.settings')}
          </button>
          <span className="cal-toolbar-fill" />
          <div className="cal-tabs">
            <button className={!isTasks ? 'active' : ''} onClick={() => goTo('calendar')}>
              {t('cal.calendar')}
            </button>
            <button className={isTasks ? 'active' : ''} onClick={() => goTo('calendar', 'tasks')}>
              {t('cal.tasks')}
            </button>
          </div>
          <button className={`tb ${prefs.todayPane ? 'active' : ''}`} title="F11" onClick={() => setPref('todayPane', !prefs.todayPane)}>
            {t('cal.todayPane')}
          </button>
        </div>

        <div className="cal-body">
          <aside className="cal-side">
            <button className="primary cal-new" onClick={() => (isTasks ? actions.openNew({ type: 'T' }) : actions.openNew({ start: date }))}>
              ＋ {t(isTasks ? 'cal.newTask' : 'cal.newEvent')}
            </button>
            <MiniMonth
              date={date}
              onPick={(d) => {
                setDate(d);
                setSelected(null);
                if (isTasks) goTo('calendar');
              }}
            />
            {isTasks && (
              <div className="cal-task-filters">
                {TASK_FILTERS.map(([key, label]) => (
                  <label key={key} className="checkbox">
                    <input type="radio" checked={taskFilter === key} onChange={() => setTaskFilter(key)} />
                    {t(label)}
                  </label>
                ))}
              </div>
            )}
            <CalendarList calendars={boot.calendars} onMenu={menuOpen} />
          </aside>

          <main className="cal-main">
            {isTasks ? (
              <TasksView filter={taskFilter} />
            ) : (
              <>
                {prefs.unifinder && <Unifinder viewRange={{ from: range.from, to: range.to }} onClose={() => setPref('unifinder', false)} />}
                <div className="cal-viewbar">
                  <div className="cal-nav">
                    <button className="tb icon" onClick={() => step(-1)} aria-label={t('cal.prev')}>
                      ‹
                    </button>
                    <button className="tb" onClick={() => setDate(today)}>
                      {t('cal.today')}
                    </button>
                    <button className="tb icon" onClick={() => step(1)} aria-label={t('cal.next')}>
                      ›
                    </button>
                  </div>
                  <h2 className="cal-title">{title}</h2>
                  <span className="cal-weeklabel">{weekLabel}</span>
                  <div className="cal-views">
                    {(['day', 'week', 'multiweek', 'month'] as const).map((v) => (
                      <button key={v} className={view === v ? 'active' : ''} onClick={() => setPref('view', v)}>
                        {t(`cal.view.${v}` as const)}
                      </button>
                    ))}
                  </div>
                  <Menu
                    label="⚙"
                    title={t('cal.viewOptions')}
                    buttonClassName="tb icon"
                    align="right"
                    items={[
                      { label: <><span className="menu-mark">{prefs.workdaysOnly ? '✓' : ''}</span>{t('cal.opt.workdaysOnly')}</>, onClick: () => setPref('workdaysOnly', !prefs.workdaysOnly) },
                      { label: <><span className="menu-mark">{prefs.showTasks ? '✓' : ''}</span>{t('cal.opt.showTasks')}</>, onClick: () => setPref('showTasks', !prefs.showTasks) },
                      { label: <><span className="menu-mark">{prefs.showCompleted ? '✓' : ''}</span>{t('cal.opt.showCompleted')}</>, onClick: () => setPref('showCompleted', !prefs.showCompleted) },
                      { label: <><span className="menu-mark">{prefs.unifinder ? '✓' : ''}</span>{t('cal.opt.unifinder')}</>, onClick: () => setPref('unifinder', !prefs.unifinder) },
                    ]}
                  />
                </div>
                <div className="cal-view">
                  {view === 'day' || view === 'week' ? (
                    <TimeGrid days={days} occurrences={occurrences} />
                  ) : (
                    <MonthView
                      start={range.from}
                      weeks={range.weeks}
                      month={view === 'month' ? date.slice(0, 7) : null}
                      occurrences={occurrences}
                      workdaysOnly={prefs.workdaysOnly}
                    />
                  )}
                </div>
              </>
            )}
          </main>

          {prefs.todayPane && <TodayPane onClose={() => setPref('todayPane', false)} />}
        </div>
      </div>

      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />

      {dialog && (
        <ItemDialog
          key={`${dialog.itemId ?? 'new'}|${dialog.scope}|${dialog.occurrence ?? ''}`}
          target={dialog}
          calendars={boot.calendars}
          categories={boot.categories}
          settings={settings}
          userName={userName}
          onClose={() => setDialog(null)}
          onDelete={
            dialog.mode === 'edit' && dialog.itemId
              ? () => {
                  const target = dialog;
                  setDialog(null);
                  void removeOccurrence({
                    itemId: target.itemId!,
                    occurrence: target.occurrence,
                    recurring: Boolean(target.initial.rrule) || target.scope !== 'all',
                    exception: false,
                    title: target.initial.title,
                    attendees: target.initial.attendees.length,
                    organizer: target.organizer,
                    calendarId: target.initial.calendarId,
                  });
                }
              : undefined
          }
          onSave={async (input, notify) => {
            const res =
              dialog.mode === 'new'
                ? await calApi.create(input, notify)
                : await calApi.update(dialog.itemId!, input, dialog.scope, dialog.occurrence, notify);
            toastWarnings(res.warnings);
            setDialog(null);
            await refresh();
          }}
        />
      )}

      {scopeAsk && (
        <Modal
          title={t(scopeAsk.kind === 'delete' ? 'cal.scope.deleteTitle' : scopeAsk.kind === 'move' ? 'cal.scope.moveTitle' : 'cal.scope.editTitle')}
          width={420}
          onClose={() => {
            scopeAsk.resolve(null);
            setScopeAsk(null);
          }}
        >
          <p>{t('cal.scope.question')}</p>
          <div className="cal-scope-buttons">
            {(['this', ...(scopeAsk.following ? ['following' as const] : []), 'all'] as const).map((scope) => (
              <button
                key={scope}
                className={scope === 'this' ? 'primary' : 'btn'}
                onClick={() => {
                  scopeAsk.resolve(scope);
                  setScopeAsk(null);
                }}
              >
                {t(`cal.scope.${scope}` as const)}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {settingsOpen && (
        <CalSettingsDialog
          settings={settings}
          categories={boot.categories}
          me={me}
          onMeChanged={onMeChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </CalContext.Provider>
  );
}

