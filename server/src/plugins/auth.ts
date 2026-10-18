/** 세션 해석 + 인증 가드 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { readSession, SESSION_COOKIE, type SessionData } from '../auth/session.js';
import { forbidden, unauthorized } from '../errors.js';
import { findUser } from '../repositories/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionData | null;
  }
  interface FastifyInstance {
    requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request) => {
    request.session = readSession(request.cookies[SESSION_COOKIE]);
  });

  app.decorate('requireUser', async (request: FastifyRequest) => {
    if (!request.session) throw unauthorized();
  });

  /**
   * 관리자 권한은 세션에 적힌 값이 아니라 **지금 DB 값**으로 판정한다. 로그인 뒤 IS_ADMIN 을
   * 거두거나 계정을 중지해도 세션 값만 보면 TTL 까지 관리자 화면이 열려 있다.
   * 관리자 요청은 드물어 조회 한 번이 부담되지 않는다.
   */
  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    const session = request.session;
    if (!session) throw unauthorized();
    if (!session.isAdmin) throw forbidden('err.adminOnly');
    const user = await findUser(session.userName);
    const active = user && (user.status ?? 'Y').toUpperCase() !== 'N';
    if (!active || !user.isAdmin) {
      session.isAdmin = Boolean(active && user?.isAdmin);
      throw forbidden('err.adminOnly');
    }
  });
});

/** 라우트에서 세션을 꺼낼 때 */
export function sessionOf(request: FastifyRequest): SessionData {
  if (!request.session) throw unauthorized();
  return request.session;
}
