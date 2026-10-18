/** 약속메일 팝업 (USR-1.4.2). 일시 · 장소 · 내용을 받아 iCalendar(.ics) 로 발송한다 */
import { useState } from 'react';
import { Modal } from '../common/Modal';
import { useT } from '../../i18n';

export interface Appointment {
  /** ISO 문자열 */
  start: string;
  end: string;
  location: string;
  description: string;
}

function toLocalInput(iso: string | undefined, fallbackOffsetMin: number): string {
  const date = iso ? new Date(iso) : new Date(Date.now() + fallbackOffsetMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function AppointmentDialog({
  value,
  onSave,
  onClose,
}: {
  value: Appointment | null;
  onSave: (appointment: Appointment) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [start, setStart] = useState(toLocalInput(value?.start, 60));
  const [end, setEnd] = useState(toLocalInput(value?.end, 120));
  const [location, setLocation] = useState(value?.location ?? '');
  const [description, setDescription] = useState(value?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  function save() {
    const s = new Date(start);
    const e = new Date(end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      setError(t('appointment.needTime'));
      return;
    }
    if (e <= s) {
      setError(t('appointment.endAfterStart'));
      return;
    }
    onSave({ start: s.toISOString(), end: e.toISOString(), location, description });
  }

  return (
    <Modal
      title={t('appointment.title')}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="primary" onClick={save}>
            {t('common.confirm')}
          </button>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('appointment.start')}</label>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('appointment.end')}</label>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('appointment.location')}</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('appointment.locationPlaceholder')} />
      </div>
      <div className="form-row">
        <label>{t('appointment.description')}</label>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <p className="hint">{t('appointment.hint')}</p>
    </Modal>
  );
}
