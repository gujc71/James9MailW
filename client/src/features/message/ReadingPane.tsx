/**
 * 읽기 패널 (USR-1.3). 원문 파싱 → sandbox iframe 본문 + 첨부 다운로드 + 약속메일 응답.
 * 툴바: 답장 · 전체답장 · 전달(▾ 원본 eml 첨부) · 삭제 · 완전삭제 · 스팸차단/해제 · [기타 ▾ — 이동·복사·PC 저장·원문보기]
 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MailboxRole, MessageDetail, MessageSummary } from '../../api/types';
import { useMessageBody } from './useMessageBody';
import { BodyViewer } from './BodyViewer';
import { VCardBox } from './VCardBox';
import { SourceDialog } from './SourceDialog';
import { ReceiptDetailModal } from '../receipts/Receipts';
import { formatBytes, formatFullDate, displayAddress } from '../../lib/format';
import { Menu } from '../common/Menu';
import { t, useT, type MessageKey } from '../../i18n';
import type { ComposeSeed } from '../compose/Compose';
import { buildQuote, bodyWithInlineImages, type Quote, type ReplyMode } from './quote';
import { showToast } from '../common/Toast';

/** 변환할 본문. 텍스트 파트가 없는 HTML 메일은 태그를 걷어 낸다 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n');
}

export type { ReplyMode };

interface Props {
  summary: MessageSummary;
  detail: MessageDetail | null;
  role: MailboxRole | null;
  /** 스팸차단 메뉴 노출 여부 (사용자 설정 > 수신거부 사용 시) */
  spamEnabled: boolean;
  /** 원문 인용문과 전달 첨부는 본문을 파싱한 이 화면이 만들어 넘긴다 (quote.ts) */
  onReply: (mode: ReplyMode, quote: Quote) => void;
  onDelete: (permanent: boolean) => void;
  onMove: () => void;
  onCopy: () => void;
  onSpam: (unmark: boolean) => void;
  /** ics 는 이 메일의 text/calendar 원문. 서버가 내 캘린더에 넣고 주최자에게 응답을 보낸다 */
  onCalendarResponse: (response: 'ACCEPT' | 'TENTATIVE' | 'DECLINE', ics: string) => void;
  /** 썬더버드 "이벤트로 변환 · 태스크로 변환" */
  onConvertToCalendar: (type: 'E' | 'T', title: string, description: string) => void;
  /** 수신확인 요청에 "읽었다" 고 회신한다 (feature-gap.md 4-4) */
  onReadReceipt: () => Promise<void>;
  onEditDraft: (seed: ComposeSeed) => void;
}

export function ReadingPane({
  summary,
  detail,
  role,
  spamEnabled,
  onReply,
  onDelete,
  onMove,
  onCopy,
  onSpam,
  onCalendarResponse,
  onConvertToCalendar,
  onReadReceipt,
  onEditDraft,
}: Props) {
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  /** 수신확인 회신을 제출하는 동안 버튼을 잠근다. 두 번 눌러도 회신은 한 통이다 */
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const { body, loading, error } = useMessageBody(summary.mailboxId, summary.uid, summary.mailId);

  // 원문을 받아 연 뒤 \Seen 을 세팅한다. 이 호출이 있어야 수신확인(READ_DATE)이 찍힌다 (2-15)
  useEffect(() => {
    if (body && !summary.flags.includes('\\Seen')) {
      void api
        .post('/api/messages/flags', {
          mailboxId: summary.mailboxId,
          uids: [summary.uid],
          add: ['\\Seen'],
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, summary.mailboxId, summary.uid]);

  const calendar = body?.mail.calendar;
  // iTIP 메서드 (RFC 5546). 메서드가 없는 .ics 는 그냥 일정 공유(PUBLISH)로 본다
  const calendarMethod = calendar ? (/^METHOD:\s*([A-Z-]+)/im.exec(calendar)?.[1]?.toUpperCase() ?? 'PUBLISH') : null;
  const [calDone, setCalDone] = useState(false);
  useEffect(() => {
    setCalDone(false);
    setShowReceipts(false);
  }, [summary.mailId]);

  async function applyItip(action: 'import' | 'reply' | 'cancel') {
    if (!calendar) return;
    try {
      await api.post('/api/calendar/itip', { ics: calendar, action });
      setCalDone(true);
      showToast(t('read.calDone'));
    } catch (cause) {
      showToast((cause as Error).message, 'error');
    }
  }
  const isSpamBox = role === 'Spam';
  const isTrash = role === 'Trash';
  const isDraft = role === 'Drafts';
  const downloadUrl = `/api/messages/${encodeURIComponent(summary.mailboxId)}/${summary.uid}/download`;

  const recipients = (type: string) =>
    (detail?.recipients ?? []).filter((r) => r.type === type).map((r) => r.address);

  function editDraft() {
    onEditDraft({
      // 알리아스로 쓰다 저장한 초안이면 그 From 으로 다시 연다. 목록에 없으면
      // 메일쓰기가 계정으로 되돌린다 (compose/Compose.tsx)
      fromAlias: summary.from ?? undefined,
      to: recipients('to').join(', '),
      cc: recipients('cc').join(', '),
      bcc: recipients('bcc').join(', '),
      subject: summary.subject ?? '',
      // 인라인 이미지는 data: 로 바꿔 넣는다. 발송할 때 서버가 다시 cid: 파트로 되돌린다
      html: body ? bodyWithInlineImages(body.mail) : '',
      draftMailboxId: summary.mailboxId,
      draftUid: summary.uid,
    });
  }

  /** 인용문·전달 첨부는 파싱한 원문에서 만든다. 본문을 받기 전에는 눌러도 빈 인용이 된다 */
  function reply(mode: ReplyMode) {
    if (!body) return;
    onReply(mode, buildQuote(mode, body.mail, summary.size));
  }

  const convertText = () => (body?.mail.text ?? (body?.mail.html ? htmlToText(body.mail.html) : '')).trim().slice(0, 20_000);
  const thisMailItems = [
    { label: t('read.convertEvent'), onClick: () => onConvertToCalendar('E', summary.subject ?? '', convertText()), disabled: !body },
    { label: t('read.convertTask'), onClick: () => onConvertToCalendar('T', summary.subject ?? '', convertText()), disabled: !body },
    { label: t('common.move'), onClick: onMove },
    { label: t('common.copy'), onClick: onCopy },
    { label: t('read.saveEml'), onClick: () => window.location.assign(downloadUrl) },
    { label: t('read.viewSource'), onClick: () => setShowSource(true) },
    ...(spamEnabled
      ? [
          {
            label: t(isSpamBox ? 'list.unmarkSpam' : 'list.markSpam'),
            onClick: () => onSpam(isSpamBox),
            danger: !isSpamBox,
          },
        ]
      : []),
  ];

  return (
    <div className="reading">
      <div className="reading-toolbar">
        {isDraft ? (
          <button className="primary" onClick={editDraft} disabled={!body}>
            {t('read.continueDraft')}
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => reply('reply')} disabled={!body}>
              {t('read.reply')}
            </button>
            <button className="btn" onClick={() => reply('replyAll')} disabled={!body}>
              {t('read.replyAll')}
            </button>
            <Menu
              label={`${t('read.forward')} ▾`}
              buttonClassName="tb"
              items={[
                { label: t('read.forwardWithAttach'), onClick: () => reply('forward'), disabled: !body },
                { label: t('read.forwardAsEml'), onClick: () => reply('forwardEml'), disabled: !body },
              ]}
            />
          </>
        )}
        {!isTrash && (
          <button className="danger" onClick={() => onDelete(false)}>
            {t('common.delete')}
          </button>
        )}
        <button className="danger" onClick={() => onDelete(true)}>
          {t('common.purge')}
        </button>
        {spamEnabled && (
          <button className="btn" onClick={() => onSpam(isSpamBox)}>
            {t(isSpamBox ? 'list.unmarkSpam' : 'list.markSpam')}
          </button>
        )}
        <Menu label={`${t('list.etc')} ▾`} buttonClassName="tb" items={thisMailItems} />
      </div>

      <h2 className="reading-subject">{summary.subject || t('common.noSubject')}</h2>
      <div className="reading-meta">
        <div>
          {t('common.from')}: {displayAddress(summary.fromDisplay, summary.from)}
          {/* 내가 보낸 메일이면 수신자별 읽음 현황 · 회수, 약속메일이면 응답도 (receipts/Receipts.tsx) */}
          {detail?.fromMe && (
            <button className="btn att-open" onClick={() => setShowReceipts(true)}>
              {t('read.receipts')}
            </button>
          )}
        </div>
        <div className="reading-meta-row">
          <span className="meta-to">{detail ? `${t('common.to')}: ${recipients('to').join(', ')}` : ''}</span>
          <span className="meta-date">
            {t('common.date')}: {formatFullDate(summary.sentAt ?? summary.receivedAt)}
          </span>
        </div>
        {detail && recipients('cc').length > 0 && (
          <div>
            {t('common.cc')}: {recipients('cc').join(', ')}
          </div>
        )}
      </div>

      {/*
        수신확인 요청(MDN) — 보낸 사람이 Disposition-Notification-To 를 붙여 보냈다 (4-4).
        상자를 띄울지는 서버가 정한다(내가 보낸 메일·요청 없는 메일에는 readReceipt 가 null).
        **자동으로 보내지 않는다.** 읽었다는 사실을 알리는 것은 사용자가 고를 일이다.
      */}
      {detail?.readReceipt && (
        <div className="mdn-box">
          {detail.readReceipt.sentAt ? (
            <span className="mdn-done">
              {t('read.mdnSent', { when: formatFullDate(detail.readReceipt.sentAt) })}
            </span>
          ) : (
            <>
              <span className="mdn-ask">
                {t('read.mdnAsk', { who: detail.readReceipt.requestedTo })}
              </span>
              <button
                className="btn"
                disabled={sendingReceipt}
                onClick={async () => {
                  setSendingReceipt(true);
                  try {
                    await onReadReceipt();
                  } finally {
                    setSendingReceipt(false);
                  }
                }}
              >
                {t('read.mdnSend')}
              </button>
            </>
          )}
        </div>
      )}

      {calendar && (
        <div className="calendar-box">
          <strong>{t('read.appointment')}</strong>
          <dl className="cal-fields">
            {appointmentFields(calendar).map(([key, value]) => (
              <div key={key}>
                <dt>{t(key)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {calendarMethod === 'REPLY' || calendarMethod === 'CANCEL' ? (
            <>
              <span className="hint">{t(calendarMethod === 'REPLY' ? 'read.calReplyNote' : 'read.calCancelNote')}</span>
              {calDone ? (
                <span className="cal-done">{t('read.calDone')}</span>
              ) : (
                <div className="cal-actions">
                  <button onClick={() => void applyItip(calendarMethod === 'REPLY' ? 'reply' : 'cancel')}>
                    {t(calendarMethod === 'REPLY' ? 'read.calApplyReply' : 'read.calApplyCancel')}
                  </button>
                </div>
              )}
            </>
          ) : calendarMethod === 'REQUEST' ? (
            // 내가 보낸 초대에는 응답할 일이 없다. 상세를 받기 전에는 누구 메일인지 모르니 버튼을 미룬다
            !detail || detail.fromMe ? null : (
            <>
              {detail?.calendarResponse ? (
                <span className="cal-done">{t('read.responded', { answer: responseLabel(detail.calendarResponse) })}</span>
              ) : (
                <div className="cal-actions">
                  <button onClick={() => onCalendarResponse('ACCEPT', calendar)}>{t('read.accept')}</button>
                  <button onClick={() => onCalendarResponse('TENTATIVE', calendar)}>{t('read.tentative')}</button>
                  <button onClick={() => onCalendarResponse('DECLINE', calendar)}>{t('read.decline')}</button>
                </div>
              )}
              <span className="hint">{t('read.addToCalendar')}</span>
            </>
            )
          ) : calDone ? (
            <span className="cal-done">{t('read.calDone')}</span>
          ) : (
            <div className="cal-actions">
              <button onClick={() => void applyItip('import')}>{t('read.calImport')}</button>
            </div>
          )}
        </div>
      )}

      {loading && <div className="reading-status">{t('read.parsing')}</div>}
      {error && <div className="error">{error}</div>}

      {body && (
        <>
          {body.mail.warnings.map((warning, index) => (
            <div key={index} className="warn">
              {t(warning as MessageKey)}
            </div>
          ))}

          {(detail?.largeAttachments.length || body.attachmentUrls.length) ? (
            <div className="attachments">
              <strong>{t('read.attachments')}</strong>
              <ul>
                {body.attachmentUrls.map((attachment, index) => (
                  <li key={index}>
                    {/* blob: 첨부는 다운로드만 허용한다. 새 탭으로 열지 않는다 (2-3) */}
                    <a href={attachment.url} download={attachment.filename}>
                      {attachment.filename}
                    </a>
                    <span className="size">{formatBytes(attachment.size)}</span>
                    <a className="link" href={attachment.url} download={attachment.filename}>
                      {t('read.savePc')}
                    </a>
                  </li>
                ))}
                {detail?.largeAttachments.map((attachment) => (
                  <li key={attachment.attachId}>
                    <a href={`/large/${attachment.attachId}`}>{attachment.fileName}</a>
                    <span className="size">
                      {formatBytes(attachment.fileSize)} · {t('read.large')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <BodyViewer mail={body.mail} cidUrls={body.cidUrls} />

          {/* v-Card 는 .vcf 첨부 대신 본문 아래에 연락처로 펼친다 (useMessageBody.ts 에서 첨부 목록에서 뺐다) */}
          <VCardBox contacts={body.mail.vcards} />
        </>
      )}

      {showSource && (
        <SourceDialog
          mailboxId={summary.mailboxId}
          uid={summary.uid}
          mailId={summary.mailId}
          downloadUrl={downloadUrl}
          onClose={() => setShowSource(false)}
        />
      )}
      {showReceipts && (
        <ReceiptDetailModal
          mailId={summary.mailId}
          subject={summary.subject}
          sentAt={summary.sentAt ?? summary.receivedAt}
          calendarOf={calendarMethod === 'REQUEST' ? { mailboxId: summary.mailboxId, uid: summary.uid } : undefined}
          onClose={() => setShowReceipts(false)}
        />
      )}
    </div>
  );
}

function responseLabel(value: string): string {
  if (value === 'ACCEPT') return t('read.accept');
  if (value === 'TENTATIVE') return t('read.tentative');
  if (value === 'DECLINE') return t('read.decline');
  return value;
}

/**
 * 약속 상자에 내걸 항목 — 일시 · 장소 · 내용을 모두 보여 준다 (USR-1.3).
 * 일정 파트는 첨부 목록에서 빼기 때문에(useMessageBody.ts) 여기에 없으면 볼 곳이 없다.
 */
function appointmentFields(ics: string): [MessageKey, string][] {
  const event = parseEvent(ics);
  const fields: [MessageKey, string][] = [];
  if (event.when) fields.push(['read.apptWhen', event.when]);
  if (event.location) fields.push(['read.apptWhere', event.location]);
  // DESCRIPTION 이 쓰기 화면의 "내용" 이다. 비어 있으면 SUMMARY(제목) 로라도 채운다
  const what = event.description ?? event.summary;
  if (what) fields.push(['read.apptWhat', what]);
  return fields;
}

interface CalendarEvent {
  when: string | null;
  location: string | null;
  summary: string | null;
  description: string | null;
}

function parseEvent(ics: string): CalendarEvent {
  // 접힌 줄(RFC 5545 3.1 — 줄바꿈 + 공백)을 먼저 편다. 긴 DESCRIPTION 이 토막 나 있다
  // VTIMEZONE 에도 DTSTART(19700101…) 가 있으므로 일정 블록(VEVENT/VTODO) 안에서만 찾는다
  const whole = ics.replace(/\r?\n[ \t]/g, '');
  const unfolded = /BEGIN:(VEVENT|VTODO)[\s\S]*?END:\1/.exec(whole)?.[0] ?? whole;
  const prop = (name: string) => {
    // DTSTART;TZID=Asia/Seoul:… 처럼 파라미터가 붙을 수 있다. 값은 첫 콜론 뒤부터
    const m = unfolded.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:([^\\r\\n]*)`, 'm'));
    if (!m) return null;
    const value = m[1]!.trim().replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    return value || null;
  };
  const start = stampToLocal(prop('DTSTART'));
  const end = stampToLocal(prop('DTEND'));
  let when = start;
  // 같은 날 끝나면 끝은 시각만 붙인다 — "2026-10-01 14:00 ~ 15:00"
  if (start && end) {
    const sameDay = end.slice(0, 10) === start.slice(0, 10);
    when = `${start} ~ ${sameDay ? end.slice(11) || end : end}`;
  }
  return { when, location: prop('LOCATION'), summary: prop('SUMMARY'), description: prop('DESCRIPTION') };
}

/**
 * iCalendar 시각을 화면 표기로 바꾼다.
 * 끝에 Z 가 붙은 UTC 는 **보는 사람의 시간대로 되돌린다** — 우리가 보내는 초대가 UTC 로
 * 실려 나가므로(server/src/mime/build.ts) 적힌 대로 찍으면 한국에서 9시간 이른 시각이 뜬다.
 * TZID 만 달린 값과 시간대 없는 값은 적힌 그대로 본다.
 */
function stampToLocal(stamp: string | null): string | null {
  if (!stamp) return null;
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:\d{2})?(Z)?)?/);
  if (!m) return stamp;
  const [, year, month, day, hour, minute, utc] = m;
  if (!hour) return `${year}-${month}-${day}`;
  if (utc) {
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
    if (!Number.isNaN(date.getTime())) {
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours(),
      )}:${pad(date.getMinutes())}`;
    }
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
