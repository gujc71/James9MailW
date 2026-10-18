/**
 * 일정 알림 창 (썬더버드 "알림" 창). 로그인한 동안 어느 화면에 있든 1분마다 서버에 물어본다.
 * 회차마다 다시 알림(5분 ~ 1주) · 닫기, 한꺼번에 다시 알림 · 모두 닫기. 소리 · 데스크톱 알림은 설정을 따른다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '../common/Modal';
import { useLocale, useT } from '../../i18n';
import { goTo } from '../../lib/hashRoute';
import { calApi, useBootstrap } from './api';
import { focusCalendarOn } from './bridge';
import type { DueAlarm } from './types';
import { fmtDateTime } from './wall';

const POLL_MS = 60_000;
const SNOOZE = [5, 10, 15, 30, 60, 120, 1440, 10080];

/** 짧은 두 음. 오디오 파일을 따로 두지 않는다 */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audio = new Ctx();
    [0, 0.25].forEach((at, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = i ? 660 : 880;
      gain.gain.setValueAtTime(0.15, audio.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + at + 0.22);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + at);
      osc.stop(audio.currentTime + at + 0.25);
    });
    window.setTimeout(() => void audio.close(), 800);
  } catch {
    // 소리를 낼 수 없는 환경이면 조용히 넘어간다
  }
}

const keyOf = (a: { alarmId: number; occurrence: string }) => `${a.alarmId}|${a.occurrence}`;

export function AlarmHost() {
  const t = useT();
  const locale = useLocale();
  const { data: boot } = useBootstrap();
  const client = useQueryClient();
  const [alarms, setAlarms] = useState<DueAlarm[]>([]);
  const seen = useRef(new Set<string>());
  const settings = boot?.settings;

  const poll = useCallback(async () => {
    try {
      const due = await calApi.alarms();
      setAlarms(due);
      const fresh = due.filter((a) => !seen.current.has(keyOf(a)));
      fresh.forEach((a) => seen.current.add(keyOf(a)));
      if (!fresh.length) return;
      if (settings?.alarmSound !== false) beep();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        for (const a of fresh.slice(0, 3)) {
          const n = new Notification(a.title || t('cal.newEventTitle'), {
            body: a.start ? fmtDateTime(locale, a.start) : '',
            tag: `j9-cal-${keyOf(a)}`,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        }
      }
    } catch {
      // 끊긴 동안은 다음 차례에 다시 묻는다
    }
  }, [settings?.alarmSound, t, locale]);

  useEffect(() => {
    if (!boot) return;
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    const visible = () => !document.hidden && void poll();
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [boot, poll]);

  // 캘린더에서 고치면 알림도 바뀐다 (지운 일정의 알림이 남지 않도록)
  useEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] === 'cal' && event.query.queryKey[1] === 'occ' && event.action.type === 'success') {
        void poll();
      }
    });
    return unsubscribe;
  }, [client, poll]);

  async function snooze(list: DueAlarm[], minutes: number) {
    setAlarms((prev) => prev.filter((a) => !list.some((x) => keyOf(x) === keyOf(a))));
    list.forEach((a) => seen.current.delete(keyOf(a)));
    await calApi.snooze(list.map(({ alarmId, occurrence }) => ({ alarmId, occurrence })), minutes).catch(() => undefined);
  }

  async function dismiss(list: DueAlarm[]) {
    setAlarms((prev) => prev.filter((a) => !list.some((x) => keyOf(x) === keyOf(a))));
    await calApi.dismiss(list.map(({ alarmId, occurrence }) => ({ alarmId, occurrence }))).catch(() => undefined);
  }

  if (!alarms.length || settings?.alarmPopup === false) return null;
  const snoozeLabel = (m: number) =>
    m < 60 ? t('cal.alarm.snoozeMin', { n: m }) : m < 1440 ? t('cal.alarm.snoozeHour', { n: m / 60 }) : m < 10080 ? t('cal.alarm.snoozeDay', { n: m / 1440 }) : t('cal.alarm.snoozeWeek');

  return (
    <Modal
      title={t('cal.alarm.title', { n: alarms.length })}
      onClose={() => void snooze(alarms, 5)}
      width={520}
      className="cal-alarm-dialog"
      footer={
        <>
          <select
            value=""
            onChange={(e) => e.target.value && void snooze(alarms, Number(e.target.value))}
            style={{ marginRight: 'auto' }}
          >
            <option value="">{t('cal.alarm.snoozeAll')}</option>
            {SNOOZE.map((m) => (
              <option key={m} value={m}>
                {snoozeLabel(m)}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => void dismiss(alarms)}>
            {t('cal.alarm.dismissAll')}
          </button>
        </>
      }
    >
      <ul className="cal-alarm-list">
        {alarms.map((a) => (
          <li key={keyOf(a)}>
            <div className="cal-alarm-main">
              <button
                className="link cal-alarm-title"
                onClick={() => {
                  if (a.start) focusCalendarOn(a.start.slice(0, 10), a.itemId);
                  goTo('calendar', a.type === 'T' ? 'tasks' : null);
                }}
              >
                {a.type === 'T' ? '☑ ' : ''}
                {a.title || t('cal.newEventTitle')}
              </button>
              <span className="hint">
                {a.start ? fmtDateTime(locale, a.start) : ''}
                {a.location ? ` · ${a.location}` : ''}
              </span>
            </div>
            <select value="" onChange={(e) => e.target.value && void snooze([a], Number(e.target.value))}>
              <option value="">{t('cal.alarm.snooze')}</option>
              {SNOOZE.map((m) => (
                <option key={m} value={m}>
                  {snoozeLabel(m)}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => void dismiss([a])}>
              {t('cal.alarm.dismiss')}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

