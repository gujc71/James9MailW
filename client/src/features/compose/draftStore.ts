/**
 * 작성 중인 메일 자동 저장 (feature-gap.md 1-3).
 *
 * 임시 보관함(서버)이 아니라 **브라우저 localStorage** 에 둔다. [임시저장] 버튼은 그대로
 * 서버에 보관하고, 이쪽은 "창을 잘못 닫았을 때 되살리기" 만 맡는다. 서버를 부르지 않으니
 * 몇 초마다 써도 부담이 없고, 보낼 생각도 없던 글이 임시 보관함에 자꾸 쌓이지도 않는다.
 *
 * 한계를 분명히 해 둔다.
 *  - **첨부 파일은 저장하지 않는다.** File 을 직렬화하면 base64 로 부풀어 localStorage
 *    한도(대략 5MB)를 그대로 넘긴다. 파일 이름만 적어 두고 복원할 때 알려 준다.
 *  - 이 브라우저, 이 기기에만 남는다. 다른 PC 에서는 복원되지 않는다.
 *  - 시크릿 창이나 저장이 막힌 환경에서는 읽기·쓰기가 예외를 던진다 — 전부 삼키고 자동
 *    저장만 조용히 포기한다. 본문 작성을 막지는 않는다.
 *  - 계정별로 키가 다르다. 같은 PC 를 함께 쓰더라도 남의 초안이 열리지 않는다.
 */

const PREFIX = 'j9-compose-draft:';

/** 이 크기를 넘으면 저장하지 않는다. localStorage 한도에 부딪혀 통째로 실패하는 것보다 낫다 */
const MAX_BYTES = 2 * 1024 * 1024;

export interface StoredDraft {
  savedAt: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  important: boolean;
  sendToSelf: boolean;
  individual: boolean;
  readReceipt: boolean;
  vcardYn: boolean;
  signatureId: number | null;
  /** 알리아스로 보내던 중이었으면 그 주소. 복원할 때 목록에 아직 있는지 다시 본다 (4-3) */
  fromAlias?: string;
  /** 답장·전달·이어쓰기 연결. 복원해도 같은 메일에 대한 답장으로 남는다 */
  inReplyTo?: string;
  forwardOf?: string;
  forwardAsEml?: boolean;
  draftMailboxId?: string;
  draftUid?: number;
  emlAttachment?: { filename: string; size: number };
  /** 저장하지 못한 첨부 이름. 복원 화면에서 "이건 안 돌아온다" 고 알려 준다 */
  droppedAttachments: string[];
}

export type SaveResult = 'saved' | 'tooBig' | 'failed';

function keyOf(userName: string): string {
  return `${PREFIX}${userName.toLowerCase()}`;
}

export function saveComposeDraft(userName: string, draft: StoredDraft): SaveResult {
  let json: string;
  try {
    json = JSON.stringify(draft);
  } catch {
    return 'failed';
  }
  if (json.length > MAX_BYTES) return 'tooBig';
  try {
    localStorage.setItem(keyOf(userName), json);
    return 'saved';
  } catch {
    // 한도 초과 · 시크릿 창 · 저장 차단
    return 'failed';
  }
}

export function loadComposeDraft(userName: string): StoredDraft | null {
  try {
    const json = localStorage.getItem(keyOf(userName));
    if (!json) return null;
    const parsed = JSON.parse(json) as StoredDraft;
    // 남이 심어 둔 값이나 옛 형식일 수 있다. 최소한만 확인하고 아니면 없는 것으로 본다
    if (typeof parsed?.savedAt !== 'number') return null;
    return { ...parsed, droppedAttachments: parsed.droppedAttachments ?? [] };
  } catch {
    return null;
  }
}

export function clearComposeDraft(userName: string): void {
  try {
    localStorage.removeItem(keyOf(userName));
  } catch {
    // 지울 수 없으면 그대로 둔다. 다음에 복원 배너가 한 번 더 뜨는 것뿐이다
  }
}

/**
 * 본문에서 글자만 뽑는다.
 * 에디터가 HTML 을 다듬으면서 태그가 달라지는 것은 "고쳤다" 가 아니므로 글자로만 견준다.
 */
export function bodyText(html: string): string {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
