/**
 * Verifies a password against JAMES_USER.PASSWORD without going through James.
 *
 * james9Mail 의 JPAUser.hashPassword 를 그대로 재현한다.
 *  - salt 는 사용자 이름(full address) 이다: hashPassword(pass, name, alg)
 *  - PBKDF2-SHA512[-iter[-keysize]] : PBKDF2WithHmacSHA512(pass, salt ISO-8859-1,
 *    iter=1000, keySize=512bit) 결과를 base64 로 인코딩. James 는 MimeUtility 로
 *    인코딩하므로 76자마다 CRLF 가 들어간다 → 비교 전에 공백을 제거한다.
 *  - PBKDF2-<iter>-<keysize> (legacy) : 같은 방식이되 HmacSHA1
 *  - 그 외(SHA-512 등) : guava Hashing.<alg>(salt+password, UTF-8) 의 소문자 hex
 *
 * 사용자 비밀번호는 여기서만 쓰고 보관하지 않는다. SMTP 는 25 번 무인증 릴레이라
 * 발송에 비밀번호가 필요하지 않다 (webmail-issues.md 1-2).
 */
import { createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

function pbkdf2Base64(
  password: string,
  salt: string,
  digest: 'sha512' | 'sha1',
  iterations: number,
  keySizeBits: number,
): string {
  const derived = pbkdf2Sync(
    password,
    Buffer.from(salt, 'latin1'),
    iterations,
    keySizeBits / 8,
    digest,
  );
  return derived.toString('base64');
}

function parseParts(algorithm: string, offset: number): { iterations: number; keySize: number } {
  const parts = algorithm.split('-');
  const iterations = parts.length >= offset + 1 ? Number.parseInt(parts[offset]!, 10) : 1000;
  const keySize = parts.length >= offset + 2 ? Number.parseInt(parts[offset + 1]!, 10) : 512;
  return {
    iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : 1000,
    keySize: Number.isFinite(keySize) && keySize > 0 ? keySize : 512,
  };
}

/** 공백(James 가 넣는 CRLF 줄바꿈 포함)을 지우고 상수시간 비교 */
function equalsIgnoringWhitespace(a: string, b: string): boolean {
  const left = Buffer.from(a.replace(/\s+/g, ''), 'utf8');
  const right = Buffer.from(b.replace(/\s+/g, ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashPassword(password: string, userName: string, algorithmRaw: string): string {
  // "SHA-512/SALTED" 처럼 슬래시로 hashing mode 를 붙일 수 있다. 이름만 떼어 쓴다.
  const algorithm = (algorithmRaw || 'SHA-512').split('/')[0]!;

  if (algorithm.startsWith('PBKDF2-SHA512')) {
    const { iterations, keySize } = parseParts(algorithm, 2);
    return pbkdf2Base64(password, userName, 'sha512', iterations, keySize);
  }
  if (algorithm.startsWith('PBKDF2')) {
    const { iterations, keySize } = parseParts(algorithm, 1);
    return pbkdf2Base64(password, userName, 'sha1', iterations, keySize);
  }
  if (algorithm === 'NONE') return password;

  const nodeAlg =
    algorithm === 'MD5'
      ? 'md5'
      : algorithm === 'SHA-256'
        ? 'sha256'
        : algorithm === 'SHA-1' || algorithm === 'SHA1'
          ? 'sha1'
          : 'sha512';
  // JPAUser 는 salted 알고리즘일 때만 salt 를 붙인다. 기본(PLAIN) 모드에서는 붙이지 않는다.
  const salted = algorithmRaw.toUpperCase().includes('SALTED');
  const input = salted ? userName + password : password;
  return createHash(nodeAlg).update(input, 'utf8').digest('hex');
}

export function verifyPassword(
  password: string,
  userName: string,
  storedHash: string,
  algorithm: string,
): boolean {
  if (!password || !storedHash) return false;
  return equalsIgnoringWhitespace(hashPassword(password, userName, algorithm), storedHash);
}
