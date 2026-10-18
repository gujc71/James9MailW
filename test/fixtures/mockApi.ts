/**
 * /api/** 를 전부 가로채는 가짜 서버.
 *
 * 왜 모킹 계층이 따로 있는가: 이 앱의 쓰기는 모두 James WebAdmin·SMTP 를 거치고 읽기는
 * MariaDB 와 같은 파일시스템을 본다 (webmail-architecture.md). 화면 스펙까지 전부 풀스택으로
 * 돌리면 셋 중 하나만 내려가도 화면과 무관한 이유로 빨개진다. 그래서 화면 검증은 여기서
 * 끝내고, 실제 연동은 specs/api · specs/e2e 가 맡는다.
 *
 * 상태는 테스트마다 새로 만든다. 스펙은 state 를 직접 만져 상황을 꾸미고(`state.messages = ...`),
 * 화면이 보낸 요청은 `state.calls` 로 확인한다.
 *
 * 처리하지 않은 경로는 `state.unhandled` 에 쌓이고 404 를 돌려준다. 새 엔드포인트가 생기면
 * 조용히 통과하지 않고 여기에 남는다.
 */
import type { Page, Route } from '@playwright/test';
import type {
  AddressBookEntry,
  Mailbox,
  Me,
  MessageDetail,
  MessageSummary,
  SendOutcome,
  Signature,
  SiteTheme,
  Usage,
} from '../../client/src/api/types';
import {
  ACCOUNT,
  BOX,
  DEFAULT_THEME,
  DEFAULT_USAGE,
  defaultMailboxes,
  emptyRules,
  makeMe,
  makeSendOutcome,
  OTHER,
  toDetail,
  type AdminAlias,
  type AdminMailLog,
  type AdminUser,
  type DropEntry,
  type ExternalAccount,
  type ExternalRunLog,
  type ReceiptDetailRow,
  type AttendanceRow,
  type ReceiptRow,
  type RulesModel,
  type UploadHistory,
} from './factories';
import { simpleEml } from './eml';

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface MockState {
  /** null 이면 /api/me 가 401 → 로그인 화면이 뜬다 */
  me: Me | null;
  loginFails: string | null;
  mailboxes: Mailbox[];
  usage: Usage;
  messages: MessageSummary[];
  /** `${mailboxId}:${uid}` → 원문(.eml). 없으면 제목만 담은 기본 원문을 만든다 */
  raw: Map<string, string>;
  details: Map<string, Partial<MessageDetail>>;
  signatures: Signature[];
  addresses: AddressBookEntry[];
  rules: RulesModel;
  external: ExternalAccount[];
  externalLogs: ExternalRunLog[];
  uploads: UploadHistory[];
  receipts: ReceiptRow[];
  receiptDetail: ReceiptDetailRow[];
  /** 약속메일 수신자별 응답 (GET .../calendar-attendance) */
  attendance: AttendanceRow[];
  sendOutcome: SendOutcome;
  /** 발송·저장을 실패시킬 때 쓴다. { status, error } */
  failures: Map<string, { status: number; error: string; code?: string }>;
  admin: {
    overview: { totals: { users: number; mailboxBytes: number; mails: number }; weekly: { date: string; count: number }[] };
    hourly: { hour: number; count: number }[];
    site: {
      site: { siteName: string; logoPath: string | null; theme: SiteTheme };
      domains: string[];
      defaultQuota: number | null;
      domainQuotas: { domain: string; limit: number | null }[];
    };
    users: AdminUser[];
    userExists: boolean;
    aliases: AdminAlias[];
    aliasExists: { exists: boolean; reason: string | null };
    mails: AdminMailLog[];
    droplist: DropEntry[];
  };
  calls: RecordedCall[];
  unhandled: string[];
}

export function freshState(over: Partial<MockState> = {}): MockState {
  return {
    me: makeMe(),
    loginFails: null,
    mailboxes: defaultMailboxes(),
    usage: { ...DEFAULT_USAGE },
    messages: [],
    raw: new Map(),
    details: new Map(),
    signatures: [],
    addresses: [],
    rules: emptyRules(),
    external: [],
    externalLogs: [],
    uploads: [],
    receipts: [],
    receiptDetail: [],
    attendance: [],
    sendOutcome: makeSendOutcome(),
    failures: new Map(),
    admin: {
      overview: {
        totals: { users: 3, mailboxBytes: 512 * 1024 * 1024, mails: 1234 },
        weekly: [
          { date: '2026-09-21', count: 10 },
          { date: '2026-09-22', count: 14 },
          { date: '2026-09-23', count: 8 },
          { date: '2026-09-24', count: 20 },
          { date: '2026-09-25', count: 17 },
          { date: '2026-09-26', count: 5 },
          { date: '2026-09-27', count: 12 },
        ],
      },
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour % 5 })),
      site: {
        site: { siteName: 'James9Mail', logoPath: null, theme: { ...DEFAULT_THEME } },
        domains: ['example.com'],
        defaultQuota: 1024 * 1024 * 1024,
        domainQuotas: [],
      },
      users: [],
      userExists: false,
      aliases: [],
      aliasExists: { exists: false, reason: null },
      mails: [],
      droplist: [],
    },
    calls: [],
    unhandled: [],
    ...over,
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const empty = (route: Route) => route.fulfill({ status: 204, body: '' });

const fail = (route: Route, status: number, error: string, code?: string) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error, code }),
  });

/** 목록 정렬. 서버(repositories/messages.ts)와 같은 열을 본다 */
function sortValue(message: MessageSummary, key: string, sentView: boolean): string | number {
  if (key === 'subject') return (message.subject ?? '').toLowerCase();
  if (key === 'size') return message.size;
  if (key === 'from') return ((sentView ? message.to : message.from) ?? '').toLowerCase();
  return (sentView ? message.sentAt : message.receivedAt) ?? '';
}

function matchesKeyword(message: MessageSummary, field: string, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  const has = (value: string | null | undefined) => (value ?? '').toLowerCase().includes(needle);
  if (field === 'from') return has(message.from) || has(message.fromDisplay);
  if (field === 'to') return has(message.to) || has(message.toDisplay);
  if (field === 'subject') return has(message.subject);
  // filename 검색은 첨부 이름을 보는 것이라 모킹에서는 첨부 있는 메일만 남긴다
  if (field === 'filename') return message.hasAttachment;
  return has(message.subject) || has(message.from) || has(message.to) || has(message.fromDisplay);
}

/**
 * 가짜 서버를 붙인다. `page.goto` 보다 먼저 불러야 한다.
 * 첫 화면 진입 전에 언어를 en 으로 고정한다 — 텍스트 셀렉터가 한글/영어로 흔들리지 않게.
 */
export async function installMockApi(page: Page, state: MockState): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('j9-locale', 'en');
    } catch {
      // 비공개 창 등
    }
  });

  /**
   * 경로는 글롭(`**​/api/**`)이 아니라 **pathname 으로** 가린다.
   * dev 서버는 소스 모듈도 그대로 서빙해서 `/src/api/client.ts` 같은 주소가 존재한다 —
   * 글롭으로 잡으면 앱 번들까지 가로채 화면이 아예 뜨지 않는다.
   */
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      let body: unknown;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData() ?? undefined;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      state.calls.push({ method, path, query, body });

      const failure = state.failures.get(`${method} ${path}`);
      if (failure) return fail(route, failure.status, failure.error, failure.code);

      const seg = path.replace(/^\/api\//, '').split('/');
      const at = (index: number) => seg[index] ?? '';

      // ------------------------------------------------------------ 인증 · 내 정보
      if (path === '/api/me' && method === 'GET') {
        return state.me ? json(route, state.me) : fail(route, 401, 'Unauthorized', 'unauthenticated');
      }
      if (path === '/api/auth/login' && method === 'POST') {
        if (state.loginFails) return fail(route, 401, state.loginFails);
        const input = body as { userName?: string; locale?: 'ko' | 'en' } | undefined;
        state.me = makeMe({
          userName: input?.userName ?? ACCOUNT,
          isAdmin: (input?.userName ?? '').startsWith('admin'),
          locale: input?.locale ?? 'en',
        });
        return json(route, { ok: true });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        state.me = null;
        return json(route, { ok: true });
      }
      if (path === '/api/me/profile' && method === 'PUT') {
        const input = body as { displayName?: string } | undefined;
        if (state.me) state.me = { ...state.me, displayName: input?.displayName ?? null };
        return json(route, state.me);
      }
      if (path === '/api/me/password' && method === 'PUT') return json(route, { ok: true });
      if (path === '/api/me/setting' && method === 'PUT') {
        const patch = (body ?? {}) as Record<string, unknown>;
        if (state.me) state.me = { ...state.me, setting: { ...state.me.setting, ...patch } };
        return json(route, state.me?.setting);
      }
      if (path === '/api/me/caldav' && method === 'GET') {
        const user = state.me?.userName ?? 'user1@example.com';
        return json(route, {
          serverUrl: 'https://mail.example.com/',
          davUrl: 'https://mail.example.com/dav/',
          userName: user,
          calendars: [
            { name: 'Home', color: '#3b82f6', readonly: false, url: `https://mail.example.com/dav/calendars/${encodeURIComponent(user)}/1/` },
          ],
        });
      }
      if (path === '/api/me/photo') {
        if (method === 'POST') return json(route, { photo: '/api/photo/me.png' });
        if (method === 'DELETE') return empty(route);
      }
      if (path.startsWith('/api/photo/') || path.startsWith('/api/site/logo/')) {
        // 1x1 투명 PNG. 깨진 이미지 아이콘이 화면에 남지 않게 한다
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/QAAAAA=',
            'base64',
          ),
        });
      }

      // ------------------------------------------------------------ 편지함
      if (path === '/api/mailboxes' && method === 'GET') {
        return json(route, { mailboxes: state.mailboxes, usage: state.usage });
      }
      if (path === '/api/mailboxes' && method === 'POST') {
        const input = body as { name: string; parentId?: string | null };
        const parent = state.mailboxes.find((box) => box.id === input.parentId);
        const name = parent ? `${parent.name}.${input.name}` : input.name;
        const created: Mailbox = {
          id: `new-${state.mailboxes.length + 1}`,
          name,
          displayName: input.name,
          parentName: parent?.name ?? null,
          role: 'personal',
          isSystem: false,
          order: state.mailboxes.length + 1,
          messageCount: 0,
          unseenCount: 0,
          size: 0,
        };
        state.mailboxes = [...state.mailboxes, created];
        return json(route, created);
      }
      if (seg[0] === 'mailboxes' && seg.length === 2 && method === 'PUT') {
        const input = body as { name: string };
        state.mailboxes = state.mailboxes.map((box) =>
          box.id === at(1) ? { ...box, name: input.name, displayName: input.name } : box,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'mailboxes' && seg.length === 2 && method === 'DELETE') {
        state.mailboxes = state.mailboxes.filter((box) => box.id !== at(1));
        return empty(route);
      }
      if (seg[0] === 'mailboxes' && at(2) === 'read-all' && method === 'POST') {
        state.messages = state.messages.map((message) =>
          message.mailboxId === at(1) && !message.flags.includes('\\Seen')
            ? { ...message, flags: [...message.flags, '\\Seen'] }
            : message,
        );
        state.mailboxes = state.mailboxes.map((box) => (box.id === at(1) ? { ...box, unseenCount: 0 } : box));
        return json(route, { updated: 1 });
      }
      if (seg[0] === 'mailboxes' && at(2) === 'empty' && method === 'POST') {
        state.messages = state.messages.filter((message) => message.mailboxId !== at(1));
        state.mailboxes = state.mailboxes.map((box) =>
          box.id === at(1) ? { ...box, messageCount: 0, unseenCount: 0 } : box,
        );
        return json(route, { moved: 0, purged: 1 });
      }

      // ------------------------------------------------------------ 메일 변경 (경로가 겹치므로 먼저)
      if (path === '/api/messages/flags' && method === 'POST') {
        const input = body as { mailboxId: string; uids: number[]; add?: string[]; remove?: string[] };
        const uids = new Set(input.uids);
        state.messages = state.messages.map((message) => {
          if (message.mailboxId !== input.mailboxId || !uids.has(message.uid)) return message;
          const flags = new Set(message.flags);
          for (const flag of input.add ?? []) flags.add(flag);
          for (const flag of input.remove ?? []) flags.delete(flag);
          return { ...message, flags: [...flags] };
        });
        return json(route, { updated: input.uids.length });
      }
      // 변경 요청은 편지함 하나 + uid 묶음으로 온다 (App.tsx groupRefs).
      // 전체 메일 보기에서 여러 편지함이 걸리면 요청이 편지함 수만큼 나뉘어 온다
      if ((path === '/api/messages/move' || path === '/api/messages/copy') && method === 'POST') {
        const input = body as { mailboxId: string; uids: number[]; targetMailboxId: string };
        const uids = new Set(input.uids);
        if (path.endsWith('move')) {
          state.messages = state.messages.map((message) =>
            message.mailboxId === input.mailboxId && uids.has(message.uid)
              ? { ...message, mailboxId: input.targetMailboxId }
              : message,
          );
        }
        return json(route, { moved: input.uids.length, copied: input.uids.length });
      }
      if (path === '/api/messages/delete' && method === 'POST') {
        const input = body as { mailboxId: string; uids: number[]; permanent?: boolean };
        const uids = new Set(input.uids);
        const hit = (message: MessageSummary) => message.mailboxId === input.mailboxId && uids.has(message.uid);
        state.messages = input.permanent
          ? state.messages.filter((message) => !hit(message))
          : state.messages.map((message) => (hit(message) ? { ...message, mailboxId: BOX.trash } : message));
        return json(route, { deleted: input.uids.length });
      }
      if (path === '/api/messages/spam' && method === 'POST') {
        const input = body as { mailboxId: string; uids: number[]; unmark?: boolean };
        const uids = new Set(input.uids);
        state.messages = state.messages.map((message) =>
          message.mailboxId === input.mailboxId && uids.has(message.uid)
            ? { ...message, mailboxId: input.unmark ? BOX.inbox : BOX.spam }
            : message,
        );
        return json(route, { moved: input.uids.length });
      }
      if (path === '/api/dropped-senders' && method === 'POST') return json(route, { added: 1 });

      // ------------------------------------------------------------ 메일 업로드
      if (path === '/api/messages/upload' && method === 'POST') {
        return json(route, { total: 1, done: 1, failed: [] });
      }
      if (path === '/api/messages/upload/history' && method === 'GET') return json(route, state.uploads);
      if (seg[0] === 'messages' && at(1) === 'upload' && method === 'DELETE') {
        state.uploads = state.uploads.filter((row) => String(row.uploadId) !== at(2));
        return empty(route);
      }

      // ------------------------------------------------------------ 목록 · 상세 · 원문
      if (path === '/api/messages' && method === 'GET') {
        const all = query.all === 'true' || !query.mailbox;
        const boxId = query.mailbox;
        const box = state.mailboxes.find((item) => item.id === boxId);
        const sentView = box ? ['Sent', 'Outbox', 'Drafts'].includes(box.role) : false;
        let rows = state.messages.filter((message) => all || message.mailboxId === boxId);
        if (query.unseen === 'true') rows = rows.filter((message) => !message.flags.includes('\\Seen'));
        if (query.flagged === 'true') rows = rows.filter((message) => message.flags.includes('\\Flagged'));
        if (query.important === 'true') rows = rows.filter((message) => message.importance === 'high');
        if (query.attachment === 'true') rows = rows.filter((message) => message.hasAttachment);
        if (query.keyword) {
          rows = rows.filter((message) => matchesKeyword(message, query.searchField ?? 'all', query.keyword!));
        }
        const key = query.sort ?? 'date';
        const desc = (query.dir ?? 'desc') === 'desc';
        rows = [...rows].sort((left, right) => {
          const a = sortValue(left, key, sentView);
          const b = sortValue(right, key, sentView);
          if (a === b) return right.uid - left.uid;
          return (a < b ? -1 : 1) * (desc ? -1 : 1);
        });
        const limit = Number(query.limit ?? 50);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return json(route, {
          messages: page,
          nextCursor: last
            ? { value: String(sortValue(last, key, sentView)), uid: last.uid, mailboxId: last.mailboxId }
            : null,
          hasMore: rows.length > limit,
        });
      }
      // /api/messages/:mailboxId/:uid/raw — 원문. 브라우저가 이걸 받아 MIME 을 판다
      if (seg[0] === 'messages' && seg.length === 4 && seg[3] === 'raw' && method === 'GET') {
        const mailboxId = decodeURIComponent(at(1));
        const uid = Number(at(2));
        const stored = state.raw.get(`${mailboxId}:${uid}`);
        const message = state.messages.find((item) => item.mailboxId === mailboxId && item.uid === uid);
        const eml = stored ?? simpleEml({
          from: message?.from ?? 'user2@example.com',
          to: message?.to ?? ACCOUNT,
          subject: message?.subject ?? '(no subject)',
          text: `Body of ${message?.subject ?? 'message'}`,
        });
        return route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'message/rfc822',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'attachment; filename="mock.eml"',
          },
          body: eml,
        });
      }
      if (seg[0] === 'messages' && seg.length === 4 && seg[3] === 'download' && method === 'GET') {
        return route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'message/rfc822',
            'Content-Disposition': "attachment; filename*=UTF-8''mock.eml",
          },
          body: state.raw.get(`${decodeURIComponent(at(1))}:${at(2)}`) ?? simpleEml({ subject: 'mock' }),
        });
      }
      if (seg[0] === 'messages' && seg.length === 4 && seg[3] === 'calendar-response' && method === 'POST') {
        const input = body as { response: string };
        return json(route, { response: input.response });
      }
      // 수신확인 요청 회신. 서버는 회신받을 주소를 원문에서 꺼내므로 몸통이 없다 (4-4)
      if (seg[0] === 'messages' && seg.length === 4 && seg[3] === 'calendar-attendance' && method === 'GET') {
        return json(route, state.attendance);
      }
      if (seg[0] === 'messages' && seg.length === 4 && seg[3] === 'read-receipt' && method === 'POST') {
        const key = `${decodeURIComponent(at(1))}:${at(2)}`;
        const requested = state.details.get(key)?.readReceipt?.requestedTo ?? OTHER;
        const sent = { requestedTo: requested, sentAt: new Date().toISOString() };
        state.details.set(key, { ...state.details.get(key), readReceipt: sent });
        return json(route, sent);
      }
      if (seg[0] === 'messages' && seg.length === 3 && method === 'GET') {
        const mailboxId = decodeURIComponent(at(1));
        const uid = Number(at(2));
        const message = state.messages.find((item) => item.mailboxId === mailboxId && item.uid === uid);
        if (!message) return fail(route, 404, 'Mail not found');
        return json(route, toDetail(message, state.details.get(`${mailboxId}:${uid}`) ?? {}));
      }

      // ------------------------------------------------------------ 동기화
      if (path === '/api/sync' && method === 'GET') {
        return json(route, { changes: [], tombstones: [], hasMore: false });
      }
      if (path === '/api/sync/head' && method === 'GET') {
        return json(route, { modseq: 1, tombstoneSeq: 1 });
      }

      // ------------------------------------------------------------ 메일 쓰기
      if (path === '/api/compose/context' && method === 'GET') {
        return json(route, {
          signatures: state.signatures,
          recent: state.addresses.slice(0, 10).map((entry) => entry.mailAddress),
          site: state.me?.site,
          setting: state.me?.setting,
          aliases: state.me?.aliases ?? [],
        });
      }
      if (path === '/api/compose/send' && method === 'POST') return json(route, state.sendOutcome);
      if (path === '/api/compose/draft' && method === 'POST') {
        return json(route, { mailId: 'draft-1', uid: 1, mailboxId: BOX.drafts });
      }
      if (path === '/api/attachments/large' && method === 'POST') {
        return json(route, { attachments: [{ attachId: 'large-1' }] });
      }
      if (seg[0] === 'attachments' && at(1) === 'large' && method === 'DELETE') return empty(route);

      // ------------------------------------------------------------ 서명 · 주소록
      if (path === '/api/signatures' && method === 'GET') return json(route, state.signatures);
      if (path === '/api/signatures' && method === 'POST') {
        const input = body as { name: string; content: string; isDefault?: boolean };
        const created: Signature = {
          signatureId: state.signatures.length + 1,
          userName: ACCOUNT,
          name: input.name,
          content: input.content,
          isDefault: Boolean(input.isDefault),
          sortOrder: state.signatures.length + 1,
        };
        state.signatures = [...state.signatures, created];
        return json(route, created);
      }
      if (path === '/api/signatures/default' && method === 'PUT') {
        const input = body as { signatureId: number | null };
        state.signatures = state.signatures.map((row) => ({
          ...row,
          isDefault: row.signatureId === input.signatureId,
        }));
        return json(route, { ok: true });
      }
      if (seg[0] === 'signatures' && seg.length === 2 && method === 'PUT') {
        const input = body as { name: string; content: string };
        state.signatures = state.signatures.map((row) =>
          String(row.signatureId) === at(1) ? { ...row, ...input } : row,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'signatures' && seg.length === 2 && method === 'DELETE') {
        state.signatures = state.signatures.filter((row) => String(row.signatureId) !== at(1));
        return empty(route);
      }
      if (path === '/api/addresses/suggest' && method === 'GET') {
        // 자동완성만 q 를 쓴다. 주소록 목록은 keyword 다 (useAddressSuggest.ts)
        const keyword = (query.q ?? '').toLowerCase();
        const items = state.addresses
          .filter((entry) => (entry.mailAddress ?? '').toLowerCase().includes(keyword))
          .map((entry) => ({ address: entry.mailAddress ?? '', name: entry.contactName }));
        return json(route, { items, complete: true });
      }
      if (path === '/api/addresses' && method === 'GET') {
        const keyword = (query.keyword ?? '').toLowerCase();
        return json(
          route,
          state.addresses.filter(
            (entry) =>
              (entry.mailAddress ?? '').toLowerCase().includes(keyword) ||
              (entry.contactName ?? '').toLowerCase().includes(keyword),
          ),
        );
      }
      if (path === '/api/addresses' && method === 'POST') {
        const input = body as { contactName?: string | null; mailAddress: string };
        const created: AddressBookEntry = {
          addressId: state.addresses.length + 1,
          uid: `uid-${state.addresses.length + 1}`,
          kind: 'I',
          contactName: input.contactName ?? null,
          mailAddress: input.mailAddress,
          org: null,
          phone: null,
          useCount: 0,
          lastUsedAt: null,
        };
        state.addresses = [...state.addresses, created];
        return json(route, created);
      }
      if (seg[0] === 'addresses' && seg.length === 2 && method === 'PUT') {
        const input = body as { contactName?: string | null; mailAddress: string };
        state.addresses = state.addresses.map((entry) =>
          String(entry.addressId) === at(1) ? { ...entry, ...input } : entry,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'addresses' && seg.length === 2 && method === 'DELETE') {
        state.addresses = state.addresses.filter((entry) => String(entry.addressId) !== at(1));
        return empty(route);
      }

      // ------------------------------------------------------------ 수신확인
      if (path === '/api/receipts' && method === 'GET') {
        const keyword = (query.keyword ?? '').toLowerCase();
        const rows = keyword
          ? state.receipts.filter((row) => (row.subject ?? '').toLowerCase().includes(keyword))
          : state.receipts;
        return json(route, rows);
      }
      if (seg[0] === 'receipts' && seg.length === 3 && seg[2] === 'recall' && method === 'POST') {
        return json(route, { recalled: state.receiptDetail.filter((row) => row.recallable).length });
      }
      if (seg[0] === 'receipts' && seg.length === 2 && method === 'GET') {
        return json(route, state.receiptDetail);
      }

      // ------------------------------------------------------------ 규칙 (Sieve)
      if (path === '/api/rules' && method === 'GET') return json(route, state.rules);
      if (path === '/api/rules' && method === 'PUT') {
        const patch = (body ?? {}) as Partial<RulesModel>;
        state.rules = { ...state.rules, ...patch, activatedAt: new Date().toISOString() };
        return json(route, { script: '# generated' });
      }

      // ------------------------------------------------------------ 외부메일
      if (path === '/api/external-mail' && method === 'GET') return json(route, state.external);
      if (path === '/api/external-mail' && method === 'POST') {
        const input = body as Partial<ExternalAccount>;
        const created: ExternalAccount = {
          externalId: state.external.length + 1,
          externalName: input.externalName ?? 'account',
          serverHost: input.serverHost ?? 'mail.example.com',
          serverPort: input.serverPort ?? 993,
          protocol: input.protocol ?? 'IMAP',
          securityType: input.securityType ?? 'SSL',
          loginId: input.loginId ?? 'me',
          targetMailboxId: input.targetMailboxId ?? BOX.inbox,
          lastRunAt: null,
        };
        state.external = [...state.external, created];
        return json(route, created);
      }
      if (seg[0] === 'external-mail' && seg.length === 3 && seg[2] === 'run' && method === 'POST') {
        return json(route, { stored: 2, errors: [] });
      }
      if (seg[0] === 'external-mail' && seg.length === 3 && seg[2] === 'logs' && method === 'GET') {
        return json(route, state.externalLogs);
      }
      if (seg[0] === 'external-mail' && seg.length === 2 && method === 'PUT') {
        const patch = (body ?? {}) as Partial<ExternalAccount>;
        state.external = state.external.map((row) =>
          String(row.externalId) === at(1) ? { ...row, ...patch } : row,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'external-mail' && seg.length === 2 && method === 'DELETE') {
        state.external = state.external.filter((row) => String(row.externalId) !== at(1));
        return empty(route);
      }

      // ------------------------------------------------------------ 관리자
      if (path === '/api/admin/overview' && method === 'GET') return json(route, state.admin.overview);
      if (path === '/api/admin/hourly' && method === 'GET') return json(route, state.admin.hourly);
      if (path === '/api/admin/site' && method === 'GET') return json(route, state.admin.site);
      if (path === '/api/admin/site' && method === 'PUT') {
        const input = body as {
          siteName?: string;
          defaultQuota?: number | null;
          theme?: Partial<SiteTheme>;
        };
        state.admin.site = {
          ...state.admin.site,
          site: {
            ...state.admin.site.site,
            siteName: input.siteName ?? state.admin.site.site.siteName,
            // 서버와 같이 넘어온 항목만 얹는다 (repositories/gu.ts saveSiteConfig)
            theme: { ...state.admin.site.site.theme, ...input.theme },
          },
          defaultQuota: input.defaultQuota ?? state.admin.site.defaultQuota,
        };
        return json(route, { ok: true });
      }
      /** 로그인 전 강조색 (공개). main.tsx 가 부팅 때 한 번 부른다 */
      if (path === '/api/site/theme' && method === 'GET') {
        return json(route, { theme: state.admin.site.site.theme });
      }
      if (path === '/api/admin/site/logo' && method === 'POST') {
        return json(route, { logoPath: '/api/site/logo/logo.png' });
      }
      if (path === '/api/admin/users/exists' && method === 'GET') {
        return json(route, { exists: state.admin.userExists });
      }
      if (path === '/api/admin/users' && method === 'GET') {
        const keyword = (query.keyword ?? '').toLowerCase();
        const rows = keyword
          ? state.admin.users.filter(
              (user) =>
                user.userName.toLowerCase().includes(keyword) ||
                (user.displayName ?? '').toLowerCase().includes(keyword),
            )
          : state.admin.users;
        return json(route, { users: rows, total: rows.length });
      }
      if (path === '/api/admin/users' && method === 'POST') {
        const input = body as { userName: string; displayName: string };
        state.admin.users = [
          ...state.admin.users,
          {
            userName: input.userName,
            displayName: input.displayName,
            status: 'Y',
            used: 0,
            limit: 1024 * 1024 * 1024,
            unlimited: false,
            regDate: '2026-09-27',
          },
        ];
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 4 && seg[3] === 'status' && method === 'POST') {
        const input = body as { status: string };
        const target = decodeURIComponent(at(2));
        state.admin.users = state.admin.users.map((user) =>
          user.userName === target ? { ...user, status: input.status } : user,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 4 && seg[3] === 'quota' && method === 'PUT') {
        const input = body as { limitBytes: number | null };
        const target = decodeURIComponent(at(2));
        state.admin.users = state.admin.users.map((user) =>
          user.userName === target
            ? { ...user, limit: input.limitBytes, unlimited: input.limitBytes === null }
            : user,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 3 && method === 'PUT') {
        const input = body as { displayName?: string };
        const target = decodeURIComponent(at(2));
        state.admin.users = state.admin.users.map((user) =>
          user.userName === target ? { ...user, displayName: input.displayName ?? user.displayName } : user,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'users' && seg.length === 3 && method === 'DELETE') {
        const target = decodeURIComponent(at(2));
        state.admin.users = state.admin.users.filter((user) => user.userName !== target);
        return empty(route);
      }
      if (path === '/api/admin/aliases/exists' && method === 'GET') {
        return json(route, state.admin.aliasExists);
      }
      if (path === '/api/admin/aliases' && method === 'GET') {
        const keyword = (query.keyword ?? '').toLowerCase();
        const rows = keyword
          ? state.admin.aliases.filter(
              (alias) =>
                alias.aliasAddress.toLowerCase().includes(keyword) ||
                alias.aliasName.toLowerCase().includes(keyword),
            )
          : state.admin.aliases;
        return json(route, rows);
      }
      if (path === '/api/admin/aliases' && method === 'POST') {
        const input = body as { aliasAddress: string; aliasName: string; targets: string[] };
        state.admin.aliases = [
          ...state.admin.aliases,
          { ...input, status: 'Y', regDate: '2026-09-27' },
        ];
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'aliases' && seg.length === 4 && seg[3] === 'status' && method === 'POST') {
        const input = body as { status: string };
        const target = decodeURIComponent(at(2));
        state.admin.aliases = state.admin.aliases.map((alias) =>
          alias.aliasAddress === target ? { ...alias, status: input.status } : alias,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'aliases' && seg.length === 3 && method === 'PUT') {
        const patch = (body ?? {}) as Partial<AdminAlias>;
        const target = decodeURIComponent(at(2));
        state.admin.aliases = state.admin.aliases.map((alias) =>
          alias.aliasAddress === target ? { ...alias, ...patch } : alias,
        );
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'aliases' && seg.length === 3 && method === 'DELETE') {
        const target = decodeURIComponent(at(2));
        state.admin.aliases = state.admin.aliases.filter((alias) => alias.aliasAddress !== target);
        return empty(route);
      }
      if (path === '/api/admin/mails' && method === 'GET') {
        const keyword = (query.keyword ?? '').toLowerCase();
        const rows = keyword
          ? state.admin.mails.filter((mail) => (mail.subject ?? '').toLowerCase().includes(keyword))
          : state.admin.mails;
        return json(route, rows);
      }
      if (path === '/api/admin/mails/delete' && method === 'POST') {
        const input = body as { mailIds: string[] };
        const ids = new Set(input.mailIds);
        state.admin.mails = state.admin.mails.filter((mail) => !ids.has(mail.mailId));
        return json(route, { deleted: ids.size });
      }
      if (seg[0] === 'admin' && seg[1] === 'mails' && seg.length === 4 && seg[3] === 'raw' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'message/rfc822', body: simpleEml({ subject: 'admin view' }) });
      }
      if (path === '/api/admin/droplist' && method === 'GET') {
        // 화면이 보내는 값은 ALL · DOMAIN · ADDRESS 다 (Admin.tsx DropList)
        const type = query.type ?? 'ALL';
        return json(
          route,
          type === 'ALL' ? state.admin.droplist : state.admin.droplist.filter((row) => row.type === type),
        );
      }
      if (path === '/api/admin/droplist' && method === 'POST') {
        const input = body as { entity: string };
        const type = input.entity.includes('@') ? 'ADDRESS' : 'DOMAIN';
        state.admin.droplist = [
          ...state.admin.droplist,
          { id: state.admin.droplist.length + 1, type, entity: input.entity },
        ];
        return json(route, { ok: true });
      }
      if (seg[0] === 'admin' && seg[1] === 'droplist' && seg.length === 3 && method === 'DELETE') {
        state.admin.droplist = state.admin.droplist.filter((row) => String(row.id) !== at(2));
        return empty(route);
      }
      if (path === '/api/health' && method === 'GET') {
        return json(route, { db: true, smtp: true, webadmin: true });
      }

      state.unhandled.push(`${method} ${path}`);
      return fail(route, 404, `mockApi: 처리하지 않은 경로 ${method} ${path}`);
    },
  );

  // 대용량 첨부(/large/:id)는 /api 밖이라 따로 받는다
  await page.route(
    (url) => url.pathname.startsWith('/large/'),
    (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="large.bin"' },
        body: 'large attachment body',
      }),
  );
}
