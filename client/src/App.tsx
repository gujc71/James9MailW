import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from './api/client';
import type { Mailbox, Me, MessageDetail, MessageSummary, ReadReceiptState } from './api/types';
import { Login } from './features/auth/Login';
import { Sidebar, type MailboxAction } from './features/mailbox/Sidebar';
import { MessageList } from './features/mailbox/MessageList';
import { Splitter, loadListWidth } from './features/mailbox/Splitter';
import { useMessageList, msgKey, type ListFilters, type MessageRef } from './features/mailbox/useMessageList';
import {
  DEFAULT_SORT,
  FIRST_DIRECTION_DESC,
  SORT_KEYS,
  loadSort,
  loadThreaded,
  saveSort,
  saveThreaded,
  showsRecipient,
  type ListSort,
  type SortKey,
} from './features/mailbox/listSort';
import { ReadingPane, type ReplyMode } from './features/message/ReadingPane';
import { ConversationPane } from './features/message/ConversationPane';
import type { ThreadGroup } from './features/mailbox/thread';
import type { Quote } from './features/message/quote';
import { Compose, type ComposeSeed } from './features/compose/Compose';
import { Settings, isSettingsTab, type SettingsTab } from './features/settings/Settings';
import { Admin, isAdminTab, type AdminTab } from './features/settings/Admin';
import { Menu } from './features/common/Menu';
import { MailboxPicker } from './features/common/MailboxPicker';
import { ToastHost, showToast } from './features/common/Toast';
import { startPolling } from './db/sync';
import {
  applyUnseenBadge,
  countsAsIncoming,
  disableNotify,
  enableNotify,
  notifyEnabled,
  notifyNewMail,
  notifySupported,
} from './lib/notify';
import { getMailboxCache, openUserDb, putMailboxCache } from './db/schema';
import { cleanupAfterLogout } from './lib/localCache';
import { useQueryClient } from '@tanstack/react-query';
import { goTo, replaceRoute, useHashRoute } from './lib/hashRoute';
import { displayAddress } from './lib/format';
import { DEFAULT_LOCALE, setLocale, useT } from './i18n';
import { adoptSiteTheme } from './lib/theme';
import { CalendarPage } from './features/calendar/CalendarPage';
import { AlarmHost } from './features/calendar/AlarmHost';
import { handToCalendar, takeCompose } from './features/calendar/bridge';

type View = 'mail' | 'settings' | 'admin' | 'calendar';
const VIEWS: readonly string[] = ['mail', 'settings', 'admin', 'calendar'];
const isView = (value: string): value is View => VIEWS.includes(value);
type SearchField = 'all' | 'from' | 'to' | 'subject' | 'filename';

export function App() {
  const t = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const queryClient = useQueryClient();

  /** 로그인한 계정의 로컬 DB 를 먼저 열고 화면을 그린다 (Shell 의 모든 경로가 이 DB 를 쓴다) */
  const enter = useCallback((loaded: Me) => {
    openUserDb(loaded.userName);
    setMe(loaded);
  }, []);

  /**
   * 로그아웃. 메모리에 든 조회 결과(TanStack Query)는 늘 비우고, 로컬 DB 는 개인 정보 관리의
   * "로그아웃 시 캐시 삭제" 설정에 따라 지우거나 닫는다 (lib/localCache.ts).
   * 화면(Shell)이 내려가 동기화 루프가 멈춘 다음에 DB 를 닫도록 한 박자 늦춘다.
   */
  const leave = useCallback(
    (userName: string) => {
      setMe(null);
      queryClient.clear();
      window.setTimeout(() => void cleanupAfterLogout(userName), 0);
    },
    [queryClient],
  );

  useEffect(() => {
    api
      .get<Me>('/api/me')
      .then((loaded) => {
        setLocale(loaded.locale ?? DEFAULT_LOCALE);
        // 공개 엔드포인트와 같은 값이지만, 세션 응답이 더 최신이다 (관리자가 방금 저장한 경우)
        adoptSiteTheme(loaded.site.theme);
        enter(loaded);
      })
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="boot">{t('common.loading')}</div>;
  if (!me) return <Login onLoggedIn={enter} />;
  return <Shell me={me} onMeChanged={setMe} onLogout={() => leave(me.userName)} />;
}

function Shell({ me, onMeChanged, onLogout }: { me: Me; onMeChanged: (me: Me) => void; onLogout: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  /**
   * 어느 화면·탭인지는 컴포넌트 상태가 아니라 주소창 해시에 둔다 (#/settings/mailbox).
   * 상태에 두면 F5 새로고침마다 초기값으로 되돌아가 늘 메일 목록이 열린다 (lib/hashRoute.ts).
   */
  const route = useHashRoute();
  const view: View = isView(route.view) ? route.view : 'mail';
  const settingsTab: SettingsTab = isSettingsTab(route.tab) ? route.tab : 'profile';
  const adminTab: AdminTab = isAdminTab(route.tab) ? route.tab : 'overview';
  // 캘린더는 캘린더 · 태스크 두 탭이다 (#/calendar · #/calendar/tasks)
  const calendarTab = route.tab === 'tasks' ? 'tasks' : 'calendar';

  /**
   * 손으로 고친 주소(#/nope, #/settings/없는탭)나 권한 없는 관리자 화면은 실제로 그려지는
   * 화면에 맞춰 주소만 조용히 고친다. 히스토리에 쌓으면 뒤로가기가 그 주소로 되돌아간다.
   */
  useEffect(() => {
    if (!window.location.hash) return;
    if (view === 'admin') replaceRoute(me.isAdmin ? 'admin' : 'mail', me.isAdmin ? adminTab : null);
    else if (view === 'settings') replaceRoute('settings', settingsTab);
    else if (view === 'calendar') replaceRoute('calendar', calendarTab === 'tasks' ? 'tasks' : null);
    else replaceRoute(view);
  }, [view, settingsTab, adminTab, calendarTab, me.isAdmin]);

  // 캘린더의 "참석자에게 메일 보내기" 는 메일 화면으로 넘어와 메일쓰기를 연다 (features/calendar/bridge.ts)
  useEffect(() => {
    if (view !== 'mail') return;
    const request = takeCompose();
    if (request) setCompose({ to: request.to, subject: request.subject });
  }, [view]);

  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [usage, setUsage] = useState(me.usage);
  const [activeMailbox, setActiveMailbox] = useState<string | null>(null);
  const [active, setActive] = useState<MessageSummary | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  /**
   * 통수 배지를 눌러 펼친 대화 (2-2). 읽기 영역을 메일 하나와 번갈아 쓰므로 둘 중 하나만
   * 들어 있다 — 메일을 열면 비우고(openMessage), 배지를 누르면 열려 있던 메일을 닫는다
   */
  const [conversation, setConversation] = useState<ThreadGroup | null>(null);
  // 전체 메일 보기에서는 편지함마다 uid 가 따로 매겨지므로 (편지함, uid) 키로 고른다
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  // 자동 저장 초안을 복원할 때는 이미 열려 있는 메일쓰기를 새 값으로 다시 그려야 한다
  const [composeKey, setComposeKey] = useState(0);
  const [filters, setFilters] = useState<ListFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  // 정렬 (2-1). 기기에 남는 값이라 다음에 열어도 마지막으로 고른 순서 그대로다 —
  // 편지함을 옮기면 기본값으로 되돌아간다 (selectMailbox)
  const [sort, setSort] = useState<ListSort>(loadSort);
  // 대화로 묶어 보기 (2-2). 정렬과 같이 이 기기에 남는 보기 방식이다
  const [threaded, setThreaded] = useState<boolean>(loadThreaded);
  const [searchField, setSearchField] = useState<SearchField>('all');
  const [searchInput, setSearchInput] = useState('');
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [picker, setPicker] = useState<{ mode: 'move' | 'copy'; refs: MessageRef[] } | null>(null);
  // 데스크톱 알림 (8-2). 저장값과 브라우저 권한이 모두 맞아야 켜진 것이다 (lib/notify.ts)
  const [notifyOn, setNotifyOn] = useState(notifyEnabled);

  // 최초 진입 시 받은편지함을 기본 선택한다 (전체 메일 아님)
  const initializedRef = useRef(false);
  const activeMailboxRef = useRef<string | null>(null);
  activeMailboxRef.current = activeMailbox;
  // 폴링·알림 콜백이 최신 값을 보게 하는 통로. 상태를 의존성에 넣으면 편지함이 갱신될 때마다
  // 폴링 루프가 끊기고 다시 시작한다
  const mailboxesRef = useRef<Mailbox[]>([]);
  mailboxesRef.current = mailboxes;
  const inboxIdRef = useRef<string | null>(null);
  const openFromNotifyRef = useRef<(message: MessageSummary) => void>(() => undefined);

  /**
   * 편지함 목록. 성공하면 Dexie 에 남기고, 끊긴 상태면 남겨 둔 것으로 그린다 (8-5) —
   * 사이드바가 비면 편지함을 고를 수 없어 오프라인에서 읽을 방법이 없어진다.
   */
  const loadMailboxes = useCallback(async () => {
    const apply = (boxes: Mailbox[], quota: Me['usage']) => {
      setMailboxes(boxes);
      setUsage(quota);
      const inbox = boxes.find((box) => box.role === 'INBOX');
      // 다른 편지함을 보고 있어도 받은편지함을 함께 훑어야 새 메일 알림이 뜬다 (8-2)
      inboxIdRef.current = inbox?.id ?? null;
      if (!initializedRef.current) {
        initializedRef.current = true;
        if (inbox) setActiveMailbox(inbox.id);
      }
    };
    try {
      const res = await api.get<{ mailboxes: Mailbox[]; usage: Me['usage'] }>('/api/mailboxes');
      apply(res.mailboxes, res.usage);
      void putMailboxCache(res.mailboxes, res.usage).catch(() => undefined);
    } catch (cause) {
      // 서버가 돌려준 오류(세션 만료 등)는 캐시로 덮지 않는다
      if (cause instanceof ApiError) throw cause;
      const cached = await getMailboxCache();
      if (!cached) throw cause;
      apply(cached.mailboxes, cached.usage);
    }
  }, []);

  useEffect(() => {
    // 캐시도 없이 끊긴 상태면 편지함이 비는 것 말고 할 수 있는 일이 없다
    void loadMailboxes().catch(() => undefined);
  }, [loadMailboxes]);

  // 폴링 기반 동기화 (architecture 2.5).
  const reloadRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const loop = startPolling(
      () => [activeMailboxRef.current, inboxIdRef.current],
      (arrived) => {
        void loadMailboxes().catch(() => undefined);
        reloadRef.current();
        // 보낸·임시·휴지통·스팸에 들어온 행은 알리지 않는다 (lib/notify.ts countsAsIncoming)
        const fresh = arrived.filter((row) => {
          const box = mailboxesRef.current.find((item) => item.id === row.mailboxId);
          return box ? countsAsIncoming(box.role) : false;
        });
        notifyNewMail(fresh, (row) => openFromNotifyRef.current(row));
      },
    );
    return loop.stop;
  }, [loadMailboxes]);

  const activeBox = useMemo(() => mailboxes.find((b) => b.id === activeMailbox) ?? null, [mailboxes, activeMailbox]);
  const activeRole = activeBox?.role ?? null;
  const totalUnseen = useMemo(() => mailboxes.reduce((s, b) => s + b.unseenCount, 0), [mailboxes]);

  /**
   * 파비콘·탭 제목 배지 (8-3). 목록 머리의 안 읽은 수와 달리 **받은 쪽 편지함만** 센다 —
   * 휴지통·스팸에 남은 안 읽음까지 세면 배지가 0 으로 내려가지 않아 곧 무시하게 된다.
   */
  const badgeUnseen = useMemo(
    () => mailboxes.filter((b) => countsAsIncoming(b.role)).reduce((s, b) => s + b.unseenCount, 0),
    [mailboxes],
  );
  useEffect(() => applyUnseenBadge(badgeUnseen), [badgeUnseen]);
  // 로그아웃하면 Shell 이 사라진다. 로그인 화면에 (3) 이 남아 있으면 안 된다
  useEffect(() => () => applyUnseenBadge(0), []);

  // 보낸 편지함 계열이면 목록·정렬이 발송일시/받는사람을 본다. 미러에서 줄 세울 때도 같은 열이어야 한다
  /** 목록 너비 (Splitter). 이 기기에 저장해 두고 다음에 열 때도 그 폭으로 뜬다 */
  const [listWidth, setListWidth] = useState(loadListWidth);

  const list = useMessageList(
    activeMailbox,
    activeMailbox === null,
    filters,
    sort,
    showsRecipient(activeRole),
  );
  reloadRef.current = list.reload;

  /**
   * 편지함을 옮긴다 (사이드바 · 전체 메일 보기 · 알림 클릭).
   *
   * 보고 있던 **필터 · 검색 · 정렬을 모두 초기화**한다. 조건을 그대로 들고 옮기면 새 편지함이
   * 텅 빈 목록으로 열려 "메일이 없는 편지함" 으로 읽히고, 사용자는 지운 적 없는 조건 때문에
   * 그렇다는 것을 알아차리지 못한다 — 썬더버드 · 아웃룩도 폴더를 옮기면 검색창을 비운다.
   * 정렬은 화면 값만 되돌리면 저장값과 어긋나므로 localStorage 에도 기본값을 되쓴다.
   *
   * 보고 있던 편지함을 다시 고른 것은 편지함이 바뀐 것이 아니므로 조건을 건드리지 않는다.
   */
  function selectMailbox(id: string | null) {
    if (id !== activeMailbox) {
      setFilters({});
      setFilterOpen(false);
      setSearchField('all');
      setSearchInput('');
      setSort(DEFAULT_SORT);
      saveSort(DEFAULT_SORT);
    }
    setActiveMailbox(id);
    setActive(null);
    setConversation(null);
    setSelected(new Set());
  }

  /**
   * 알림을 눌렀을 때. 알림이 뜬 메일은 보고 있던 편지함과 다를 수 있으므로 편지함부터 옮긴다 (8-2).
   * 주소도 메일 화면으로 되돌린다 — 설정 화면에 머문 채 메일만 열리면 어디에 열렸는지 알 수 없다.
   */
  openFromNotifyRef.current = (message: MessageSummary) => {
    goTo('mail');
    // 편지함을 옮기며 목록 조건도 비운다 — 걸러진 목록이면 알림이 가리킨 메일이 정작 목록에 없다
    selectMailbox(message.mailboxId);
    void openMessage(message);
  };

  async function toggleNotify() {
    if (notifyOn) {
      disableNotify();
      setNotifyOn(false);
      showToast(t('notify.disabled'));
      return;
    }
    const result = await enableNotify();
    setNotifyOn(result === 'granted');
    showToast(result === 'granted' ? t('notify.enabled') : t('notify.blocked'), result === 'granted' ? 'info' : 'error');
  }

  function fail(cause: unknown, fallback: string) {
    showToast(cause instanceof ApiError ? cause.message : fallback, 'error');
  }

  async function refreshAll() {
    await loadMailboxes().catch(() => undefined);
    await list.refresh();
  }

  async function openMessage(message: MessageSummary) {
    // 행을 고르면 그 메일만 체크된 상태로 남긴다 (기존 체크는 모두 해제)
    setSelected(new Set([msgKey(message)]));
    setActive(message);
    setConversation(null);
    setDetail(null);
    try {
      const d = await api.get<MessageDetail>(`/api/messages/${encodeURIComponent(message.mailboxId)}/${message.uid}`);
      setDetail(d);
      if (!message.flags.includes('\\Seen')) {
        list.patch(msgKey(message), [...message.flags, '\\Seen']);
        setTimeout(() => void loadMailboxes(), 500);
      }
    } catch {
      // 상세 조회 실패는 본문 영역에서 다시 드러난다
    }
  }

  async function toggleStar(message: MessageSummary) {
    const flagged = message.flags.includes('\\Flagged');
    const nextFlags = flagged ? message.flags.filter((f) => f !== '\\Flagged') : [...message.flags, '\\Flagged'];
    list.patch(msgKey(message), nextFlags);
    await api
      .post('/api/messages/flags', {
        mailboxId: message.mailboxId,
        uids: [message.uid],
        add: flagged ? [] : ['\\Flagged'],
        remove: flagged ? ['\\Flagged'] : [],
      })
      .catch(() => list.patch(msgKey(message), message.flags));
  }

  /** 체크된 키를 목록의 (편지함, uid) 로 되돌린다 */
  function refsOf(keys: Set<string>): MessageRef[] {
    return list.messages.filter((m) => keys.has(msgKey(m))).map((m) => ({ mailboxId: m.mailboxId, uid: m.uid }));
  }

  /** 대상 메일을 편지함별로 나눈다. 전체 메일 보기에서는 여러 편지함이 섞인다 */
  function groupRefs(refs: MessageRef[]): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    for (const ref of refs) groups.set(ref.mailboxId, [...(groups.get(ref.mailboxId) ?? []), ref.uid]);
    return groups;
  }

  /** 대상 메일을 목록·본문에서 걷어낸다 */
  function dropFromView(refs: MessageRef[]) {
    const keys = refs.map(msgKey);
    list.remove(keys);
    if (active && keys.includes(msgKey(active))) setActive(null);
    if (conversation && conversation.messages.some((message) => keys.includes(msgKey(message)))) {
      setConversation(null);
    }
  }

  async function deleteMessages(refs: MessageRef[], permanent: boolean) {
    if (permanent && !confirm(t('app.confirmPurge'))) return;
    dropFromView(refs);
    setSelected(new Set());
    try {
      for (const [box, ids] of groupRefs(refs))
        await api.post('/api/messages/delete', { mailboxId: box, uids: ids, permanent });
    } catch (cause) {
      fail(cause, t('common.deleteFailed'));
    }
    await refreshAll();
  }

  async function setSeen(refs: MessageRef[], seen: boolean) {
    try {
      for (const [box, ids] of groupRefs(refs)) {
        await api.post('/api/messages/flags', {
          mailboxId: box,
          uids: ids,
          add: seen ? ['\\Seen'] : [],
          remove: seen ? [] : ['\\Seen'],
        });
      }
    } catch (cause) {
      fail(cause, t('common.actionFailed'));
    }
    setSelected(new Set());
    await refreshAll();
  }

  async function moveOrCopy(mode: 'move' | 'copy', refs: MessageRef[], target: Mailbox) {
    // 이미 대상 편지함에 있는 메일은 건너뛴다
    const targets = refs.filter((r) => r.mailboxId !== target.id);
    if (targets.length === 0) return;
    try {
      for (const [box, uids] of groupRefs(targets))
        await api.post(`/api/messages/${mode}`, { mailboxId: box, uids, targetMailboxId: target.id });
      if (mode === 'move') dropFromView(targets);
      showToast(
        t(mode === 'move' ? 'app.moved' : 'app.copied', { n: targets.length, box: target.displayName }),
      );
    } catch (cause) {
      fail(cause, t(mode === 'move' ? 'app.moveFailed' : 'app.copyFailed'));
    }
    setSelected(new Set());
    await refreshAll();
  }

  /** 스팸차단: 스팸함 이동 + 발신자 수신거부 등록(내부 사용자 제외). 스팸함에서는 해제 */
  async function spam(refs: MessageRef[], unmark: boolean) {
    const keys = new Set(refs.map(msgKey));
    const senders = new Set(
      list.messages.filter((m) => keys.has(msgKey(m)) && m.from).map((m) => m.from!.toLowerCase()),
    );
    try {
      for (const [box, ids] of groupRefs(refs)) await api.post('/api/messages/spam', { mailboxId: box, uids: ids, unmark });
      if (!unmark) {
        for (const sender of senders) {
          // 내부 사용자는 서버가 거부한다 (설계서 공통 정책). 그 오류는 조용히 넘긴다
          await api.post('/api/dropped-senders', { entity: sender }).catch(() => undefined);
        }
      }
      dropFromView(refs);
    } catch (cause) {
      fail(cause, t('app.spamFailed'));
    }
    setSelected(new Set());
    await refreshAll();
  }

  async function addContacts(refs: MessageRef[]) {
    const keys = new Set(refs.map(msgKey));
    const senders = new Map<string, string | null>();
    for (const m of list.messages) {
      if (keys.has(msgKey(m)) && m.from) senders.set(m.from, m.fromDisplay);
    }
    let added = 0;
    for (const [address, name] of senders) {
      await api
        .post('/api/addresses', { mailAddress: address, contactName: name })
        .then(() => added++)
        .catch(() => undefined);
    }
    showToast(t('app.contactsAdded', { n: added }));
    setSelected(new Set());
  }

  function showMailsFrom(refs: MessageRef[]) {
    const keys = new Set(refs.map(msgKey));
    const first = list.messages.find((m) => keys.has(msgKey(m)) && m.from);
    if (!first?.from) return;
    setSearchField('from');
    setSearchInput(first.from);
    setFilters((prev) => ({ ...prev, keyword: first.from!, searchField: 'from' }));
    setSelected(new Set());
  }

  /**
   * 이 메일이 내 알리아스로 온 것이면 답장·전달도 그 알리아스로 보낸다 (4-3).
   * 썬더버드가 신원을 고르는 방식과 같다 — group1 로 온 메일에 답장하면 group1 이 From 이다.
   */
  function replyFromAlias(): string | undefined {
    if (!detail || me.aliases.length === 0) return undefined;
    const arrived = new Set(detail.recipients.map((r) => r.address.toLowerCase()));
    return me.aliases.find((a) => arrived.has(a.address.toLowerCase()))?.address;
  }

  /** 인용문(quote)은 원문을 파싱한 읽기 화면이 만들어 넘겨 준다 (message/quote.ts) */
  function buildReplySeed(mode: ReplyMode, quote: Quote): ComposeSeed {
    if (!active) return {};
    if (mode === 'forward' || mode === 'forwardEml') {
      return {
        fromAlias: replyFromAlias(),
        subject: `Fwd: ${active.subject ?? ''}`,
        forwardOf: active.mailId,
        forwardAsEml: mode === 'forwardEml',
        html: quote.html,
        // 원본 첨부를 그대로 다시 올린다. 용량·개수 한도는 메일쓰기가 본다
        attachments: quote.attachments,
        // 원본 eml 전달이면 첨부칸에 "원본 메일" 로 보여 준다 (파일은 서버가 붙인다)
        emlAttachment: quote.eml,
      };
    }
    const to = active.from ?? '';
    const fromAlias = replyFromAlias();
    let cc = '';
    if (mode === 'replyAll' && detail) {
      // 숨은참조자·본인·보낸 사람을 제외한 전 수신자 (USR-1.3 전체답장).
      // 발신 알리아스도 뺀다 — group1 로 보내면서 group1 을 참조에 두면 나에게 되돌아온다
      const mine = new Set([me.userName.toLowerCase(), (fromAlias ?? '').toLowerCase()]);
      const from = (active.from ?? '').toLowerCase();
      cc = detail.recipients
        .filter((r) => r.type === 'to' || r.type === 'cc')
        .map((r) => r.address)
        .filter((a) => !mine.has(a.toLowerCase()) && a.toLowerCase() !== from)
        .filter((a, i, arr) => arr.indexOf(a) === i)
        .join(', ');
    }
    return {
      fromAlias,
      to,
      cc,
      subject: `Re: ${active.subject ?? ''}`,
      inReplyTo: active.mailId,
      html: quote.html,
    };
  }

  function applySearch() {
    setFilters((prev) => ({ ...prev, keyword: searchInput || undefined, searchField }));
  }

  async function onMailboxAction(action: MailboxAction) {
    const { box } = action;
    try {
      if (action.type === 'add') {
        const name = prompt(t('app.promptChildMailbox', { box: box.displayName }));
        if (!name) return;
        await api.post('/api/mailboxes', { name, parentId: box.id });
      } else if (action.type === 'rename') {
        const name = prompt(t('app.promptRenameMailbox'), box.displayName);
        if (!name || name === box.displayName) return;
        await api.put(`/api/mailboxes/${box.id}`, { name });
      } else if (action.type === 'readAll') {
        await api.post(`/api/mailboxes/${box.id}/read-all`);
      } else if (action.type === 'manage') {
        goTo('settings', 'mailbox');
        return;
      } else if (action.type === 'empty') {
        const purge = box.role === 'Trash' || box.role === 'Spam';
        if (!confirm(t(purge ? 'app.confirmEmptyPurge' : 'app.confirmEmptyTrash', { box: box.displayName })))
          return;
        await api.post(`/api/mailboxes/${box.id}/empty`);
        if (active?.mailboxId === box.id) setActive(null);
        if (conversation?.head.mailboxId === box.id) setConversation(null);
      }
      await refreshAll();
    } catch (cause) {
      fail(cause, t('common.actionFailed'));
    }
  }

  // 모바일에서 메뉴 항목을 고르면 사이드 메뉴를 접는다 (편지함 선택과 동일)
  const collapseMenuOnMobile = () => {
    if (window.innerWidth < 720) setSidebarHidden(true);
  };

  const openSettings = (tab: SettingsTab = 'profile') => {
    goTo('settings', tab);
    collapseMenuOnMobile();
  };

  const topbar = (
    <header className="topbar">
      <div className="brand-wrap">
        <button className="link burger" title={t('app.toggleSidebar')} onClick={() => setSidebarHidden((v) => !v)}>
          ≡
        </button>
        {me.site.logoPath && <img className="logo" src={me.site.logoPath} alt="" />}
        <button className="brand" onClick={() => goTo('mail')}>
          {me.site.siteName}
        </button>
      </div>
      <div className="top-actions">
        {/* 관리자 화면에서는 같은 자리에 '메일' 로 바뀌어 메일 화면으로 돌아간다 */}
        {me.isAdmin && (
          <button className="link" onClick={() => (view === 'admin' ? goTo('mail') : goTo('admin', adminTab))}>
            {view === 'admin' ? t('app.mail') : t('app.admin')}
          </button>
        )}
        {notifySupported() && (
          <button
            className={`link bell ${notifyOn ? 'on' : ''}`}
            title={t(notifyOn ? 'notify.on' : 'notify.off')}
            aria-label={t(notifyOn ? 'notify.on' : 'notify.off')}
            aria-pressed={notifyOn}
            onClick={() => void toggleNotify()}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d={notifyOn
                  ? 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'
                  : 'M20 18.69 7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01C6.28 8.56 6 9.73 6 11v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-7.32V11c0-3.08-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68c-.24.05-.47.12-.7.2h-.01L18 14.68z'} />
            </svg>
          </button>
        )}
        {/* 톱니 아이콘. 글자는 툴팁(hover)과 화면 낭독기용으로만 남긴다 */}
        <button
          className={`link gear ${view === 'settings' ? 'active' : ''}`}
          title={t('app.settings')}
          aria-label={t('app.settings')}
          onClick={() => openSettings()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.47.41h3.84c.23 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
          </svg>
        </button>
        {/* 메일 화면 등에서는 달력 아이콘(캘린더로), 캘린더 화면에서는 같은 자리가 메일 아이콘(메일로)이 된다 */}
        {view === 'calendar' ? (
          <button
            className="link gear"
            title={t('app.mail')}
            aria-label={t('app.mail')}
            onClick={() => {
              goTo('mail');
              collapseMenuOnMobile();
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v.51l8 5.33 8-5.33V6H4zm16 2.9-7.45 4.97a1 1 0 0 1-1.1 0L4 8.9V18h16V8.9z" />
            </svg>
          </button>
        ) : (
          <button
            className="link gear"
            title={t('app.calendar')}
            aria-label={t('app.calendar')}
            onClick={() => {
              goTo('calendar');
              collapseMenuOnMobile();
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zm13 8H4v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9zM7 12h3v3H7v-3zm5 0h3v3h-3v-3z" />
            </svg>
          </button>
        )}
        {me.photo && <img className="me-photo" src={me.photo} alt="" />}
        <span className="who">{me.displayName || me.userName}</span>
        <button
          className="link"
          onClick={async () => {
            await api.post('/api/auth/logout').catch(() => undefined);
            onLogout();
          }}
        >
          {t('app.logout')}
        </button>
      </div>
    </header>
  );

  const sidebar = (
    <Sidebar
      mailboxes={mailboxes}
      usage={usage}
      activeId={activeMailbox}
      onSelect={(id) => {
        selectMailbox(id);
        goTo('mail');
        collapseMenuOnMobile();
      }}
      onAction={onMailboxAction}
      onDropMessages={(target, refs) => void moveOrCopy('move', refs, target)}
    />
  );

  if (view === 'admin' && me.isAdmin) {
    return (
      <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
        {topbar}
        <Admin
          tab={adminTab}
          onTab={(next) => {
            goTo('admin', next);
            collapseMenuOnMobile();
          }}
        />
        <AlarmHost />
      </div>
    );
  }

  if (view === 'calendar') {
    return (
      <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
        {topbar}
        <CalendarPage tab={calendarTab} me={me} onMeChanged={onMeChanged} />
        <ToastHost />
        <AlarmHost />
      </div>
    );
  }

  if (view === 'settings') {
    return (
      <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
        {topbar}
        <div className="body">
          {sidebar}
          <Settings
              me={me}
              tab={settingsTab}
              onTab={(next) => {
                goTo('settings', next);
                collapseMenuOnMobile();
              }}
              mailboxes={mailboxes}
              onMailboxesChanged={loadMailboxes}
              onMeChanged={onMeChanged}
            />
        </div>
        <AlarmHost />
      </div>
    );
  }

  const selectedRefs = refsOf(selected);
  const spamEnabled = me.setting.rejectUseYn;
  const filterCount = [filters.unseen, filters.flagged, filters.important, filters.attachment].filter(
    Boolean,
  ).length;

  const searchBar = (
    <div className="search">
      <select value={searchField} onChange={(e) => setSearchField(e.target.value as SearchField)}>
        <option value="all">{t('common.all')}</option>
        <option value="from">{t('common.from')}</option>
        <option value="to">{t('common.to')}</option>
        <option value="subject">{t('common.subject')}</option>
        <option value="filename">{t('search.filename')}</option>
      </select>
      <input
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && applySearch()}
        placeholder={t('common.search')}
      />
      <button className="btn" onClick={applySearch}>
        {t('common.search')}
      </button>
    </div>
  );

  /**
   * 정렬 (2-1). 같은 기준을 다시 고르면 방향만 뒤집는다 — 열 머리글을 두 번 누르는 조작과 같다.
   * 정렬이 바뀌면 커서가 무의미해지므로 useMessageList 가 첫 페이지부터 다시 받는다.
   */
  function chooseSort(key: SortKey) {
    setSort((prev) => {
      const next: ListSort =
        prev.key === key ? { key, desc: !prev.desc } : { key, desc: FIRST_DIRECTION_DESC[key] };
      saveSort(next);
      return next;
    });
  }

  function chooseDirection(desc: boolean) {
    setSort((prev) => {
      const next: ListSort = { ...prev, desc };
      saveSort(next);
      return next;
    });
  }

  // 'from' 은 목록이 보여 주는 주소 열이라 보낸 편지함 계열에서는 '받는사람' 으로 읽힌다
  const sortKeyLabel = (key: SortKey): string => {
    if (key === 'from') return showsRecipient(activeRole) ? t('common.to') : t('common.from');
    if (key === 'subject') return t('common.subject');
    if (key === 'size') return t('list.size');
    return t('common.date');
  };
  const arrow = sort.desc ? '↓' : '↑';
  const mark = (on: boolean) => <span className="menu-mark">{on ? '✓' : ''}</span>;

  const sortMenu = [
    ...SORT_KEYS.map((key) => ({
      label: (
        <>
          {mark(key === sort.key)}
          {sortKeyLabel(key)}
          {key === sort.key ? ` ${arrow}` : ''}
        </>
      ),
      onClick: () => chooseSort(key),
    })),
    {
      label: (
        <>
          {mark(!sort.desc)}
          {t('list.sortAsc')} ↑
        </>
      ),
      onClick: () => chooseDirection(false),
    },
    {
      label: (
        <>
          {mark(sort.desc)}
          {t('list.sortDesc')} ↓
        </>
      ),
      onClick: () => chooseDirection(true),
    },
    {
      label: (
        <>
          {mark(threaded)}
          {t('list.threadView')}
        </>
      ),
      onClick: () => {
        const next = !threaded;
        setThreaded(next);
        saveThreaded(next);
        // 묶음이 바뀌면 체크해 둔 메일이 어떤 묶음에 속하는지도 바뀐다. 눈에 보이는 것과
        // 다음 조작이 건드릴 대상이 어긋나지 않게 체크를 푼다
        setSelected(new Set());
      },
    },
  ];

  const selectedMenu = [
    { label: t('common.move'), onClick: () => setPicker({ mode: 'move', refs: selectedRefs }) },
    { label: t('common.copy'), onClick: () => setPicker({ mode: 'copy', refs: selectedRefs }) },
    { label: t('common.delete'), onClick: () => void deleteMessages(selectedRefs, false) },
    { label: t('common.purge'), onClick: () => void deleteMessages(selectedRefs, true), danger: true },
    { label: t('list.markRead'), onClick: () => void setSeen(selectedRefs, true) },
    { label: t('list.markUnread'), onClick: () => void setSeen(selectedRefs, false) },
    ...(spamEnabled
      ? [
          {
            label: t(activeRole === 'Spam' ? 'list.unmarkSpam' : 'list.markSpam'),
            onClick: () => void spam(selectedRefs, activeRole === 'Spam'),
            danger: activeRole !== 'Spam',
          },
        ]
      : []),
  ];

  return (
    <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
      {topbar}
      {/* 목록 너비는 Splitter 가 끌어서 바꾼다. CSS 변수로 내려 미디어 쿼리가 먼저 먹게 한다 */}
      <div className="body" style={{ '--list-w': `${listWidth}px` } as CSSProperties}>
        {sidebar}

        <main className={`list-pane ${active ? 'has-active' : ''}`}>
          <div className="mailbox-header">
            <strong>{activeBox ? activeBox.displayName : t('sidebar.allMail')}</strong>
            {(activeBox ? activeBox.unseenCount : totalUnseen) > 0 && (
              <span className="unseen">
                {t('list.unseenCount', { n: activeBox ? activeBox.unseenCount : totalUnseen })}
              </span>
            )}
            <div className="search-narrow">{searchBar}</div>
          </div>

          <div className="list-header">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={list.messages.length > 0 && selected.size === list.messages.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(list.messages.map(msgKey)) : new Set())}
              />
            </label>
            <div className="filter-wrap">
              <button className="tb" onClick={() => setFilterOpen((v) => !v)}>
                {filterCount === 0 ? t('common.all') : t('list.filterN', { n: filterCount })} ▾
              </button>
              {filterOpen && (
                <div className="filters">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={filterCount === 0}
                      onChange={() =>
                        setFilters((p) => ({
                          ...p,
                          unseen: undefined,
                          flagged: undefined,
                          important: undefined,
                          attachment: undefined,
                        }))
                      }
                    />
                    {t('common.all')}
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(filters.unseen)}
                      onChange={(e) => setFilters((p) => ({ ...p, unseen: e.target.checked || undefined }))}
                    />
                    {t('list.unseen')}
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(filters.flagged)}
                      onChange={(e) => setFilters((p) => ({ ...p, flagged: e.target.checked || undefined }))}
                    />
                    {t('list.flagged')}
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(filters.important)}
                      onChange={(e) => setFilters((p) => ({ ...p, important: e.target.checked || undefined }))}
                    />
                    {t('list.importance')}
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(filters.attachment)}
                      onChange={(e) => setFilters((p) => ({ ...p, attachment: e.target.checked || undefined }))}
                    />
                    {t('list.attachment')}
                  </label>
                </div>
              )}
            </div>
            {/* 목록 머리줄이 420px 안에서 네 버튼을 나눠 쓰므로 '정렬' 글자는 title 로 넘긴다 */}
            <Menu
              label={`⇅ ${sortKeyLabel(sort.key)} ${arrow}`}
              title={t('list.sort')}
              buttonClassName="tb"
              items={sortMenu}
            />
            <Menu
              label={`${t('list.etc')} ▾${selected.size ? ` (${selected.size})` : ''}`}
              buttonClassName="tb"
              items={selectedMenu.map((item) => ({ ...item, disabled: selected.size === 0 }))}
            />
            {activeRole === 'INBOX' && (
              <Menu
                label={`${t('list.thisPerson')} ▾`}
                buttonClassName="tb"
                items={[
                  { label: t('list.addContact'), onClick: () => void addContacts(selectedRefs), disabled: selected.size === 0 },
                  { label: t('list.showMailsFrom'), onClick: () => showMailsFrom(selectedRefs), disabled: selected.size === 0 },
                ]}
              />
            )}
          </div>

          <MessageList
            messages={list.messages}
            threads={list.threads}
            threaded={threaded}
            role={activeRole}
            sort={sort}
            activeKey={active ? msgKey(active) : null}
            selected={selected}
            hasMore={list.hasMore}
            loading={list.loading}
            error={list.error}
            offline={list.offline}
            partial={list.partial}
            onOpen={openMessage}
            onOpenThread={(thread) => {
              setActive(null);
              setConversation(thread);
            }}
            onToggleSelect={(keys) =>
              setSelected((prev) => {
                const next = new Set(prev);
                // 대화 한 묶음이 통째로 들어온다. 이미 전부 골라 둔 묶음이면 통째로 푼다
                if (keys.every((k) => next.has(k))) keys.forEach((k) => next.delete(k));
                else keys.forEach((k) => next.add(k));
                return next;
              })
            }
            onToggleStar={toggleStar}
            onLoadMore={list.loadMore}
          />

          <button className="fab" title={t('compose.newMessage')} onClick={() => setCompose({})}>
            ✎
          </button>
        </main>

        <Splitter width={listWidth} onWidth={setListWidth} />

        <section className={`read-pane ${active || conversation ? 'has-active' : ''}`}>
          <div className="read-search">
            {(active || conversation) && (
              <button
                className="link back-to-list"
                onClick={() => {
                  setActive(null);
                  setConversation(null);
                }}
              >
                {t('read.backToList')}
              </button>
            )}
            {searchBar}
          </div>
          <div className="read-scroll">
            {conversation ? (
              <ConversationPane group={conversation} me={me} onOpenMessage={openMessage} />
            ) : active ? (
              <ReadingPane
                summary={active}
                detail={detail}
                role={mailboxes.find((b) => b.id === active.mailboxId)?.role ?? activeRole}
                spamEnabled={spamEnabled}
                onReply={(mode, quote) => setCompose(buildReplySeed(mode, quote))}
                onDelete={(permanent) => void deleteMessages([{ mailboxId: active.mailboxId, uid: active.uid }], permanent)}
                onMove={() => setPicker({ mode: 'move', refs: [{ mailboxId: active.mailboxId, uid: active.uid }] })}
                onCopy={() => setPicker({ mode: 'copy', refs: [{ mailboxId: active.mailboxId, uid: active.uid }] })}
                onSpam={(unmark) => void spam([{ mailboxId: active.mailboxId, uid: active.uid }], unmark)}
                onEditDraft={(seed) => setCompose(seed)}
                onCalendarResponse={async (response, ics) => {
                  // 원문 일정(ics)을 같이 보내면 서버가 내 캘린더에 넣고 주최자에게 응답을 보낸다
                  const updated = await api.post<{ response: string | null; warnings?: string[] }>(
                    `/api/messages/${encodeURIComponent(active.mailboxId)}/${active.uid}/calendar-response`,
                    { response, ics },
                  );
                  setDetail((prev) => (prev ? { ...prev, calendarResponse: updated.response } : prev));
                  updated.warnings?.forEach((w) => showToast(w, 'error'));
                  void queryClient.invalidateQueries({ queryKey: ['cal'] });
                }}
                onConvertToCalendar={(type, title, description) => {
                  // 썬더버드 "이벤트로 변환 · 태스크로 변환": 캘린더 화면에서 새 항목 창이 열린다
                  handToCalendar({ type, title, description });
                  goTo('calendar', type === 'T' ? 'tasks' : null);
                }}
                onReadReceipt={async () => {
                  // 몸통을 보내지 않는다. 회신받을 주소는 서버가 원문 헤더에서 꺼낸다 (4-4)
                  try {
                    const state = await api.post<ReadReceiptState>(
                      `/api/messages/${encodeURIComponent(active.mailboxId)}/${active.uid}/read-receipt`,
                      {},
                    );
                    setDetail((prev) => (prev ? { ...prev, readReceipt: state } : prev));
                    showToast(t('read.mdnSentToast'));
                  } catch (cause) {
                    showToast((cause as Error).message, 'error');
                  }
                }}
              />
            ) : (
              <div className="read-empty">
                {t('read.empty')}
                <div className="read-hint">
                  {t('read.loggedInAs', { who: displayAddress(me.displayName, me.userName) })}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <ToastHost />
      <AlarmHost />

      {picker && (
        <MailboxPicker
          mailboxes={mailboxes}
          title={t(picker.mode === 'move' ? 'picker.moveTitle' : 'picker.copyTitle')}
          excludeIds={picker.refs.length === 1 ? [picker.refs[0]!.mailboxId] : []}
          onPick={(target) => {
            const p = picker;
            setPicker(null);
            void moveOrCopy(p.mode, p.refs, target);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {compose && (
        <Compose
          key={composeKey}
          me={me}
          seed={compose}
          onRestore={(seed) => {
            setCompose(seed);
            setComposeKey((n) => n + 1);
          }}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            void refreshAll();
          }}
        />
      )}
    </div>
  );
}
