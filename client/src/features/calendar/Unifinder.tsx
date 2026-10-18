/**
 * 이벤트 목록 (썬더버드 Unifinder). 기간 필터 · 검색 · 열 정렬 · 열 고르기.
 * 행을 누르면 보기가 그날로 가고, 두 번 누르면 편집, 오른쪽 메뉴는 보기의 일정 메뉴와 같다.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useT, type MessageKey } from '../../i18n';
import { Menu } from '../common/Menu';
import { useRange, useSeries } from './api';
import { useCal } from './context';
import type { Occurrence } from './types';
import { addDays, addMonths, fmtDateTime, isDateOnly, nowIn, startOfMonth } from './wall';

export type UnifinderFilter = 'all' | 'future' | 'today' | 'next7' | 'next14' | 'next31' | 'thisMonth' | 'view';

const FILTERS: [UnifinderFilter, MessageKey][] = [
  ['all', 'cal.uf.all'],
  ['future', 'cal.uf.future'],
  ['today', 'cal.uf.today'],
  ['next7', 'cal.uf.next7'],
  ['next14', 'cal.uf.next14'],
  ['next31', 'cal.uf.next31'],
  ['thisMonth', 'cal.uf.thisMonth'],
  ['view', 'cal.uf.view'],
];

type Col = 'title' | 'start' | 'end' | 'category' | 'location' | 'calendar' | 'status';
const COLS: [Col, MessageKey][] = [
  ['title', 'common.subject'],
  ['start', 'cal.f.start'],
  ['end', 'cal.f.end'],
  ['category', 'cal.f.category'],
  ['location', 'cal.f.location'],
  ['calendar', 'cal.f.calendar'],
  ['status', 'common.status'],
];
const STORE = 'j9-cal-unifinder';

function loadPrefs(): { filter: UnifinderFilter; cols: Col[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return { filter: raw.filter ?? 'next7', cols: Array.isArray(raw.cols) && raw.cols.length ? raw.cols : ['title', 'start', 'end', 'category'] };
  } catch {
    return { filter: 'next7', cols: ['title', 'start', 'end', 'category'] };
  }
}

export function Unifinder({ viewRange, onClose }: { viewRange: { from: string; to: string }; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const ctx = useCal();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: 'start', desc: false });

  useEffect(() => {
    const id = window.setTimeout(() => setQ(input.trim()), 250);
    return () => window.clearTimeout(id);
  }, [input]);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(prefs));
    } catch {
      // 저장하지 못해도 이번 화면에는 그대로 쓴다
    }
  }, [prefs]);

  const today = ctx.today;
  const range = useMemo((): { from: string; to: string } | null => {
    switch (prefs.filter) {
      case 'today':
        return { from: today, to: addDays(today, 1) };
      case 'next7':
        return { from: today, to: addDays(today, 7) };
      case 'next14':
        return { from: today, to: addDays(today, 14) };
      case 'next31':
        return { from: today, to: addDays(today, 31) };
      case 'thisMonth':
        return { from: startOfMonth(today), to: addMonths(startOfMonth(today), 1) };
      case 'view':
        return viewRange;
      default:
        return null;
    }
  }, [prefs.filter, today, viewRange]);

  const series = prefs.filter === 'all' || prefs.filter === 'future';
  const rangeQuery = useRange(range?.from ?? today, range?.to ?? today, q, !series);
  const seriesQuery = useSeries(q, prefs.filter === 'future' ? nowIn(ctx.boot.settings.timezone) : null, series);
  const source = (series ? seriesQuery.data : rangeQuery.data) ?? [];

  const rows = useMemo(() => {
    const list = source.filter((o) => o.type === 'E' && ctx.calendarById.get(o.calendarId)?.visible);
    const value = (o: Occurrence): string => {
      switch (sort.col) {
        case 'title':
          return o.title.toLowerCase();
        case 'end':
          return o.end;
        case 'category':
          return o.categories.join(',');
        case 'location':
          return o.location ?? '';
        case 'calendar':
          return ctx.calendarById.get(o.calendarId)?.name ?? '';
        case 'status':
          return o.status ?? '';
        default:
          return o.start;
      }
    };
    return list.sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (sort.desc ? -1 : 1));
  }, [source, sort, ctx.calendarById]);

  const statusLabel = (s: string | null) =>
    s === 'TENTATIVE' ? t('cal.st.tentative') : s === 'CONFIRMED' ? t('cal.st.confirmed') : s === 'CANCELLED' ? t('cal.st.cancelled') : '';
  const cell = (o: Occurrence, col: Col) => {
    switch (col) {
      case 'title':
        return o.title;
      case 'start':
        return fmtDateTime(locale, o.start);
      case 'end':
        return fmtDateTime(locale, o.allDay && isDateOnly(o.end) ? addDays(o.end, -1) : o.end);
      case 'category':
        return o.categories.join(', ');
      case 'location':
        return o.location ?? '';
      case 'calendar':
        return ctx.calendarById.get(o.calendarId)?.name ?? '';
      case 'status':
        return statusLabel(o.status);
    }
  };

  return (
    <div className="cal-uf">
      <div className="cal-uf-bar">
        <select value={prefs.filter} onChange={(e) => setPrefs({ ...prefs, filter: e.target.value as UnifinderFilter })}>
          {FILTERS.map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
        <span className="hint">{t('cal.uf.contains')}</span>
        <input
          type="search"
          value={input}
          placeholder={t('cal.uf.searchPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1 }}
        />
        <Menu
          label="▦"
          title={t('cal.uf.columns')}
          buttonClassName="tb icon"
          align="right"
          items={COLS.map(([col, label]) => ({
            label: (
              <>
                <span className="menu-mark">{prefs.cols.includes(col) ? '✓' : ''}</span>
                {t(label)}
              </>
            ),
            onClick: () =>
              setPrefs({
                ...prefs,
                cols: prefs.cols.includes(col) ? (prefs.cols.length > 1 ? prefs.cols.filter((c) => c !== col) : prefs.cols) : COLS.map(([c]) => c).filter((c) => c === col || prefs.cols.includes(c)),
              }),
          }))}
        />
        <button className="cal-icon-btn" title={t('common.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="cal-uf-table">
        <table className="grid">
          <thead>
            <tr>
              {prefs.cols.map((col) => (
                <th
                  key={col}
                  onClick={() => setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: false }))}
                  className="sortable"
                >
                  {t(COLS.find(([c]) => c === col)![1])}
                  {sort.col === col ? (sort.desc ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                className={`${ctx.selectedId === o.id ? 'selected' : ''} ${o.status === 'CANCELLED' ? 'struck' : ''}`}
                onClick={() => {
                  ctx.actions.select(o);
                  ctx.actions.goToDate(o.start.slice(0, 10));
                }}
                onDoubleClick={() => ctx.actions.openOccurrence(o)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  ctx.actions.select(o);
                  ctx.actions.occurrenceMenu(e, o);
                }}
              >
                {prefs.cols.map((col) => (
                  <td key={col}>
                    {col === 'title' && <span className="cal-dot" style={{ background: ctx.calendarById.get(o.calendarId)?.color }} />}
                    {cell(o, col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="hint cal-uf-empty">{t('cal.uf.empty')}</div>}
      </div>
    </div>
  );
}
