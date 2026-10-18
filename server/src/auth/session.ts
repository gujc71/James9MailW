/**
 * Cookie session.
 *
 * 세션 쿠키만 httpOnly + SameSite=Lax 로 내려주고, 사용자 비밀번호는 보관하지 않는다.
 * SMTP 제출은 25 번 무인증 릴레이라 비밀번호가 필요하지 않다 (webmail-issues.md 1-2).
 * 저장소는 프로세스 메모리다. Redis 는 구성에서 제외했으므로(architecture 0절)
 * 웹서버를 여러 대로 늘릴 때는 이 부분을 sticky session 또는 공유 저장소로 바꾼다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export interface SessionData {
  userName: string;
  displayName: string | null;
  isAdmin: boolean;
  /** 로그인 화면에서 고른 언어. 사이트 전체 출력에 쓴다 (설계서 로그인 화면) */
  locale: 'ko' | 'en';
  expiresAt: number;
}

const sessions = new Map<string, SessionData>();
/**
 * 사용자 → 세션 ID. 비밀번호 변경·계정 중지·삭제 때 그 사용자의 세션을 한꺼번에 끊는다.
 * 이것이 없으면 비밀번호를 바꿔도 탈취된 세션이 TTL 까지 살아 있다.
 */
const byUser = new Map<string, Set<string>>();

function userKey(userName: string): string {
  return userName.toLowerCase();
}

function track(id: string, userName: string): void {
  const key = userKey(userName);
  let set = byUser.get(key);
  if (!set) byUser.set(key, (set = new Set()));
  set.add(id);
}

function drop(id: string): void {
  const data = sessions.get(id);
  sessions.delete(id);
  if (!data) return;
  const set = byUser.get(userKey(data.userName));
  set?.delete(id);
  if (set && set.size === 0) byUser.delete(userKey(data.userName));
}

function idOf(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  return dot > 0 ? token.slice(0, dot) : null;
}

export const SESSION_COOKIE = 'j9sid';

function sign(id: string): string {
  return createHmac('sha256', config.sessionSecret).update(id).digest('base64url');
}

export function createSession(data: Omit<SessionData, 'expiresAt'>): string {
  const id = randomBytes(24).toString('base64url');
  sessions.set(id, { ...data, expiresAt: Date.now() + config.sessionTtlMs });
  track(id, data.userName);
  return `${id}.${sign(id)}`;
}

export function readSession(token: string | undefined): SessionData | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(id);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  const data = sessions.get(id);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    drop(id);
    return null;
  }
  // 슬라이딩 만료
  data.expiresAt = Date.now() + config.sessionTtlMs;
  return data;
}

export function destroySession(token: string | undefined): void {
  const id = idOf(token);
  if (id) drop(id);
}

/**
 * 한 사용자의 세션을 모두 끊는다. exceptToken 을 주면 그 세션(지금 요청한 사람)은 남긴다.
 * @returns 끊은 세션 수
 */
export function destroyUserSessions(userName: string, exceptToken?: string): number {
  const keep = idOf(exceptToken);
  const ids = [...(byUser.get(userKey(userName)) ?? [])];
  let removed = 0;
  for (const id of ids) {
    if (id === keep) continue;
    drop(id);
    removed += 1;
  }
  return removed;
}

/** 만료 세션 청소 */
export function sweepSessions(): void {
  const now = Date.now();
  for (const [id, data] of sessions) {
    if (data.expiresAt < now) drop(id);
  }
}
