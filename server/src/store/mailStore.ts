/**
 * Read access to the James mail file store.
 *
 * JAMES_MAIL.MAIL_FILE_PATH 는 MailFileStorage.baseDir() 기준 상대경로다
 * ({도메인}/yyyy/MM/dd/{uuid}.eml). 웹서버와 James 가 같은 파일시스템을 봐야 한다
 * (webmail-issues.md 1-6). 결합 결과가 루트 밖이면 거부한다.
 */
import { createReadStream, type ReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { notFound, forbidden } from '../errors.js';

const ROOT = config.paths.mailStore;

/** 상대경로를 저장 루트에 결합하고 루트 밖으로 나가지 않는지 확인한다 */
export function resolveMailPath(relativePath: string): string {
  if (!relativePath) throw notFound('err.emptyMailPath');
  // MAIL_FILE_PATH 는 James 가 만든 값이지만, 경로 조작을 막는 검사는 그대로 둔다.
  const normalized = path.normalize(relativePath).replace(/^([/\\])+/, '');
  const absolute = path.resolve(ROOT, normalized);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolute !== ROOT && !absolute.startsWith(rootWithSep)) {
    throw forbidden('err.outsideRoot');
  }
  return absolute;
}

export async function statMail(relativePath: string): Promise<{ size: number; mtimeMs: number }> {
  const absolute = resolveMailPath(relativePath);
  try {
    const info = await stat(absolute);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    // JAMES_MAIL 은 계정 간 공유 행이라, 마지막 소유자가 지운 뒤 파일이 없을 수 있다.
    throw notFound('err.rawFileMissing');
  }
}

export function openMail(relativePath: string, range?: { start: number; end: number }): ReadStream {
  const absolute = resolveMailPath(relativePath);
  return range ? createReadStream(absolute, range) : createReadStream(absolute);
}

/**
 * 원문 앞머리 bytes 만큼을 읽는다. 목록이 헤더 한 줄(중요도)을 볼 때 쓴다.
 * 헤더 이름·값은 ASCII 라 latin1 로 그대로 읽어도 낱말 비교에 지장이 없다.
 * 파일이 없거나 경로가 수상하면 목록 전체를 실패시키지 않고 null 을 돌려준다.
 */
export async function readMailHead(relativePath: string, bytes: number): Promise<string | null> {
  if (!relativePath || bytes <= 0) return null;
  let handle;
  try {
    handle = await open(resolveMailPath(relativePath), 'r');
  } catch {
    // 마지막 소유자가 지운 뒤 파일이 없을 수 있다 (statMail 주석과 같은 사정)
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
