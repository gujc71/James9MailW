/**
 * 기본 편지함 보충.
 *
 * James 의 PUT /users/{user} 는 계정 행만 만들고 편지함은 만들지 않는다. 그래서 새 계정은
 * 첫 수신 때 INBOX 하나가 생길 뿐이라 발송 사본(Sent) · 임시 보관(Drafts) · 삭제(Trash) ·
 * 스팸(Spam) 이 갈 곳이 없다. sql/02-seed.sql 이 시드 계정에 직접 넣어 두는 다섯 편지함을
 * 계정 생성 경로에서도 똑같이 만들어 준다.
 *
 * 편지함 생성은 James WebAdmin 을 거친다 — MAILBOX_ID · UID_VALIDITY 를 James 가 정하고
 * MailboxListener 가 떠야 하기 때문이다 (james/webadmin.ts 머리말). 표시 순서와 기본 편지함
 * 구분만 웹 전용 컬럼이라 만든 뒤에 직접 채운다.
 */
import { james } from '../james/webadmin.js';
import * as mailboxes from '../repositories/mailboxes.js';

/**
 * 없는 기본 편지함만 만든다. 여러 번 불러도 안전하다.
 * @returns 이번에 새로 만든 편지함 이름
 */
export async function ensureDefaultMailboxes(userName: string): Promise<string[]> {
  const existing = new Set(await mailboxes.listMailboxNames(userName));
  const created: string[] = [];

  for (let i = 0; i < mailboxes.DEFAULT_MAILBOXES.length; i += 1) {
    const name = mailboxes.DEFAULT_MAILBOXES[i]!;
    if (existing.has(name)) continue;
    await james.createMailbox({ user: userName, name });
    await mailboxes.markDefaultMailbox(userName, name, i + 1);
    created.push(name);
  }
  return created;
}

/** expunge 한 번에 넘기는 UID 수. 편지함 비우기(routes/mutations.ts)와 같은 크기 */
const EXPUNGE_BATCH = 500;

/**
 * 계정 삭제 전에 그 계정의 메일과 편지함을 모두 지운다 (ADM-3).
 *
 * James 의 DELETE /users/{user} 는 JAMES_USER 행만 지운다. 그대로 두면 JAMES_MAILBOX 와
 * JAMES_MAIL_OWNER 행이 주인 없이 남아 용량 집계·ADM-5 메일 조회에 계속 잡힌다.
 *
 * 메일은 편지함을 지우기 전에 expunge 로 먼저 없앤다 — 그래야 툼스톤 리스너가
 * GU_MESSAGE_TOMBSTONE 을 남기고(동기화 중인 클라이언트가 삭제를 따라간다) 쿼터 카운터도
 * 함께 줄어든다 (james/webadmin.ts 머리말, 편지함 비우기와 같은 경로).
 * 하위 편지함이 부모보다 먼저 지워지도록 이름이 긴 것부터 처리한다 (INBOX.sub → INBOX).
 */
export async function purgeUserMailboxes(
  userName: string,
): Promise<{ mailboxes: number; messages: number }> {
  const boxes = await mailboxes.listMailboxRefs(userName);
  boxes.sort((a, b) => b.name.length - a.name.length);

  let messages = 0;
  for (const box of boxes) {
    const uids = await mailboxes.listMailboxUids(box.id);
    for (let i = 0; i < uids.length; i += EXPUNGE_BATCH) {
      await james.expunge({ mailboxId: box.id, uids: uids.slice(i, i + EXPUNGE_BATCH) });
    }
    messages += uids.length;
    await james.deleteMailbox({ mailboxId: box.id });
  }
  return { mailboxes: boxes.length, messages };
}
