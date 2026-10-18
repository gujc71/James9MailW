/**
 * 라우트가 던지는 오류. Fastify 의 errorHandler 가 statusCode 로 변환한다.
 *
 * message 에는 문구 대신 i18n 키를 담는다 (i18n.ts). 문구는 응답을 만들 때
 * 요청 로케일로 번역되고, 카탈로그에 없는 문자열은 그대로 나간다.
 * {name} 자리를 채울 값은 params 로 함께 넘긴다.
 */
import type { MessageParams } from './i18n.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
    readonly params?: MessageParams,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string, params?: MessageParams, details?: unknown) =>
  new HttpError(400, m, 'BAD_REQUEST', details, params);
export const unauthorized = (m = 'err.loginRequired', params?: MessageParams) =>
  new HttpError(401, m, 'UNAUTHORIZED', undefined, params);
export const forbidden = (m = 'err.forbidden', params?: MessageParams) =>
  new HttpError(403, m, 'FORBIDDEN', undefined, params);
export const notFound = (m = 'err.notFound', params?: MessageParams) =>
  new HttpError(404, m, 'NOT_FOUND', undefined, params);
export const conflict = (m: string, params?: MessageParams) =>
  new HttpError(409, m, 'CONFLICT', undefined, params);
/** 동기화 커서가 툼스톤 보관기간을 넘겼다. 클라이언트는 전체 재동기화한다 */
export const gone = (m = 'err.cursorExpired', params?: MessageParams) =>
  new HttpError(410, m, 'CURSOR_EXPIRED', undefined, params);
export const payloadTooLarge = (m: string, params?: MessageParams) =>
  new HttpError(413, m, 'TOO_LARGE', undefined, params);
/** James WebAdmin 이 없거나 커스텀 라우트가 배포되지 않았다 */
export const upstreamUnavailable = (m: string, params?: MessageParams) =>
  new HttpError(503, m, 'JAMES_UNAVAILABLE', undefined, params);
