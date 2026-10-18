/**
 * 프로세스 메모리 기반 요청 제한.
 *
 * 웹서버가 한 대라는 전제다(세션 저장소와 같다 — auth/session.ts). 여러 대로 늘리면
 * 세션과 함께 공유 저장소로 옮긴다. 키마다 [창 시작, 횟수] 만 들고 있어 가볍다.
 */
import { config } from '../config.js';

export interface RateLimiter {
  /** 이 키의 남은 잠금 시간(ms). 막혀 있지 않으면 0 */
  blockedFor(key: string): number;
  /** 한 번 센다. 한도를 넘었으면 남은 잠금 시간(ms), 아니면 0 */
  hit(key: string): number;
  /** 성공 등으로 기록을 지운다 */
  reset(key: string): void;
  /** 창이 지난 기록을 지운다. 스케줄러가 부른다 */
  sweep(): void;
}

export function createRateLimiter(options: { max: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, { start: number; count: number }>();

  const current = (key: string, now: number) => {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= options.windowMs) return null;
    return entry;
  };

  return {
    blockedFor(key) {
      const now = Date.now();
      const entry = current(key, now);
      if (!entry || entry.count < options.max) return 0;
      return entry.start + options.windowMs - now;
    },
    hit(key) {
      const now = Date.now();
      let entry = current(key, now);
      if (!entry) hits.set(key, (entry = { start: now, count: 0 }));
      entry.count += 1;
      return entry.count > options.max ? entry.start + options.windowMs - now : 0;
    },
    reset(key) {
      hits.delete(key);
    },
    sweep() {
      const now = Date.now();
      for (const [key, entry] of hits) {
        if (now - entry.start >= options.windowMs) hits.delete(key);
      }
    },
  };
}

const MINUTE = 60_000;

/** 모든 리미터. 스케줄러가 한꺼번에 청소한다 */
export const limiters: RateLimiter[] = [];

function register(limiter: RateLimiter): RateLimiter {
  limiters.push(limiter);
  return limiter;
}


/** 로그인 실패: (IP, 계정) 조합. 계정만으로 막으면 남이 일부러 틀려 주인을 잠글 수 있다 */
export const loginFailures = register(
  createRateLimiter({ max: config.login.maxFailures, windowMs: config.login.lockMinutes * MINUTE }),
);

/**
 * 로그인 실패: IP 단위. 계정을 바꿔 가며 찌르는 것(password spraying)을 막는다.
 * 앞단 프록시가 있는데 TRUST_PROXY 를 켜지 않으면 모든 사용자가 프록시 IP 하나로 보여 이 한도를
 * 함께 쓰게 된다. 그래서 넉넉히 잡고, 운영에서는 TRUST_PROXY 를 반드시 맞춘다.
 */
export const loginFailuresByIp = register(
  createRateLimiter({ max: config.login.maxFailures * 20, windowMs: config.login.lockMinutes * MINUTE }),
);

/** 세션 없이 열리는 대용량 첨부 링크. ATTACH_ID 추측·대역폭 소모를 막는다 */
export const largeDownloads = register(createRateLimiter({ max: 120, windowMs: MINUTE }));

/** 발송 (계정 단위). 탈취된 세션으로 스팸을 쏟아 내는 것을 늦춘다 */
export const sendPerUser = register(createRateLimiter({ max: 60, windowMs: MINUTE }));
