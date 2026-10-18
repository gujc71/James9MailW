/**
 * Staging folder for the James APPEND route.
 *
 * webmail-issues.md 4-1 / 4-1a / 4-1b:
 *  - 웹서버가 원문을 {mailId}.eml 로 쓰고, 라우트에는 **파일 이름만** 넘긴다.
 *  - {mailId}.eml.part 로 쓴 뒤 rename 해서 James 가 쓰다 만 파일을 읽지 않게 한다.
 *  - 성공하든 실패하든 웹서버가 지운다.
 *  - 하루 지난 잔여 파일은 스케줄러가 지운다.
 * 파일 이름은 항상 웹서버가 발급한 UUID 라 사용자 입력이 경로에 섞이지 않는다.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import { isUuid } from '../util/uuidv7.js';

const DIR = config.paths.staging;

export async function ensureStagingDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

function paths(mailId: string): { part: string; final: string; name: string } {
  if (!isUuid(mailId)) throw new Error(`staging file name must be a uuid: ${mailId}`);
  const name = `${mailId}.eml`;
  return { part: path.join(DIR, `${name}.part`), final: path.join(DIR, name), name };
}

/** Buffer 를 스테이징에 쓰고 완성된 파일 이름을 돌려준다 */
export async function writeStagingBuffer(mailId: string, data: Buffer): Promise<string> {
  await ensureStagingDir();
  const { part, final, name } = paths(mailId);
  await writeFile(part, data);
  await rename(part, final);
  return name;
}

/** 스트림을 .part 로 흘려 쓴다. commit 을 불러야 James 가 볼 수 있는 이름이 된다 */
export async function writeStagingStream(mailId: string, source: Readable): Promise<void> {
  await ensureStagingDir();
  const { part } = paths(mailId);
  await pipeline(source, createWriteStream(part));
}

export async function commitStaging(mailId: string): Promise<string> {
  const { part, final, name } = paths(mailId);
  await rename(part, final);
  return name;
}

export function stagingPartPath(mailId: string): string {
  return paths(mailId).part;
}

export function stagingFinalPath(mailId: string): string {
  return paths(mailId).final;
}

export function stagingFileName(mailId: string): string {
  return paths(mailId).name;
}

/** APPEND 이 끝나면 성공·실패와 무관하게 호출한다 */
export async function removeStaging(mailId: string): Promise<void> {
  const { part, final } = paths(mailId);
  await rm(final, { force: true });
  await rm(part, { force: true });
}

/** 하루 지난 잔여 파일 정리 (4-1b) */
export async function sweepStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  await ensureStagingDir();
  const now = Date.now();
  let removed = 0;
  for (const entry of await readdir(DIR)) {
    const full = path.join(DIR, entry);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(full, { force: true });
        removed += 1;
      }
    } catch {
      // 다른 프로세스가 먼저 지웠다
    }
  }
  return removed;
}
