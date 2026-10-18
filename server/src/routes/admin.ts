/**
 * 관리자 화면 (ADM-1 ~ ADM-6).
 *
 * ADM-5 에서 관리자가 원문을 보면 모든 사용자의 메일을 볼 수 있는 경로가 생긴다.
 * 소유자 검사와 별도의 명시적 권한 + 감사 로그를 둔다. 또 관리자 조회는 플래그를
 * 건드리지 않는다 — 건드리면 수신자의 수신확인이 오염된다 (webmail-issues.md 2-16, 7-9).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, notFound } from '../errors.js';
import { db, dbWrite } from '../db/kysely.js';
import { escapeLike, toIso } from '../util/mysql.js';
import * as users from '../repositories/users.js';
import * as quota from '../repositories/quota.js';
import * as gu from '../repositories/gu.js';
import * as contacts from '../repositories/contacts.js';
import * as messages from '../repositories/messages.js';
import { james, MappingType } from '../james/webadmin.js';
import { ensureDefaultMailboxes, purgeUserMailboxes } from '../services/mailboxes.js';
import { openMail } from '../store/mailStore.js';
import { moveFile, parseMultipart } from '../store/uploads.js';
import { config } from '../config.js';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { destroyUserSessions } from '../auth/session.js';
import { sniffImageExt } from '../store/photos.js';
import * as photos from '../store/photos.js';
import { resolveLargePath } from '../store/uploads.js';
import { addDropEntry, normalizeDropEntity } from '../repositories/dropList.js';

/** 색 입력은 소문자 6자리 hex 만 받는다 (ADM-2 강조색) */
const HEX = z.string().regex(/^#[0-9a-f]{6}$/);

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- ADM-1 현황

  app.get('/api/admin/overview', { onRequest: [app.requireAdmin] }, async () => {
    const totals = await quota.siteTotals();

    // 최근 1주일 일자별 발송량. MAIL_DATE_YMD 와 MAIL_TYPE 인덱스를 그대로 쓴다
    const weekly = await db
      .selectFrom('JAMES_MAIL')
      .select(({ fn }) => ['MAIL_DATE_YMD', fn.countAll<number>().as('cnt')])
      .where('MAIL_DATE_YMD', '>=', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10))
      .where('MAIL_TYPE', 'in', ['IO', 'II'])
      .groupBy('MAIL_DATE_YMD')
      .orderBy('MAIL_DATE_YMD', 'asc')
      .execute();

    return {
      totals,
      weekly: weekly.map((r) => ({ date: r.MAIL_DATE_YMD, count: Number(r.cnt) })),
    };
  });

  /** 선택한 날짜의 시간대별 발송량 */
  app.get('/api/admin/hourly', { onRequest: [app.requireAdmin] }, async (request) => {
    const { date } = z
      .object({ date: z.string().default(new Date().toISOString().slice(0, 10)) })
      .parse(request.query);
    const rows = await db
      .selectFrom('JAMES_MAIL')
      .select(({ fn }) => [sql<number>`HOUR(MAIL_DATE)`.as('h'), fn.countAll<number>().as('cnt')])
      .where('MAIL_DATE_YMD', '=', date)
      .where('MAIL_TYPE', 'in', ['IO', 'II'])
      .groupBy(sql`HOUR(MAIL_DATE)`)
      .execute();
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    for (const row of rows) {
      const hour = Number(row.h);
      if (hourly[hour]) hourly[hour].count = Number(row.cnt);
    }
    return hourly;
  });

  // ---------------------------------------------------------------- ADM-2.0 기본 설정

  app.get('/api/admin/site', { onRequest: [app.requireAdmin] }, async () => {
    const [site, domains, globalQuota] = await Promise.all([
      gu.getSiteConfig(),
      users.listDomains(),
      db
        .selectFrom('JAMES_QUOTA_LIMIT')
        .select('QUOTA_LIMIT')
        .where('QUOTA_SCOPE', '=', 'GLOBAL')
        .where('IDENTIFIER', '=', 'default_key')
        .where('QUOTA_TYPE', '=', 'SIZE')
        .executeTakeFirst(),
    ]);

    // DOMAIN 행이 하나라도 있으면 그 도메인에서는 GLOBAL 값이 무시된다.
    // 화면에 보이지 않으면 원인 파악이 어려우므로 함께 내려준다 (webmail-issues.md 6-2).
    const domainQuotas = await db
      .selectFrom('JAMES_QUOTA_LIMIT')
      .select(['IDENTIFIER', 'QUOTA_LIMIT'])
      .where('QUOTA_SCOPE', '=', 'DOMAIN')
      .where('QUOTA_TYPE', '=', 'SIZE')
      .execute();

    return {
      site,
      domains,
      defaultQuota: globalQuota?.QUOTA_LIMIT ?? null,
      domainQuotas: domainQuotas.map((d) => ({
        domain: d.IDENTIFIER,
        limit: d.QUOTA_LIMIT === null ? null : Number(d.QUOTA_LIMIT),
      })),
    };
  });

  app.put('/api/admin/site', { onRequest: [app.requireAdmin] }, async (request) => {
    const input = z
      .object({
        siteName: z.string().min(1).max(100).optional(),
        logoPath: z.string().nullable().optional(),
        attachMaxSize: z.number().int().positive().optional(),
        attachMaxCount: z.number().int().positive().optional(),
        largeMaxSize: z.number().int().positive().optional(),
        largeKeepDays: z.number().int().positive().optional(),
        passwordMinLen: z.number().int().min(4).optional(),
        passwordMinSpec: z.number().int().min(0).optional(),
        /** 신규 계정 기본 용량 = GLOBAL SIZE 행 */
        defaultQuotaBytes: z.number().int().optional(),
        /** ADM-2 강조색. 항목별로 골라 보내며 빠진 항목은 기존 값을 유지한다 (gu.THEME_KEYS) */
        theme: z
          .object({
            accent: HEX.optional(),
            accentHover: HEX.optional(),
            accentText: HEX.optional(),
            accentPale: HEX.optional(),
            accentSoft: HEX.optional(),
            accentSoft2: HEX.optional(),
            gradFrom: HEX.optional(),
            gradTo: HEX.optional(),
            syntaxField: HEX.optional(),
          })
          .optional(),
      })
      .parse(request.body);

    const { defaultQuotaBytes, ...site } = input;
    await gu.saveSiteConfig(site);

    if (defaultQuotaBytes !== undefined) {
      // GLOBAL 행은 quotaRoot 계산이 필요 없어 그대로 upsert 한다
      await dbWrite
        .insertInto('JAMES_QUOTA_LIMIT')
        .values({
          QUOTA_SCOPE: 'GLOBAL',
          IDENTIFIER: 'default_key',
          QUOTA_TYPE: 'SIZE',
          QUOTA_LIMIT: defaultQuotaBytes,
        })
        .onDuplicateKeyUpdate({ QUOTA_LIMIT: defaultQuotaBytes })
        .execute();
    }
    return { ok: true };
  });

  /**
   * ADM-2.0 사이트 로고 업로드. 파일은 LARGE_ATTACH_DIR/site/ 아래에 두고
   * SITE_LOGO_PATH 에는 공개 URL(/api/site/logo/<파일명>)을 저장한다.
   */
  app.post('/api/admin/site/logo', { onRequest: [app.requireAdmin] }, async (request) => {
    const parsed = await parseMultipart(request, { files: 1, fileSize: 2 * 1024 * 1024 + 1 });
    try {
      const file = parsed.files.find((f) => f.field === 'logo');
      if (!file) throw badRequest('err.noLogoFile');
      if (file.size > 2 * 1024 * 1024) throw badRequest('err.logoTooBig');
      // 확장자는 브라우저가 주는 값이라 믿지 않는다. SVG 는 스크립트를 품을 수 있어 새로 받지 않는다
      const ext = await sniffImageExt(file.path);
      if (!ext) throw badRequest('err.imageOnly');
      const dir = path.join(config.paths.largeAttach, 'site');
      await mkdir(dir, { recursive: true });
      const name = `logo-${Date.now()}${ext}`;
      await moveFile(file.path, path.join(dir, name));
      return { logoPath: `/api/site/logo/${name}` };
    } finally {
      await parsed.cleanup();
    }
  });

  /** 로고 서빙 (공개). 파일명은 logo-<숫자>.<확장자> 만 허용한다 */
  app.get('/api/site/logo/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().regex(/^logo-\d+\.(png|jpe?g|gif|svg|webp)$/) }).parse(request.params);
    const file = path.join(config.paths.largeAttach, 'site', name);
    const info = await stat(file).catch(() => null);
    if (!info) throw notFound('err.noLogo');
    const ext = path.extname(name).slice(1);
    const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    if (ext === 'svg') {
      // 예전에 올린 SVG 로고. 주소를 직접 열어도 스크립트가 돌지 않게 가둔다
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    reply
      .header('Content-Type', type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=86400')
      .header('Content-Length', String(info.size));
    return reply.send(createReadStream(file));
  });

  /**
   * 사이트 색 (공개). 로그인 화면도 --accent 를 쓰므로 세션 전에 한 번 받아야 한다.
   * 내려주는 값은 브랜딩 색 아홉 개뿐이라 로고 서빙과 같은 수준으로 열어 둔다.
   */
  app.get('/api/site/theme', async (_request, reply) => {
    const site = await gu.getSiteConfig();
    reply.header('Cache-Control', 'no-cache');
    return { theme: site.theme };
  });

  // ---------------------------------------------------------------- ADM-3 사용자 관리

  app.get('/api/admin/users', { onRequest: [app.requireAdmin] }, async (request) => {
    const query = z
      .object({
        keyword: z.string().optional(),
        /** 알리아스 대상 지정(ADM-4)처럼 중지 계정을 후보에서 빼야 하는 화면이 켠다 */
        activeOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().max(200).default(50),
        offset: z.coerce.number().int().default(0),
      })
      .parse(request.query);

    const { rows, total } = await users.listUsers(query);
    const usages = await quota.usageMany(rows.map((row) => row.userName));
    const enriched = rows.map((row) => {
        const usage = usages.get(row.userName) ?? { used: 0, limit: null, unlimited: true, scope: null };
        return {
          userName: row.userName,
          displayName: row.displayName,
          status: (row.status ?? 'Y').toUpperCase() === 'N' ? 'N' : 'Y',
          isAdmin: row.isAdmin,
          regDate: row.regDate,
          used: usage.used,
          limit: usage.limit,
          unlimited: usage.unlimited,
          quotaScope: usage.scope,
        };
      });
    return { users: enriched, total };
  });

  /** ADM-3.1 중복검사 */
  app.get('/api/admin/users/exists', { onRequest: [app.requireAdmin] }, async (request) => {
    const { userName } = z.object({ userName: z.string().min(1) }).parse(request.query);
    return { exists: await users.userExists(userName) };
  });

  /** ADM-3.1 사용자 추가. 계정 생성은 James 가 하고 웹 전용 컬럼만 뒤에 채운다 */
  app.post('/api/admin/users', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        userName: z.string().email(),
        displayName: z.string().trim().min(2, 'err.nameMin2').max(30),
        password: z.string().min(1),
      })
      .parse(request.body);

    const local = input.userName.split('@')[0] ?? '';
    if (local.length < 4) throw badRequest('err.accountMin4');
    if (await users.userExists(input.userName)) throw badRequest('err.accountTaken');

    const site = await gu.getSiteConfig();
    const specials = (input.password.match(/[^A-Za-z0-9]/g) ?? []).length;
    if (input.password.length < site.passwordMinLen || specials < site.passwordMinSpec) {
      throw badRequest('err.pwPolicy', { len: site.passwordMinLen, spec: site.passwordMinSpec });
    }

    await james.createUser(input.userName, input.password);
    await users.setUserProfileOnCreate(input.userName, input.displayName);
    // INBOX / Sent / Drafts / Trash / Spam. 계정은 이미 만들어졌으므로 여기서 실패해도
    // 등록 자체는 되돌리지 않는다 — 다음 로그인 때 다시 채운다 (routes/auth.ts).
    await ensureDefaultMailboxes(input.userName).catch((cause: unknown) => {
      request.log.error({ err: cause, user: input.userName }, '기본 편지함 생성 실패');
    });
    await gu.writeAudit({
      adminName: session.userName,
      action: 'USER_CREATE',
      target: input.userName,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  /**
   * ADM-3.3 사용자 정보 수정. 표시 이름·상태는 웹 전용 컬럼이라 직접 갱신하고,
   * 비밀번호는 해시·version 컬럼 때문에 James 를 거친다 (USR-14 와 같은 경로).
   * password 가 없거나 빈 문자열이면 비밀번호는 그대로 둔다.
   */
  app.put('/api/admin/users/:userName', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { userName } = z.object({ userName: z.string() }).parse(request.params);
    const input = z
      .object({
        displayName: z.string().trim().min(2, 'err.nameMin2').max(30).optional(),
        status: z.enum(['Y', 'N']).optional(),
        password: z.string().optional(),
      })
      .parse(request.body);

    const user = await users.findUser(userName);
    if (!user) throw notFound('err.userNotFound');

    if (input.password) {
      const site = await gu.getSiteConfig();
      const specials = (input.password.match(/[^A-Za-z0-9]/g) ?? []).length;
      if (input.password.length < site.passwordMinLen) {
        throw badRequest('err.pwMinLen', { len: site.passwordMinLen });
      }
      if (specials < site.passwordMinSpec) {
        throw badRequest('err.pwMinSpec', { spec: site.passwordMinSpec });
      }
      await james.setUserPassword(userName, input.password);
    }

    if (input.displayName !== undefined) await users.updateProfile(userName, { displayName: input.displayName });
    if (input.status !== undefined) await users.setUserStatus(userName, input.status);
    // 비밀번호를 바꿨거나 중지했으면 그 사용자의 열린 세션을 끊는다 (TTL 까지 살아 있지 않게)
    if (input.password || input.status === 'N') destroyUserSessions(userName);

    await gu.writeAudit({
      adminName: session.userName,
      action: input.password ? 'USER_UPDATE_PW' : 'USER_UPDATE',
      target: userName,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  app.post('/api/admin/users/:userName/status', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { userName } = z.object({ userName: z.string() }).parse(request.params);
    const input = z.object({ status: z.enum(['Y', 'N']) }).parse(request.body);
    await users.setUserStatus(userName, input.status);
    if (input.status === 'N') destroyUserSessions(userName);
    await gu.writeAudit({
      adminName: session.userName,
      action: `USER_STATUS_${input.status}`,
      target: userName,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  app.delete('/api/admin/users/:userName', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { userName } = z.object({ userName: z.string() }).parse(request.params);
    // 계정 행보다 메일·편지함을 먼저 지운다. 계정이 없어지면 소유자 조회가 안 돼
    // 남은 JAMES_MAILBOX / JAMES_MAIL_OWNER 행을 찾아 지울 방법이 없다.
    const purged = await purgeUserMailboxes(userName);
    const photo = (await users.findUser(userName))?.photo ?? null;
    await james.deleteUser(userName);
    destroyUserSessions(userName);

    // 대용량 첨부는 파일까지 지운다. 행만 지우면 디스크에 주인 없는 파일이 남는다
    const largeFiles = await db
      .selectFrom('GU_LARGE_ATTACH')
      .select('FILE_PATH')
      .where('USER_NAME', '=', userName)
      .execute();
    await Promise.allSettled(
      largeFiles.map((row) => rm(resolveLargePath(row.FILE_PATH), { force: true })),
    );
    await photos.removePhotoByUrl(photo);

    // 외부메일 실행 이력은 계정 ID 로 묶여 있어 계정 행을 지우기 전에 먼저 지운다
    const externalIds = (
      await db.selectFrom('GU_EXTERNAL_EMAIL').select('EXTERNAL_ID').where('USER_NAME', '=', userName).execute()
    ).map((row) => Number(row.EXTERNAL_ID));
    if (externalIds.length > 0) {
      await dbWrite.deleteFrom('GU_EXTERNAL_EMAIL_LOG').where('EXTERNAL_ID', 'in', externalIds).execute();
    }

    // 계정 삭제 시 GU_ 테이블의 해당 사용자 행도 함께 지운다 (web.md 9 절)
    await Promise.all([
      dbWrite.deleteFrom('GU_LARGE_ATTACH').where('USER_NAME', '=', userName).execute(),
      dbWrite.deleteFrom('GU_MDN_SENT').where('USER_NAME', '=', userName).execute(),
      dbWrite.deleteFrom('GU_CALENDAR_RESPONSE').where('USER_NAME', '=', userName).execute(),
      dbWrite
        .deleteFrom('JAMES_DROP_LIST')
        .where('OWNER_SCOPE', '=', 'USER')
        .where('OWNER', '=', userName)
        .execute(),
      dbWrite.deleteFrom('GU_USER_SETTING').where('USER_NAME', '=', userName).execute(),
      dbWrite.deleteFrom('GU_SIGNATURE').where('USER_NAME', '=', userName).execute(),
      contacts.deleteAllOf(userName),
      dbWrite.deleteFrom('GU_RECENT_RECIPIENT').where('USER_NAME', '=', userName).execute(),
      dbWrite.deleteFrom('GU_EXTERNAL_EMAIL').where('USER_NAME', '=', userName).execute(),
      dbWrite.deleteFrom('GU_MAIL_UPLOAD').where('USER_NAME', '=', userName).execute(),
    ]);
    await gu.writeAudit({
      adminName: session.userName,
      action: 'USER_DELETE',
      target: `${userName} (편지함 ${purged.mailboxes}개 · 메일 ${purged.messages}통)`,
      remoteAddr: request.ip,
    });
    return { ok: true, ...purged };
  });

  /** ADM-3.2 할당량 변경. quotaRoot 계산은 James 에 맡긴다 (6-1) */
  app.put('/api/admin/users/:userName/quota', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { userName } = z.object({ userName: z.string() }).parse(request.params);
    const input = z
      .object({
        /** null 이면 "기본값 사용"(행 삭제), -1 이면 무제한 (6-3) */
        limitBytes: z.number().int().nullable(),
      })
      .parse(request.body);

    if (input.limitBytes === null) {
      await james.deleteUserQuotaSize(userName);
    } else {
      const usage = await quota.usageOf(userName);
      if (input.limitBytes >= 0 && input.limitBytes < usage.used) {
        throw badRequest('err.quotaTooSmall');
      }
      await james.setUserQuotaSize(userName, input.limitBytes);
    }
    await gu.writeAudit({
      adminName: session.userName,
      action: 'USER_QUOTA',
      target: `${userName}=${input.limitBytes}`,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- ADM-4 알리아스

  /**
   * 알리아스에 등록된 실제 계정. 중지해도 rewrite 행은 남으므로 상태를 가리지 않고 읽는다
   * (MAPPING_TYPE 이 Alias 인 행만 — Group/Forward 는 이 화면 대상이 아니다).
   */
  async function aliasTargets(aliasUser: string, aliasDomain: string): Promise<string[]> {
    const rows = await db
      .selectFrom('JAMES_RECIPIENT_REWRITE')
      .select('TARGET_ADDRESS')
      .where('MAPPING_TYPE', '=', MappingType.Alias)
      .where('USER_NAME', '=', aliasUser)
      .where('DOMAIN_NAME', '=', aliasDomain)
      .execute();
    return rows.map((row) => row.TARGET_ADDRESS);
  }

  /**
   * 사용/중지를 rewrite 행에 반영한다. James 는 ALIAS_STATUS 가 'N' 인 행을 배달에서
   * 건너뛴다 (james9Mail 의 JPARecipientRewrite.selectUserDomainMapping).
   *
   * 쓰기를 WebAdmin 으로 넘기지 않고 직접 UPDATE 하는 유일한 자리다 — James 에 이 컬럼을
   * 세우는 라우트가 없고, OpenJPA 2차 캐시가 꺼져 있어(persistence.xml 에 DataCache 없음,
   * QuerySQLCache=false) 다음 배달부터 바로 반영된다.
   */
  async function setAliasRowStatus(aliasUser: string, aliasDomain: string, status: 'Y' | 'N'): Promise<void> {
    await dbWrite
      .updateTable('JAMES_RECIPIENT_REWRITE')
      .set({ ALIAS_STATUS: status })
      .where('MAPPING_TYPE', '=', MappingType.Alias)
      .where('USER_NAME', '=', aliasUser)
      .where('DOMAIN_NAME', '=', aliasDomain)
      .execute();
  }

  app.get('/api/admin/aliases', { onRequest: [app.requireAdmin] }, async (request) => {
    const query = z.object({ keyword: z.string().optional() }).parse(request.query);

    let aliasQuery = db.selectFrom('GU_MAIL_ALIAS').selectAll();
    if (query.keyword?.trim()) {
      const like = `%${escapeLike(query.keyword.trim())}%`;
      aliasQuery = aliasQuery.where((eb) =>
        eb.or([eb('ALIAS_NAME', 'like', like), eb('ALIAS_USER', 'like', like)]),
      );
    }
    const aliases = await aliasQuery.orderBy('REG_DATE', 'desc').execute();

    // 등록된 실제 계정은 JAMES_RECIPIENT_REWRITE 가 들고 있다. 알리아스 1개에 N 행이다.
    // 중지된 알리아스의 행도 그대로 남아 있으므로 ALIAS_STATUS 는 보지 않는다.
    const aliasUsers = [...new Set(aliases.map((alias) => alias.ALIAS_USER))];
    const targetRows =
      aliasUsers.length === 0
        ? []
        : await db
            .selectFrom('JAMES_RECIPIENT_REWRITE')
            .select(['USER_NAME', 'DOMAIN_NAME', 'TARGET_ADDRESS'])
            .where('MAPPING_TYPE', '=', MappingType.Alias)
            .where('USER_NAME', 'in', aliasUsers)
            .execute();
    const targetsOf = new Map<string, string[]>();
    for (const row of targetRows) {
      const key = `${row.USER_NAME}@${row.DOMAIN_NAME}`;
      const list = targetsOf.get(key) ?? [];
      list.push(row.TARGET_ADDRESS);
      targetsOf.set(key, list);
    }

    return aliases.map((alias) => ({
      aliasUser: alias.ALIAS_USER,
      aliasDomain: alias.ALIAS_DOMAIN,
      aliasAddress: `${alias.ALIAS_USER}@${alias.ALIAS_DOMAIN}`,
      aliasName: alias.ALIAS_NAME,
      status: alias.ALIAS_STATUS,
      regDate: toIso(alias.REG_DATE),
      targets: targetsOf.get(`${alias.ALIAS_USER}@${alias.ALIAS_DOMAIN}`) ?? [],
    }));
  });

  /** ADM-4.1 중복검사: 실제 계정 · 기존 알리아스 모두 확인한다 */
  app.get('/api/admin/aliases/exists', { onRequest: [app.requireAdmin] }, async (request) => {
    const { aliasAddress } = z.object({ aliasAddress: z.string().min(1) }).parse(request.query);
    const [aliasUser, aliasDomain] = aliasAddress.split('@') as [string, string | undefined];
    if (await users.userExists(aliasAddress)) return { exists: true, reason: 'USER' };
    if (!aliasDomain) return { exists: false, reason: null };
    const alias = await db
      .selectFrom('GU_MAIL_ALIAS')
      .select('ALIAS_USER')
      .where('ALIAS_USER', '=', aliasUser)
      .where('ALIAS_DOMAIN', '=', aliasDomain)
      .executeTakeFirst();
    return { exists: Boolean(alias), reason: alias ? 'ALIAS' : null };
  });

  /** ADM-4.1 수정: 이름 · 포함 계정 */
  app.put('/api/admin/aliases/:aliasAddress', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { aliasAddress } = z.object({ aliasAddress: z.string() }).parse(request.params);
    const input = z
      .object({
        aliasName: z.string().min(1).max(100),
        targets: z.array(z.string().email()).min(1),
      })
      .parse(request.body);
    const [aliasUser, aliasDomain] = aliasAddress.split('@') as [string, string];

    const alias = await db
      .selectFrom('GU_MAIL_ALIAS')
      .select('ALIAS_STATUS')
      .where('ALIAS_USER', '=', aliasUser)
      .where('ALIAS_DOMAIN', '=', aliasDomain)
      .executeTakeFirst();
    if (!alias) throw notFound('err.aliasNotFound');

    // 이전 대상은 화면 말고 DB 에서 읽는다 — 그 사이 다른 관리자가 바꿨을 수 있다.
    const currentTargets = await aliasTargets(aliasUser, aliasDomain);
    for (const target of currentTargets) {
      if (!input.targets.includes(target)) await james.removeAlias(target, aliasAddress);
    }
    for (const target of input.targets) {
      if (!currentTargets.includes(target)) await james.addAlias(target, aliasAddress);
    }
    // James 가 새로 넣은 행은 늘 사용 상태다. 중지된 알리아스에 대상을 더하면 그 행만
    // 살아나므로 상태를 한 번 더 덮는다.
    if (alias.ALIAS_STATUS === 'N') await setAliasRowStatus(aliasUser, aliasDomain, 'N');
    await dbWrite
      .updateTable('GU_MAIL_ALIAS')
      .set({ ALIAS_NAME: input.aliasName, UPDATE_DATE: new Date() })
      .where('ALIAS_USER', '=', aliasUser)
      .where('ALIAS_DOMAIN', '=', aliasDomain)
      .execute();
    await gu.writeAudit({
      adminName: session.userName,
      action: 'ALIAS_UPDATE',
      target: aliasAddress,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  app.post('/api/admin/aliases', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        aliasAddress: z.string().email(),
        aliasName: z.string().min(1).max(100),
        targets: z.array(z.string().email()).min(1),
      })
      .parse(request.body);

    const [aliasUser, aliasDomain] = input.aliasAddress.split('@') as [string, string];
    if (aliasUser.length < 4) throw badRequest('err.aliasMin4');
    if (await users.userExists(input.aliasAddress)) {
      throw badRequest('err.aliasIsUser');
    }

    for (const target of input.targets) {
      await james.addAlias(target, input.aliasAddress);
    }
    await dbWrite
      .insertInto('GU_MAIL_ALIAS')
      .values({
        ALIAS_USER: aliasUser,
        ALIAS_DOMAIN: aliasDomain,
        ALIAS_NAME: input.aliasName,
        ALIAS_STATUS: 'Y',
        REG_DATE: new Date(),
        UPDATE_DATE: new Date(),
      })
      .onDuplicateKeyUpdate({ ALIAS_NAME: input.aliasName, UPDATE_DATE: new Date() })
      .execute();

    await gu.writeAudit({
      adminName: session.userName,
      action: 'ALIAS_CREATE',
      target: input.aliasAddress,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  /**
   * 사용/중지. **등록된 실제 계정은 건드리지 않는다** — rewrite 행의 ALIAS_STATUS 만 바꾸면
   * James 가 그 행을 배달에서 건너뛴다 (webmail-issues.md 7-4). 행을 지웠다 되살리던 때와 달리
   * 대상 목록이 그대로 남고, 대상 수만큼 WebAdmin 을 부르다 중간에 실패할 일도 없다.
   */
  app.post('/api/admin/aliases/:aliasAddress/status', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { aliasAddress } = z.object({ aliasAddress: z.string() }).parse(request.params);
    const input = z.object({ status: z.enum(['Y', 'N']) }).parse(request.body);
    const [aliasUser, aliasDomain] = aliasAddress.split('@') as [string, string];

    await setAliasRowStatus(aliasUser, aliasDomain, input.status);
    await dbWrite
      .updateTable('GU_MAIL_ALIAS')
      .set({ ALIAS_STATUS: input.status, UPDATE_DATE: new Date() })
      .where('ALIAS_USER', '=', aliasUser)
      .where('ALIAS_DOMAIN', '=', aliasDomain)
      .execute();

    await gu.writeAudit({
      adminName: session.userName,
      action: `ALIAS_STATUS_${input.status}`,
      target: aliasAddress,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  app.delete('/api/admin/aliases/:aliasAddress', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { aliasAddress } = z.object({ aliasAddress: z.string() }).parse(request.params);
    const [aliasUser, aliasDomain] = aliasAddress.split('@') as [string, string];

    for (const target of await aliasTargets(aliasUser, aliasDomain)) {
      await james.removeAlias(target, aliasAddress);
    }
    await dbWrite
      .deleteFrom('GU_MAIL_ALIAS')
      .where('ALIAS_USER', '=', aliasUser)
      .where('ALIAS_DOMAIN', '=', aliasDomain)
      .execute();

    await gu.writeAudit({
      adminName: session.userName,
      action: 'ALIAS_DELETE',
      target: aliasAddress,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- ADM-5 메일 로그

  app.get('/api/admin/mails', { onRequest: [app.requireAdmin] }, async (request) => {
    const query = z
      .object({
        field: z.enum(['all', 'from', 'to', 'subject']).default('all'),
        /** 메일 종류: II 내부, IO 외부발송, OI 외부수신. all 이면 걸러내지 않는다 */
        type: z.enum(['all', 'II', 'IO', 'OI']).default('all'),
        keyword: z.string().optional(),
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
        limit: z.coerce.number().int().max(200).default(50),
        offset: z.coerce.number().int().default(0),
      })
      .parse(request.query);

    let mailQuery = db
      .selectFrom('JAMES_MAIL as m')
      .select(({ fn, selectFrom }) => [
        'm.MAIL_ID as MAIL_ID',
        'm.MAIL_SUBJECT as MAIL_SUBJECT',
        'm.MAIL_DATE as MAIL_DATE',
        'm.MAIL_FROM as MAIL_FROM',
        'm.MAIL_FROM_DISP as MAIL_FROM_DISP',
        'm.MAIL_TO as MAIL_TO',
        'm.MAIL_TO_DISP as MAIL_TO_DISP',
        'm.MAIL_TYPE as MAIL_TYPE',
        'm.MAIL_SIZE as MAIL_SIZE',
        selectFrom('JAMES_MAIL_RECIPIENTS as r')
          .select(fn.countAll<number>().as('c'))
          .whereRef('r.MAIL_ID', '=', 'm.MAIL_ID')
          .as('RCPT_COUNT'),
      ]);

    if (query.type !== 'all') mailQuery = mailQuery.where('m.MAIL_TYPE', '=', query.type);
    if (query.fromDate) mailQuery = mailQuery.where('m.MAIL_DATE_YMD', '>=', query.fromDate);
    if (query.toDate) mailQuery = mailQuery.where('m.MAIL_DATE_YMD', '<=', query.toDate);
    if (query.keyword?.trim()) {
      const like = `%${escapeLike(query.keyword.trim())}%`;
      if (query.field === 'from')
        mailQuery = mailQuery.where((eb) =>
          eb.or([eb('m.MAIL_FROM', 'like', like), eb('m.MAIL_FROM_DISP', 'like', like)]),
        );
      else if (query.field === 'to')
        mailQuery = mailQuery.where((eb) =>
          eb.or([eb('m.MAIL_TO', 'like', like), eb('m.MAIL_TO_DISP', 'like', like)]),
        );
      else if (query.field === 'subject') mailQuery = mailQuery.where('m.MAIL_SUBJECT', 'like', like);
      else
        mailQuery = mailQuery.where((eb) =>
          eb.or([
            eb('m.MAIL_FROM', 'like', like),
            eb('m.MAIL_FROM_DISP', 'like', like),
            eb('m.MAIL_TO', 'like', like),
            eb('m.MAIL_TO_DISP', 'like', like),
            eb('m.MAIL_SUBJECT', 'like', like),
          ]),
        );
    }

    const rows = await mailQuery
      .orderBy('m.MAIL_DATE', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();

    return rows.map((r) => ({
      mailId: r.MAIL_ID,
      subject: r.MAIL_SUBJECT,
      date: toIso(r.MAIL_DATE),
      from: r.MAIL_FROM,
      fromDisplay: r.MAIL_FROM_DISP,
      to: r.MAIL_TO,
      toDisplay: r.MAIL_TO_DISP,
      mailType: r.MAIL_TYPE,
      size: Number(r.MAIL_SIZE),
      recipientCount: Number(r.RCPT_COUNT ?? 0),
    }));
  });

  /**
   * 관리자 원문 열람. 플래그를 건드리지 않는다 (2-16) — 건드리면 수신자의
   * 수신확인이 관리자 조회로 찍혀 버린다. 열람 사실은 감사 로그에 남는다 (7-9).
   */
  app.get('/api/admin/mails/:mailId/raw', { onRequest: [app.requireAdmin] }, async (request, reply) => {
    const session = sessionOf(request);
    const { mailId } = z.object({ mailId: z.string() }).parse(request.params);
    const row = await messages.findMessageByMailId(mailId);
    if (!row) throw notFound('err.mailNotFound');

    await gu.writeAudit({
      adminName: session.userName,
      action: 'MAIL_VIEW',
      target: mailId,
      remoteAddr: request.ip,
    });

    reply
      .header('Content-Type', 'message/rfc822')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${mailId}.eml"`)
      .header('Cache-Control', 'private, no-store');
    return reply.send(openMail(row.filePath));
  });

  /** ADM-5 삭제: 모든 수신자 편지함에서 지운다. 복원 불가 */
  app.post('/api/admin/mails/delete', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const input = z.object({ mailIds: z.array(z.string()).min(1).max(200) }).parse(request.body);

    const owners = await db
      .selectFrom('JAMES_MAIL_OWNER')
      .select(['MAILBOX_ID', 'MAIL_UID'])
      .where('MAIL_ID', 'in', input.mailIds)
      .execute();

    const byMailbox = new Map<string, number[]>();
    for (const owner of owners) {
      if (!owner.MAILBOX_ID) continue;
      const list = byMailbox.get(owner.MAILBOX_ID) ?? [];
      list.push(Number(owner.MAIL_UID));
      byMailbox.set(owner.MAILBOX_ID, list);
    }

    let removed = 0;
    for (const [mailboxId, uids] of byMailbox) {
      await james.expunge({ mailboxId, uids });
      removed += uids.length;
    }

    await gu.writeAudit({
      adminName: session.userName,
      action: 'MAIL_DELETE',
      target: input.mailIds.join(',').slice(0, 500),
      remoteAddr: request.ip,
    });
    return { ok: true, removed };
  });

  // ---------------------------------------------------------------- ADM-6 수신거부

  app.get('/api/admin/droplist', { onRequest: [app.requireAdmin] }, async (request) => {
    const query = z
      .object({ type: z.enum(['ALL', 'ADDRESS', 'DOMAIN']).default('ALL') })
      .parse(request.query);
    let dropQuery = db.selectFrom('JAMES_DROP_LIST').selectAll();
    if (query.type !== 'ALL') dropQuery = dropQuery.where('DENIED_ENTITY_TYPE', '=', query.type);
    const rows = await dropQuery.orderBy('DROPLIST_ID', 'desc').limit(500).execute();
    return rows.map((r) => ({
      id: Number(r.DROPLIST_ID),
      scope: r.OWNER_SCOPE,
      owner: r.OWNER,
      type: r.DENIED_ENTITY_TYPE,
      entity: r.DENIED_ENTITY,
    }));
  });

  app.post('/api/admin/droplist', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const input = z.object({ entity: z.string().min(3).max(320) }).parse(request.body);
    // 입력값을 분석해 계정인지 도메인인지 판단한다 (설계서 ADM-6)
    const { entity, type } = normalizeDropEntity(input.entity);
    await addDropEntry({ scope: 'GLOBAL', owner: null, entity, type });
    await gu.writeAudit({
      adminName: session.userName,
      action: 'DROP_ADD',
      target: entity,
      remoteAddr: request.ip,
    });
    return { ok: true };
  });

  app.delete('/api/admin/droplist/:id', { onRequest: [app.requireAdmin] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    await dbWrite.deleteFrom('JAMES_DROP_LIST').where('DROPLIST_ID', '=', id).execute();
    await gu.writeAudit({
      adminName: session.userName,
      action: 'DROP_DELETE',
      target: String(id),
      remoteAddr: request.ip,
    });
    return { ok: true };
  });
}
