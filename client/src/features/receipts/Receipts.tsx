/**
 * 수신확인 (USR-2). 내가 보낸 메일의 수신자별 읽음 현황 · 회수 · 전체회수.
 * 메일 읽기 화면의 "수신 확인" 버튼이 연다 (features/message/ReadingPane.tsx).
 *
 * 수신확인과 회수는 내부 계정 수신자에게만 통한다. 외부 도메인 수신자는 읽었는지 알 수 없고
 * 회수도 못 하므로 "확인 불가" 로 드러내 보여 준다 — 조용히 빼면 0/0 이 "아무도 안 읽음" 으로
 * 읽힌다 (feature-gap.md 4-4).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { displayAddress, formatFullDate } from '../../lib/format';
import { Modal } from '../common/Modal';
import { useT, type MessageKey } from '../../i18n';

interface ReceiptDetail {
  recipient: string;
  /** 메일 헤더에 적힌 표시이름. 없으면 null */
  name: string | null;
  readDate: string | null;
  /** false 면 외부 도메인이라 읽음 여부를 알 수 없다 */
  tracked: boolean;
  recallable: boolean;
}

/** 약속메일 수신자별 응답 (server/src/services/calendarAttendance.ts) */
interface AttendanceRow {
  recipient: string;
  response: 'ACCEPT' | 'TENTATIVE' | 'DECLINE' | null;
  respondedAt: string | null;
}

const RESPONSE_LABEL: Record<NonNullable<AttendanceRow['response']>, MessageKey> = {
  ACCEPT: 'read.accept',
  TENTATIVE: 'read.tentative',
  DECLINE: 'read.decline',
};

export function ReceiptDetailModal({
  mailId,
  subject,
  sentAt,
  calendarOf,
  onClose,
}: {
  /** 연 메일의 MAIL_ID. "내게도 발송" 사본이면 서버가 Sent 사본으로 거슬러 찾는다 */
  mailId: string;
  subject: string | null;
  sentAt: string | null;
  /** 약속메일(METHOD:REQUEST)이면 그 메일 위치. 주면 수신자별 응답 칸이 붙는다 */
  calendarOf?: { mailboxId: string; uid: number };
  onClose: () => void;
}) {
  const t = useT();
  const [details, setDetails] = useState<ReceiptDetail[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .get<ReceiptDetail[]>(`/api/receipts/${encodeURIComponent(mailId)}`)
        .then(setDetails)
        .catch((cause) => setMsg(cause instanceof ApiError ? cause.message : t('common.queryFailed'))),
    [mailId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  /** 소문자 주소 → 응답. 약속메일이 아니면 null */
  const [attendance, setAttendance] = useState<Map<string, AttendanceRow> | null>(null);
  useEffect(() => {
    if (!calendarOf) return;
    api
      .get<AttendanceRow[]>(
        `/api/messages/${encodeURIComponent(calendarOf.mailboxId)}/${calendarOf.uid}/calendar-attendance`,
      )
      .then((rows) => setAttendance(new Map(rows.map((row) => [row.recipient.toLowerCase(), row]))))
      .catch((cause) => setMsg(cause instanceof ApiError ? cause.message : t('common.queryFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarOf?.mailboxId, calendarOf?.uid]);
  const countResponse = (response: AttendanceRow['response']) =>
    attendance ? [...attendance.values()].filter((row) => row.response === response).length : 0;

  async function recall(all: boolean) {
    const targets = all ? undefined : [...selected];
    if (!all && (!targets || targets.length === 0)) return;
    if (!confirm(t(all ? 'receipts.confirmRecallAll' : 'receipts.confirmRecall'))) return;
    setMsg(null);
    try {
      const res = await api.post<{ recalled: number }>(`/api/receipts/${encodeURIComponent(mailId)}/recall`, {
        all,
        recipients: targets,
      });
      setMsg(t('receipts.recalled', { n: res.recalled }));
      setSelected(new Set());
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('receipts.recallFailed'));
    }
  }

  function responseCell(row: AttendanceRow | undefined) {
    if (!attendance) return '';
    // 나 자신(내게도 발송)은 응답 대상이 아니다
    if (!row) return '-';
    if (!row.response) return <span className="hint">{t('read.attNone')}</span>;
    return (
      <span className={`att-${row.response.toLowerCase()}`}>
        {t(RESPONSE_LABEL[row.response])}
        {row.respondedAt && <span className="hint"> · {formatFullDate(row.respondedAt)}</span>}
      </span>
    );
  }

  const recallableCount = details?.filter((d) => d.recallable).length ?? 0;
  const untrackedCount = details?.filter((d) => !d.tracked).length ?? 0;

  return (
    <Modal
      title={t('receipts.title')}
      onClose={onClose}
      width={calendarOf ? 600 : 480}
      footer={
        <>
          <button className="primary" disabled={selected.size === 0} onClick={() => recall(false)}>
            {t('receipts.recall')}
          </button>
          <button className="btn" disabled={recallableCount === 0} onClick={() => recall(true)}>
            {t('receipts.recallAll')}
          </button>
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      <p>
        <strong>{subject || t('common.noSubject')}</strong>
        <span className="hint"> · {formatFullDate(sentAt)}</span>
      </p>
      {attendance && (
        <p className="hint">
          {t('read.attSummary', {
            accept: countResponse('ACCEPT'),
            tentative: countResponse('TENTATIVE'),
            decline: countResponse('DECLINE'),
            none: countResponse(null),
          })}
        </p>
      )}
      {!details && <div className="list-status">{t('common.loading')}</div>}
      {details && (
        <table className="grid">
          <thead>
            <tr>
              <th></th>
              <th>{t('common.to')}</th>
              <th>{t('receipts.readDate')}</th>
              {calendarOf && <th>{t('read.attResponse')}</th>}
            </tr>
          </thead>
          <tbody>
            {details.map((d) => (
              <tr key={d.recipient}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!d.recallable}
                    title={
                      !d.tracked
                        ? t('receipts.cannotRecallExternal')
                        : d.readDate
                          ? t('receipts.cannotRecall')
                          : undefined
                    }
                    checked={selected.has(d.recipient)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        next.has(d.recipient) ? next.delete(d.recipient) : next.add(d.recipient);
                        return next;
                      })
                    }
                  />
                </td>
                <td>{displayAddress(d.name, d.recipient)}</td>
                <td>
                  {!d.tracked ? (
                    <span className="hint">{t('receipts.untracked')}</span>
                  ) : d.readDate ? (
                    formatFullDate(d.readDate)
                  ) : (
                    '-'
                  )}
                </td>
                {calendarOf && <td>{responseCell(attendance?.get(d.recipient.toLowerCase()))}</td>}
              </tr>
            ))}
            {details.length === 0 && (
              <tr>
                <td colSpan={calendarOf ? 4 : 3} className="hint">
                  {t('receipts.noInternal')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {untrackedCount > 0 && <div className="hint">{t('receipts.untrackedNote', { n: untrackedCount })}</div>}
      {msg && <div className="info">{msg}</div>}
    </Modal>
  );
}
