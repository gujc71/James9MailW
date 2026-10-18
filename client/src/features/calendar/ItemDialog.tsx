/**
 * 이벤트 · 태스크 편집 (썬더버드 "이벤트 편집" 창).
 * 일반(제목 · 장소 · 캘린더 · 분류 · 일시 · 반복 · 알림 · 상태) + 탭(설명 · 참석자 · 첨부).
 * 시각은 이 일정의 시간대(tzid) 벽시계로 다룬다.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Modal } from '../common/Modal';
import { useLocale, useT } from '../../i18n';
import { useAddressSuggest } from '../compose/useAddressSuggest';
import { addressOf, isValidAddress, parseAddresses } from '../compose/RecipientInput';
import { AddressBook } from '../common/AddressBook';
import { Menu } from '../common/Menu';
import { calApi } from './api';
import { RecurrenceDialog } from './RecurrenceDialog';
import { FreeBusyDialog } from './FreeBusyDialog';
import { describeRule, presetOf, presetRule, type Preset } from './rrule';
import { addDays, addMinutes, dateOf, isDateOnly, ms, timeOf } from './wall';
import type { Alarm, Attachment, Attendee, CalendarInfo, CalSettings, Category, ItemInput, ItemType } from './types';

export interface DialogTarget {
  mode: 'new' | 'edit';
  itemId?: string;
  scope: 'this' | 'following' | 'all';
  occurrence: string | null;
  initial: ItemInput;
  /** 받은 초대면 주최자가 남이다 — 초대 메일을 다시 보내지 않는다 */
  isOrganizer: boolean;
  organizer: string | null;
}

const ALARM_PRESETS = [0, 5, 10, 15, 30, 60, 120, 720, 1440, 2880, 10080];
const UNITS = [
  { key: 'min', minutes: 1 },
  { key: 'hour', minutes: 60 },
  { key: 'day', minutes: 1440 },
  { key: 'week', minutes: 10080 },
] as const;

let zonesCache: string[] | null = null;
function timeZones(extra: string[]): string[] {
  if (!zonesCache) {
    try {
      zonesCache = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      zonesCache = ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles'];
    }
  }
  return [...new Set([...extra, 'UTC', ...zonesCache])];
}

export function alarmLabel(t: ReturnType<typeof useT>, alarm: Alarm, type: ItemType): string {
  const abs = Math.abs(alarm.offsetMin);
  const unit = [...UNITS].reverse().find((u) => abs % u.minutes === 0 && abs >= u.minutes) ?? UNITS[0];
  const amount = abs / unit.minutes;
  const anchor = t(alarm.related === 'E' ? (type === 'T' ? 'cal.alarm.due' : 'cal.alarm.end') : 'cal.alarm.start');
  if (alarm.offsetMin === 0) return t('cal.alarm.atAnchor', { anchor });
  return t(alarm.offsetMin > 0 ? 'cal.alarm.before' : 'cal.alarm.after', {
    n: amount,
    unit: t(`cal.unit.${unit.key}` as const),
    anchor,
  });
}

export function ItemDialog({
  target,
  calendars,
  categories,
  settings,
  userName,
  onSave,
  onDelete,
  onClose,
}: {
  target: DialogTarget;
  calendars: CalendarInfo[];
  categories: Category[];
  settings: CalSettings;
  userName: string;
  onSave: (input: ItemInput, notify: boolean) => Promise<void>;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const init = target.initial;
  const isTask = init.type === 'T';

  const [title, setTitle] = useState(init.title);
  const [location, setLocation] = useState(init.location);
  const [calendarId, setCalendarId] = useState(init.calendarId);
  const [cats, setCats] = useState<string[]>(init.categories);
  const [newCat, setNewCat] = useState('');
  const [allDay, setAllDay] = useState(init.allDay);
  const [tzid, setTzid] = useState(init.tzid);
  const [showTz, setShowTz] = useState(init.tzid !== settings.timezone);

  const baseStart = init.start ?? (isTask ? null : null);
  const [hasStart, setHasStart] = useState(Boolean(init.start));
  const [startDate, setStartDate] = useState(dateOf(baseStart ?? init.due ?? new Date().toISOString().slice(0, 10)));
  const [startTime, setStartTime] = useState(baseStart && !isDateOnly(baseStart) ? timeOf(baseStart) : '09:00');
  // 종일 일정의 끝은 화면에서 마지막 날(포함)로 보인다. 저장할 때 다음 날로 돌린다
  const initEnd = isTask ? init.due : init.end;
  const [hasDue, setHasDue] = useState(Boolean(init.due));
  const [endDate, setEndDate] = useState(() => {
    if (!initEnd) return startDate;
    return init.allDay && !isTask ? addDays(dateOf(initEnd), -1) : dateOf(initEnd);
  });
  const [endTime, setEndTime] = useState(initEnd && !isDateOnly(initEnd) ? timeOf(initEnd) : '10:00');

  const [preset, setPreset] = useState<Preset>(presetOf(init.rrule, startDate));
  const [customRule, setCustomRule] = useState<string | null>(init.rrule);
  const [editRule, setEditRule] = useState(false);

  const [alarms, setAlarms] = useState<Alarm[]>(init.alarms);
  const [customAlarm, setCustomAlarm] = useState<{ n: number; unit: number; dir: 1 | -1; related: 'S' | 'E' } | null>(null);

  const [status, setStatus] = useState(init.status ?? '');
  const [priority, setPriority] = useState(init.priority);
  const [privacy, setPrivacy] = useState(init.privacy);
  const [transp, setTransp] = useState(init.transp);
  const [percent, setPercent] = useState(init.percent);
  const [completedAt, setCompletedAt] = useState(init.completed ? init.completed.slice(0, 16) : '');

  const [tab, setTab] = useState<'desc' | 'attendees' | 'attach'>('desc');
  const [description, setDescription] = useState(init.description);
  const [url, setUrl] = useState(init.url);
  const [attendees, setAttendees] = useState<Attendee[]>(init.attendees);
  const [attachments, setAttachments] = useState<Attachment[]>(init.attachments);
  const [attendeeInput, setAttendeeInput] = useState('');
  const [attActive, setAttActive] = useState(-1);
  const [attError, setAttError] = useState<string | null>(null);
  const [recentAtt, setRecentAtt] = useState<{ email: string; name: string | null }[]>([]);
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [attachInput, setAttachInput] = useState({ url: '', name: '' });
  const [notify, setNotify] = useState(target.isOrganizer && init.attendees.length > 0);
  const [freeBusy, setFreeBusy] = useState(false);
  const suggest = useAddressSuggest(userName);
  // 이미 넣은 참석자는 후보에서 뺀다
  const attOptions = suggest.items.filter((s) => !attendees.some((a) => a.email === s.address.toLowerCase()));
  const attOpen = attOptions.length > 0 && attendeeInput.trim().length > 0;
  const attActiveIndex = attActive < attOptions.length ? attActive : -1;

  useEffect(() => {
    if (isTask) return;
    calApi
      .recentAttendees()
      .then(setRecentAtt)
      .catch(() => setRecentAtt([]));
  }, [isTask]);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const writable = calendars.filter((c) => !c.readonly || c.calendarId === init.calendarId);
  const readonly = Boolean(calendars.find((c) => c.calendarId === calendarId)?.readonly);
  const allCategories = useMemo(
    () => [...new Set([...categories.map((c) => c.name), ...cats])],
    [categories, cats],
  );
  const rrule = preset === 'custom' ? customRule : presetRule(preset, startDate);

  const startWall = allDay ? startDate : `${startDate}T${startTime}`;
  const endWall = allDay ? endDate : `${endDate}T${endTime}`;

  /** 시작을 옮기면 끝도 같은 길이로 따라간다 (썬더버드와 같다) */
  function moveStart(nextDate: string, nextTime: string) {
    if (!isTask) {
      const length = ms(endWall) - ms(startWall);
      const next = allDay ? nextDate : `${nextDate}T${nextTime}`;
      const moved = allDay ? addDays(next, Math.round(length / 86_400_000)) : addMinutes(next, Math.round(length / 60_000));
      setEndDate(dateOf(moved));
      if (!allDay) setEndTime(timeOf(moved));
    }
    setStartDate(nextDate);
    setStartTime(nextTime);
  }

  /** "홍길동 <a@b>" · "a@b" 를 여러 개 받는다. 이름이 있으면 함께 남긴다 */
  function addAttendees(entries: string[]) {
    const bad = entries.filter((e) => !isValidAddress(e));
    const good = entries.filter((e) => isValidAddress(e));
    setAttError(bad.length ? t('recipient.invalid', { entry: bad.join(', ') }) : null);
    if (good.length) {
      setAttendees((prev) => {
        const have = new Set(prev.map((a) => a.email));
        const added: Attendee[] = [];
        for (const entry of good) {
          const email = addressOf(entry).toLowerCase();
          if (have.has(email)) continue;
          have.add(email);
          const named = /^\s*"?([^"<]*?)"?\s*</.exec(entry)?.[1]?.trim() || null;
          added.push({
            email,
            name: named ?? suggest.items.find((s) => s.address.toLowerCase() === email)?.name ?? null,
            role: 'REQ-PARTICIPANT',
            partstat: 'NEEDS-ACTION',
            rsvp: true,
          });
        }
        return [...prev, ...added];
      });
      if (target.isOrganizer) setNotify(true);
    }
    // 틀린 주소는 고칠 수 있게 입력칸에 남긴다
    setAttendeeInput(bad.join(', '));
    setAttActive(-1);
    suggest.clear();
  }

  function chooseAttendee(index: number) {
    const item = attOptions[index];
    if (!item) return;
    // 주소록 그룹은 멤버 전부를 참석자로 넣는다
    if (item.members) addAttendees(item.members.map((m) => (m.name ? `${m.name} <${m.address}>` : m.address)));
    else addAttendees([item.name ? `${item.name} <${item.address}>` : item.address]);
  }

  function onAttendeeKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중의 엔터는 조합 확정이다
    if (attOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAttActive((i) => (i + 1 >= attOptions.length ? 0 : i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAttActive((i) => (i <= 0 ? attOptions.length - 1 : i - 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        suggest.clear();
        setAttActive(-1);
        return;
      }
      // 고른 후보가 있거나, 주소가 아닌 이름만 쳤으면 맨 위 후보를 넣는다
      if ((e.key === 'Enter' || e.key === 'Tab') && (attActiveIndex >= 0 || !isValidAddress(attendeeInput.trim()))) {
        e.preventDefault();
        chooseAttendee(Math.max(0, attActiveIndex));
        return;
      }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      if (attendeeInput.trim()) addAttendees(parseAddresses(attendeeInput));
    }
  }

  async function save() {
    setError(null);
    if (!isTask && ms(endWall) < ms(startWall)) {
      setError(t('cal.err.endBeforeStart'));
      return;
    }
    if (isTask && hasStart && hasDue && ms(endWall) < ms(startWall)) {
      setError(t('cal.err.dueBeforeStart'));
      return;
    }
    if (preset === 'custom' && !customRule) {
      setError(t('cal.err.noRule'));
      return;
    }
    const input: ItemInput = {
      type: init.type,
      calendarId,
      title: title.trim() || t(isTask ? 'cal.newTaskTitle' : 'cal.newEventTitle'),
      location,
      description,
      url,
      allDay,
      tzid,
      start: isTask ? (hasStart ? startWall : null) : startWall,
      end: isTask ? null : allDay ? addDays(endDate, 1) : endWall,
      due: isTask ? (hasDue ? endWall : null) : null,
      status: status || null,
      priority,
      privacy,
      transp,
      percent: isTask ? percent : 0,
      completed: isTask && (status === 'COMPLETED' || percent === 100) ? (completedAt ? new Date(completedAt).toISOString() : null) : null,
      rrule: isTask && !hasStart && !hasDue ? null : rrule,
      categories: cats,
      alarms,
      attendees: isTask ? [] : attendees,
      attachments,
    };
    setSaving(true);
    try {
      await onSave(input, notify && input.attendees.length > 0);
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  const header =
    target.mode === 'new'
      ? t(isTask ? 'cal.dlg.newTask' : 'cal.dlg.newEvent')
      : t(isTask ? 'cal.dlg.editTask' : 'cal.dlg.editEvent');
  const scopeNote =
    target.mode === 'edit' && target.scope !== 'all'
      ? t(target.scope === 'this' ? 'cal.scope.editingThis' : 'cal.scope.editingFollowing')
      : null;

  const timeInputs = (date: string, time: string, onDate: (v: string) => void, onTime: (v: string) => void, disabled = false) => (
    <div className="cal-inline">
      <input type="date" value={date} disabled={disabled} onChange={(e) => e.target.value && onDate(e.target.value)} />
      {!allDay && <input type="time" step={300} value={time} disabled={disabled} onChange={(e) => e.target.value && onTime(e.target.value)} />}
    </div>
  );

  return (
    <Modal
      title={header}
      onClose={onClose}
      width={720}
      className="cal-item-dialog"
      footer={
        <>
          {onDelete && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={onDelete} disabled={readonly}>
              {t('common.delete')}
            </button>
          )}
          {!isTask && attendees.length > 0 && target.isOrganizer && (
            <label className="checkbox">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              {t('cal.dlg.sendInvites')}
            </label>
          )}
          <button className="primary" onClick={() => void save()} disabled={saving || readonly}>
            {t('cal.dlg.saveClose')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </>
      }
    >
      {scopeNote && <div className="info cal-scope-note">{scopeNote}</div>}
      {readonly && <div className="warn">{t('cal.readonlyNote')}</div>}
      {!target.isOrganizer && target.organizer && (
        <div className="info cal-scope-note">{t('cal.dlg.invitedBy', { who: target.organizer })}</div>
      )}
      <div className="cal-form">
        <label>{t('common.subject')}</label>
        <input
          autoFocus
          value={title}
          placeholder={t(isTask ? 'cal.newTaskTitle' : 'cal.newEventTitle')}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void save()}
        />

        <label>{t('cal.f.location')}</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} />

        <label>{t('cal.f.calendar')}</label>
        <div className="cal-inline">
          <select value={calendarId} onChange={(e) => setCalendarId(Number(e.target.value))}>
            {writable.map((c) => (
              <option key={c.calendarId} value={c.calendarId}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="cal-dot" style={{ background: calendars.find((c) => c.calendarId === calendarId)?.color }} />
        </div>

        <label>{t('cal.f.category')}</label>
        <div className="cal-cats">
          {allCategories.map((name) => (
            <label key={name} className={`cal-cat-toggle ${cats.includes(name) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={cats.includes(name)}
                onChange={(e) => setCats(e.target.checked ? [...cats, name] : cats.filter((c) => c !== name))}
              />
              <span className="cal-dot" style={{ background: categories.find((c) => c.name === name)?.color ?? 'var(--border-strong)' }} />
              {name}
            </label>
          ))}
          <input
            className="cal-cat-new"
            value={newCat}
            placeholder={t('cal.f.newCategory')}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newCat.trim()) {
                e.preventDefault();
                setCats([...new Set([...cats, newCat.trim().replace(/,/g, ' ')])]);
                setNewCat('');
              }
            }}
          />
        </div>

        <label />
        <div className="cal-inline">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                const next = e.target.checked;
                setAllDay(next);
                if (!next && !isTask && endDate === startDate && endTime <= startTime) setEndTime('10:00');
              }}
            />
            {t(isTask ? 'cal.f.dateOnly' : 'cal.f.allDay')}
          </label>
          <button type="button" className="link" onClick={() => setShowTz((v) => !v)}>
            {t('cal.f.timezone')}
          </button>
          {showTz && !allDay && (
            <select className="cal-tz-select" value={tzid} onChange={(e) => setTzid(e.target.value)} aria-label={t('cal.f.timezone')}>
              {timeZones([settings.timezone, init.tzid]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          )}
        </div>

        {isTask ? (
          <>
            <label className="checkbox cal-label-check">
              <input type="checkbox" checked={hasStart} onChange={(e) => setHasStart(e.target.checked)} />
              {t('cal.f.start')}
            </label>
            {timeInputs(startDate, startTime, (v) => setStartDate(v), setStartTime, !hasStart)}
            <label className="checkbox cal-label-check">
              <input type="checkbox" checked={hasDue} onChange={(e) => setHasDue(e.target.checked)} />
              {t('cal.f.due')}
            </label>
            {timeInputs(endDate, endTime, setEndDate, setEndTime, !hasDue)}
          </>
        ) : (
          <>
            <label>{t('cal.f.date')}</label>
            <div className="cal-inline cal-date-range">
              <span title={t('cal.f.start')}>
                {timeInputs(startDate, startTime, (v) => moveStart(v, startTime), (v) => moveStart(startDate, v))}
              </span>
              <span title={t('cal.f.end')}>{timeInputs(endDate, endTime, setEndDate, setEndTime)}</span>
            </div>
          </>
        )}

        <label>{t('cal.f.repeat')}</label>
        <div className="cal-inline cal-repeat-row">
          <select
            value={preset}
            disabled={target.scope === 'this' && target.mode === 'edit'}
            onChange={(e) => {
              const next = e.target.value as Preset;
              if (next === 'custom') {
                setEditRule(true);
                return;
              }
              setPreset(next);
            }}
          >
            <option value="none">{t('cal.repeat.none')}</option>
            <option value="daily">{t('cal.repeat.daily')}</option>
            <option value="weekdays">{t('cal.repeat.weekdays')}</option>
            <option value="weekly">{t('cal.repeat.weekly')}</option>
            <option value="biweekly">{t('cal.repeat.biweekly')}</option>
            <option value="monthly">{t('cal.repeat.monthly')}</option>
            <option value="yearly">{t('cal.repeat.yearly')}</option>
            <option value="custom">{t('cal.repeat.custom')}</option>
          </select>
          {rrule && <span className="hint">{describeRule(rrule, startDate, locale)}</span>}
          {preset === 'custom' && (
            <button type="button" className="link" onClick={() => setEditRule(true)}>
              {t('common.edit')}
            </button>
          )}
          <span className="cal-reminder-label">{t('cal.f.reminder')}</span>
          <div className="cal-stack">
            <div className="cal-chips">
              {alarms.map((a, i) => (
                <span key={`${a.offsetMin}${a.related}`} className="chip">
                  <span className="chip-text">{alarmLabel(t, a, init.type)}</span>
                  <button type="button" className="chip-x" onClick={() => setAlarms(alarms.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </span>
              ))}
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'custom') setCustomAlarm({ n: 15, unit: 1, dir: 1, related: 'S' });
                  else if (v !== '') {
                    const offsetMin = Number(v);
                    if (!alarms.some((a) => a.offsetMin === offsetMin && a.related === 'S'))
                      setAlarms([...alarms, { offsetMin, related: 'S' }]);
                  }
                }}
              >
                <option value="">{t(alarms.length ? 'cal.alarm.addMore' : 'cal.alarm.none')}</option>
                {ALARM_PRESETS.map((m) => (
                  <option key={m} value={m}>
                    {alarmLabel(t, { offsetMin: m, related: 'S' }, init.type)}
                  </option>
                ))}
                <option value="custom">{t('cal.alarm.custom')}</option>
              </select>
            </div>
            {customAlarm && (
              <div className="cal-inline">
                <input
                  type="number"
                  min={0}
                  max={999}
                  style={{ width: 70 }}
                  value={customAlarm.n}
                  onChange={(e) => setCustomAlarm({ ...customAlarm, n: Math.max(0, Number(e.target.value) || 0) })}
                />
                <select value={customAlarm.unit} onChange={(e) => setCustomAlarm({ ...customAlarm, unit: Number(e.target.value) })}>
                  {UNITS.map((u) => (
                    <option key={u.key} value={u.minutes}>
                      {t(`cal.unit.${u.key}` as const)}
                    </option>
                  ))}
                </select>
                <select value={customAlarm.dir} onChange={(e) => setCustomAlarm({ ...customAlarm, dir: Number(e.target.value) as 1 | -1 })}>
                  <option value={1}>{t('cal.alarm.dirBefore')}</option>
                  <option value={-1}>{t('cal.alarm.dirAfter')}</option>
                </select>
                <select value={customAlarm.related} onChange={(e) => setCustomAlarm({ ...customAlarm, related: e.target.value as 'S' | 'E' })}>
                  <option value="S">{t('cal.alarm.start')}</option>
                  <option value="E">{t(isTask ? 'cal.alarm.due' : 'cal.alarm.end')}</option>
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const offsetMin = customAlarm.n * customAlarm.unit * customAlarm.dir;
                    if (!alarms.some((a) => a.offsetMin === offsetMin && a.related === customAlarm.related))
                      setAlarms([...alarms, { offsetMin, related: customAlarm.related }]);
                    setCustomAlarm(null);
                  }}
                >
                  {t('common.add')}
                </button>
              </div>
            )}
          </div>
        </div>

        {isTask ? (
          <>
            <label>{t('common.status')}</label>
            <div className="cal-inline">
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  if (e.target.value === 'COMPLETED') setPercent(100);
                  else if (percent === 100) setPercent(0);
                }}
              >
                <option value="">{t('cal.st.none')}</option>
                <option value="NEEDS-ACTION">{t('cal.st.needsAction')}</option>
                <option value="IN-PROCESS">{t('cal.st.inProcess')}</option>
                <option value="COMPLETED">{t('cal.st.completed')}</option>
                <option value="CANCELLED">{t('cal.st.cancelled')}</option>
              </select>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                style={{ width: 80 }}
                value={percent}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                  setPercent(v);
                  if (v === 100) setStatus('COMPLETED');
                  else if (status === 'COMPLETED') setStatus(v > 0 ? 'IN-PROCESS' : 'NEEDS-ACTION');
                }}
              />
              <span>% {t('cal.f.complete')}</span>
              {(status === 'COMPLETED' || percent === 100) && (
                <input type="datetime-local" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} />
              )}
            </div>
          </>
        ) : (
          <>
            <label>{t('common.status')}</label>
            <div className="cal-inline">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t('cal.st.none')}</option>
                <option value="TENTATIVE">{t('cal.st.tentative')}</option>
                <option value="CONFIRMED">{t('cal.st.confirmed')}</option>
                <option value="CANCELLED">{t('cal.st.cancelled')}</option>
              </select>
              <span>{t('cal.f.showAs')}</span>
              <select value={transp} onChange={(e) => setTransp(e.target.value)}>
                <option value="OPAQUE">{t('cal.f.busy')}</option>
                <option value="TRANSPARENT">{t('cal.f.free')}</option>
              </select>
            </div>
          </>
        )}

        <label>{t('cal.f.priority')}</label>
        <div className="cal-inline">
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            <option value={0}>{t('cal.pri.none')}</option>
            <option value={9}>{t('cal.pri.low')}</option>
            <option value={5}>{t('cal.pri.normal')}</option>
            <option value={1}>{t('cal.pri.high')}</option>
          </select>
          <span>{t('cal.f.privacy')}</span>
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            <option value="PUBLIC">{t('cal.priv.public')}</option>
            <option value="CONFIDENTIAL">{t('cal.priv.confidential')}</option>
            <option value="PRIVATE">{t('cal.priv.private')}</option>
          </select>
        </div>
      </div>

      <div className="settings-tabs cal-dlg-tabs">
        <button className={`tab-btn ${tab === 'desc' ? 'active' : ''}`} onClick={() => setTab('desc')}>
          {t('cal.f.description')}
        </button>
        {!isTask && (
          <button className={`tab-btn ${tab === 'attendees' ? 'active' : ''}`} onClick={() => setTab('attendees')}>
            {t('cal.f.attendees')} {attendees.length ? `(${attendees.length})` : ''}
          </button>
        )}
        <button className={`tab-btn ${tab === 'attach' ? 'active' : ''}`} onClick={() => setTab('attach')}>
          {t('cal.f.attachments')} {attachments.length ? `(${attachments.length})` : ''}
        </button>
      </div>

      {tab === 'desc' && (
        <div className="cal-tab-body">
          <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
          <div className="cal-inline" style={{ marginTop: 8 }}>
            <span>{t('cal.f.url')}</span>
            <input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
            {/^https?:\/\//.test(url) && (
              <a href={url} target="_blank" rel="noreferrer noopener">
                ↗
              </a>
            )}
          </div>
        </div>
      )}

      {tab === 'attendees' && !isTask && (
        <div className="cal-tab-body">
          <div className="cal-inline cal-att-add">
            <div className="cal-suggest-wrap">
              <input
                value={attendeeInput}
                placeholder={t('cal.att.placeholder')}
                role="combobox"
                aria-expanded={attOpen}
                aria-autocomplete="list"
                autoComplete="off"
                onChange={(e) => {
                  setAttendeeInput(e.target.value);
                  setAttActive(-1);
                  setAttError(null);
                  suggest.query(e.target.value);
                }}
                onKeyDown={onAttendeeKeyDown}
                onBlur={() => window.setTimeout(() => suggest.clear(), 150)}
              />
              {attOpen && (
                <ul className="suggest" role="listbox">
                  {attOptions.map((s, i) => (
                    <li
                      key={s.address || `group-${s.groupId}`}
                      role="option"
                      aria-selected={i === attActiveIndex}
                      className={`suggest-item ${i === attActiveIndex ? 'on' : ''}`}
                      onMouseEnter={() => setAttActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        chooseAttendee(i);
                      }}
                    >
                      {s.name && <span className="suggest-name">{s.name}</span>}
                      <span className="suggest-addr">
                        {s.members ? t('addressbook.groupMembers', { count: s.members.length }) : s.address}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {recentAtt.length > 0 && (
              <Menu
                label="▼"
                buttonClassName="btn"
                title={t('cal.att.recent')}
                items={recentAtt.map((r) => {
                  const entry = r.name ? `${r.name} <${r.email}>` : r.email;
                  return { label: entry, onClick: () => addAttendees([entry]) };
                })}
              />
            )}
            <button type="button" className="btn" onClick={() => attendeeInput.trim() && addAttendees(parseAddresses(attendeeInput))}>
              {t('common.add')}
            </button>
            <button type="button" className="btn" onClick={() => setAddressBookOpen(true)}>
              {t('compose.addressBook')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={allDay || !attendees.length}
              onClick={() => setFreeBusy(true)}
            >
              {t('cal.att.freeBusy')}
            </button>
          </div>
          {attError && <div className="error cal-att-error">{attError}</div>}
          <table className="grid cal-att-table">
            <thead>
              <tr>
                <th>{t('cal.att.who')}</th>
                <th>{t('cal.att.role')}</th>
                <th>{t('cal.att.answer')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr className="cal-att-organizer">
                <td>{target.organizer ?? userName}</td>
                <td>{t('cal.att.organizer')}</td>
                <td />
                <td />
              </tr>
              {attendees.map((a, i) => (
                <tr key={a.email}>
                  <td>{a.name ? `${a.name} <${a.email}>` : a.email}</td>
                  <td>
                    <select
                      value={a.role}
                      disabled={!target.isOrganizer}
                      onChange={(e) => setAttendees(attendees.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                    >
                      <option value="REQ-PARTICIPANT">{t('cal.att.required')}</option>
                      <option value="OPT-PARTICIPANT">{t('cal.att.optional')}</option>
                      <option value="NON-PARTICIPANT">{t('cal.att.forInfo')}</option>
                      <option value="CHAIR">{t('cal.att.chair')}</option>
                    </select>
                  </td>
                  <td>
                    <span className={`cal-partstat ${a.partstat.toLowerCase()}`}>{t(partstatKey(a.partstat))}</span>
                  </td>
                  <td>
                    {target.isOrganizer && (
                      <button type="button" className="link danger" onClick={() => setAttendees(attendees.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!attendees.length && <p className="hint">{t('cal.att.empty')}</p>}
        </div>
      )}

      {tab === 'attach' && (
        <div className="cal-tab-body">
          <div className="cal-inline">
            <input
              value={attachInput.url}
              placeholder="https://"
              style={{ flex: 2 }}
              onChange={(e) => setAttachInput({ ...attachInput, url: e.target.value })}
            />
            <input
              value={attachInput.name}
              placeholder={t('common.name')}
              style={{ flex: 1 }}
              onChange={(e) => setAttachInput({ ...attachInput, name: e.target.value })}
            />
            <button
              type="button"
              className="btn"
              disabled={!/^https?:\/\/\S+$/.test(attachInput.url.trim())}
              onClick={() => {
                setAttachments([...attachments, { url: attachInput.url.trim(), name: attachInput.name.trim() || null }]);
                setAttachInput({ url: '', name: '' });
              }}
            >
              {t('common.add')}
            </button>
          </div>
          <ul className="attach-list">
            {attachments.map((a, i) => (
              <li key={`${a.url}${i}`}>
                <a href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.name || a.url}
                </a>{' '}
                <button type="button" className="link danger" onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">{t('cal.f.attachHint')}</p>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {editRule && (
        <RecurrenceDialog
          rrule={rrule}
          startDate={startDate}
          allDay={allDay}
          weekStart={settings.weekStart}
          onClose={() => setEditRule(false)}
          onSave={(rule) => {
            const nextPreset = presetOf(rule, startDate);
            setPreset(nextPreset === 'none' ? 'custom' : nextPreset);
            setCustomRule(rule);
            setEditRule(false);
          }}
        />
      )}
      {addressBookOpen && (
        <AddressBook
          onPick={(list) => {
            addAttendees(list);
            setAddressBookOpen(false);
          }}
          onClose={() => setAddressBookOpen(false)}
        />
      )}
      {freeBusy && (
        <FreeBusyDialog
          emails={[userName, ...attendees.map((a) => a.email)]}
          start={startWall}
          end={endWall}
          dayStartHour={settings.dayStartHour}
          dayEndHour={settings.dayEndHour}
          onClose={() => setFreeBusy(false)}
          onPick={(s, e) => {
            setStartDate(dateOf(s));
            setStartTime(timeOf(s));
            setEndDate(dateOf(e));
            setEndTime(timeOf(e));
            setFreeBusy(false);
          }}
        />
      )}
    </Modal>
  );
}

export function partstatKey(partstat: string) {
  switch (partstat) {
    case 'ACCEPTED':
      return 'cal.ps.accepted' as const;
    case 'TENTATIVE':
      return 'cal.ps.tentative' as const;
    case 'DECLINED':
      return 'cal.ps.declined' as const;
    case 'DELEGATED':
      return 'cal.ps.delegated' as const;
    default:
      return 'cal.ps.needsAction' as const;
  }
}
