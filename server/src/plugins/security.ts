/**
 * 앱 자체의 보안 헤더.
 *
 * 브라우저가 MIME 을 파싱하는 구조라 앱 CSP 에 blob:/data: 가 필요하다
 * (webmail-issues.md 2-5, webmail-architecture.md 2.6). 값을 코드에 고정해 둔다.
 *
 *  - img-src 'self' blob: data:   파서가 첨부·인라인 이미지를 blob: 로 만든다
 *  - frame-src blob:             본문은 srcdoc sandbox iframe 안에서만 그린다
 *  - worker-src 'self' blob:     MIME 파싱은 Web Worker 에서 한다
 *  - script-src 'self'           인라인 스크립트 금지
 *  - object-src 'none', frame-ancestors 'none'
 *
 * 원문 자체의 응답 헤더(message/rfc822 + nosniff + attachment)는 routes/messages.ts 에 있다.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src blob:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // HTTPS 로만 서비스할 때(쿠키 Secure 와 같은 스위치) 브라우저가 http 로 내려가지 않게 한다
    if (config.cookieSecure) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // 원문·첨부 응답은 자체 헤더를 쓰므로 CSP 를 덮어쓰지 않는다
    if (!request.url.startsWith('/api/messages/') && !request.url.startsWith('/large/')) {
      reply.header('Content-Security-Policy', CSP);
    }
  });
});
