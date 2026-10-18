/**
 * USR-14 프로필 사진 저장.
 *
 * JAMES_USER.USER_PHOTO 는 James 가 만드는 컬럼이라 길이를 늘리지 않았다(7-6).
 * 그래서 이미지 자체는 사이트 로고와 같은 방식으로 LARGE_ATTACH_DIR/photo/ 아래
 * 파일로 두고, 컬럼에는 공개 URL(/api/photo/<파일명>)만 넣는다. 50 자 안쪽이라
 * 기본 VARCHAR 길이로도 들어간다.
 *
 * 파일명은 <계정 해시 16자>-<타임스탬프>.<확장자> 다.
 *  - 계정 주소를 파일명에 그대로 쓰지 않아 폴더만 봐서는 주소를 알 수 없다
 *  - 타임스탬프가 바뀌므로 새로 올리면 URL 이 달라진다(캐시가 옛 사진을 못 준다)
 */
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** 컬럼에 저장하는 URL 접두사 = 서빙 라우트 경로 */
export const PHOTO_URL_PREFIX = '/api/photo/';

/** 서빙 라우트가 허용하는 파일명 (경로 조작 차단) */
export const PHOTO_NAME_RE = /^[0-9a-f]{16}-\d{13}\.(png|jpg|gif|webp)$/;

export const PHOTO_MAX_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function photoDir(): string {
  return path.join(config.paths.largeAttach, 'photo');
}

export function photoFilePath(name: string): string {
  return path.join(photoDir(), name);
}

export function photoContentType(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function newPhotoName(userName: string, ext: string): string {
  const key = createHash('sha256').update(userName.toLowerCase()).digest('hex').slice(0, 16);
  return `${key}-${Date.now()}${ext}`;
}

/**
 * 확장자·Content-Type 은 브라우저가 주는 값이라 믿지 않고 시그니처로 판별한다.
 * SVG 는 스크립트를 품을 수 있어 받지 않는다(사이트 로고와 다른 점).
 */
export async function sniffImageExt(file: string): Promise<'.png' | '.jpg' | '.gif' | '.webp' | null> {
  const head = Buffer.alloc(12);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (bytesRead < 12) return null;
  } finally {
    await handle.close();
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return '.gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

/** 옛 사진 삭제. 우리가 만든 이름일 때만 지운다(로고·다른 값이 들어와도 안전) */
export async function removePhotoByUrl(url: string | null): Promise<void> {
  if (!url || !url.startsWith(PHOTO_URL_PREFIX)) return;
  const name = url.slice(PHOTO_URL_PREFIX.length);
  if (!PHOTO_NAME_RE.test(name)) return;
  await rm(photoFilePath(name), { force: true }).catch(() => undefined);
}
