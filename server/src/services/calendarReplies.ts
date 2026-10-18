/**
 * 받은 일정 응답(iTIP REPLY) 메일을 주최자의 캘린더에 저절로 반영한다.
 *
 * 참석자가 수락 · 미정 · 거절하면 주최자 편지함에 METHOD:REPLY 메일이 온다. 예전에는 주최자가
 * 그 메일을 열어 [참석 응답을 내 일정에 반영] 을 눌러야만 참석자 응답이 바뀌었다.
 * 이제 캘린더를 열거나 일정을 펼칠 때 아직 반영하지 않은 REPLY 메일을 찾아 적용한다.
 *  - 후보는 DB(MIME 파트 표)로 고르고, 원문은 후보만 연다
 *  - 반영한 메일은 GU_CALENDAR_RESPONSE 에 표시해 다시 열지 않는다
 *  - REPLY 가 아닌 것으로 드러난 일정 메일(REQUEST 등)은 표시할 수 없어(그 칸은 내 응답 기록이다)
 *    프로세스 메모리에 기억해 둔다
 */
import { readFile } from 'node:fs/promises';
import PostalMime from 'postal-mime';
import { resolveMailPath } from '../store/mailStore.js';
import { markReplyApplied, pendingReplyMails } from '../repositories/gu.js';
import { applyItip } from './calendarItip.js';
import type { Locale } from '../i18n.js';

/** 이보다 오래된 메일은 보지 않는다 */
const WINDOW_MS = 60 * 86_400_000;
/** 한 번에 여는 원문 수 상한. 남은 것은 다음 번에 */
const BATCH = 50;
const NOT_REPLY_MAX = 10_000;

const notReply = new Set<string>();
const running = new Map<string, Promise<number>>();

function decode(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content instanceof ArrayBuffer) return new TextDecoder().decode(content);
  if (ArrayBuffer.isView(content)) return new TextDecoder().decode(content as ArrayBufferView);
  return '';
}

/** 원문에서 METHOD 가 method 인 text/calendar 파트를 꺼낸다. 없으면 null */
export async function calendarPartOf(filePath: string, method: string): Promise<string | null> {
  const raw = await readFile(resolveMailPath(filePath));
  const parsed = await PostalMime.parse(raw);
  const pattern = new RegExp(`^METHOD:\\s*${method}\\s*$`, 'im');
  for (const part of parsed.attachments ?? []) {
    if ((part.mimeType ?? '').toLowerCase() !== 'text/calendar') continue;
    const text = decode(part.content);
    if (pattern.test(text)) return text;
  }
  return null;
}

const replyCalendarOf = (filePath: string) => calendarPartOf(filePath, 'REPLY');

async function sweep(userName: string, locale: Locale): Promise<number> {
  const rows = (await pendingReplyMails(userName, new Date(Date.now() - WINDOW_MS), BATCH + notReply.size))
    .filter((r) => !notReply.has(r.mailId))
    .slice(0, BATCH);
  let changed = 0;
  for (const row of rows) {
    let ics: string | null;
    try {
      ics = await replyCalendarOf(row.filePath);
    } catch {
      // 원문이 없거나 깨졌다. 다시 열어 봐야 같으니 반영한 것으로 친다
      await markReplyApplied(row.mailId, userName);
      continue;
    }
    if (!ics) {
      if (notReply.size >= NOT_REPLY_MAX) notReply.clear();
      notReply.add(row.mailId);
      continue;
    }
    try {
      changed += (await applyItip(userName, ics, 'reply', locale)).changed;
    } catch {
      // 해석할 수 없는 응답. 반영할 것이 없다
    }
    await markReplyApplied(row.mailId, userName);
  }
  return changed;
}

/** 같은 사용자의 동시 호출은 하나로 합친다. 실패해도 캘린더 화면은 그대로 열리게 삼킨다 */
export function applyPendingReplies(userName: string, locale: Locale): Promise<number> {
  const current = running.get(userName);
  if (current) return current;
  const task = sweep(userName, locale)
    .catch(() => 0)
    .finally(() => running.delete(userName));
  running.set(userName, task);
  return task;
}
