/** fetch 래퍼. 세션 쿠키는 브라우저가 자동으로 붙인다 (credentials: include) */
import { getLocale } from '../i18n';

/**
 * 서버 오류 문구도 이 언어로 받는다 (server/src/i18n.ts).
 * x-requested-with 는 CSRF 방어 헤더다 — 서버가 상태를 바꾸는 요청에 이 헤더를 요구한다
 * (server/src/app.ts). 다른 사이트의 폼·이미지 요청은 이 헤더를 붙일 수 없다.
 */
function localeHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'x-locale': getLocale(), 'x-requested-with': 'james9mail', ...extra };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? response.statusText, body?.code);
  }
  return body as T;
}

export const api = {
  async get<T>(path: string): Promise<T> {
    return handle<T>(await fetch(path, { credentials: 'include', headers: localeHeaders() }));
  },
  async post<T>(path: string, body?: unknown): Promise<T> {
    return handle<T>(
      await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: localeHeaders(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  },
  async put<T>(path: string, body?: unknown): Promise<T> {
    return handle<T>(
      await fetch(path, {
        method: 'PUT',
        credentials: 'include',
        headers: localeHeaders(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  },
  async del<T>(path: string, body?: unknown): Promise<T> {
    return handle<T>(
      await fetch(path, {
        method: 'DELETE',
        credentials: 'include',
        headers: localeHeaders(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  },
  /** 작성 폼은 multipart 로 보낸다 (첨부 스트림) */
  async form<T>(path: string, formData: FormData): Promise<T> {
    return handle<T>(
      await fetch(path, { method: 'POST', credentials: 'include', headers: localeHeaders(), body: formData }),
    );
  },
};
