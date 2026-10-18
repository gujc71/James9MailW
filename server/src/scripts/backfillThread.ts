/**
 * 스레드 컬럼이 생기기 전에 저장된 메일을 채워 넣는 일회성 작업 (feature-gap 2-2).
 *
 *   npm run backfill:thread          # 전부
 *   npm run backfill:thread -- --limit 5000 --dry
 *
 * James 는 저장 시점에만 MAIL_THREAD_ID 와 JAMES_MAIL_REFERENCE 를 쓴다. 그래서 그 전에
 * 들어온 메일은 두 값이 비어 있고, 묶어 보기를 켜도 한 통씩 흩어져 보인다. 여기서 원문
 * 앞머리만 읽어 References · In-Reply-To 를 되살리고 같은 규칙으로 대화를 정한다
 * (ThreadResolver.java 와 짝이다 — 한쪽을 고치면 다른 쪽도 고쳐야 한다).
 *
 * **James 테이블에 직접 쓰는 예외다.** 웹서버는 James 테이블을 WebAdmin 으로만 건드리는
 * 것이 원칙인데(webmail-architecture.md 2.3), 그 원칙은 MODSEQ · 리스너 · 쿼터가 어긋나는
 * 것을 막기 위한 것이다. 여기서 채우는 두 값은 James 가 **저장할 때 한 번 쓰고 그 뒤로
 * 건드리지 않는 파생값**이라 그 셋 중 어느 것도 따라 움직이지 않는다. 대신 MODSEQ 가
 * 올라가지 않으므로 이미 돌고 있는 브라우저 미러는 이 변화를 받지 못한다 — 미러는
 * Dexie v3 올라갈 때 통째로 비워져 다시 받는다 (client/src/db/schema.ts).
 *
 * 다시 돌려도 안전하다. 이미 채워진 메일(MAIL_THREAD_ID IS NOT NULL)은 건너뛴다.
 */
import { db, dbWrite, closeDb } from '../db/kysely.js';
import { readMailHead } from '../store/mailStore.js';

/** 헤더 블록이 이보다 길면 잘라 읽는다. mime/importance.ts 와 같은 상한이다 */
const HEAD_READ_CAP = 32 * 1024;
/** 한 통이 남기는 조상 행 수 상한. JPAMessage.MAX_REFERENCES 와 같은 값이어야 한다 */
const MAX_REFERENCES = 20;
/** 한 번에 읽어 처리할 메일 수 */
const BATCH = 500;

const MESSAGE_ID_PATTERN = /<([^<>]+)>/g;

/** 꺾쇠를 붙인 표기. JAMES_MAIL.MESSAGE_ID 는 헤더에 적힌 그대로라 둘 다 올 수 있다 */
function angled(messageId: string): string | null {
  const trimmed = messageId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.length <= 255 ? trimmed : null;
  }
  const wrapped = `<${trimmed}>`;
  return wrapped.length <= 255 ? wrapped : null;
}

function unangled(messageId: string): string {
  return messageId.length > 2 && messageId.startsWith('<') && messageId.endsWith('>')
    ? messageId.slice(1, -1)
    : messageId;
}

/**
 * 헤더 블록 → 조상 사슬 (뿌리부터). 접힌 줄을 펴고 첫 빈 줄에서 멈춘다 —
 * 본문에 들어 있는 꺾쇠 낱말을 조상으로 잘못 읽지 않으려면 헤더에서 끊어야 한다.
 */
export function parseChain(headerBlock: string): string[] {
  const head = headerBlock.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const chain = new Set<string>();

  for (const name of ['references', 'in-reply-to']) {
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toLowerCase() !== name) continue;
      const value = line.slice(colon + 1);
      const ids = [...value.matchAll(MESSAGE_ID_PATTERN)].map((m) => m[1]!);
      // 꺾쇠 없이 보내는 클라이언트가 있다. 뒤따르는 주석은 버린다
      const tokens = ids.length > 0 ? ids : value.trim().split(/\s+/).slice(0, 1);
      for (const id of tokens) {
        const canonical = angled(id);
        if (canonical) chain.add(canonical);
      }
    }
  }

  const kept = [...chain];
  if (kept.length <= MAX_REFERENCES) return kept;
  // 뿌리와 가까운 조상을 남기고 가운데를 버린다 (JPAMessage.parseReferences 와 같은 규칙)
  return [kept[0]!, ...kept.slice(kept.length - MAX_REFERENCES + 1)];
}

interface MailRow {
  MAIL_ID: string;
  MESSAGE_ID: string;
  MAIL_FILE_PATH: string;
  MAIL_BODY_START_OCTET: number;
}

/** 조상들이 이미 들어가 있는 대화. 없는 조상·아직 안 채운 조상은 빠진다 */
async function threadsOfAncestors(chain: string[]): Promise<Map<string, string>> {
  const candidates = new Set<string>();
  const askedFor = new Map<string, string>();
  for (const ancestor of chain) {
    candidates.add(ancestor);
    askedFor.set(ancestor, ancestor);
    const bare = unangled(ancestor);
    candidates.add(bare);
    askedFor.set(bare, ancestor);
  }

  const rows = await db
    .selectFrom('JAMES_MAIL')
    .select(['MESSAGE_ID', 'MAIL_THREAD_ID'])
    .where('MESSAGE_ID', 'in', [...candidates])
    .execute();

  const threads = new Map<string, string>();
  for (const row of rows) {
    if (!row.MAIL_THREAD_ID) continue;
    const ancestor = askedFor.get(row.MESSAGE_ID);
    if (ancestor && !threads.has(ancestor)) threads.set(ancestor, row.MAIL_THREAD_ID);
  }
  return threads;
}

/** 이 메일이 속할 대화. ThreadResolver.resolve() 와 같은 순서로 고른다 */
async function resolveThread(mail: MailRow, chain: string[]): Promise<string | null> {
  if (chain.length === 0) return angled(mail.MESSAGE_ID);
  const known = await threadsOfAncestors(chain);
  for (const ancestor of chain) {
    const threadId = known.get(ancestor);
    if (threadId) return threadId;
  }
  return chain[0]!;
}

async function backfillOne(mail: MailRow, dry: boolean): Promise<'threaded' | 'unreadable'> {
  const bytes = Math.min(
    mail.MAIL_BODY_START_OCTET > 0 ? mail.MAIL_BODY_START_OCTET : HEAD_READ_CAP,
    HEAD_READ_CAP,
  );
  const head = await readMailHead(mail.MAIL_FILE_PATH, bytes);
  // 파일이 사라진 메일도 자기 자신을 뿌리로 삼아 대화 하나는 된다. 조상만 알 수 없다
  const chain = head === null ? [] : parseChain(head);
  const threadId = await resolveThread(mail, chain);
  if (dry || !threadId) return head === null ? 'unreadable' : 'threaded';

  await dbWrite.transaction().execute(async (tx) => {
    // 다시 돌릴 때 조상 행이 겹치지 않게 먼저 비운다
    await tx.deleteFrom('JAMES_MAIL_REFERENCE').where('MAIL_ID', '=', mail.MAIL_ID).execute();
    if (chain.length > 0) {
      await tx
        .insertInto('JAMES_MAIL_REFERENCE')
        .values(
          chain.map((refMessageId, ordinal) => ({
            // James 의 JPAUniqueIdGenerator 와 같은 자리를 채우면 되고, 형식은 상관없다
            REFERENCE_ID: `${mail.MAIL_ID}-${ordinal}`,
            MAIL_ID: mail.MAIL_ID,
            REF_ORDINAL: ordinal,
            REF_MESSAGE_ID: refMessageId,
          })),
        )
        .execute();
    }
    await tx
      .updateTable('JAMES_MAIL')
      .set({ MAIL_THREAD_ID: threadId })
      .where('MAIL_ID', '=', mail.MAIL_ID)
      .execute();
  });

  return head === null ? 'unreadable' : 'threaded';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  let done = 0;
  let unreadable = 0;
  for (;;) {
    const take = Math.min(BATCH, limit - done);
    if (take <= 0) break;
    const mails = await db
      .selectFrom('JAMES_MAIL')
      .select(['MAIL_ID', 'MESSAGE_ID', 'MAIL_FILE_PATH', 'MAIL_BODY_START_OCTET'])
      .where('MAIL_THREAD_ID', 'is', null)
      // 오래된 것부터. 뿌리가 먼저 채워지면 답장이 그 대화를 그대로 물려받는다
      .orderBy('MAIL_DATE', 'asc')
      .limit(take)
      .execute();
    if (mails.length === 0) break;

    for (const mail of mails) {
      const outcome = await backfillOne(mail as MailRow, dry);
      if (outcome === 'unreadable') unreadable += 1;
      done += 1;
    }
    console.log(`... ${done}`);
    // --dry 는 아무것도 쓰지 않아 같은 행이 계속 걸린다. 한 묶음만 보고 끝낸다
    if (dry) break;
  }

  console.log(
    dry
      ? `[dry] ${done}통을 살펴봤습니다 (원문을 못 읽은 메일 ${unreadable}통). 아무것도 쓰지 않았습니다.`
      : `${done}통을 채웠습니다 (원문을 못 읽어 조상 없이 둔 메일 ${unreadable}통).`,
  );
}

main()
  .catch((cause) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
