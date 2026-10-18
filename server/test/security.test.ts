/**
 * 보안 관련 순수 함수 단위 테스트. DB·James 없이 돈다 (`npm test`).
 *
 * config.ts 가 필수 환경변수를 요구하므로, .env 가 없는 환경(CI)에서도 뜨도록 빈 자리만
 * 채운 뒤 모듈을 불러온다. DB 풀은 만들어지지만 쿼리를 하지 않으므로 연결하지 않는다.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = path.join(os.tmpdir(), 'j9-unit');
for (const [key, value] of Object.entries({
  SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  SECRET_KEY: 'unit-test-secret-key-0123456789abcdef0123',
  DB_USER: 'unit',
  DB_NAME: 'unit',
  MAIL_STORE_DIR: path.join(tmp, 'store'),
  MAIL_STAGING_DIR: path.join(tmp, 'staging'),
  LARGE_ATTACH_DIR: path.join(tmp, 'large'),
  UPLOAD_TMP_DIR: path.join(tmp, 'upload'),
})) {
  if (!process.env[key]) process.env[key] = value;
}

const { createRateLimiter } = await import('../src/util/rateLimit.js');
const { isBlockedAddress } = await import('../src/services/externalMail.js');
const { normalizeDropEntity } = await import('../src/repositories/dropList.js');
const { stripBccHeader } = await import('../src/mime/stripBcc.js');
const { hashPassword, verifyPassword } = await import('../src/auth/password.js');
const { escapeLike } = await import('../src/util/mysql.js');
const { parseNotifyTo } = await import('../src/mime/mdn.js');
const { createSession, destroyUserSessions, readSession } = await import('../src/auth/session.js');
const { closeDb } = await import('../src/db/kysely.js');

after(async () => {
  await closeDb();
});

describe('요청 제한', () => {
  test('한도까지는 통과하고 넘으면 남은 시간을 돌려준다', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
    assert.equal(limiter.hit('a'), 0);
    assert.equal(limiter.hit('a'), 0);
    assert.equal(limiter.hit('a'), 0);
    assert.equal(limiter.blockedFor('a') > 0, true);
    assert.equal(limiter.hit('a') > 0, true);
    // 다른 키는 따로 센다
    assert.equal(limiter.blockedFor('b'), 0);
  });

  test('reset 하면 다시 열린다', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    limiter.hit('k');
    limiter.hit('k');
    assert.ok(limiter.blockedFor('k') > 0);
    limiter.reset('k');
    assert.equal(limiter.blockedFor('k'), 0);
  });
});

describe('외부메일 접속 대상 (SSRF)', () => {
  test('루프백·링크로컬·미지정은 언제나 막는다', () => {
    for (const ip of ['127.0.0.1', '127.8.8.8', '0.0.0.0', '169.254.169.254', '::1', '::', '::ffff:127.0.0.1', 'fe80::1']) {
      assert.equal(isBlockedAddress(ip, true), true, ip);
    }
  });

  test('사설 대역은 설정으로만 연다', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', 'fd00::1']) {
      assert.equal(isBlockedAddress(ip, false), true, ip);
      assert.equal(isBlockedAddress(ip, true), false, ip);
    }
  });

  test('공인 주소는 통과한다', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) {
      assert.equal(isBlockedAddress(ip, false), false, ip);
    }
  });
});

describe('수신거부 값 정리', () => {
  test('주소와 도메인을 소문자로 판정한다', () => {
    assert.deepEqual(normalizeDropEntity(' Spam@Example.COM '), { entity: 'spam@example.com', type: 'ADDRESS' });
    assert.deepEqual(normalizeDropEntity('bad.example.org'), { entity: 'bad.example.org', type: 'DOMAIN' });
  });

  test('형식이 아니면 400', () => {
    for (const value of ['abc', 'a b@c.com', 'x@', '@example.com', "'; drop table", 'example']) {
      assert.throws(() => normalizeDropEntity(value), (error: { statusCode?: number }) => error.statusCode === 400, value);
    }
  });
});

describe('Bcc 제거', () => {
  async function run(input: string, chunk = 7): Promise<string> {
    const parts: Buffer[] = [];
    const source = Readable.from(
      Array.from({ length: Math.ceil(input.length / chunk) }, (_, i) => Buffer.from(input.slice(i * chunk, (i + 1) * chunk), 'latin1')),
    );
    for await (const part of source.pipe(stripBccHeader())) parts.push(part as Buffer);
    return Buffer.concat(parts).toString('latin1');
  }

  test('접힌 줄까지 지우고 본문의 Bcc: 는 남긴다', async () => {
    const raw = 'From: a@x.com\r\nBcc: b@x.com,\r\n c@x.com\r\nSubject: hi\r\n\r\nBcc: body line\r\n';
    assert.equal(await run(raw), 'From: a@x.com\r\nSubject: hi\r\n\r\nBcc: body line\r\n');
  });
});

describe('비밀번호 검증 (James 해시 재현)', () => {
  test('PBKDF2-SHA512 는 계정 이름을 salt 로 쓴다', () => {
    const stored = hashPassword('secret', 'user@example.com', 'PBKDF2-SHA512');
    assert.equal(verifyPassword('secret', 'user@example.com', stored, 'PBKDF2-SHA512'), true);
    assert.equal(verifyPassword('secret', 'other@example.com', stored, 'PBKDF2-SHA512'), false);
    assert.equal(verifyPassword('wrong', 'user@example.com', stored, 'PBKDF2-SHA512'), false);
  });

  test('빈 값은 언제나 실패', () => {
    assert.equal(verifyPassword('', 'u', 'x', 'SHA-512'), false);
    assert.equal(verifyPassword('p', 'u', '', 'SHA-512'), false);
  });
});

describe('기타', () => {
  test('LIKE 특수문자를 글자 그대로 찾게 한다', () => {
    assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  });

  test('수신확인 요청은 첫 주소 하나만, 주소가 아니면 무시한다', () => {
    assert.equal(parseNotifyTo('Subject: x\r\nDisposition-Notification-To: A <a@x.com>, b@y.com\r\n\r\n'), 'a@x.com');
    assert.equal(parseNotifyTo('Disposition-Notification-To: nobody\r\n\r\n'), null);
  });

  test('비밀번호를 바꾸면 그 사용자의 다른 세션만 끊긴다', () => {
    const base = { displayName: null, isAdmin: false, locale: 'ko' as const };
    const mine = createSession({ ...base, userName: 'u@x.com' });
    const other = createSession({ ...base, userName: 'U@x.com' });
    const stranger = createSession({ ...base, userName: 'v@x.com' });
    assert.equal(destroyUserSessions('u@x.com', mine), 1);
    assert.ok(readSession(mine));
    assert.equal(readSession(other), null);
    assert.ok(readSession(stranger));
  });
});
