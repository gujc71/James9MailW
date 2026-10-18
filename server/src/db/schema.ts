/**
 * Kysely table types for the James and GU schemas.
 *
 * webmail-architecture.md 2.1 은 kysely-codegen 으로 타입을 생성하라고 한다
 * (`npm run db:codegen`). 그 명령은 실행 중인 DB 가 있어야 하므로, 여기에는
 * james9mail.md / web.md DDL 과 실제 DB 를 대조해 손으로 옮긴 정의를 둔다.
 * 생성 결과로 교체하려면 이 파일의 Database 인터페이스만 바꾸면 된다.
 *
 * 실측 차이 한 가지: james9mail.md 는 JAMES_USER 의 PK 를 EMAIL 로 적었지만
 * 실제 테이블과 JPAUser 엔티티는 USER_NAME 이다. 값은 둘 다 full address 이며
 * 컬럼명은 JAMES_USER_ID_COLUMN 한 곳에서만 참조한다.
 */
import type { ColumnType, Generated } from 'kysely';

/** DATETIME 컬럼. mysql2 가 Date 로 돌려주고, 쓸 때는 Date 로 넣는다 */
type DateTime = ColumnType<Date, Date | string, Date | string>;
type DateTimeNull = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** BIT(1). mysql2 는 Buffer 로 돌려준다 (util/mysql.ts 의 toBool 참고) */
type Bit = ColumnType<Buffer | number, number, number>;

/** JAMES_USER 의 식별자 컬럼 이름. 문서는 EMAIL, 실제 스키마는 USER_NAME */
export const JAMES_USER_ID_COLUMN = 'USER_NAME';

// ------------------------------------------------------------------ James

export interface JamesMailbox {
  MAILBOX_ID: string;
  MAILBOX_NAME: string;
  MAILBOX_NAMESPACE: string;
  USER_NAME: string | null;
  MAILBOX_UID_VALIDITY: number;
  MAILBOX_LAST_UID: number | null;
  MAILBOX_HIGHEST_MODSEQ: number | null;
  MAILBOX_MESSAGE_COUNT: number | null;
  MAILBOX_SIZE: number | null;
  /** 트리 표시 순서, 1 부터 */
  MAILBOX_ORDER: number | null;
  /** b 기본 편지함, p 개인 편지함 */
  MAILBOX_TYPE: string | null;
}

export interface JamesMail {
  MAIL_ID: string;
  MESSAGE_ID: string;
  MAIL_FROM: string | null;
  MAIL_FROM_DISP: string | null;
  MAIL_SENDER: string | null;
  MAIL_TO: string | null;
  MAIL_TO_DISP: string | null;
  MAIL_SUBJECT: string | null;
  MAIL_DATE: DateTimeNull;
  MAIL_DATE_YMD: string | null;
  MAIL_SIZE: number;
  /** 저장 루트 기준 상대경로 */
  MAIL_FILE_PATH: string;
  MAIL_BODY_START_OCTET: number;
  MAIL_CONTENT_OCTETS_COUNT: number;
  MAIL_REPLY_TO: string | null;
  MAIL_IN_REPLY_TO: string | null;
  /**
   * 이 메일이 속한 대화(스레드)의 뿌리 Message-ID. 꺾쇠를 포함한다.
   * James 가 저장 시점에 한 번 정하고 뒤에 바꾸지 않는다 (ThreadResolver).
   * 이 컬럼이 생기기 전에 저장된 메일은 null 이고, 읽는 쪽은 한 통짜리 대화로 본다.
   */
  MAIL_THREAD_ID: string | null;
  MAIL_HAS_ATTACHMENT: number;
  /** II 내부, IO 발신, OI 수신 */
  MAIL_TYPE: string | null;
}

export interface JamesMailOwner {
  OWNER_ID: string;
  MAILBOX_ID: string | null;
  MAIL_ID: string;
  MAIL_UID: number | null;
  MAIL_MODSEQ: number | null;
  MAIL_DATE: DateTimeNull;
  MAIL_IS_ANSWERED: Bit;
  MAIL_IS_DELETED: Bit;
  MAIL_IS_DRAFT: Bit;
  MAIL_IS_FLAGGED: Bit;
  MAIL_IS_RECENT: Bit;
  MAIL_IS_SEEN: Bit;
}

export interface JamesMailRecipients {
  RECIPIENT_ID: string;
  MAIL_ID: string | null;
  MAIL_ADDRESS: string | null;
  /** to, cc, bcc */
  MAIL_ADDRESS_TYPE: string | null;
}

/**
 * References · In-Reply-To 가 가리키는 조상 Message-ID 한 줄에 한 건 (James 측 테이블).
 * REF_ORDINAL 0 이 대화의 뿌리, 마지막이 직계 부모다. 답장 발송 시 References 사슬을
 * 이어 붙이는 데 쓴다 (services/compose.ts).
 */
export interface JamesMailReference {
  REFERENCE_ID: string;
  MAIL_ID: string | null;
  REF_ORDINAL: number;
  REF_MESSAGE_ID: string;
}

export interface JamesMailMimePart {
  PART_ID: string;
  MAIL_ID: string | null;
  PART_ORDINAL: number;
  PART_PARENT_ORDINAL: number;
  PART_SECTION: string | null;
  MIME_TYPE: string | null;
  MIME_SUBTYPE: string | null;
  CONTENT_TYPE_PARAMS: string | null;
  CONTENT_ID: string | null;
  CONTENT_DESCRIPTION: string | null;
  CONTENT_ENCODING: string | null;
  CONTENT_OCTETS: number;
  LINE_COUNT: number | null;
  CONTENT_MD5: string | null;
  DISPOSITION_TYPE: string | null;
  DISPOSITION_PARAMS: string | null;
  CONTENT_LANGUAGE: string | null;
  CONTENT_LOCATION: string | null;
  FILE_NAME: string | null;
}

export interface JamesMailReceipt {
  MAIL_ID: string;
  RECIPIENT: string;
  /** 발신자 Sent 사본의 MAIL_ID 와 같은 값 */
  SENDER_MAIL_ID: string;
  READ_DATE: DateTimeNull;
}

export interface JamesMailboxAcl {
  MAILBOX_ID: string;
  ENTITY_KEY: string;
  RIGHTS: string;
}

export interface JamesQuotaLimit {
  /** USER, DOMAIN, GLOBAL */
  QUOTA_SCOPE: string;
  /** quotaRoot(#private&user@domain) / 도메인명 / default_key */
  IDENTIFIER: string;
  /** COUNT, SIZE */
  QUOTA_TYPE: string;
  /** null 미설정, -1 무제한 */
  QUOTA_LIMIT: number | null;
}

export interface JamesUser {
  USER_NAME: string;
  PASSWORD: string;
  PASSWORD_HASH_ALGORITHM: string;
  version: number | null;
  USER_DISPLAY_NAME: string | null;
  USER_PHOTO: string | null;
  USER_DATE: DateTimeNull;
  USER_STATUS: string | null;
  IS_ADMIN: string | null;
}

export interface JamesDomain {
  DOMAIN_NAME: string;
}

/**
 * 매핑 타입은 TARGET_ADDRESS 의 "alias:" 접두사가 아니라 MAPPING_TYPE 컬럼에 들어간다.
 * 값은 James 의 Mapping.Type 이름 그대로다: Alias · Group · Forward · Address ·
 * Regex · Domain · DomainAlias · Error. TARGET_ADDRESS 는 접두사 없는 순수 값이다.
 */
export interface JamesRecipientRewrite {
  USER_NAME: string;
  DOMAIN_NAME: string;
  MAPPING_TYPE: string;
  TARGET_ADDRESS: string;
  /** 'N' 이면 James 가 배달에서 건너뛴다. 그 외 값(옛 행의 빈 값 포함)은 모두 사용 중 */
  ALIAS_STATUS: string;
}

export interface JamesDropList {
  DROPLIST_ID: number;
  OWNER_SCOPE: string;
  OWNER: string | null;
  DENIED_ENTITY_TYPE: string;
  DENIED_ENTITY: string;
}

export interface JamesSieveScript {
  uuid: string;
  USER_NAME: string;
  SCRIPT_NAME: string;
  SCRIPT_CONTENT: string;
  SCRIPT_SIZE: number;
  IS_ACTIVE: Bit;
  ACTIVATION_DATE_TIME: DateTimeNull;
}

// ------------------------------------------------------------------ GU (web.md)

export interface GuSiteConfig {
  CONFIG_ID: number;
  SITE_NAME: string;
  SITE_LOGO_PATH: string | null;
  SITE_THEME: string | null;
  ATTACH_MAX_SIZE: number;
  ATTACH_MAX_COUNT: number;
  LARGE_MAX_SIZE: number;
  LARGE_KEEP_DAYS: number;
  PASSWORD_MIN_LEN: number;
  PASSWORD_MIN_SPEC: number;
  UPDATE_DATE: DateTime;
}

export interface GuUserSetting {
  USER_NAME: string;
  LIST_PAGE_SIZE: number;
  SEND_CONFIRM_YN: string;
  SIGN_POSITION: string;
  COMPANY_SIGN_YN: string;
  PERSONAL_SIGN_YN: string;
  VCARD_YN: string;
  REJECT_USE_YN: string;
  VACATION_USE_YN: string;
  FORWARD_USE_YN: string;
  /** 외부 프로그램(CalDAV)에서 일정 관리 (sql/04-caldav.sql) */
  CALDAV_USE_YN: Generated<string>;
  /** 외부 프로그램(CardDAV)에서 주소록 관리 (sql/05-carddav.sql) */
  CARDDAV_USE_YN: Generated<string>;
  UPDATE_DATE: DateTimeNull;
}

export interface GuSignature {
  SIGNATURE_ID: Generated<number>;
  USER_NAME: string | null;
  SIGN_SCOPE: string;
  SIGN_NAME: string;
  SIGN_CONTENT: string;
  IS_DEFAULT: string;
  SORT_ORDER: number;
  REG_DATE: DateTime;
  UPDATE_DATE: DateTimeNull;
}

/** 주소록 한 행 = vCard 한 장 (sql/05-carddav.sql) */
export interface GuAddressBook {
  ADDRESS_ID: Generated<number>;
  USER_NAME: string;
  CONTACT_UID: string;
  DAV_NAME: string | null;
  /** I 개인, G 그룹 */
  CONTACT_KIND: Generated<string>;
  CONTACT_NAME: string | null;
  /** 대표 메일. 전체는 GU_ADDRESS_EMAIL */
  MAIL_ADDRESS: string | null;
  ORG_NAME: string | null;
  PHONE: string | null;
  VCARD_DATA: string | null;
  USE_COUNT: number;
  LAST_USED_AT: DateTimeNull;
  REG_DATE: DateTime;
  /** DATETIME(3). 내용이 바뀔 때만 고친다 (ETag) */
  UPDATE_DATE: DateTime;
}

export interface GuAddressEmail {
  ADDRESS_ID: number;
  SORT_ORDER: number;
  USER_NAME: string;
  MAIL_ADDRESS: string;
}

export interface GuRecentRecipient {
  RECENT_ID: Generated<number>;
  USER_NAME: string;
  CONTACT_NAME: string | null;
  MAIL_ADDRESS: string;
  LAST_USED_AT: DateTime;
}

export interface GuExternalEmail {
  EXTERNAL_ID: Generated<number>;
  USER_NAME: string;
  EXTERNAL_NAME: string;
  SERVER_HOST: string;
  SERVER_PORT: number;
  PROTOCOL: string;
  SECURITY_TYPE: string;
  LOGIN_ID: string;
  LOGIN_PASSWD: string;
  TARGET_MAILBOX_ID: string;
  LAST_RUN_AT: DateTimeNull;
  REG_DATE: DateTime;
  UPDATE_DATE: DateTimeNull;
}

export interface GuExternalEmailLog {
  LOG_ID: Generated<number>;
  EXTERNAL_ID: number;
  START_TIME: DateTime;
  END_TIME: DateTimeNull;
  MAIL_COUNT: number;
  RUN_STATUS: string;
  ERROR_MSG: string | null;
}

export interface GuMailUpload {
  UPLOAD_ID: Generated<number>;
  USER_NAME: string;
  MAILBOX_ID: string;
  MAILBOX_NAME: string;
  FILE_COUNT: number;
  DONE_COUNT: number;
  RUN_STATUS: string;
  RUN_DATE: DateTime;
}

export interface GuLargeAttach {
  ATTACH_ID: string;
  MAIL_ID: string | null;
  USER_NAME: string;
  FILE_NAME: string;
  FILE_SIZE: number;
  FILE_PATH: string;
  CONTENT_TYPE: string | null;
  DOWN_COUNT: number;
  EXPIRE_DATE: DateTime;
  REG_DATE: DateTime;
}

export interface GuCalendarResponse {
  MAIL_ID: string;
  USER_NAME: string;
  RESPONSE_TYPE: string;
  RESPONSE_DATE: DateTime;
}

/** 받은 메일의 수신확인 요청(MDN)에 회신한 기록 (feature-gap.md 4-4) */
export interface GuMdnSent {
  MAIL_ID: string;
  USER_NAME: string;
  SENT_TO: string;
  SENT_DATE: DateTime;
}

export interface GuMailAlias {
  ALIAS_USER: string;
  ALIAS_DOMAIN: string;
  ALIAS_NAME: string;
  ALIAS_STATUS: string;
  REG_DATE: DateTime;
  UPDATE_DATE: DateTimeNull;
}

export interface GuMessageTombstone {
  SEQ: Generated<number>;
  MAILBOX_ID: string;
  MAIL_UID: number;
  MAIL_ID: string;
  DELETED_AT: DateTime;
}

export interface GuSyncMarker {
  MARKER_KEY: string;
  MARKER_VAL: number;
}

export interface GuAdminAudit {
  AUDIT_ID: Generated<number>;
  ADMIN_NAME: string;
  ACTION: string;
  TARGET: string | null;
  REMOTE_ADDR: string | null;
  REG_DATE: DateTime;
}

// ------------------------------------------------------------------ 캘린더 (sql/03-calendar-tables.sql)

export interface CalCalendar {
  CALENDAR_ID: Generated<number>;
  USER_NAME: string;
  CAL_NAME: string;
  CAL_COLOR: string;
  /** LOCAL 내 캘린더, ICS 네트워크 구독 */
  CAL_TYPE: string;
  SOURCE_URL: string | null;
  REFRESH_MIN: number;
  LAST_SYNC: DateTimeNull;
  SYNC_ERROR: string | null;
  VISIBLE_YN: string;
  READONLY_YN: string;
  ALARM_YN: string;
  DEFAULT_YN: string;
  FEED_TOKEN: string | null;
  SORT_ORDER: number;
  REG_DATE: DateTime;
  UPDATE_DATE: DateTime;
}

export interface CalItem {
  ITEM_ID: string;
  CALENDAR_ID: number;
  USER_NAME: string;
  /** E 이벤트, T 태스크 */
  ITEM_TYPE: string;
  ICAL_UID: string;
  PARENT_ID: string | null;
  RECURRENCE_ID: string | null;
  TITLE: string;
  LOCATION: string | null;
  DESCRIPTION: string | null;
  ITEM_URL: string | null;
  ALL_DAY_YN: string;
  TZID: string;
  START_LOCAL: string | null;
  END_LOCAL: string | null;
  DUE_LOCAL: string | null;
  START_UTC: DateTimeNull;
  END_UTC: DateTimeNull;
  RANGE_END_UTC: DateTimeNull;
  COMPLETED_DATE: DateTimeNull;
  PERCENT_DONE: number;
  STATUS: string | null;
  PRIORITY: number;
  PRIVACY: string;
  TRANSP: string;
  RRULE: string | null;
  EXDATES: string | null;
  CATEGORIES: string | null;
  ORGANIZER: string | null;
  SEQUENCE_NO: number;
  /** CalDAV 자원 이름. NULL 이면 <UID>.ics (sql/04-caldav.sql) */
  DAV_NAME: string | null;
  /** 외부 프로그램이 붙인 X- 속성 원문, 줄바꿈으로 묶는다 */
  EXTRA_PROPS: string | null;
  REG_DATE: DateTime;
  UPDATE_DATE: DateTime;
}

export interface CalAttendee {
  ITEM_ID: string;
  EMAIL: string;
  ATT_NAME: string | null;
  ATT_ROLE: string;
  PARTSTAT: string;
  RSVP_YN: string;
}

export interface CalAlarm {
  ALARM_ID: Generated<number>;
  ITEM_ID: string;
  OFFSET_MIN: number;
  /** S 시작 기준, E 끝(태스크는 기한) 기준 */
  RELATED: string;
}

export interface CalAlarmState {
  ALARM_ID: number;
  OCCUR_KEY: string;
  SNOOZE_UNTIL: DateTimeNull;
  DISMISSED_YN: string;
  UPDATE_DATE: DateTime;
}

export interface CalAttach {
  ATTACH_ID: Generated<number>;
  ITEM_ID: string;
  ATTACH_URL: string;
  ATTACH_NAME: string | null;
}

export interface CalCategory {
  USER_NAME: string;
  CATEGORY_NAME: string;
  CATEGORY_COLOR: string | null;
  SORT_ORDER: number;
}

export interface CalSetting {
  USER_NAME: string;
  TIMEZONE: string;
  WEEK_START: number;
  DAYS_OFF: string;
  DAY_START_HOUR: number;
  DAY_END_HOUR: number;
  VISIBLE_HOURS: number;
  MULTIWEEK_COUNT: number;
  PREV_WEEKS: number;
  WEEKNUM_YN: string;
  DEFAULT_LENGTH_MIN: number;
  DEFAULT_ALARM_MIN: number;
  ALARM_SOUND_YN: string;
  ALARM_POPUP_YN: string;
  MISSED_ALARM_YN: string;
  UPDATE_DATE: DateTime;
}

export interface Database {
  JAMES_MAILBOX: JamesMailbox;
  JAMES_MAIL: JamesMail;
  JAMES_MAIL_OWNER: JamesMailOwner;
  JAMES_MAIL_RECIPIENTS: JamesMailRecipients;
  JAMES_MAIL_REFERENCE: JamesMailReference;
  JAMES_MAIL_MIME_PART: JamesMailMimePart;
  JAMES_MAIL_RECEIPT: JamesMailReceipt;
  JAMES_MAILBOX_ACL: JamesMailboxAcl;
  JAMES_QUOTA_LIMIT: JamesQuotaLimit;
  JAMES_USER: JamesUser;
  JAMES_DOMAIN: JamesDomain;
  JAMES_RECIPIENT_REWRITE: JamesRecipientRewrite;
  JAMES_DROP_LIST: JamesDropList;
  JAMES_SIEVE_SCRIPT: JamesSieveScript;

  GU_SITE_CONFIG: GuSiteConfig;
  GU_USER_SETTING: GuUserSetting;
  GU_SIGNATURE: GuSignature;
  GU_ADDRESS_BOOK: GuAddressBook;
  GU_ADDRESS_EMAIL: GuAddressEmail;
  GU_RECENT_RECIPIENT: GuRecentRecipient;
  GU_EXTERNAL_EMAIL: GuExternalEmail;
  GU_EXTERNAL_EMAIL_LOG: GuExternalEmailLog;
  GU_MAIL_UPLOAD: GuMailUpload;
  GU_LARGE_ATTACH: GuLargeAttach;
  GU_CALENDAR_RESPONSE: GuCalendarResponse;
  GU_MDN_SENT: GuMdnSent;
  GU_MAIL_ALIAS: GuMailAlias;
  GU_MESSAGE_TOMBSTONE: GuMessageTombstone;
  GU_SYNC_MARKER: GuSyncMarker;
  GU_ADMIN_AUDIT: GuAdminAudit;

  CAL_CALENDAR: CalCalendar;
  CAL_ITEM: CalItem;
  CAL_ATTENDEE: CalAttendee;
  CAL_ALARM: CalAlarm;
  CAL_ALARM_STATE: CalAlarmState;
  CAL_ATTACH: CalAttach;
  CAL_CATEGORY: CalCategory;
  CAL_SETTING: CalSetting;
}
