/**
 * UUID v7 in the same shape as James' JPAUniqueIdGenerator.
 *
 * 48비트 밀리초 타임스탬프 + 74비트 난수를 표준 36자로 렌더링한다.
 * 발송 시 발급하는 senderMailId 가 곧 Sent 사본의 MAIL_ID 이자
 * X-Sender-Mail-ID 헤더 값이며, 그 헤더 컬럼(SENDER_MAIL_ID)이 VARCHAR(36) 이라
 * 36자를 넘으면 안 된다 (webmail-issues.md 1-1, webmail-architecture.md 5.3).
 */
import { randomBytes } from 'node:crypto';

export function uuidv7(): string {
  const bytes = randomBytes(16);
  const millis = Date.now();

  // 48 bit timestamp
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;
  // version 7
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  // RFC 4122 variant
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 스테이징 파일 이름으로 쓰기 전에 확인한다 (4-1a: 경로에 사용자 입력이 섞이면 안 된다) */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
