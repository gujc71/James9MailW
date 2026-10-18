/**
 * "원문을 편지함에 넣기" 한 경로.
 *
 * 임시저장(Drafts), EML 업로드(USR-22), 외부메일 가져오기(USR-18), 발송 후 Sent 사본이
 * 모두 이 경로를 쓴다. 웹서버가 스테이징 폴더에 쓰고 James 가 읽는다
 * (webmail-issues.md 4-1, 4-1b).
 *
 * 웹서버가 파일·JAMES_MAIL·JAMES_MAIL_OWNER 를 직접 쓰면 안 된다. UID·MODSEQ 발급,
 * MAILBOX_LAST_UID/MAILBOX_SIZE, 쿼터, MIME_PART·RECIPIENTS 추출, MAIL_TYPE 판정,
 * 파일 경로 규칙이 모두 JPAMessageMapper.add 안에 있다 (3-3).
 *
 * 실패는 그 자리에서 끝난다. 스테이징 파일을 지우고 호출자에게 실패를 알릴 뿐,
 * 재시도 큐에 쌓지 않는다 — 발송 후 Sent 사본도 마찬가지다(1-1 ⑦).
 */
import { james, type AppendResult } from '../james/webadmin.js';
import { removeStaging, stagingFileName } from '../store/staging.js';

export interface AppendParams {
  mailboxId: string;
  /** 웹서버가 발급한 UUID. 스테이징 파일 이름이자 MAIL_ID 가 된다 */
  mailId: string;
  flags?: string[];
  internalDate?: Date;
}

export interface AppendOutcome {
  ok: boolean;
  result?: AppendResult;
  error?: string;
}

export async function appendStagedFile(params: AppendParams): Promise<AppendOutcome> {
  try {
    const result = await james.appendFromEml({
      mailboxId: params.mailboxId,
      file: stagingFileName(params.mailId),
      flags: params.flags ?? [],
      internalDate: (params.internalDate ?? new Date()).toISOString(),
      // MAIL_TYPE 은 gu.mailId 속성이 있을 때만 판정되므로 항상 넘긴다 (4-1)
      mailId: params.mailId,
    });
    await removeStaging(params.mailId);
    return { ok: true, result };
  } catch (cause) {
    const message = (cause as Error).message ?? String(cause);
    await removeStaging(params.mailId);
    return { ok: false, error: message };
  }
}
