/**
 * 모킹 응답을 만드는 공장.
 *
 * 응답 타입은 클라이언트가 쓰는 것을 **그대로 import** 한다 (client/src/api/types.ts).
 * 서버 응답 모양이 바뀌면 여기서 타입 오류가 나서 낡은 모킹이 조용히 통과하지 못한다.
 * 타입만 가져오므로(verbatimModuleSyntax + import type) 런타임 의존은 없다.
 */
import type {
  AddressBookEntry,
  Mailbox,
  MailboxRole,
  Me,
  MessageDetail,
  MessageSummary,
  SendOutcome,
  Signature,
  SiteConfig,
  SiteTheme,
  Usage,
  UserSetting,
} from '../../client/src/api/types';

export const ACCOUNT = 'user1@example.com';
export const ADMIN_ACCOUNT = 'admin@example.com';
export const OTHER = 'user2@example.com';

/** 편지함 아이디는 02-seed.sql 의 user1 값을 그대로 쓴다 — e2e 와 눈으로 맞춰 보기 쉽다 */
export const BOX = {
  inbox: '624095a7-b45a-4e1b-a616-e0400db56473',
  sent: '8f7405b3-519e-4e27-aa1a-5b0948511769',
  drafts: '47597620-ac7e-4cf3-b5ce-e2befecd46fe',
  trash: '5bc05519-bdc7-482a-8311-60fdb60bfea1',
  spam: 'e9af9101-c97c-4547-be73-72a0be614506',
  project: 'b0000000-0000-4000-8000-000000000001',
} as const;

export const DEFAULT_SETTING: UserSetting = {
  listPageSize: 50,
  sendConfirmYn: true,
  personalSignYn: true,
  vcardYn: false,
  rejectUseYn: true,
  vacationUseYn: false,
  forwardUseYn: false,
  caldavUseYn: false,
  carddavUseYn: false,
};

/** ADM-2 강조색. client/src/lib/theme.ts 의 THEME_DEFAULT 와 같은 값 */
export const DEFAULT_THEME: SiteTheme = {
  accent: '#4f46e5',
  accentHover: '#4338ca',
  accentText: '#3f37c9',
  accentPale: '#f4f1fe',
  accentSoft: '#eef0fe',
  accentSoft2: '#e4e7fd',
  gradFrom: '#5b53ea',
  gradTo: '#7c5cf0',
  syntaxField: '#4a4ec2',
};

export const DEFAULT_SITE: SiteConfig = {
  siteName: 'James9Mail',
  logoPath: null,
  theme: { ...DEFAULT_THEME },
  attachMaxSize: 25 * 1024 * 1024,
  attachMaxCount: 10,
  largeMaxSize: 300 * 1024 * 1024,
  largeKeepDays: 14,
  passwordMinLen: 8,
  passwordMinSpec: 2,
};

export const DEFAULT_USAGE: Usage = {
  used: 128 * 1024 * 1024,
  limit: 1024 * 1024 * 1024,
  unlimited: false,
  scope: 'GLOBAL',
};

export function makeMe(over: Partial<Me> = {}): Me {
  return {
    userName: ACCOUNT,
    displayName: 'User One',
    photo: null,
    isAdmin: false,
    // 화면 문구를 영어로 고정한다. App.tsx 가 /api/me 의 locale 로 setLocale 을 부른다
    locale: 'en',
    setting: { ...DEFAULT_SETTING },
    site: { ...DEFAULT_SITE },
    usage: { ...DEFAULT_USAGE },
    aliases: [],
    ...over,
  };
}

interface BoxSeed {
  id: string;
  name: string;
  role: MailboxRole;
  order: number;
  parentName?: string | null;
  isSystem?: boolean;
  unseenCount?: number;
  messageCount?: number;
}

/** 편지함 표시 이름은 서버가 정해서 내려준다 (repositories/mailboxes.ts) */
const DISPLAY: Record<string, string> = {
  INBOX: 'Inbox',
  Sent: 'Sent',
  Drafts: 'Drafts',
  Trash: 'Trash',
  Spam: 'Spam',
};

export function makeMailbox(seed: BoxSeed): Mailbox {
  return {
    id: seed.id,
    name: seed.name,
    displayName: DISPLAY[seed.name] ?? seed.name,
    parentName: seed.parentName ?? null,
    role: seed.role,
    isSystem: seed.isSystem ?? seed.role !== 'personal',
    order: seed.order,
    messageCount: seed.messageCount ?? 0,
    unseenCount: seed.unseenCount ?? 0,
    size: 0,
  };
}

export function defaultMailboxes(): Mailbox[] {
  return [
    makeMailbox({ id: BOX.inbox, name: 'INBOX', role: 'INBOX', order: 1, unseenCount: 2, messageCount: 4 }),
    makeMailbox({ id: BOX.sent, name: 'Sent', role: 'Sent', order: 2, messageCount: 1 }),
    makeMailbox({ id: BOX.drafts, name: 'Drafts', role: 'Drafts', order: 3, messageCount: 1 }),
    makeMailbox({ id: BOX.trash, name: 'Trash', role: 'Trash', order: 4 }),
    makeMailbox({ id: BOX.spam, name: 'Spam', role: 'Spam', order: 5 }),
    makeMailbox({ id: BOX.project, name: 'Project', role: 'personal', order: 6, isSystem: false }),
  ];
}

let uidSeq = 100;

export interface MessageSeed {
  mailboxId?: string;
  uid?: number;
  subject?: string;
  from?: string;
  fromDisplay?: string | null;
  to?: string;
  toDisplay?: string | null;
  receivedAt?: string;
  sentAt?: string;
  seen?: boolean;
  flagged?: boolean;
  important?: boolean;
  hasAttachment?: boolean;
  size?: number;
  mailId?: string;
  /** 같은 값을 주면 한 대화로 묶인다. 생략하면 그 메일 하나만의 대화다 (2-2) */
  threadId?: string | null;
  /** 사내 계정의 프로필 사진 URL. 목록 아바타와 대화 보기의 말풍선 사진이 쓴다 */
  fromPhoto?: string | null;
  toPhoto?: string | null;
}

export function makeMessage(seed: MessageSeed = {}): MessageSummary {
  const uid = seed.uid ?? ++uidSeq;
  const mailboxId = seed.mailboxId ?? BOX.inbox;
  const flags: string[] = [];
  if (seed.seen ?? true) flags.push('\\Seen');
  if (seed.flagged) flags.push('\\Flagged');
  const day = String((uid % 27) + 1).padStart(2, '0');
  const receivedAt = seed.receivedAt ?? `2026-09-${day}T09:00:00.000Z`;
  return {
    mailboxId,
    uid,
    modseq: uid,
    mailId: seed.mailId ?? `mail-${mailboxId.slice(0, 4)}-${uid}`,
    receivedAt,
    sentAt: seed.sentAt ?? receivedAt,
    subject: seed.subject ?? `Message ${uid}`,
    from: seed.from ?? OTHER,
    fromDisplay: seed.fromDisplay ?? 'User Two',
    to: seed.to ?? ACCOUNT,
    toDisplay: seed.toDisplay ?? 'User One',
    fromPhoto: seed.fromPhoto ?? null,
    toPhoto: seed.toPhoto ?? null,
    size: seed.size ?? 2048,
    hasAttachment: seed.hasAttachment ?? false,
    messageId: `<${uid}@example.com>`,
    inReplyTo: null,
    threadId: seed.threadId === undefined ? `<${uid}@example.com>` : seed.threadId,
    mailType: 'I',
    flags,
    importance: seed.important ? 'high' : null,
  };
}

export function toDetail(summary: MessageSummary, over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    ...summary,
    recipients: [{ address: summary.to ?? ACCOUNT, type: 'to' }],
    largeAttachments: [],
    calendarResponse: null,
    readReceipt: null,
    fromMe: false,
    ...over,
  };
}

export function makeSignature(over: Partial<Signature> = {}): Signature {
  return {
    signatureId: 1,
    userName: ACCOUNT,
    name: 'Work',
    content: '<p>User One / james9Mail</p>',
    isDefault: true,
    sortOrder: 1,
    ...over,
  };
}

export function makeAddress(over: Partial<AddressBookEntry> = {}): AddressBookEntry {
  return {
    addressId: 1,
    uid: 'uid-1',
    kind: 'I',
    contactName: 'User Two',
    mailAddress: OTHER,
    org: null,
    phone: null,
    useCount: 3,
    lastUsedAt: '2026-09-20T01:00:00.000Z',
    ...over,
  };
}

export function makeSendOutcome(over: Partial<SendOutcome> = {}): SendOutcome {
  return {
    mailId: 'sent-mail-1',
    mailIds: ['sent-mail-1'],
    delivered: true,
    sentCopySaved: true,
    accepted: [OTHER],
    rejected: [],
    noticeSent: false,
    warnings: [],
    ...over,
  };
}

// ---------------------------------------------------------------- 서버에만 있는 모양들
// 클라이언트가 인라인 타입으로 받는 응답들. 한곳에 모아 둔다.

export interface RuleCondition {
  field: string;
  values: string[];
}

export type RuleAction =
  | { type: 'FILEINTO'; mailboxName: string }
  | { type: 'SPAM'; mailboxName: string }
  | { type: 'DELETE' }
  | { type: 'FORWARD'; address: string; keepCopy: boolean };

export interface RuleModelRule {
  screen: 'FILTER' | 'REJECT' | 'FORWARD';
  order: number;
  enabled: boolean;
  name: string;
  conditions: RuleCondition[];
  action: RuleAction;
  startDate?: string | null;
  endDate?: string | null;
}

export interface VacationModel {
  enabled: boolean;
  name: string;
  order: number;
  subject: string;
  body: string;
  days: number;
  startDate: string | null;
  endDate: string | null;
}

export interface RulesModel {
  filters: RuleModelRule[];
  rejects: RuleModelRule[];
  forwards: RuleModelRule[];
  vacation: VacationModel | null;
  activatedAt: string | null;
}

export function emptyRules(): RulesModel {
  return { filters: [], rejects: [], forwards: [], vacation: null, activatedAt: null };
}

export interface ExternalAccount {
  externalId: number;
  externalName: string;
  serverHost: string;
  serverPort: number;
  protocol: 'POP3' | 'IMAP';
  securityType: 'PLAIN' | 'SSL';
  loginId: string;
  targetMailboxId: string;
  lastRunAt: string | null;
}

export interface ExternalRunLog {
  logId: number;
  startTime: string | null;
  endTime: string | null;
  mailCount: number;
  runStatus: string;
  errorMsg: string | null;
}

export interface UploadHistory {
  uploadId: number;
  mailboxName: string;
  fileCount: number;
  doneCount: number;
  runStatus: string;
  runDate: string | null;
}

export interface ReceiptRow {
  mailId: string;
  subject: string | null;
  sentAt: string | null;
  recipientCount: number;
  readCount: number;
  untrackedCount: number;
  firstRecipient: string | null;
}

export interface ReceiptDetailRow {
  recipient: string;
  name?: string | null;
  readDate: string | null;
  tracked: boolean;
  recallable: boolean;
}

export interface AttendanceRow {
  recipient: string;
  response: 'ACCEPT' | 'TENTATIVE' | 'DECLINE' | null;
  respondedAt: string | null;
}

export interface AdminUser {
  userName: string;
  displayName: string | null;
  status: string;
  used: number;
  limit: number | null;
  unlimited: boolean;
  regDate: string | null;
}

export interface AdminAlias {
  aliasAddress: string;
  aliasName: string;
  status: string;
  regDate: string | null;
  targets: string[];
}

/** JAMES_MAIL 로그 한 줄. mailType 은 II 내부 · IO 외부발송 · OI 외부수신 */
export interface AdminMailLog {
  mailId: string;
  subject: string | null;
  date: string | null;
  from: string | null;
  fromDisplay: string | null;
  to: string | null;
  toDisplay: string | null;
  mailType: string | null;
  recipientCount: number;
}

export interface DropEntry {
  id: number;
  type: string;
  entity: string;
}
