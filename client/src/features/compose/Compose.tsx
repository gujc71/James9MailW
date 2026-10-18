/**
 * 메일쓰기 (USR-1.4). 브라우저는 입력값만 multipart 로 보낸다.
 * 첨부는 일반/대용량으로 나뉜다. 대용량은 먼저 업로드해 ATTACH_ID 를 받는다 (USR-1.4.1).
 *  - 주소록 팝업(POPUP-3) · 최근 발송 주소 10개 ▼ · +참조/숨은참조
 *  - <약속> → iCalendar 약속메일 (USR-1.4.2)
 *  - 파일 드래그앤드롭 · 대용량 일괄 전환 · 미리보기 · 임시저장 이어쓰기
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { Me, SendableAlias, SendOutcome, Signature, SiteConfig, UserSetting } from '../../api/types';
import { formatBytes, formatFullDate, formatListDate, displayAddress } from '../../lib/format';
import { AddressBook, formatContact } from '../common/AddressBook';
import { Menu } from '../common/Menu';
import { showToast } from '../common/Toast';
import { useDragMove } from '../common/useDragMove';
import { useEscapeClose } from '../common/useEscapeClose';
import { AppointmentDialog, type Appointment } from './AppointmentDialog';
import { HtmlEditor, type HtmlEditorHandle } from './editor/HtmlEditor';
import { Preview } from './Preview';
import { RecipientInput, useRecipients, parseAddresses, type AddressField } from './RecipientInput';
import {
  bodyText,
  clearComposeDraft,
  loadComposeDraft,
  saveComposeDraft,
  type SaveResult,
  type StoredDraft,
} from './draftStore';
import { useT } from '../../i18n';

/** 자동 저장 주기. localStorage 라 서버를 부르지 않으므로 짧게 잡는다 */
const AUTOSAVE_MS = 5000;

export interface ComposeSeed {
  /** 알리아스로 보낼 때의 From 주소. 목록에 없는 값이면 무시하고 계정으로 돌아간다 (4-3) */
  fromAlias?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  html?: string;
  inReplyTo?: string;
  forwardOf?: string;
  forwardAsEml?: boolean;
  /** 전달(첨부 포함)로 넘어온 원본 첨부. 읽기 화면이 파싱해 File 로 되살린 것이다 (message/quote.ts) */
  attachments?: File[];
  /**
   * 원본 eml 전달일 때 첨부칸에 보여 줄 원본 메일의 이름·크기.
   * 파일은 서버가 원문에서 바로 붙이므로 브라우저가 올리지 않는다 — 보여주기용이다.
   */
  emlAttachment?: { filename: string; size: number };
  /** 임시 보관함에서 이어 쓰는 경우 (발송·재저장 시 이전 draft 를 지운다) */
  draftMailboxId?: string;
  draftUid?: number;
  // 아래 다섯은 자동 저장 복원용이다. 주지 않으면 화면 기본값·설정값을 따른다 (draftStore.ts)
  important?: boolean;
  sendToSelf?: boolean;
  individual?: boolean;
  readReceipt?: boolean;
  vcardYn?: boolean;
  signatureId?: number | null;
}

interface LocalAttachment {
  file: File;
  large: boolean;
  attachId?: string;
}

export function Compose({
  me,
  seed,
  onClose,
  onSent,
  onRestore,
}: {
  me: Me;
  seed: ComposeSeed;
  onClose: () => void;
  onSent: () => void;
  /** 자동 저장된 초안으로 메일쓰기를 다시 열어 달라는 요청 (App 이 key 를 갈아 새로 그린다) */
  onRestore?: (seed: ComposeSeed) => void;
}) {
  // 받는사람·참조·숨은참조는 블럭(칩) 목록 하나로 묶어 다룬다 (칸 사이 드래그 이동 때문)
  const t = useT();
  const rcp = useRecipients(seed, me.userName);
  const [showCcBcc, setShowCcBcc] = useState(Boolean(seed.cc || seed.bcc));
  const [subject, setSubject] = useState(seed.subject ?? '');
  // 본문 HTML 의 원본은 에디터가 쥐고 있다. 이 state 는 미리보기처럼 화면에 다시 그릴 때 쓰는
  // 사본이라 잠깐 뒤처질 수 있으므로, 보낼 때는 bodyRef 에서 그 순간의 값을 읽는다.
  const [html, setHtml] = useState(seed.html ?? '');
  const bodyRef = useRef<HtmlEditorHandle>(null);
  const currentHtml = () => bodyRef.current?.getHtml() ?? html;
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  // 원본 eml 첨부는 서버가 붙이므로 목록이 아니라 붙였는지 여부만 들고 있다.
  // 지우면 forwardAsEml 을 떼어 보내 원본이 안 붙는다 — 보이는 대로 나가야 한다
  const [emlAttached, setEmlAttached] = useState(Boolean(seed.forwardAsEml && seed.emlAttachment));
  // 원본 메일이 붙어 있으면 접힌 채로 두지 않는다. 붙은 걸 모르고 보내면 안 된다
  const [showAttachList, setShowAttachList] = useState(Boolean(seed.emlAttachment));
  const [important, setImportant] = useState(seed.important ?? false);
  const [sendToSelf, setSendToSelf] = useState(seed.sendToSelf ?? false);
  const [individual, setIndividual] = useState(seed.individual ?? false);
  const [readReceipt, setReadReceipt] = useState(seed.readReceipt ?? false);
  const [signatureId, setSignatureId] = useState<number | ''>(seed.signatureId ?? '');
  const [vcardYn, setVcardYn] = useState(seed.vcardYn ?? false);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  /**
   * 보내는사람 후보. me(로그인 시점)로 먼저 그리고, 메일쓰기를 열며 받은 값으로 갈아 끼운다.
   * 관리자가 알리아스를 중지하거나 대상에서 빼도 탭을 열어 둔 사용자에게는 me 쪽이 그대로
   * 남아 있기 때문이다 — 중지된 알리아스가 선택지로 보이면 고르는 순간 발송이 거절된다.
   */
  const [aliases, setAliases] = useState<SendableAlias[]>(me.aliases);
  // '' 은 로그인 계정이다. seed 로 온 값이라도 목록에 없으면 계정으로 되돌린다
  const [fromAlias, setFromAlias] = useState(
    () => me.aliases.find((a) => a.address.toLowerCase() === (seed.fromAlias ?? '').toLowerCase())?.address ?? '',
  );

  const [site, setSite] = useState<SiteConfig | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [setting, setSetting] = useState<UserSetting | null>(null);
  const [recent, setRecent] = useState<{ contactName: string | null; mailAddress: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendOutcome | null>(null);
  const [dragging, setDragging] = useState(false);

  const [addressBookFor, setAddressBookFor] = useState<AddressField | null>(null);
  const [appointmentOpen, setAppointmentOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    void api
      .get<{
        signatures: Signature[];
        recent: { contactName: string | null; mailAddress: string }[];
        site: SiteConfig;
        setting: UserSetting;
        aliases: SendableAlias[];
      }>(
        '/api/compose/context',
      )
      .then((ctx) => {
        setSite(ctx.site);
        setAliases(ctx.aliases);
        // 고른 알리아스가 그 사이 중지·제외됐으면 계정으로 되돌린다. 남겨 두면 보낼 수 없는
        // 주소를 고른 채로 [보내기] 를 눌러 400 을 보게 된다
        setFromAlias((cur) => (cur && !ctx.aliases.some((a) => a.address === cur) ? '' : cur));
        setSignatures(ctx.signatures);
        setSetting(ctx.setting);
        setRecent(ctx.recent);
        // 서명 사용 설정에 따라 기본 서명을 미리 고른다 (USR-17 연계)
        const usable = ctx.setting.personalSignYn ? ctx.signatures : [];
        // 복원해 온 서명이 그 사이 지워졌거나 사용이 꺼졌으면 놓는다 — 그대로 두면 보낼 때 400
        setSignatureId((cur) => (cur !== '' && !usable.some((s) => s.signatureId === cur) ? '' : cur));
        const def = usable.find((s) => s.isDefault);
        // 복원해 온 값이 있으면 기본값으로 덮지 않는다 (seed.signatureId · seed.vcardYn)
        if (def && seed.signatureId === undefined) setSignatureId(def.signatureId);
        if (seed.vcardYn === undefined) setVcardYn(ctx.setting.vcardYn);
      })
      .catch(() => undefined)
      // 첨부 한도(site)를 알고 나서 원본 첨부를 올려야 일반/대용량 구분이 맞는다
      .finally(() => setContextLoaded(true));
  }, []);

  // 전달(첨부 포함)로 넘어온 원본 첨부를 첨부칸에 한 번만 올린다. 한도는 addFiles 가 본다
  const seededAttachRef = useRef(false);
  useEffect(() => {
    if (!contextLoaded || seededAttachRef.current) return;
    seededAttachRef.current = true;
    if (seed.attachments?.length) addFiles(seed.attachments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextLoaded]);

  // ---------------------------------------------------------------- 자동 저장 (feature-gap.md 1-3)

  const [saved, setSaved] = useState<{ result: SaveResult; at: number } | null>(null);
  const [stored, setStored] = useState<StoredDraft | null>(null);

  /** 열었을 때의 값. 이것과 달라진 게 있으면 "쓰던 중" 으로 본다 */
  const baselineRef = useRef({
    to: parseAddresses(seed.to ?? '').join(', '),
    cc: parseAddresses(seed.cc ?? '').join(', '),
    bcc: parseAddresses(seed.bcc ?? '').join(', '),
    subject: seed.subject ?? '',
    body: bodyText(seed.html ?? ''),
    attachCount: seed.attachments?.length ?? 0,
  });

  /**
   * 발송 옵션(중요·내게도·개별발송…)은 견주지 않는다. 서명·vCard 는 서버 설정이 늦게 와서
   * 값이 한 번 바뀌므로, 그걸 "고쳤다" 로 세면 아무것도 안 했는데 경고가 뜬다.
   */
  function isDirty(): boolean {
    const base = baselineRef.current;
    return (
      rcp.to !== base.to ||
      rcp.cc !== base.cc ||
      rcp.bcc !== base.bcc ||
      subject !== base.subject ||
      attachments.length !== base.attachCount ||
      bodyText(currentHtml()) !== base.body
    );
  }

  function snapshot(): StoredDraft {
    return {
      savedAt: Date.now(),
      to: rcp.to,
      cc: rcp.cc,
      bcc: rcp.bcc,
      subject,
      html: currentHtml(),
      important,
      sendToSelf,
      individual,
      readReceipt,
      vcardYn,
      signatureId: signatureId === '' ? null : signatureId,
      fromAlias: fromAlias || undefined,
      inReplyTo: seed.inReplyTo,
      forwardOf: seed.forwardOf,
      forwardAsEml: seed.forwardAsEml && emlAttached ? true : undefined,
      draftMailboxId: seed.draftMailboxId,
      draftUid: seed.draftUid,
      emlAttachment: emlAttached ? seed.emlAttachment : undefined,
      // 파일 자체는 담지 못한다. 이름만 적어 복원할 때 알려 준다
      droppedAttachments: attachments.map((item) => item.file.name),
    };
  }

  /**
   * 한 번 서버에 남겼으면(발송·임시저장) 다시 저장하지 않는다.
   * 발송 결과 창이 떠 있는 동안에도 타이머는 계속 돌기 때문에, 이 표시가 없으면 방금 지운
   * 자동 저장분이 5초 뒤에 되살아난다.
   */
  const doneRef = useRef(false);

  /** 저장·판정은 타이머와 beforeunload 에서 부르므로 매 렌더마다 최신 것으로 갈아 둔다 */
  const autoSaveRef = useRef<() => void>(() => undefined);
  const dirtyRef = useRef<() => boolean>(() => false);
  autoSaveRef.current = () => setSaved({ result: saveComposeDraft(me.userName, snapshot()), at: Date.now() });
  dirtyRef.current = () => !doneRef.current && isDirty();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (dirtyRef.current()) autoSaveRef.current();
    }, AUTOSAVE_MS);

    // 탭을 닫거나 새로 고치면 한 번 더 저장하고 막아 세운다. 문구는 브라우저가 정한다
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current()) return;
      autoSaveRef.current();
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // 새 메일로 열었을 때만 복원을 권한다. 답장·전달·이어쓰기는 이미 제 내용이 들어 있다
  useEffect(() => {
    const seeded =
      seed.to || seed.cc || seed.bcc || seed.subject || seed.html || seed.inReplyTo || seed.forwardOf;
    if (!seeded) setStored(loadComposeDraft(me.userName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 자동 저장된 초안을 메일쓰기 입력값으로 되돌린다. 첨부는 살릴 수 없다 */
  function restore(draft: StoredDraft) {
    onRestore?.({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      inReplyTo: draft.inReplyTo,
      forwardOf: draft.forwardOf,
      forwardAsEml: draft.forwardAsEml,
      draftMailboxId: draft.draftMailboxId,
      draftUid: draft.draftUid,
      emlAttachment: draft.emlAttachment,
      important: draft.important,
      sendToSelf: draft.sendToSelf,
      individual: draft.individual,
      readReceipt: draft.readReceipt,
      vcardYn: draft.vcardYn,
      signatureId: draft.signatureId,
      fromAlias: draft.fromAlias,
    });
  }

  /** 발송·임시저장으로 내용이 서버에 남았으면 자동 저장분은 치운다 */
  function forgetAutoSaved() {
    doneRef.current = true;
    clearComposeDraft(me.userName);
    setSaved(null);
  }

  /** 닫기 전에 확인한다. 버리겠다고 해도 자동 저장분은 남겨 다시 열 때 복원할 수 있게 한다 */
  function requestClose() {
    if (dirtyRef.current()) {
      if (!confirm(t('compose.confirmClose'))) return;
      autoSaveRef.current();
    }
    onClose();
  }

  const generalBytes = attachments.filter((a) => !a.large).reduce((s, a) => s + a.file.size, 0);
  const largeBytes = attachments.filter((a) => a.large).reduce((s, a) => s + a.file.size, 0);

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const next: LocalAttachment[] = [...attachments];
    for (const file of Array.from(files)) {
      // 용량·개수 초과 시 대용량으로 자동 전환 (USR-1.4.1)
      const wouldExceed =
        !site ||
        next.filter((a) => !a.large).length >= site.attachMaxCount ||
        next.filter((a) => !a.large).reduce((s, a) => s + a.file.size, 0) + file.size > site.attachMaxSize;
      next.push({ file, large: wouldExceed });
    }
    setAttachments(next);
    setShowAttachList(true);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  }

  async function uploadLargeAttachments(): Promise<string[]> {
    const known = attachments.filter((a) => a.large && a.attachId).map((a) => a.attachId!);
    const pending = attachments.filter((a) => a.large && !a.attachId);
    if (pending.length === 0) return known;
    const form = new FormData();
    for (const item of pending) form.append('files', item.file, item.file.name);
    const uploaded = await api.form<{ attachments: { attachId: string }[] }>('/api/attachments/large', form);
    const ids = uploaded.attachments.map((a) => a.attachId);
    // 재시도 시 같은 파일을 다시 올리지 않도록 ID 를 붙여 둔다
    setAttachments((prev) => {
      let i = 0;
      return prev.map((a) => (a.large && !a.attachId ? { ...a, attachId: ids[i++] } : a));
    });
    return [...known, ...ids];
  }

  function buildForm(largeAttachIds: string[]): FormData {
    const form = new FormData();
    form.set('to', rcp.to);
    form.set('cc', rcp.cc);
    form.set('bcc', rcp.bcc);
    form.set('subject', subject);
    // 소유 확인은 서버가 한다. 목록에 없는 주소를 넣으면 발송이 거절된다 (4-3)
    if (fromAlias) form.set('fromAlias', fromAlias);
    form.set('html', currentHtml());
    form.set('important', String(important));
    form.set('sendToSelf', String(sendToSelf));
    form.set('individual', String(individual));
    form.set('readReceipt', String(readReceipt));
    form.set('vcardYn', String(vcardYn));
    if (signatureId) form.set('signatureId', String(signatureId));
    if (seed.inReplyTo) form.set('inReplyTo', seed.inReplyTo);
    if (seed.forwardOf) form.set('forwardOf', seed.forwardOf);
    // 첨부칸에서 "원본 메일" 을 지웠으면 원본을 붙이지 않는다
    if (seed.forwardAsEml && emlAttached) form.set('forwardAsEml', 'true');
    if (seed.draftMailboxId && seed.draftUid) {
      form.set('draftMailboxId', seed.draftMailboxId);
      form.set('draftUid', String(seed.draftUid));
    }
    if (appointment) form.set('appointment', JSON.stringify(appointment));
    form.set('largeAttachIds', JSON.stringify(largeAttachIds));
    for (const item of attachments.filter((a) => !a.large)) {
      form.append('attachments', item.file, item.file.name);
    }
    return form;
  }

  async function send() {
    // "내게도 발송"은 내 계정을 수신자(To)로 넣으므로 그 자체로 수신자 1명이다 (USR-1.4.2)
    if (rcp.isEmpty && !sendToSelf) {
      showToast(t('compose.needRecipient'), 'error');
      return;
    }
    setBusy(true);
    try {
      const largeAttachIds = await uploadLargeAttachments();
      const outcome = await api.form<SendOutcome>('/api/compose/send', buildForm(largeAttachIds));
      // 나갔으면 자동 저장분은 더 볼 일이 없다. 결과 창이 뜨는 동안에도 남겨 두지 않는다
      forgetAutoSaved();
      // 거부된 주소가 있으면 설정과 무관하게 반드시 보여준다. 조용히 닫으면 못 간 걸 모른다.
      if (
        setting?.sendConfirmYn ||
        outcome.rejected.length > 0 ||
        outcome.warnings.length > 0
      ) {
        setResult(outcome);
      } else onSent();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : t('compose.sendFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    try {
      const largeAttachIds = await uploadLargeAttachments();
      await api.form('/api/compose/draft', buildForm(largeAttachIds));
      // 임시 보관함에 남았으므로 로컬 사본은 치운다
      forgetAutoSaved();
      onSent();
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : t('compose.draftFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function pickAddresses(addresses: string[]) {
    const field = addressBookFor;
    setAddressBookFor(null);
    if (!field) return;
    rcp.add(field, addresses);
  }

  // ESC: 발송 결과 창이면 확인, 작성 창이면 X 와 같다
  useEscapeClose(() => (result ? onSent() : requestClose()));
  // 타이틀 행을 끌어 창을 옮긴다 (뒤의 목록·원본 메일을 보면서 쓸 수 있게)
  const { startDrag, style: dragStyle } = useDragMove();

  const recentItems = recent.map((entry) => ({
    label: formatContact(entry),
    onClick: () => rcp.add('to', [formatContact(entry)]),
  }));

  const selectedAlias = aliases.find((a) => a.address === fromAlias) ?? null;
  // 미리보기·발송 결과에 보여 줄 From. 실제 헤더는 서버가 같은 규칙으로 다시 만든다
  const fromLabel = selectedAlias
    ? displayAddress(selectedAlias.aliasName, selectedAlias.address)
    : displayAddress(me.displayName, me.userName);
  // 설정에서 서명을 "사용 안 함"으로 꺼 뒀으면 고르는 칸 자체를 내보내지 않는다 (USR-17)
  const usableSignatures = setting?.personalSignYn ? signatures : [];
  const selectedSignature = usableSignatures.find((s) => s.signatureId === signatureId) ?? null;

  if (result) {
    return (
      <div className="modal-backdrop">
        <div className="modal send-confirm">
          <h3>{t(result.delivered ? 'compose.sendResultTitle' : 'compose.sendFailedTitle')}</h3>
          <p>{t(result.delivered ? 'compose.sentOk' : 'compose.sentNone')}</p>
          {result.warnings.map((w, i) => (
            <p key={i} className="warn">
              {w}
            </p>
          ))}
          <div className="modal-actions">
            <button className="primary" onClick={onSent}>
              {t('common.confirm')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div
        className={`modal compose ${dragging ? 'dragging' : ''}`}
        style={dragStyle}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            if (!dragging) setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="modal-head" onMouseDown={startDrag}>
          <h3>{t('compose.title')}</h3>
          <button className="x" onClick={requestClose}>
            ✕
          </button>
        </div>
        <div className="compose-body">
          {stored && (
            <div className="restore-bar">
              <span>
                {t('compose.restoreTitle', { time: formatFullDate(new Date(stored.savedAt).toISOString()) })}
                {stored.droppedAttachments.length > 0 && (
                  <span className="hint">
                    {' '}
                    {t('compose.restoreNoAttach', { list: stored.droppedAttachments.join(', ') })}
                  </span>
                )}
              </span>
              <span className="restore-actions">
                <button type="button" className="btn" onClick={() => restore(stored)}>
                  {t('compose.restore')}
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => {
                    clearComposeDraft(me.userName);
                    setStored(null);
                  }}
                >
                  {t('common.delete')}
                </button>
              </span>
            </div>
          )}
          <div className="field">
            <span>{t('compose.from')}</span>
            {aliases.length === 0 ? (
              <div className="field-static">{fromLabel}</div>
            ) : (
              <select
                className="from-select"
                value={fromAlias}
                onChange={(e) => setFromAlias(e.target.value)}
                aria-label={t('compose.from')}
              >
                <option value="">{displayAddress(me.displayName, me.userName)}</option>
                {aliases.map((alias) => (
                  <option key={alias.address} value={alias.address}>
                    {displayAddress(alias.aliasName, alias.address)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <span className="field-label-add">
              {t('compose.to')}
              {!showCcBcc && (
                <button
                  type="button"
                  className="field-add"
                  title={t('compose.ccBcc')}
                  aria-label={t('compose.addCcBcc')}
                  onClick={() => setShowCcBcc(true)}
                >
                  +
                </button>
              )}
            </span>
            <RecipientInput ctl={rcp} field="to" placeholder={t('compose.toPlaceholder')} />
            {recent.length > 0 && (
              <Menu label="▼" items={recentItems} buttonClassName="tb" title={t('compose.recentAddresses')} />
            )}
            <button type="button" className="tb" onClick={() => setAddressBookFor('to')}>
              {t('compose.addressBook')}
            </button>
          </div>
          {showCcBcc && (
            <>
              <div className="field">
                <span>{t('compose.cc')}</span>
                <RecipientInput ctl={rcp} field="cc" placeholder={t('compose.ccPlaceholder')} />
                <button type="button" className="tb" onClick={() => setAddressBookFor('cc')}>
                  {t('compose.addressBook')}
                </button>
              </div>
              <div className="field">
                <span>{t('compose.bcc')}</span>
                <RecipientInput ctl={rcp} field="bcc" />
                <button type="button" className="tb" onClick={() => setAddressBookFor('bcc')}>
                  {t('compose.addressBook')}
                </button>
              </div>
            </>
          )}
          <div className="field">
            <span>{t('common.subject')}</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            <button
              type="button"
              className={`tb ${appointment ? 'active' : ''}`}
              onClick={() => setAppointmentOpen(true)}
              title={t('appointment.title')}
            >
              {t('compose.appointmentBtn')}
            </button>
          </div>
          {appointment && (
            <div className="appointment-line">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
                <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zm13 8H4v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9zM7 12h3v3H7v-3zm5 0h3v3h-3v-3z" />
              </svg>
              <span>
                {formatFullDate(appointment.start)} ~ {formatFullDate(appointment.end)}
                {appointment.location && ` · ${appointment.location}`}
                {appointment.description && ` · ${appointment.description.slice(0, 40)}`}
              </span>
              <button type="button" className="link" onClick={() => setAppointmentOpen(true)}>
                {t('common.edit')}
              </button>
              <button type="button" className="link danger" onClick={() => setAppointment(null)}>
                {t('common.delete')}
              </button>
            </div>
          )}

          <div className="attach-bar">
            <span className="field-label">{t('compose.attachments')}</span>
            <button
              type="button"
              className="tb"
              onClick={() => setShowAttachList((v) => !v)}
              title={t('compose.toggleAttachList')}
            >
              {showAttachList ? '−' : '+'}
            </button>
            <label className="btn">
              {t('compose.myPc')}
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className="tb"
              disabled={!attachments.some((a) => !a.large)}
              onClick={() => setAttachments((prev) => prev.map((a) => ({ ...a, large: true })))}
            >
              {t('compose.convertAllLarge')}
            </button>
          </div>
          {showAttachList && (
            <div className="attach-panel">
              {site && (
                <div className="attach-usage">
                  {t('compose.attachUsage', {
                    large: formatBytes(largeBytes),
                    largeMax: formatBytes(site.largeMaxSize),
                    general: formatBytes(generalBytes),
                    generalMax: formatBytes(site.attachMaxSize),
                    count: attachments.filter((a) => !a.large).length,
                    countMax: site.attachMaxCount,
                  })}
                </div>
              )}
              <div className="hint">{t('compose.dragHint')}</div>
              {(attachments.length > 0 || emlAttached) && (
                <ul className="attach-list">
                  {emlAttached && seed.emlAttachment && (
                    <li>
                      <span className="name">{seed.emlAttachment.filename}</span>
                      <span className="size">{formatBytes(seed.emlAttachment.size)}</span>
                      <span className="tag">{t('compose.originalMail')}</span>
                      <button type="button" className="link danger" onClick={() => setEmlAttached(false)}>
                        {t('common.delete')}
                      </button>
                    </li>
                  )}
                  {attachments.map((item, index) => (
                    <li key={index}>
                      <span className="name">{item.file.name}</span>
                      {item.large && <span className="tag large">{t('compose.large')}</span>}
                      <span className="size">{formatBytes(item.file.size)}</span>
                      <span className="tag">{t(item.large ? 'compose.large' : 'compose.normal')}</span>
                      {!item.large && (
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            setAttachments((prev) => prev.map((a, i) => (i === index ? { ...a, large: true } : a)))
                          }
                        >
                          {t('compose.convert')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                      >
                        {t('common.delete')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <HtmlEditor
            ref={bodyRef}
            initialHtml={seed.html ?? ''}
            onChange={setHtml}
            placeholder={t('compose.bodyPlaceholder')}
          />

          <div className="compose-options">
            {usableSignatures.length > 0 && (
              <label>
                {t('compose.signature')}
                <select value={signatureId} onChange={(e) => setSignatureId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('common.none')}</option>
                  {usableSignatures.map((s) => (
                    <option key={s.signatureId} value={s.signatureId}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="checkbox">
              <input type="checkbox" checked={vcardYn} onChange={(e) => setVcardYn(e.target.checked)} />
              {t('compose.vcard')}
            </label>
          </div>
          <div className="compose-options">
            <span className="field-label">{t('compose.sendOptions')}</span>
            <label className="checkbox">
              <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />
              {t('compose.important')}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={sendToSelf} onChange={(e) => setSendToSelf(e.target.checked)} />
              {t('compose.sendToSelf')}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={individual} onChange={(e) => setIndividual(e.target.checked)} />
              {t('compose.individual')}
            </label>
            {/* 수신확인 요청(MDN). 외부 도메인 수신자에게도 통하는 유일한 수신확인이다 —
                다만 받는 쪽이 알려 주기로 해야 회신이 오므로 보장은 없다 (feature-gap.md 4-4) */}
            <label className="checkbox" title={t('compose.readReceiptHint')}>
              <input type="checkbox" checked={readReceipt} onChange={(e) => setReadReceipt(e.target.checked)} />
              {t('compose.readReceipt')}
            </label>
          </div>
        </div>
        <div className="modal-actions">
          {/* 자동 저장 상태. 왼쪽에 붙어 버튼들을 오른쪽으로 밀어 둔다 */}
          {saved && (
            <span className={`autosave ${saved.result === 'saved' ? '' : 'warn-text'}`}>
              {saved.result === 'saved'
                ? t('compose.autoSaved', { time: formatListDate(new Date(saved.at).toISOString()) })
                : t(saved.result === 'tooBig' ? 'compose.autoSaveTooBig' : 'compose.autoSaveFailed')}
            </span>
          )}
          <button className="primary" disabled={busy} onClick={send}>
            {t('compose.send')}
          </button>
          <button className="btn" disabled={busy} onClick={saveDraft}>
            {t('compose.saveDraft')}
          </button>
          <button className="btn" disabled={busy} onClick={() => { setHtml(currentHtml()); setPreviewOpen(true); }}>
            {t('compose.preview')}
          </button>
          <button className="btn" disabled={busy} onClick={requestClose}>
            {t('common.cancel')}
          </button>
        </div>
        {dragging && <div className="drop-hint">{t('compose.dropHint')}</div>}
      </div>

      {addressBookFor && <AddressBook onPick={pickAddresses} onClose={() => setAddressBookFor(null)} />}
      {appointmentOpen && (
        <AppointmentDialog
          value={appointment}
          onSave={(value) => {
            setAppointment(value);
            setAppointmentOpen(false);
          }}
          onClose={() => setAppointmentOpen(false)}
        />
      )}
      {previewOpen && (
        <Preview
          from={fromLabel}
          to={rcp.to}
          cc={rcp.cc}
          subject={subject}
          html={html}
          signatureHtml={selectedSignature?.content ?? null}
          attachments={[
            ...(emlAttached && seed.emlAttachment ? [seed.emlAttachment.filename] : []),
            ...attachments.map((a) => a.file.name),
          ]}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
