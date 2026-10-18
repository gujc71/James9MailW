/**
 * multipart 업로드를 임시 파일로 받는다.
 *
 * 30MB 첨부 10개가 base64 로 40MB 가 된다. 이것을 메모리 문자열로 조립하면
 * 동시 발송 몇 건에 Node 힙이 찬다. 스트림 -> 임시 파일 -> nodemailer 스트림 첨부로
 * 흘려보낸다 (webmail-issues.md 3-5).
 */
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export interface UploadedFile {
  field: string;
  filename: string;
  contentType: string;
  path: string;
  size: number;
}

export interface ParsedMultipart {
  fields: Record<string, string[]>;
  files: UploadedFile[];
  cleanup(): Promise<void>;
}

async function ensureTmpDir(): Promise<string> {
  await mkdir(config.paths.uploadTmp, { recursive: true });
  return config.paths.uploadTmp;
}

/**
 * 라우트별 업로드 한도. app.ts 의 전역 한도(200MB × 50개)는 가장 큰 경로(발송)에 맞춘
 * 상한이라, 사진처럼 작은 업로드에도 그대로 두면 검사 전에 수백 MB 를 디스크에 받아 버린다.
 * 여기서 주면 busboy 가 **받는 도중에** 끊는다 (넘치면 413).
 */
export interface MultipartLimits {
  /** 파일 하나의 최대 바이트 */
  fileSize?: number;
  /** 파일 개수 */
  files?: number;
  /** 본문 같은 텍스트 필드 하나의 최대 바이트 */
  fieldSize?: number;
  /** 모든 파일을 합친 최대 바이트. 넘으면 그 자리에서 413 */
  totalFileSize?: number;
}

/** 파일 이름은 헤더에서 오므로 경로로 쓰지 않는다. 저장 이름은 UUID 다 */
export async function parseMultipart(
  request: FastifyRequest,
  limits: MultipartLimits = {},
): Promise<ParsedMultipart> {
  const dir = await ensureTmpDir();
  const fields: Record<string, string[]> = {};
  const files: UploadedFile[] = [];
  // 쓰다가 실패한 파일까지 지워야 하므로 목록에 넣기 전에 경로부터 기억한다
  const written: string[] = [];
  const cleanup = async () => {
    await Promise.allSettled(written.map((file) => rm(file, { force: true })));
  };

  const busboyLimits: Record<string, number> = {};
  if (limits.fileSize !== undefined) busboyLimits.fileSize = limits.fileSize;
  if (limits.files !== undefined) busboyLimits.files = limits.files;
  if (limits.fieldSize !== undefined) busboyLimits.fieldSize = limits.fieldSize;

  let total = 0;
  try {
    for await (const part of request.parts({ limits: busboyLimits })) {
      if (part.type === 'file') {
        const file = part as MultipartFile;
        const target = path.join(dir, `${randomUUID()}.upload`);
        written.push(target);
        await pipeline(file.file, createWriteStream(target));
        const info = await stat(target);
        total += info.size;
        if (limits.totalFileSize !== undefined && total > limits.totalFileSize) {
          throw Object.assign(new Error('multipart total size exceeded'), { statusCode: 413 });
        }
        files.push({
          field: file.fieldname,
          filename: file.filename || 'attachment',
          contentType: file.mimetype || 'application/octet-stream',
          path: target,
          size: info.size,
        });
      } else {
        const value = part as MultipartValue;
        const list = (fields[value.fieldname] ??= []);
        list.push(String(value.value));
      }
    }
  } catch (cause) {
    await cleanup();
    throw cause;
  }

  return { fields, files, cleanup };
}

export function field(fields: Record<string, string[]>, name: string): string | undefined {
  return fields[name]?.[0];
}

export function jsonField<T>(fields: Record<string, string[]>, name: string, fallback: T): T {
  const raw = field(fields, name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function boolField(fields: Record<string, string[]>, name: string): boolean {
  const raw = field(fields, name);
  return raw === 'true' || raw === '1' || raw === 'Y';
}

/** 대용량 첨부 저장 루트 기준 상대경로를 만든다 (GU_LARGE_ATTACH.FILE_PATH) */
export async function moveToLargeStore(source: string, attachId: string): Promise<string> {
  const today = new Date();
  const relativeDir = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
  const absoluteDir = path.join(config.paths.largeAttach, relativeDir);
  await mkdir(absoluteDir, { recursive: true });
  const relativePath = `${relativeDir}/${attachId}`;
  await moveFile(source, path.join(config.paths.largeAttach, relativePath));
  return relativePath;
}

/** 임시 폴더와 저장 폴더가 다른 드라이브면 rename 이 실패한다 */
export async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch {
    await copyFile(source, target);
    await rm(source, { force: true });
  }
}

/** 대용량 첨부 경로도 루트 밖으로 나가지 않는지 확인한다 */
export function resolveLargePath(relativePath: string): string {
  const root = config.paths.largeAttach;
  const absolute = path.resolve(root, path.normalize(relativePath).replace(/^([/\\])+/, ''));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new Error('large attachment path escapes the store root');
  }
  return absolute;
}
