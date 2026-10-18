// 웹메일 API 를 직접 부르는 도우미 (seed · cleanup)
//  - 쓰기 요청에는 x-requested-with 헤더가 있어야 한다 (CSRF 방어, server/src/app.ts)
//  - 읽음 플래그는 반드시 '\\Seen' (역슬래시 포함). 'Seen' 은 오류 없이 사용자 키워드로 저장된다
export const API = process.env.MANUAL_API_URL ?? 'http://127.0.0.1:4000';
export const PASSWORD = process.env.MANUAL_PASSWORD ?? 'TEST1234';
export const SEEN = '\\Seen';
export const FLAGGED = '\\Flagged';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login(user, locale = 'ko') {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify({ userName: `${user}@example.com`, password: PASSWORD, locale }),
  });
  if (!res.ok) throw new Error(`login ${user} ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  async function call(method, path, body) {
    const headers = { cookie, 'x-requested-with': 'fetch' };
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    const r = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
    /** 모든 편지함의 메일 목록 (최근 200통) */
    async messages() {
      return (await call('GET', '/api/messages?all=1&limit=200')).messages;
    },
  };
}
