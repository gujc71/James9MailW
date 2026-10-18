/**
 * GU_ 웹 전용 테이블 조회·갱신 (web.md).
 * James 엔진이 쓰지 않는 표라 여기서는 DB 에 직접 쓴다.
 */
import { db, dbWrite } from '../db/kysely.js';
import { escapeLike, toIso } from '../util/mysql.js';

// ------------------------------------------------------------------ GU_SITE_CONFIG

/**
 * 관리자가 고르는 강조색 토큰 (ADM-2). CSS 의 --accent* 와 1:1 로 맞춘다.
 * 값은 늘 '#rrggbb' 소문자 6자리다. 파생(호버·연한 배경 등)을 서버에서 계산하지
 * 않고 아홉 색을 그대로 저장한다 — 화면에서는 CSS 변수에 그대로 얹기만 하면 되고,
 * 관리자가 항목별로 따로 고른 값도 그대로 남는다.
 * 반투명 계열(--ring, --sh-accent 등)은 accent 에서 알파만 바꿔 쓰므로 항목이 없다.
 */
export const THEME_KEYS = [
  'accent',
  'accentHover',
  'accentText',
  'accentPale',
  'accentSoft',
  'accentSoft2',
  'gradFrom',
  'gradTo',
  'syntaxField',
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];
export type SiteTheme = Record<ThemeKey, string>;

/** styles.css :root 의 현재 값. 관리자가 손대지 않으면 화면은 지금과 똑같다 */
export const THEME_DEFAULT: SiteTheme = {
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

const HEX_RE = /^#[0-9a-f]{6}$/;

/** SITE_THEME 칸의 JSON 을 기본값 위에 얹는다. 깨진 값은 조용히 버린다 */
function parseTheme(raw: string | null): SiteTheme {
  const theme = { ...THEME_DEFAULT };
  if (!raw) return theme;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return theme;
  }
  if (!parsed || typeof parsed !== 'object') return theme;
  for (const key of THEME_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && HEX_RE.test(value)) theme[key] = value;
  }
  return theme;
}

/** 기본값과 같은 항목은 담지 않는다 — 기본 팔레트가 바뀌면 그때 따라가도록 */
function serializeTheme(theme: SiteTheme): string | null {
  const diff: Partial<SiteTheme> = {};
  for (const key of THEME_KEYS) if (theme[key] !== THEME_DEFAULT[key]) diff[key] = theme[key];
  return Object.keys(diff).length ? JSON.stringify(diff) : null;
}

export interface SiteConfig {
  siteName: string;
  logoPath: string | null;
  theme: SiteTheme;
  attachMaxSize: number;
  attachMaxCount: number;
  largeMaxSize: number;
  largeKeepDays: number;
  passwordMinLen: number;
  passwordMinSpec: number;
}

const SITE_DEFAULT: SiteConfig = {
  siteName: 'James9Mail',
  logoPath: null,
  theme: THEME_DEFAULT,
  attachMaxSize: 31_457_280,
  attachMaxCount: 10,
  largeMaxSize: 104_857_600,
  largeKeepDays: 30,
  passwordMinLen: 8,
  passwordMinSpec: 2,
};

/**
 * 사이트 설정은 발송·첨부·로그인마다 읽지만 바뀌는 일은 드물다. 짧게 캐시하고 저장할 때 비운다.
 * 웹서버가 여러 대면 다른 서버의 변경은 최대 TTL 만큼 늦게 보인다.
 */
const SITE_CACHE_MS = 30_000;
let siteCache: { value: Promise<SiteConfig>; at: number } | null = null;

export function getSiteConfig(): Promise<SiteConfig> {
  const now = Date.now();
  if (siteCache && now - siteCache.at < SITE_CACHE_MS) return siteCache.value;
  const value = loadSiteConfig();
  siteCache = { value, at: now };
  // 실패한 조회를 캐시에 남기지 않는다
  value.catch(() => {
    if (siteCache?.value === value) siteCache = null;
  });
  return value;
}

async function loadSiteConfig(): Promise<SiteConfig> {
  const row = await db
    .selectFrom('GU_SITE_CONFIG')
    .selectAll()
    .where('CONFIG_ID', '=', 1)
    .executeTakeFirst();
  if (!row) return SITE_DEFAULT;
  return {
    siteName: row.SITE_NAME,
    logoPath: row.SITE_LOGO_PATH,
    theme: parseTheme(row.SITE_THEME),
    attachMaxSize: Number(row.ATTACH_MAX_SIZE),
    attachMaxCount: row.ATTACH_MAX_COUNT,
    largeMaxSize: Number(row.LARGE_MAX_SIZE),
    largeKeepDays: row.LARGE_KEEP_DAYS,
    passwordMinLen: row.PASSWORD_MIN_LEN,
    passwordMinSpec: row.PASSWORD_MIN_SPEC,
  };
}

export async function saveSiteConfig(
  patch: Partial<Omit<SiteConfig, 'theme'>> & { theme?: Partial<SiteTheme> },
): Promise<void> {
  const current = await loadSiteConfig();
  // theme 은 항목별로 저장하는 화면이라 통째로 덮지 않고 넘어온 색만 얹는다
  const merged: SiteConfig = { ...current, ...patch, theme: { ...current.theme, ...patch.theme } };
  await dbWrite
    .insertInto('GU_SITE_CONFIG')
    .values({
      CONFIG_ID: 1,
      SITE_NAME: merged.siteName,
      SITE_LOGO_PATH: merged.logoPath,
      SITE_THEME: serializeTheme(merged.theme),
      ATTACH_MAX_SIZE: merged.attachMaxSize,
      ATTACH_MAX_COUNT: merged.attachMaxCount,
      LARGE_MAX_SIZE: merged.largeMaxSize,
      LARGE_KEEP_DAYS: merged.largeKeepDays,
      PASSWORD_MIN_LEN: merged.passwordMinLen,
      PASSWORD_MIN_SPEC: merged.passwordMinSpec,
      UPDATE_DATE: new Date(),
    })
    .onDuplicateKeyUpdate({
      SITE_NAME: merged.siteName,
      SITE_LOGO_PATH: merged.logoPath,
      SITE_THEME: serializeTheme(merged.theme),
      ATTACH_MAX_SIZE: merged.attachMaxSize,
      ATTACH_MAX_COUNT: merged.attachMaxCount,
      LARGE_MAX_SIZE: merged.largeMaxSize,
      LARGE_KEEP_DAYS: merged.largeKeepDays,
      PASSWORD_MIN_LEN: merged.passwordMinLen,
      PASSWORD_MIN_SPEC: merged.passwordMinSpec,
      UPDATE_DATE: new Date(),
    })
    .execute();
  siteCache = null;
}

// ------------------------------------------------------------------ GU_USER_SETTING

export interface UserSetting {
  listPageSize: number;
  sendConfirmYn: boolean;
  personalSignYn: boolean;
  vcardYn: boolean;
  rejectUseYn: boolean;
  vacationUseYn: boolean;
  forwardUseYn: boolean;
  /** 외부 프로그램(썬더버드 등)에서 CalDAV 로 일정 관리 (routes/caldav.ts) */
  caldavUseYn: boolean;
  /** 외부 프로그램(썬더버드 등)에서 CardDAV 로 주소록 관리 (routes/carddav.ts) */
  carddavUseYn: boolean;
}

const SETTING_DEFAULT: UserSetting = {
  listPageSize: 50,
  sendConfirmYn: true,
  personalSignYn: false,
  vcardYn: false,
  rejectUseYn: false,
  vacationUseYn: false,
  forwardUseYn: false,
  caldavUseYn: false,
  carddavUseYn: false,
};

const yn = (value: boolean) => (value ? 'Y' : 'N');
const isY = (value: string | null | undefined) => (value ?? 'N').toUpperCase() === 'Y';

export async function getUserSetting(userName: string): Promise<UserSetting> {
  const row = await db
    .selectFrom('GU_USER_SETTING')
    .selectAll()
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  if (!row) return SETTING_DEFAULT;
  return {
    listPageSize: row.LIST_PAGE_SIZE,
    sendConfirmYn: isY(row.SEND_CONFIRM_YN),
    personalSignYn: isY(row.PERSONAL_SIGN_YN),
    vcardYn: isY(row.VCARD_YN),
    rejectUseYn: isY(row.REJECT_USE_YN),
    vacationUseYn: isY(row.VACATION_USE_YN),
    forwardUseYn: isY(row.FORWARD_USE_YN),
    caldavUseYn: isY(row.CALDAV_USE_YN),
    carddavUseYn: isY(row.CARDDAV_USE_YN),
  };
}

export async function saveUserSetting(
  userName: string,
  patch: Partial<UserSetting>,
): Promise<UserSetting> {
  const merged = { ...(await getUserSetting(userName)), ...patch };
  const values = {
    USER_NAME: userName,
    LIST_PAGE_SIZE: merged.listPageSize,
    SEND_CONFIRM_YN: yn(merged.sendConfirmYn),
    // 서명 위치 · 전사 서명을 걷어낸 뒤에도 두 컬럼은 NOT NULL 로 남아 있다
    // (sql/01-gu-tables.sql). 값을 빼면 INSERT 가 깨지므로 고정값을 적는다.
    SIGN_POSITION: 'B',
    COMPANY_SIGN_YN: 'N',
    PERSONAL_SIGN_YN: yn(merged.personalSignYn),
    VCARD_YN: yn(merged.vcardYn),
    REJECT_USE_YN: yn(merged.rejectUseYn),
    VACATION_USE_YN: yn(merged.vacationUseYn),
    FORWARD_USE_YN: yn(merged.forwardUseYn),
    CALDAV_USE_YN: yn(merged.caldavUseYn),
    CARDDAV_USE_YN: yn(merged.carddavUseYn),
    UPDATE_DATE: new Date(),
  };
  const { USER_NAME: _ignored, ...update } = values;
  await dbWrite.insertInto('GU_USER_SETTING').values(values).onDuplicateKeyUpdate(update).execute();
  return merged;
}

// ------------------------------------------------------------------ GU_SIGNATURE

export interface SignatureRow {
  signatureId: number;
  userName: string;
  name: string;
  content: string;
  isDefault: boolean;
  sortOrder: number;
}

/**
 * GU_SIGNATURE 한 줄 → SignatureRow.
 * SIGN_SCOPE 는 전사 서명을 걷어낸 뒤로 늘 P 다 — 컬럼만 NOT NULL 로 남아 있다.
 */
function toSignature(r: {
  SIGNATURE_ID: number | bigint;
  USER_NAME: string | null;
  SIGN_NAME: string;
  SIGN_CONTENT: string;
  IS_DEFAULT: string | null;
  SORT_ORDER: number;
}): SignatureRow {
  return {
    signatureId: Number(r.SIGNATURE_ID),
    userName: r.USER_NAME ?? '',
    name: r.SIGN_NAME,
    content: r.SIGN_CONTENT,
    isDefault: isY(r.IS_DEFAULT),
    sortOrder: r.SORT_ORDER,
  };
}

/**
 * 내 서명 목록. SIGN_SCOPE 를 P 로 좁히는 건 옛 전사 서명 행(USER_NAME 이 null 인 C 행)이
 * DB 에 남아 있을 수 있어서다 — 기능이 사라졌으니 어디에도 나오지 않아야 한다.
 */
export async function listSignatures(userName: string): Promise<SignatureRow[]> {
  const rows = await db
    .selectFrom('GU_SIGNATURE')
    .selectAll()
    .where('SIGN_SCOPE', '=', 'P')
    .where('USER_NAME', '=', userName)
    .orderBy('SORT_ORDER', 'asc')
    .orderBy('SIGNATURE_ID', 'asc')
    .execute();
  return rows.map(toSignature);
}

/** 수정 · 삭제 전 대상 확인용. 소유권 판단은 부르는 쪽(라우트)이 한다 */
export async function findSignature(signatureId: number): Promise<SignatureRow | null> {
  const row = await db
    .selectFrom('GU_SIGNATURE')
    .selectAll()
    .where('SIGNATURE_ID', '=', signatureId)
    .where('SIGN_SCOPE', '=', 'P')
    .executeTakeFirst();
  return row ? toSignature(row) : null;
}

/** 발송 시 서명 소유권 확인. 본인 서명이어야 한다 (3-1) */
export async function findUsableSignature(
  userName: string,
  signatureId: number,
): Promise<SignatureRow | null> {
  const all = await listSignatures(userName);
  return all.find((s) => s.signatureId === signatureId) ?? null;
}

/** 그 사람의 기본 서명을 모두 내린다 */
function clearDefaults(userName: string) {
  return dbWrite
    .updateTable('GU_SIGNATURE')
    .set({ IS_DEFAULT: 'N' })
    .where('USER_NAME', '=', userName)
    .execute();
}

export async function createSignature(
  userName: string,
  input: { name: string; content: string; isDefault: boolean; sortOrder: number },
): Promise<number> {
  if (input.isDefault) await clearDefaults(userName);
  const result = await dbWrite
    .insertInto('GU_SIGNATURE')
    .values({
      USER_NAME: userName,
      // 컬럼은 NOT NULL 로 남아 있다. 이제 개인 서명뿐이므로 늘 P 다
      SIGN_SCOPE: 'P',
      SIGN_NAME: input.name,
      SIGN_CONTENT: input.content,
      IS_DEFAULT: yn(input.isDefault),
      SORT_ORDER: input.sortOrder,
      REG_DATE: new Date(),
      UPDATE_DATE: new Date(),
    })
    .executeTakeFirst();
  return Number(result.insertId ?? 0);
}

/** 서명 내용 수정. 소유권은 라우트가 findSignature 로 먼저 가린다 */
export async function updateSignature(
  signatureId: number,
  patch: { name?: string; content?: string; sortOrder?: number },
): Promise<void> {
  const values: Record<string, unknown> = { UPDATE_DATE: new Date() };
  if (patch.name !== undefined) values.SIGN_NAME = patch.name;
  if (patch.content !== undefined) values.SIGN_CONTENT = patch.content;
  if (patch.sortOrder !== undefined) values.SORT_ORDER = patch.sortOrder;
  await dbWrite
    .updateTable('GU_SIGNATURE')
    .set(values as never)
    .where('SIGNATURE_ID', '=', signatureId)
    .execute();
}

/**
 * 기본 서명을 정한다 (USR-17). signatureId 가 null 이면 기본 없음.
 * 기본은 하나뿐이어야 하므로 내리고 올리는 두 걸음을 여기서 묶는다.
 */
export async function setDefaultSignature(
  userName: string,
  signatureId: number | null,
): Promise<void> {
  await clearDefaults(userName);
  if (signatureId === null) return;
  await dbWrite
    .updateTable('GU_SIGNATURE')
    .set({ IS_DEFAULT: 'Y', UPDATE_DATE: new Date() })
    .where('SIGNATURE_ID', '=', signatureId)
    .where('USER_NAME', '=', userName)
    .execute();
}

export async function deleteSignature(signatureId: number): Promise<void> {
  await dbWrite.deleteFrom('GU_SIGNATURE').where('SIGNATURE_ID', '=', signatureId).execute();
}

// ------------------------------------------------------------- GU_RECENT_RECIPIENT

export interface RecentRecipientRow {
  contactName: string | null;
  mailAddress: string;
  lastUsedAt: string | null;
}

/**
 * USR-1.4 의 "최근에 발송한 계정 10개" 드롭다운. 주소록(외부 주소만 모은다)과 달리
 * 내부·외부를 가리지 않고 최근에 보낸 주소를 돌려준다.
 */
export async function recentRecipients(userName: string, limit = 10): Promise<RecentRecipientRow[]> {
  const rows = await db
    .selectFrom('GU_RECENT_RECIPIENT')
    .selectAll()
    .where('USER_NAME', '=', userName)
    .orderBy('LAST_USED_AT', 'desc')
    .orderBy('RECENT_ID', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    contactName: r.CONTACT_NAME,
    mailAddress: r.MAIL_ADDRESS,
    lastUsedAt: toIso(r.LAST_USED_AT),
  }));
}

/** 발송한 주소를 최근 목록에 남긴다. 주소당 한 행이라 이미 있으면 시각만 밀어 올린다 */
export async function touchRecentRecipient(params: {
  userName: string;
  mailAddress: string;
  contactName?: string | null;
}): Promise<void> {
  const now = new Date();
  await dbWrite
    .insertInto('GU_RECENT_RECIPIENT')
    .values({
      USER_NAME: params.userName,
      CONTACT_NAME: params.contactName ?? null,
      MAIL_ADDRESS: params.mailAddress,
      LAST_USED_AT: now,
    })
    .onDuplicateKeyUpdate((eb) => ({
      // 이번에 이름을 모르면 전에 남겨 둔 이름을 지우지 않는다
      CONTACT_NAME: params.contactName ?? eb.ref('GU_RECENT_RECIPIENT.CONTACT_NAME'),
      LAST_USED_AT: now,
    }))
    .execute();
}

// ------------------------------------------------------------------ GU_LARGE_ATTACH

export interface LargeAttachRow {
  attachId: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  contentType: string | null;
  userName: string;
  mailId: string | null;
  expireDate: string | null;
}

export async function createLargeAttach(row: {
  attachId: string;
  userName: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  contentType: string | null;
  keepDays: number;
}): Promise<void> {
  const now = new Date();
  const expire = new Date(now.getTime() + row.keepDays * 24 * 60 * 60 * 1000);
  await dbWrite
    .insertInto('GU_LARGE_ATTACH')
    .values({
      ATTACH_ID: row.attachId,
      MAIL_ID: null,
      USER_NAME: row.userName,
      FILE_NAME: row.fileName,
      FILE_SIZE: row.fileSize,
      FILE_PATH: row.filePath,
      CONTENT_TYPE: row.contentType,
      DOWN_COUNT: 0,
      EXPIRE_DATE: expire,
      REG_DATE: now,
    })
    .execute();
}

export async function findLargeAttachments(
  userName: string,
  attachIds: string[],
): Promise<LargeAttachRow[]> {
  if (attachIds.length === 0) return [];
  const rows = await db
    .selectFrom('GU_LARGE_ATTACH')
    .selectAll()
    .where('ATTACH_ID', 'in', attachIds)
    .where('USER_NAME', '=', userName)
    .execute();
  return rows.map((r) => ({
    attachId: r.ATTACH_ID,
    fileName: r.FILE_NAME,
    fileSize: Number(r.FILE_SIZE),
    filePath: r.FILE_PATH,
    contentType: r.CONTENT_TYPE,
    userName: r.USER_NAME,
    mailId: r.MAIL_ID,
    expireDate: toIso(r.EXPIRE_DATE),
  }));
}

/** 발송 시점에 senderMailId 로 MAIL_ID 를 채운다 (webmail-issues.md 3-7) */
export async function linkLargeAttachments(attachIds: string[], mailId: string): Promise<void> {
  if (attachIds.length === 0) return;
  await dbWrite
    .updateTable('GU_LARGE_ATTACH')
    .set({ MAIL_ID: mailId })
    .where('ATTACH_ID', 'in', attachIds)
    .execute();
}

export async function getDownloadableAttach(attachId: string): Promise<LargeAttachRow | null> {
  const row = await db
    .selectFrom('GU_LARGE_ATTACH')
    .selectAll()
    .where('ATTACH_ID', '=', attachId)
    .where('EXPIRE_DATE', '>', new Date())
    .executeTakeFirst();
  if (!row) return null;
  return {
    attachId: row.ATTACH_ID,
    fileName: row.FILE_NAME,
    fileSize: Number(row.FILE_SIZE),
    filePath: row.FILE_PATH,
    contentType: row.CONTENT_TYPE,
    userName: row.USER_NAME,
    mailId: row.MAIL_ID,
    expireDate: toIso(row.EXPIRE_DATE),
  };
}

export async function bumpDownloadCount(attachId: string): Promise<void> {
  await dbWrite
    .updateTable('GU_LARGE_ATTACH')
    .set((eb) => ({ DOWN_COUNT: eb('DOWN_COUNT', '+', 1) }))
    .where('ATTACH_ID', '=', attachId)
    .execute();
}

/** 만료·고아 첨부 정리 (3-7) */
export async function listExpiredAttachments(): Promise<LargeAttachRow[]> {
  const rows = await db
    .selectFrom('GU_LARGE_ATTACH')
    .selectAll()
    .where('EXPIRE_DATE', '<', new Date())
    .execute();
  return rows.map((r) => ({
    attachId: r.ATTACH_ID,
    fileName: r.FILE_NAME,
    fileSize: Number(r.FILE_SIZE),
    filePath: r.FILE_PATH,
    contentType: r.CONTENT_TYPE,
    userName: r.USER_NAME,
    mailId: r.MAIL_ID,
    expireDate: toIso(r.EXPIRE_DATE),
  }));
}

export async function deleteLargeAttach(attachId: string): Promise<void> {
  await dbWrite.deleteFrom('GU_LARGE_ATTACH').where('ATTACH_ID', '=', attachId).execute();
}

// ------------------------------------------------------------------ GU_CALENDAR_RESPONSE

export async function getCalendarResponse(
  mailId: string,
  userName: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('GU_CALENDAR_RESPONSE')
    .select('RESPONSE_TYPE')
    .where('MAIL_ID', '=', mailId)
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  return row?.RESPONSE_TYPE ?? null;
}

/** 한 번 응답하면 바꿀 수 없다. INSERT 만 하고 UPDATE 하지 않는다 (web.md 6 절) */
export async function saveCalendarResponse(
  mailId: string,
  userName: string,
  responseType: 'ACCEPT' | 'TENTATIVE' | 'DECLINE',
): Promise<boolean> {
  // 조회 후 삽입은 두 요청이 동시에 오면 둘 다 통과한다. PK(MAIL_ID, USER_NAME) 에 맡긴다
  const result = await dbWrite
    .insertInto('GU_CALENDAR_RESPONSE')
    .ignore()
    .values({
      MAIL_ID: mailId,
      USER_NAME: userName,
      RESPONSE_TYPE: responseType,
      RESPONSE_DATE: new Date(),
    })
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/**
 * 아직 캘린더에 반영하지 않은 일정 응답(REPLY) 메일 후보. text/calendar 파트가 있고
 * Content-Type 파라미터가 비었거나 REPLY 를 말하는 것만, 오래된 순으로 (나중 응답이 이긴다).
 * 반영한 메일은 GU_CALENDAR_RESPONSE 에 'APPLIED' 로 남는다 — REPLY 메일에는 내 응답이 없으니 겹치지 않는다.
 */
export async function pendingReplyMails(
  userName: string,
  since: Date,
  limit: number,
): Promise<{ mailId: string; filePath: string }[]> {
  const rows = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .leftJoin('GU_CALENDAR_RESPONSE as r', (join) =>
      join.onRef('r.MAIL_ID', '=', 'o.MAIL_ID').on('r.USER_NAME', '=', userName),
    )
    .select(['m.MAIL_ID as mailId', 'm.MAIL_FILE_PATH as filePath'])
    .where('b.USER_NAME', '=', userName)
    .where('o.MAIL_DATE', '>=', since)
    .where('r.MAIL_ID', 'is', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('JAMES_MAIL_MIME_PART as p')
          .select('p.PART_ID')
          .whereRef('p.MAIL_ID', '=', 'm.MAIL_ID')
          .where('p.MIME_TYPE', '=', 'text')
          .where('p.MIME_SUBTYPE', '=', 'calendar')
          .where((w) => w.or([w('p.CONTENT_TYPE_PARAMS', 'is', null), w('p.CONTENT_TYPE_PARAMS', 'like', '%reply%')])),
      ),
    )
    .groupBy(['m.MAIL_ID', 'm.MAIL_FILE_PATH', 'm.MAIL_DATE'])
    .orderBy('m.MAIL_DATE', 'asc')
    .limit(limit)
    .execute();
  return rows;
}

/**
 * 일정 응답(REPLY)일 수 있는 받은 메일 전부 — 반영 여부와 상관없이, 오래된 순으로.
 * 약속 응답 확인 창이 외부 수신자의 응답을 찾을 때 쓴다 (services/calendarAttendance.ts).
 */
export async function replyMailCandidates(
  userName: string,
  since: Date,
  limit: number,
): Promise<{ mailId: string; filePath: string; mailDate: Date | null }[]> {
  const rows = await db
    .selectFrom('JAMES_MAIL_OWNER as o')
    .innerJoin('JAMES_MAILBOX as b', 'b.MAILBOX_ID', 'o.MAILBOX_ID')
    .innerJoin('JAMES_MAIL as m', 'm.MAIL_ID', 'o.MAIL_ID')
    .select(['m.MAIL_ID as mailId', 'm.MAIL_FILE_PATH as filePath', 'm.MAIL_DATE as mailDate'])
    .where('b.USER_NAME', '=', userName)
    .where('o.MAIL_IS_DELETED', '=', 0)
    .where('o.MAIL_DATE', '>=', since)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('JAMES_MAIL_MIME_PART as p')
          .select('p.PART_ID')
          .whereRef('p.MAIL_ID', '=', 'm.MAIL_ID')
          .where('p.MIME_TYPE', '=', 'text')
          .where('p.MIME_SUBTYPE', '=', 'calendar')
          .where((w) => w.or([w('p.CONTENT_TYPE_PARAMS', 'is', null), w('p.CONTENT_TYPE_PARAMS', 'like', '%reply%')])),
      ),
    )
    .groupBy(['m.MAIL_ID', 'm.MAIL_FILE_PATH', 'm.MAIL_DATE'])
    .orderBy('m.MAIL_DATE', 'asc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, mailDate: r.mailDate ? new Date(r.mailDate) : null }));
}

export async function markReplyApplied(mailId: string, userName: string): Promise<void> {
  await dbWrite
    .insertInto('GU_CALENDAR_RESPONSE')
    .ignore()
    .values({ MAIL_ID: mailId, USER_NAME: userName, RESPONSE_TYPE: 'APPLIED', RESPONSE_DATE: new Date() })
    .execute();
}

// ------------------------------------------------------------------ GU_MDN_SENT

/** 이 메일의 수신확인 요청에 이미 회신했는가. 보낸 시각(ISO)을 돌려준다 (feature-gap.md 4-4) */
export async function getMdnSentAt(mailId: string, userName: string): Promise<Date | null> {
  const row = await db
    .selectFrom('GU_MDN_SENT')
    .select('SENT_DATE')
    .where('MAIL_ID', '=', mailId)
    .where('USER_NAME', '=', userName)
    .executeTakeFirst();
  return row?.SENT_DATE ? new Date(row.SENT_DATE) : null;
}

/**
 * 회신을 보냈다고 남긴다. 이미 있으면 false — **발송 전에 불러** 두 번 나가는 것을 막는다.
 * 사용자가 버튼을 연달아 누르거나 두 탭에서 같은 메일을 열어도 회신은 한 통이다.
 */
export async function markMdnSent(
  mailId: string,
  userName: string,
  sentTo: string,
): Promise<boolean> {
  // PK(MAIL_ID, USER_NAME) 가 동시 요청 중 하나만 통과시킨다 (조회 후 삽입은 경쟁에 진다)
  const result = await dbWrite
    .insertInto('GU_MDN_SENT')
    .ignore()
    .values({ MAIL_ID: mailId, USER_NAME: userName, SENT_TO: sentTo, SENT_DATE: new Date() })
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/** 회신에 실패했으면 기록을 되돌린다. 안 그러면 다시 시도할 길이 없다 */
export async function clearMdnSent(mailId: string, userName: string): Promise<void> {
  await dbWrite
    .deleteFrom('GU_MDN_SENT')
    .where('MAIL_ID', '=', mailId)
    .where('USER_NAME', '=', userName)
    .execute();
}

// ------------------------------------------------------------------ GU_ADMIN_AUDIT

/** 관리자 원문 열람·삭제는 반드시 기록한다 (webmail-issues.md 7-9) */
export async function writeAudit(entry: {
  adminName: string;
  action: string;
  target?: string | null;
  remoteAddr?: string | null;
}): Promise<void> {
  await dbWrite
    .insertInto('GU_ADMIN_AUDIT')
    .values({
      ADMIN_NAME: entry.adminName,
      ACTION: entry.action,
      TARGET: entry.target ?? null,
      REMOTE_ADDR: entry.remoteAddr ?? null,
      REG_DATE: new Date(),
    })
    .execute();
}
