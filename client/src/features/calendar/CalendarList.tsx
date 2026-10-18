/** 왼쪽 캘린더 목록. 체크로 보이기 · 숨기기, 오른쪽 메뉴로 속성 · 새로 고침 · 내보내기 · 삭제 */
import { useState, type MouseEvent } from 'react';
import { useT } from '../../i18n';
import { showToast } from '../common/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { calApi, calKeys, useInvalidate } from './api';
import { CalendarDialog } from './CalendarDialog';
import type { Bootstrap, CalendarInfo } from './types';
import type { CtxItem } from './ContextMenu';

export function CalendarList({
  calendars,
  onMenu,
}: {
  calendars: CalendarInfo[];
  onMenu: (e: MouseEvent, items: CtxItem[]) => void;
}) {
  const t = useT();
  const invalidate = useInvalidate();
  const client = useQueryClient();
  const [open, setOpen] = useState(true);
  const [dialog, setDialog] = useState<{ calendar: CalendarInfo | null } | null>(null);

  /** 보이기 체크는 화면을 먼저 바꾸고 저장한다. 회차 조회는 숨긴 캘린더도 받아 두므로 다시 받지 않는다 */
  async function toggle(cal: CalendarInfo, visible: boolean) {
    client.setQueryData<Bootstrap>(calKeys.bootstrap, (prev) =>
      prev ? { ...prev, calendars: prev.calendars.map((c) => (c.calendarId === cal.calendarId ? { ...c, visible } : c)) } : prev,
    );
    await calApi.updateCalendar(cal.calendarId, { visible }).catch((cause: Error) => showToast(cause.message, 'error'));
  }

  async function remove(cal: CalendarInfo) {
    if (!confirm(t('cal.confirmDeleteCalendar', { name: cal.name }))) return;
    try {
      await calApi.deleteCalendar(cal.calendarId);
      await invalidate();
    } catch (cause) {
      showToast((cause as Error).message, 'error');
    }
  }

  async function refresh(cal: CalendarInfo) {
    try {
      const res = await calApi.refreshCalendar(cal.calendarId);
      showToast(t('cal.refreshed', { n: res.saved }));
    } catch (cause) {
      showToast((cause as Error).message, 'error');
    }
    await invalidate();
  }

  function menu(e: MouseEvent, cal: CalendarInfo | null) {
    e.preventDefault();
    const items: CtxItem[] = [{ label: t('cal.newCalendar'), onClick: () => setDialog({ calendar: null }) }];
    if (cal) {
      items.push(
        { separator: true },
        { label: t('cal.showOnly'), onClick: () => calendars.forEach((c) => void toggle(c, c.calendarId === cal.calendarId)) },
        { label: t('cal.showAll'), onClick: () => calendars.forEach((c) => void toggle(c, true)) },
        { separator: true },
        ...(cal.type === 'ICS' ? [{ label: t('cal.refreshNow'), onClick: () => void refresh(cal) }] : []),
        { label: t('cal.export'), onClick: () => window.location.assign(calApi.exportUrl(cal.calendarId)) },
        ...(!cal.readonly && !cal.isDefault
          ? [{ label: t('cal.makeDefault'), onClick: () => void calApi.updateCalendar(cal.calendarId, { isDefault: true }).then(invalidate) }]
          : []),
        { label: t('cal.deleteCalendar'), danger: true, onClick: () => void remove(cal) },
        { separator: true },
        { label: t('cal.properties'), onClick: () => setDialog({ calendar: cal }) },
      );
    }
    onMenu(e, items);
  }

  return (
    <div className="cal-list" onContextMenu={(e) => menu(e, null)}>
      <div className="cal-list-head">
        <button className="cal-list-title" onClick={() => setOpen((v) => !v)}>
          {t('cal.calendars')} <span className="cal-caret">{open ? '▾' : '▸'}</span>
        </button>
        <button className="cal-icon-btn" title={t('cal.newCalendar')} onClick={() => setDialog({ calendar: null })}>
          ＋
        </button>
      </div>
      {open && (
        <ul>
          {calendars.map((cal) => (
            <li
              key={cal.calendarId}
              className={cal.visible ? '' : 'hidden-cal'}
              onContextMenu={(e) => {
                e.stopPropagation();
                menu(e, cal);
              }}
              onDoubleClick={() => setDialog({ calendar: cal })}
            >
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={cal.visible}
                  style={{ accentColor: cal.color }}
                  onChange={(e) => void toggle(cal, e.target.checked)}
                />
                <span className="cal-dot" style={{ background: cal.color }} />
                <span className="cal-list-name" title={cal.sourceUrl ?? cal.name}>
                  {cal.name}
                </span>
              </label>
              <span className="cal-list-flags">
                {cal.isDefault && <span title={t('cal.calDlg.default')}>★</span>}
                {cal.readonly && <span title={t('cal.calDlg.readonly')}>🔒</span>}
                {cal.type === 'ICS' && <span title={cal.syncError ?? t('cal.calDlg.network')}>{cal.syncError ? '⚠' : '⇅'}</span>}
                {cal.feedUrl && <span title={t('cal.calDlg.publishOn')}>📡</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {dialog && <CalendarDialog calendar={dialog.calendar} onClose={() => setDialog(null)} />}
    </div>
  );
}
