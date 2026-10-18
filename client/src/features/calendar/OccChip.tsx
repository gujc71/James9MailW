/** 월 · 여러 주 보기와 종일 줄에 그리는 일정 한 칸 */
import type { DragEvent, MouseEvent } from 'react';
import { useLocale, useT } from '../../i18n';
import { chipStyle, isWritable, useCal } from './context';
import type { Occurrence } from './types';
import { fmtRange, fmtTime } from './wall';

/** 끌어 옮기는 중인 회차. dataTransfer 는 dragover 에서 읽을 수 없어 모듈에 둔다 */
export const dragging: { occ: Occurrence | null; copy: boolean } = { occ: null, copy: false };

export function occTooltip(occ: Occurrence, locale: string, calName: string | undefined): string {
  return [
    occ.title,
    fmtRange(locale, occ.start, occ.end, occ.allDay),
    occ.location ?? '',
    calName ?? '',
    occ.categories.join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}

export function OccIcons({ occ }: { occ: Occurrence }) {
  const t = useT();
  return (
    <>
      {occ.type === 'T' && <span className={`cal-task-box ${occ.completed ? 'done' : ''}`} aria-label={t('cal.task')} />}
      {occ.recurring && (
        <span className="cal-ic" title={t(occ.exception ? 'cal.icon.exception' : 'cal.icon.recurring')}>
          {occ.exception ? '↻̸' : '↻'}
        </span>
      )}
      {occ.hasAlarm && (
        <span className="cal-ic" title={t('cal.icon.alarm')}>
          ⏰
        </span>
      )}
      {occ.attendees > 0 && (
        <span className="cal-ic" title={t('cal.icon.attendees')}>
          👥
        </span>
      )}
      {occ.privacy !== 'PUBLIC' && (
        <span className="cal-ic" title={t('cal.icon.private')}>
          🔒
        </span>
      )}
    </>
  );
}

export function OccChip({ occ, showTime = true, day }: { occ: Occurrence; showTime?: boolean; day?: string }) {
  const locale = useLocale();
  const ctx = useCal();
  const writable = isWritable(occ, ctx);
  const startsToday = !day || occ.start.slice(0, 10) === day;
  const style = chipStyle(occ, ctx);
  return (
    <div
      className={`cal-chip ${occ.allDay ? 'allday' : 'timed'} ${ctx.selectedId === occ.id ? 'selected' : ''} ${
        occ.status === 'CANCELLED' || occ.completed ? 'struck' : ''
      } ${occ.status === 'TENTATIVE' ? 'tentative' : ''} ${occ.transp === 'TRANSPARENT' ? 'free' : ''}`}
      style={occ.allDay ? style : { borderLeft: style.borderLeft }}
      title={occTooltip(occ, locale, ctx.calendarById.get(occ.calendarId)?.name)}
      draggable={writable}
      onDragStart={(e: DragEvent) => {
        dragging.occ = occ;
        dragging.copy = e.ctrlKey || e.altKey;
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', occ.title);
      }}
      onDragEnd={() => {
        dragging.occ = null;
      }}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        ctx.actions.select(occ);
      }}
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
      {!occ.allDay && <span className="cal-chip-dot" style={{ background: ctx.calendarById.get(occ.calendarId)?.color }} />}
      <OccIcons occ={occ} />
      {showTime && !occ.allDay && startsToday && <span className="cal-chip-time">{fmtTime(locale, occ.start)}</span>}
      <span className="cal-chip-title">{occ.title}</span>
    </div>
  );
}
