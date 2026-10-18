/**
 * Runtime configuration, read once from the environment.
 *
 * 설정값은 전부 여기서 읽는다. 특히 MAIL_STORE_DIR / MAIL_STAGING_DIR 은
 * James 쪽 설정과 같은 절대경로여야 한다 (webmail-issues.md 1-6).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// 아주 작은 .env 로더. dotenv 의존성을 하나 더 들이지 않는다.
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

function int(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} is not a number`);
  return parsed;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: int('PORT', 4000),
  host: str('HOST', '127.0.0.1'),
  sessionSecret: str('SESSION_SECRET'),
  sessionTtlMs: int('SESSION_TTL_HOURS', 12) * 60 * 60 * 1000,
  corsOrigin: process.env.CORS_ORIGIN || '',
  /** 세션 쿠키 Secure 속성 + HSTS. HTTPS 로 서비스하면 반드시 켠다 (운영 기본값 true) */
  cookieSecure: bool('COOKIE_SECURE', isProduction),
  /**
   * 앞단 프록시(nginx 등)의 X-Forwarded-* 를 믿을지. 프록시 없이 노출된 서버가 이 헤더를
   * 믿으면 누구나 IP·Host 를 꾸밀 수 있다. 프록시 IP 목록(콤마)이나 true 를 준다.
   */
  trustProxy: ((): boolean | string => {
    const raw = (process.env.TRUST_PROXY ?? '').trim();
    if (!raw || ['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
    if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
    return raw;
  })(),
  /**
   * 메일 본문에 넣는 링크(대용량 첨부)의 기준 주소. 요청 Host 헤더로 만들면 공격자가 Host 를
   * 바꿔 발송 메일에 남의 도메인 링크를 심을 수 있으므로 설정값을 우선한다.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  /** 빌드한 클라이언트(client/dist). 있으면 웹서버가 정적 서빙한다 */
  clientDist: path.resolve(process.env.CLIENT_DIST_DIR || path.join(process.cwd(), '..', 'client', 'dist')),

  login: {
    /** 같은 IP·계정 조합의 로그인 실패 허용 횟수와 잠금 시간 */
    maxFailures: int('LOGIN_MAX_FAILURES', 5),
    lockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  },

  externalMail: {
    /**
     * 외부메일 서버 인증서 검증을 끈다. 자체 서명 인증서를 쓰는 사내 서버 때문에 필요할 때만
     * 켠다 — 켜면 중간자가 외부 계정 비밀번호를 가로챌 수 있다.
     */
    tlsInsecure: bool('EXTERNAL_MAIL_TLS_INSECURE', false),
    /** 사설 IP(10/8, 172.16/12, 192.168/16 등) 서버를 허용할지. 사내 POP3 를 쓸 때만 켠다 */
    allowPrivate: bool('EXTERNAL_MAIL_ALLOW_PRIVATE', false),
  },

  db: {
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME'),
    poolSize: int('DB_POOL_SIZE', 10),
  },

  paths: {
    /** James MailFileStorage.baseDir(). MAIL_FILE_PATH 는 이 폴더 기준 상대경로다 */
    mailStore: path.resolve(str('MAIL_STORE_DIR')),
    /** APPEND 스테이징 폴더. James 쪽 설정과 같은 절대경로여야 한다 */
    staging: path.resolve(str('MAIL_STAGING_DIR')),
    largeAttach: path.resolve(str('LARGE_ATTACH_DIR')),
    uploadTmp: path.resolve(str('UPLOAD_TMP_DIR')),
  },

  james: {
    webadminUrl: str('JAMES_WEBADMIN_URL', 'http://localhost:8000').replace(/\/+$/, ''),
    webadminTimeoutMs: int('JAMES_WEBADMIN_TIMEOUT_MS', 30_000),
    smtpHost: str('JAMES_SMTP_HOST', '127.0.0.1'),
    smtpPort: int('JAMES_SMTP_PORT', 25),
  },

  policy: {
    tombstoneKeepDays: int('TOMBSTONE_KEEP_DAYS', 30),
    secretKey: str('SECRET_KEY'),
    messageIdDomain: process.env.MESSAGE_ID_DOMAIN || '',
    /** 발송 실패 안내메일의 From. 비우면 발신자 도메인의 postmaster@ 를 쓴다 */
    postmaster: process.env.POSTMASTER_ADDRESS || '',
    /** 동기화 응답 1회 최대 행 수 */
    syncPageSize: 500,
  },
} as const;

export type Config = typeof config;

/**
 * 비밀값 점검. 예시 파일의 값이나 짧은 값이 그대로 운영에 가면 세션 위조·외부 계정 비밀번호
 * 복호화가 가능해진다. 운영(NODE_ENV=production)에서는 기동을 멈추고, 개발에서는 경고만 한다.
 */
function checkSecrets(): void {
  const problems: string[] = [];
  const secret = config.sessionSecret;
  if (secret.length < 32 || /change-me/i.test(secret)) {
    problems.push('SESSION_SECRET 은 예시 값이 아닌 32자 이상의 임의 문자열이어야 합니다');
  }
  const key = config.policy.secretKey;
  if (key.length < 32 || /^0+$/.test(key) || /change-me/i.test(key)) {
    problems.push('SECRET_KEY 는 예시 값이 아닌 32자 이상의 임의 값이어야 합니다 (openssl rand -hex 32)');
  }
  if (problems.length === 0) return;
  if (config.isProduction) throw new Error(problems.join('\n'));
  for (const problem of problems) console.warn(`[config] ${problem}`);
}

checkSecrets();
