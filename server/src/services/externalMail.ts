/**
 * 외부메일 가져오기 (USR-18).
 *
 * James 의 FetchMail 은 XML 정적 설정이라 GU_EXTERNAL_EMAIL 로 동적 등록되는 계정에
 * 맞지 않는다. 웹서버가 POP3/IMAP 으로 받아 원문을 스테이징 폴더에 쓰고 APPEND
 * 라우트로 넣는다. mailId 를 넘기면 MailTypeResolver 가 From 헤더 기준으로 OI 를
 * 판정하므로 별도 파라미터가 필요 없다 (webmail-issues.md 4-3).
 *
 * 한 번에 수백 통을 가져올 수 있으므로 라우트 호출은 순차로 한다.
 */
import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { forbidden } from '../errors.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { commitStaging, writeStagingStream } from '../store/staging.js';
import { appendStagedFile } from './append.js';
import { uuidv7 } from '../util/uuidv7.js';

// ------------------------------------------------------------------ 비밀번호 암호화

function secretKey(): Buffer {
  return createHash('sha256').update(config.policy.secretKey).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split('.');
  if (!iv || !tag || !data) throw new Error('stored secret is malformed');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

// ------------------------------------------------------------------ 접속 대상 검사 (SSRF)

/** IPv4 를 32비트 정수로 */
function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** 어떤 설정으로도 열 수 없는 대역: 루프백·링크로컬(클라우드 메타데이터)·미지정·멀티캐스트 */
const V4_ALWAYS_BLOCKED = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];
/** 사내 서버를 쓰려면 EXTERNAL_MAIL_ALLOW_PRIVATE 로 여는 대역 */
const V4_PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

export function isBlockedAddress(ip: string, allowPrivate: boolean): boolean {
  let address = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) 는 IPv4 로 본다
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) address = mapped[1]!;
  if (net.isIPv4(address)) {
    if (V4_ALWAYS_BLOCKED.some((cidr) => inV4(address, cidr))) return true;
    return !allowPrivate && V4_PRIVATE.some((cidr) => inV4(address, cidr));
  }
  if (net.isIPv6(address)) {
    if (address === '::' || address === '::1') return true;
    if (/^fe[89ab]/.test(address) || address.startsWith('ff')) return true; // 링크로컬 · 멀티캐스트
    if (/^f[cd]/.test(address)) return !allowPrivate; // 고유 로컬(사설)
    return false;
  }
  return true;
}

/**
 * 사용자가 적은 서버 주소를 IP 로 풀어 막힌 대역인지 본다. 이 검사가 없으면 외부메일 설정이
 * 웹서버 안쪽(WebAdmin 8000, DB 3306, 클라우드 메타데이터)을 두드리는 통로가 된다.
 * 검사한 IP 로 그대로 접속해야 DNS 를 두 번 풀 때 답이 바뀌는 수법(rebinding)도 막힌다.
 */
export async function resolveAllowedHost(host: string): Promise<string> {
  const allowPrivate = config.externalMail.allowPrivate;
  if (/^localhost\.?$/i.test(host)) throw forbidden('err.externalHostBlocked');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address, allowPrivate))) {
    throw forbidden('err.externalHostBlocked');
  }
  return addresses[0]!.address;
}

// ------------------------------------------------------------------ POP3

/** 응답 하나가 이보다 크면 끊는다. 악의적 서버가 끝없이 보내 메모리를 채우지 못하게 한다 */
const POP3_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 아주 작은 POP3 클라이언트. RETR 로 원문을 받아 그대로 넘긴다.
 * 유지보수 중인 POP3 라이브러리가 마땅치 않아 직접 구현했다.
 */
class Pop3Client {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private pending: { resolve: (v: string) => void; reject: (e: Error) => void; multiline: boolean } | null =
    null;

  private failure: Error | null = null;

  constructor(
    /** 검사를 마친 IP. 이름을 다시 풀지 않는다 (resolveAllowedHost) */
    private readonly address: string,
    /** 인증서 확인용 원래 서버 이름 */
    private readonly serverName: string,
    private readonly port: number,
    private readonly useTls: boolean,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this.socket!.removeListener('error', reject);
        resolve();
      };
      this.socket = this.useTls
        ? tls.connect(
            {
              host: this.address,
              port: this.port,
              servername: net.isIP(this.serverName) ? undefined : this.serverName,
              rejectUnauthorized: !config.externalMail.tlsInsecure,
            },
            onReady,
          )
        : net.connect({ host: this.address, port: this.port }, onReady);
      this.socket.setTimeout(60_000);
      this.socket.once('error', reject);
      this.socket.on('data', (chunk) => this.onData(chunk.toString('binary')));
      // 연결 뒤의 오류·타임아웃·끊김도 기다리던 응답을 실패시켜야 한다. 안 그러면 Promise 가 영영 안 끝난다
      this.socket.on('error', (error) => this.fail(error));
      this.socket.on('timeout', () => this.fail(new Error('POP3 server timed out')));
      this.socket.on('close', () => this.fail(new Error('POP3 connection closed')));
    });
    await this.read(false); // greeting
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.socket?.destroy();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > POP3_MAX_BUFFER) {
      this.fail(new Error('POP3 response too large'));
      return;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.pending) return;
    if (this.pending.multiline) {
      const end = this.buffer.indexOf('\r\n.\r\n');
      if (this.buffer.startsWith('-ERR')) {
        const line = this.buffer.indexOf('\r\n');
        if (line < 0) return;
        const message = this.buffer.slice(0, line);
        this.buffer = this.buffer.slice(line + 2);
        const pending = this.pending;
        this.pending = null;
        pending.reject(new Error(message));
        return;
      }
      if (end < 0) return;
      const payload = this.buffer.slice(0, end + 2);
      this.buffer = this.buffer.slice(end + 5);
      const pending = this.pending;
      this.pending = null;
      pending.resolve(payload);
      return;
    }
    const line = this.buffer.indexOf('\r\n');
    if (line < 0) return;
    const response = this.buffer.slice(0, line);
    this.buffer = this.buffer.slice(line + 2);
    const pending = this.pending;
    this.pending = null;
    if (response.startsWith('-ERR')) pending.reject(new Error(response));
    else pending.resolve(response);
  }

  private read(multiline: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.pending = { resolve, reject, multiline };
      this.flush();
    });
  }

  private async command(line: string, multiline = false): Promise<string> {
    // 줄바꿈이 섞이면 한 명령에 다른 명령을 덧붙일 수 있다 (명령 주입)
    if (/[\r\n]/.test(line)) throw new Error('POP3 command must not contain line breaks');
    this.socket!.write(`${line}\r\n`, 'binary');
    return this.read(multiline);
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${password}`);
  }

  /** 메시지 번호 목록 */
  async list(): Promise<number[]> {
    const body = await this.command('LIST', true);
    return body
      .split(/\r?\n/)
      .slice(1)
      .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
      .filter((n) => Number.isFinite(n));
  }

  async retrieve(index: number): Promise<Buffer> {
    const body = await this.command(`RETR ${index}`, true);
    // 첫 줄(+OK ...)을 떼고, byte-stuffing(..) 을 되돌린다
    const firstLine = body.indexOf('\r\n');
    const raw = body.slice(firstLine + 2).replace(/^\.\./gm, '.');
    return Buffer.from(raw, 'binary');
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } catch {
      // 서버가 이미 끊었다
    }
    this.socket?.destroy();
  }
}

// ------------------------------------------------------------------ 가져오기

export interface FetchAccount {
  externalId: number;
  userName: string;
  host: string;
  port: number;
  protocol: 'POP3' | 'IMAP';
  security: 'PLAIN' | 'SSL';
  loginId: string;
  password: string;
  targetMailboxId: string;
}

export interface FetchResult {
  fetched: number;
  stored: number;
  errors: string[];
}

async function storeOne(account: FetchAccount, raw: Buffer): Promise<boolean> {
  const mailId = uuidv7();
  await writeStagingStream(mailId, Readable.from(raw));
  await commitStaging(mailId);
  const outcome = await appendStagedFile({
    mailboxId: account.targetMailboxId,
    mailId,
    // 외부에서 이미 읽은 메일이므로 읽음 상태로 넣는다 (USR-18)
    flags: ['\\Seen'],
  });
  return outcome.ok;
}

async function fetchPop3(account: FetchAccount, limit: number): Promise<FetchResult> {
  const address = await resolveAllowedHost(account.host);
  const client = new Pop3Client(address, account.host, account.port, account.security === 'SSL');
  const errors: string[] = [];
  let fetched = 0;
  let stored = 0;
  await client.connect();
  try {
    await client.login(account.loginId, account.password);
    const indexes = (await client.list()).slice(0, limit);
    for (const index of indexes) {
      try {
        const raw = await client.retrieve(index);
        fetched += 1;
        if (await storeOne(account, raw)) stored += 1;
        // 원본은 지우지 않는다. 지우려면 DELE 를 보내야 하는데 설계서에 그런 옵션이 없다.
      } catch (cause) {
        errors.push(`#${index}: ${(cause as Error).message}`);
      }
    }
  } finally {
    await client.quit();
  }
  return { fetched, stored, errors };
}

async function fetchImap(account: FetchAccount, limit: number): Promise<FetchResult> {
  const address = await resolveAllowedHost(account.host);
  const client = new ImapFlow({
    host: address,
    port: account.port,
    secure: account.security === 'SSL',
    auth: { user: account.loginId, pass: account.password },
    logger: false,
    tls: {
      rejectUnauthorized: !config.externalMail.tlsInsecure,
      // IP 로 접속하므로 인증서 확인에 쓸 원래 이름을 따로 준다
      ...(net.isIP(account.host) ? {} : { servername: account.host }),
    },
  });
  const errors: string[] = [];
  let fetched = 0;
  let stored = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      const total = typeof mailbox === 'object' ? mailbox.exists : 0;
      if (total > 0) {
        const from = Math.max(1, total - limit + 1);
        for await (const message of client.fetch(`${from}:${total}`, { source: true })) {
          if (!message.source) continue;
          fetched += 1;
          try {
            if (await storeOne(account, message.source)) stored += 1;
          } catch (cause) {
            errors.push(`#${message.seq}: ${(cause as Error).message}`);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { fetched, stored, errors };
}

/** 지금 가져오는 중인 계정. 같은 계정을 두 번 돌리면 같은 메일이 두 벌 들어간다 */
const running = new Set<number>();

export function isFetchRunning(externalId: number): boolean {
  return running.has(externalId);
}

export async function fetchExternal(account: FetchAccount, limit = 200): Promise<FetchResult> {
  running.add(account.externalId);
  try {
    return await (account.protocol === 'IMAP' ? fetchImap(account, limit) : fetchPop3(account, limit));
  } finally {
    running.delete(account.externalId);
  }
}
