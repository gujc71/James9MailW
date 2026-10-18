/** 로그인 / 로그아웃 / 내 정보 · 프로필 사진 (설계서 로그인 화면, USR-14) */
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  createSession,
  destroySession,
  destroyUserSessions,
  SESSION_COOKIE,
} from '../auth/session.js';
import { HttpError } from '../errors.js';
import { loginFailures, loginFailuresByIp } from '../util/rateLimit.js';
import { verifyPassword } from '../auth/password.js';
import { badRequest, notFound, payloadTooLarge, unauthorized } from '../errors.js';
import { sessionOf } from '../plugins/auth.js';
import * as users from '../repositories/users.js';
import * as gu from '../repositories/gu.js';
import * as quota from '../repositories/quota.js';
import * as aliases from '../repositories/aliases.js';
import { james } from '../james/webadmin.js';
import { ensureDefaultMailboxes } from '../services/mailboxes.js';
import { moveFile, parseMultipart } from '../store/uploads.js';
import * as photos from '../store/photos.js';

const loginSchema = z.object({
  userName: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  locale: z.enum(['ko', 'en']).default('en'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);

    // 무차별 대입 방어. (IP, 계정) 과 IP 단위를 따로 센다. 막혀 있으면 비밀번호를 검사하지도 않는다
    const pairKey = `${request.ip}|${input.userName.toLowerCase()}`;
    const blocked = Math.max(loginFailures.blockedFor(pairKey), loginFailuresByIp.blockedFor(request.ip));
    if (blocked > 0) {
      reply.header('Retry-After', String(Math.ceil(blocked / 1000)));
      throw new HttpError(429, 'err.tooManyAttempts', 'TOO_MANY_ATTEMPTS', undefined, {
        min: Math.max(1, Math.ceil(blocked / 60_000)),
      });
    }
    const fail = () => {
      loginFailures.hit(pairKey);
      loginFailuresByIp.hit(request.ip);
      request.log.warn({ user: input.userName, ip: request.ip }, 'login failed');
      // 계정 유무를 흘리지 않도록 같은 메시지를 쓴다
      return unauthorized('err.badCredentials');
    };

    const user = await users.findUser(input.userName);
    if (!user) throw fail();
    if (!verifyPassword(input.password, user.userName, user.passwordHash, user.algorithm)) {
      throw fail();
    }
    loginFailures.reset(pairKey);
    // ADM-3 에서 중지한 계정은 로그인이 막힌다
    if ((user.status ?? 'Y').toUpperCase() === 'N') {
      throw unauthorized('err.accountSuspended');
    }

    // 계정 생성 때 못 만들었거나 James CLI 로 만들어진 계정이면 여기서 기본 편지함을
    // 채운다. 이미 다섯 개가 있으면 조회 한 번으로 끝난다. James 가 멎어 있어도 로그인은 막지 않는다.
    await ensureDefaultMailboxes(user.userName).catch((cause: unknown) => {
      request.log.error({ err: cause, user: user.userName }, '기본 편지함 생성 실패');
    });

    const token = createSession({
      userName: user.userName,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      locale: input.locale,
    });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });

    return {
      userName: user.userName,
      displayName: user.displayName,
      photo: user.photo,
      isAdmin: user.isAdmin,
      locale: input.locale,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
    return { ok: true };
  });

  /** 앱 최초 진입 시 한 번에 내려주는 부트스트랩 (설계서 슬라이드 5) */
  app.get('/api/me', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const [user, setting, site, usage, sendableAliases] = await Promise.all([
      users.findUser(session.userName),
      gu.getUserSetting(session.userName),
      gu.getSiteConfig(),
      quota.usageOf(session.userName),
      // 읽기 화면이 답장 From 기본값을 고르는 데 쓴다. 메일쓰기 창이 열리기 전에 필요하다 (4-3)
      aliases.listSendableAliases(session.userName),
    ]);
    return {
      userName: session.userName,
      displayName: user?.displayName || null,
      photo: user?.photo ?? null,
      isAdmin: session.isAdmin,
      locale: session.locale,
      setting,
      site,
      usage,
      aliases: sendableAliases,
    };
  });

  /** USR-14 이름 변경 */
  app.put('/api/me/profile', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({ displayName: z.string().max(30).nullable().optional() })
      .parse(request.body);
    await users.updateProfile(session.userName, input);
    return { ok: true };
  });

  /**
   * USR-14 사진 등록. 이미지는 파일로 두고 컬럼에는 URL 만 넣는다 (store/photos.ts).
   * 확장자·Content-Type 은 믿지 않고 시그니처로 판별한다.
   */
  app.post('/api/me/photo', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    // 사진 한 장만 받는다. 한도를 넘으면 받는 도중에 413 으로 끊긴다
    const parsed = await parseMultipart(request, { files: 1, fileSize: photos.PHOTO_MAX_BYTES + 1 });
    try {
      const file = parsed.files.find((f) => f.field === 'photo');
      if (!file) throw badRequest('err.noPhotoFile');
      if (file.size > photos.PHOTO_MAX_BYTES) {
        throw payloadTooLarge('err.photoTooBig', { mb: photos.PHOTO_MAX_BYTES / 1024 / 1024 });
      }
      const ext = await photos.sniffImageExt(file.path);
      if (!ext) throw badRequest('err.photoType');

      await mkdir(photos.photoDir(), { recursive: true });
      const name = photos.newPhotoName(session.userName, ext);
      await moveFile(file.path, photos.photoFilePath(name));

      // 교체 전 사진은 URL 을 바꾼 뒤에 지운다 (지우기가 실패해도 등록은 유효하다)
      const previous = (await users.findUser(session.userName))?.photo ?? null;
      const photo = photos.PHOTO_URL_PREFIX + name;
      await users.updateProfile(session.userName, { photo });
      await photos.removePhotoByUrl(previous);
      return { photo };
    } finally {
      await parsed.cleanup();
    }
  });

  /** USR-14 사진 삭제. 지우면 목록·상단바는 이름 첫 글자 아바타로 돌아간다 */
  app.delete('/api/me/photo', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const previous = (await users.findUser(session.userName))?.photo ?? null;
    await users.updateProfile(session.userName, { photo: null });
    await photos.removePhotoByUrl(previous);
    return { ok: true };
  });

  /**
   * 사진 서빙. 로고와 달리 로그인한 사용자에게만 준다.
   * 파일명에 타임스탬프가 들어가 교체하면 URL 이 바뀌므로 길게 캐시해도 된다.
   */
  app.get('/api/photo/:name', { onRequest: [app.requireUser] }, async (request, reply) => {
    const { name } = z.object({ name: z.string().regex(photos.PHOTO_NAME_RE) }).parse(request.params);
    const file = photos.photoFilePath(name);
    const info = await stat(file).catch(() => null);
    if (!info) throw notFound('err.noPhoto');
    reply
      .header('Content-Type', photos.photoContentType(name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=86400')
      .header('Content-Length', String(info.size));
    return reply.send(createReadStream(file));
  });

  /** USR-14 비밀번호 변경. 해시·version 컬럼 때문에 James 를 거친다 */
  app.put('/api/me/password', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) })
      .parse(request.body);

    // 현재 비밀번호 확인도 로그인과 같은 잠금을 탄다 — 세션을 훔친 쪽이 여기서 비밀번호를 맞혀 볼 수 있다
    const pairKey = `${request.ip}|${session.userName.toLowerCase()}`;
    if (loginFailures.blockedFor(pairKey) > 0) {
      throw new HttpError(429, 'err.tooManyAttempts', 'TOO_MANY_ATTEMPTS', undefined, {
        min: config.login.lockMinutes,
      });
    }

    const user = await users.findUser(session.userName);
    if (!user) throw unauthorized();
    if (!verifyPassword(input.currentPassword, user.userName, user.passwordHash, user.algorithm)) {
      loginFailures.hit(pairKey);
      throw badRequest('err.currentPwWrong');
    }

    const site = await gu.getSiteConfig();
    const specials = (input.newPassword.match(/[^A-Za-z0-9]/g) ?? []).length;
    if (input.newPassword.length < site.passwordMinLen) {
      throw badRequest('err.pwMinLen', { len: site.passwordMinLen });
    }
    if (specials < site.passwordMinSpec) {
      throw badRequest('err.pwMinSpec', { spec: site.passwordMinSpec });
    }

    await james.setUserPassword(session.userName, input.newPassword);
    // 다른 곳(탈취됐을 수도 있는 세션 포함)의 로그인은 끊고 지금 이 세션만 남긴다
    destroyUserSessions(session.userName, request.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  /** USR-13 개인 환경설정 저장 */
  app.put('/api/me/setting', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        listPageSize: z.number().int().min(10).max(200).optional(),
        sendConfirmYn: z.boolean().optional(),
        personalSignYn: z.boolean().optional(),
        vcardYn: z.boolean().optional(),
        rejectUseYn: z.boolean().optional(),
        vacationUseYn: z.boolean().optional(),
        forwardUseYn: z.boolean().optional(),
        caldavUseYn: z.boolean().optional(),
        carddavUseYn: z.boolean().optional(),
      })
      .parse(request.body);
    return gu.saveUserSetting(session.userName, input);
  });
}
