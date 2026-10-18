/** 서버 응답 타입. 서버 라우트와 1:1 로 맞춘다 */

/**
 * 관리자가 고르는 강조색 항목 (ADM-2). 값은 늘 '#rrggbb' 소문자다.
 * CSS 변수로 얹는 일과 색 계산은 lib/theme.ts 가 한다.
 */
export type ThemeKey =
  | 'accent'
  | 'accentHover'
  | 'accentText'
  | 'accentPale'
  | 'accentSoft'
  | 'accentSoft2'
  | 'gradFrom'
  | 'gradTo'
  | 'syntaxField';

export type SiteTheme = Record<ThemeKey, string>;

export interface Usage {
  used: number;
  limit: number | null;
  unlimited: boolean;
  scope: string | null;
}

export interface UserSetting {
  listPageSize: number;
  sendConfirmYn: boolean;
  personalSignYn: boolean;
  vcardYn: boolean;
  rejectUseYn: boolean;
  vacationUseYn: boolean;
  forwardUseYn: boolean;
  /** 외부 프로그램(썬더버드 등)에서 CalDAV 로 일정 관리 */
  caldavUseYn: boolean;
  /** 외부 프로그램(썬더버드 등)에서 CardDAV 로 주소록 관리 */
  carddavUseYn: boolean;
}

export interface SiteConfig {
  siteName: string;
  logoPath: string | null;
  /** 관리자가 고른 강조색 아홉 개 (lib/theme.ts) */
  theme: SiteTheme;
  attachMaxSize: number;
  attachMaxCount: number;
  largeMaxSize: number;
  largeKeepDays: number;
  passwordMinLen: number;
  passwordMinSpec: number;
}

/** 이 계정이 From 으로 쓸 수 있는 알리아스 (feature-gap 4-3) */
export interface SendableAlias {
  address: string;
  /** 관리자가 붙인 이름. 예: "그룹1" */
  aliasName: string;
}

export interface Me {
  userName: string;
  displayName: string | null;
  photo: string | null;
  isAdmin: boolean;
  locale: 'ko' | 'en';
  setting: UserSetting;
  site: SiteConfig;
  usage: Usage;
  /** 비어 있으면 보내는사람은 계정 하나뿐이라 선택칸을 띄우지 않는다 */
  aliases: SendableAlias[];
}

export type MailboxRole =
  | 'INBOX'
  | 'Sent'
  | 'Drafts'
  | 'Trash'
  | 'Spam'
  | 'Outbox'
  | 'Archive'
  | 'personal';

export interface Mailbox {
  id: string;
  name: string;
  displayName: string;
  parentName: string | null;
  role: MailboxRole;
  isSystem: boolean;
  order: number;
  messageCount: number;
  unseenCount: number;
  size: number;
}

export interface MessageSummary {
  mailboxId: string;
  uid: number;
  modseq: number;
  mailId: string;
  receivedAt: string | null;
  sentAt: string | null;
  subject: string | null;
  from: string | null;
  fromDisplay: string | null;
  to: string | null;
  toDisplay: string | null;
  /** 사내 계정일 때의 프로필 사진 URL. 목록 아바타가 쓴다 */
  fromPhoto: string | null;
  toPhoto: string | null;
  size: number;
  hasAttachment: boolean;
  messageId: string;
  inReplyTo: string | null;
  /**
   * 이 메일이 속한 대화의 뿌리 Message-ID (JAMES_MAIL.MAIL_THREAD_ID).
   * 같은 값이면 한 대화다. 스레드 컬럼이 생기기 전에 저장된 메일은 null 이라
   * 목록은 그런 메일을 한 통짜리 대화로 본다 (features/mailbox/thread.ts).
   */
  threadId: string | null;
  mailType: string | null;
  flags: string[];
  /** 보낸 사람이 헤더(Importance·X-Priority)로 선언한 중요도. 별표와 별개다 */
  importance: 'high' | null;
}

export interface MessageDetail extends MessageSummary {
  recipients: { address: string; type: string }[];
  largeAttachments: { attachId: string; fileName: string; fileSize: number }[];
  calendarResponse: string | null;
  /**
   * 보낸 사람이 붙인 수신확인 요청(Disposition-Notification-To). 요청이 없거나 내가 보낸
   * 메일이면 null 이다 — 판정은 서버가 원문 헤더를 읽어 한다 (feature-gap.md 4-4)
   */
  readReceipt: ReadReceiptState | null;
  /** From 이 내 계정이나 알리아스다 — 내가 보낸 약속메일에는 참석/미정/불참을 묻지 않는다 */
  fromMe: boolean;
}

export interface ReadReceiptState {
  /** 회신을 받을 주소. 누구에게 알리는지 보여 주고 나서 묻는다 */
  requestedTo: string;
  /** 이미 회신했으면 그 시각. null 이면 아직 묻는 중 */
  sentAt: string | null;
}

export interface SyncResponse {
  changes: (MessageSummary & { receivedAt: string | null })[];
  tombstones: { seq: number; uid: number; mailId: string }[];
  hasMore: boolean;
}

export interface Signature {
  signatureId: number;
  userName: string | null;
  name: string;
  content: string;
  isDefault: boolean;
  sortOrder: number;
}

/** 주소록 한 행 = vCard 한 장 (개인 또는 그룹). server/src/repositories/contacts.ts ContactRow */
export interface AddressBookEntry {
  addressId: number;
  uid: string;
  /** I 개인, G 그룹 */
  kind: 'I' | 'G';
  contactName: string | null;
  /** 대표 메일. 메일 없는 연락처 · 그룹은 null */
  mailAddress: string | null;
  org: string | null;
  phone: string | null;
  useCount: number;
  lastUsedAt: string | null;
}

export interface ContactTyped {
  type: string;
  value: string;
}

export interface ContactAddress {
  type: string;
  poBox: string;
  extended: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

/** 연락처 필드 (server/src/contacts/vcard.ts ContactFields) */
export interface ContactFields {
  kind: 'individual' | 'group';
  displayName: string;
  familyName: string;
  givenName: string;
  nickname: string;
  emails: ContactTyped[];
  phones: ContactTyped[];
  org: string;
  department: string;
  title: string;
  addresses: ContactAddress[];
  /** YYYY-MM-DD, 해를 모르면 --MM-DD */
  birthday: string;
  urls: string[];
  note: string;
  photo: string | null;
  /** 그룹 멤버: 연락처 UID 또는 'mailto:주소' */
  members: string[];
}

/** 그룹 편집 화면의 멤버. 연락처 행, 지워진 UID, 주소만 적힌 멤버 셋 중 하나 */
export type GroupMember = AddressBookEntry | { uid: string; missing: true } | { address: string };

export interface ContactDetail extends AddressBookEntry {
  fields: ContactFields;
  members: GroupMember[];
}

export interface Recipient {
  name: string | null;
  address: string;
}

/** 수신자 자동완성 후보 (주소록 + 내부 계정 + 알리아스 + 주소록 그룹) */
export interface AddressSuggestion {
  /** 그룹이면 빈 값 */
  address: string;
  name: string | null;
  /** 주소록 그룹이면 멤버를 푼 목록. 고르면 전부 들어간다 */
  groupId?: number;
  members?: Recipient[];
}

export interface AddressSuggestResult {
  items: AddressSuggestion[];
  /** 한도에 걸리지 않고 다 담았다 = 이 목록만으로 더 긴 입력을 걸러도 된다 */
  complete: boolean;
}

export interface SendOutcome {
  mailId: string;
  mailIds: string[];
  /** 한 명에게라도 나갔는가. false 면 아무것도 발송되지 않았다 */
  delivered: boolean;
  sentCopySaved: boolean;
  accepted: string[];
  /** 메일 서버가 거부한 주소 (없는 계정·중지된 계정) */
  rejected: string[];
  /** 거부된 주소가 있어 받은 편지함에 안내메일이 들어갔는가 */
  noticeSent: boolean;
  warnings: string[];
}

