/**
 * 받은 메일의 "중요도 높음" 판정.
 *
 * 발신자가 선언한 중요도는 헤더(Importance · X-Priority · X-MSMail-Priority ·
 * Priority)로만 오고, James 는 이 값을 컬럼으로 뽑아 두지 않는다. 그래서 목록에
 * 띄우려면 원문을 열어야 한다 — repositories/messages.ts 머리말이 말하는
 * "목록을 위해 원문을 열지 않는다" 의 유일한 예외다. 대신 두 가지로 값을 아낀다:
 *  - 본문 시작 오프셋(JAMES_MAIL.MAIL_BODY_START_OCTET)까지만, 그것도 상한을 두고 읽는다
 *  - MAIL_ID 로 캐시한다. 한 통의 중요도는 뒤에 바뀌지 않으므로 무효화가 없다
 *
 * 별표(\Flagged)와는 다른 값이다. 별표는 받는 사람이 직접 찍고 언제든 끄는 표시이고,
 * 이 값은 보낸 사람이 붙여 보낸 것으로 받는 사람이 바꿀 수 없다. 화면도 따로 보여 준다.
 */
import { readMailHead } from '../store/mailStore.js';

/** 지금은 '높음' 만 화면에 쓴다. 낮음(Importance: low)은 표시하지 않는다 */
export type Importance = 'high' | null;

/** 헤더 블록이 이보다 길면 잘라 읽는다. 중요도 헤더는 앞머리에 있다 */
const HEAD_READ_CAP = 32 * 1024;

const CACHE_MAX = 5000;
/** MAIL_ID → 중요도. 삽입 순서대로 가장 오래된 것을 버린다 */
const cache = new Map<string, Importance>();

function remember(mailId: string, value: Importance): Importance {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(mailId, value);
  return value;
}

/**
 * 헤더 블록 → 중요도. 접힌 줄(RFC 5322 folding)을 펴고 첫 빈 줄에서 멈춘다.
 * 'normal' 같은 값은 어느 헤더에도 걸리지 않으므로 그대로 null 이 된다.
 */
export function parseImportance(headerBlock: string): Importance {
  const head = headerBlock.split(/\r?\n\r?\n/, 1)[0] ?? '';
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().toLowerCase();
    switch (name) {
      case 'importance':
      case 'x-msmail-priority':
        // RFC 4021 은 high·normal·low, Outlook 은 같은 낱말을 X-MSMail-Priority 에 쓴다
        if (value.startsWith('high')) return 'high';
        break;
      case 'priority':
        // RFC 2156: urgent · normal · non-urgent
        if (value.startsWith('urgent')) return 'high';
        break;
      case 'x-priority':
        // "1", "1 (Highest)", "2 (High)" 까지를 높음으로 본다 (mime/build.ts 는 1 을 쓴다)
        switch (value.match(/^\d+/)?.[0]) {
          case '1':
          case '2':
            return 'high';
        }
        break;
    }
  }
  return null;
}

/** 원문 앞머리를 읽어 중요도를 정한다. 파일이 없거나 읽히지 않으면 null */
export async function importanceOf(
  mailId: string,
  filePath: string,
  bodyStartOctet: number,
): Promise<Importance> {
  const cached = cache.get(mailId);
  if (cached !== undefined) return cached;
  const bytes = Math.min(bodyStartOctet > 0 ? bodyStartOctet : HEAD_READ_CAP, HEAD_READ_CAP);
  const head = await readMailHead(filePath, bytes);
  // 파일을 못 읽은 것은 캐시하지 않는다 — 일시적인 실패일 수 있다
  if (head === null) return null;
  return remember(mailId, parseImportance(head));
}

/** SUMMARY_COLUMNS 로 뽑은 행에서 중요도 판정에 필요한 세 값 */
export interface ImportanceRow {
  MAIL_ID: string;
  MAIL_FILE_PATH: string;
  MAIL_BODY_START_OCTET: number;
}

/**
 * 한 페이지 분의 중요도를 요약에 채운다. rows 와 summaries 는 같은 순서다.
 * 캐시에 있으면 파일을 열지 않으므로 목록 재조회·폴링은 대개 디스크를 건드리지 않는다.
 */
export async function attachImportance<T extends { importance: Importance }>(
  rows: readonly ImportanceRow[],
  summaries: T[],
): Promise<T[]> {
  await Promise.all(
    summaries.map(async (summary, index) => {
      const row = rows[index];
      if (!row) return;
      summary.importance = await importanceOf(
        row.MAIL_ID,
        row.MAIL_FILE_PATH,
        Number(row.MAIL_BODY_START_OCTET ?? 0),
      );
    }),
  );
  return summaries;
}
