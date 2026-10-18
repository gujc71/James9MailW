/**
 * 목록을 대화(스레드)로 묶는다 (feature-gap 2-2).
 *
 * 묶는 기준은 **서버가 정해 준 threadId 하나**다. James 가 메일을 저장할 때 References ·
 * In-Reply-To 를 보고 대화의 뿌리 Message-ID 를 박아 두므로(JAMES_MAIL.MAIL_THREAD_ID),
 * 클라이언트는 그래프를 다시 풀지 않고 같은 값끼리 모으기만 하면 된다. 판정이 서버 한 곳에
 * 있으니 온라인 목록과 미러 목록의 묶음이 어긋날 일도 없다.
 *
 * 제목으로 묶지는 않는다. "회의" 같은 제목이 한 덩어리가 되는 쪽이 대화가 둘로 갈라지는
 * 것보다 나쁘고, 썬더버드도 제목 묶기는 기본적으로 꺼 둔다.
 */
import type { MessageSummary } from '../../api/types';

export interface ThreadGroup {
  /** 묶음의 키. threadId 가 있으면 그 값, 없으면 그 메일 하나만의 키다 */
  key: string;
  /**
   * 묶인 메일들. **목록 정렬 그대로** 들어온다 — 대표행이 맨 앞이고, 펼쳤을 때의 자식 순서도
   * 목록과 같은 기준이라 "정렬을 바꿨는데 대화 안쪽만 그대로" 로 보이지 않는다.
   */
  messages: MessageSummary[];
  /** 접힌 상태에서 목록에 보이는 한 줄. 정렬 기준에서 가장 앞선 메일이다 */
  head: MessageSummary;
  count: number;
  /** 대화 안에 안 읽은 메일이 몇 통인가. 접힌 줄의 배지로 쓴다 */
  unseen: number;
  /** 대화 안에 하나라도 있으면 참. 접힌 줄에 표시를 남겨 둔다 */
  hasAttachment: boolean;
  flagged: boolean;
}

/** 이 메일이 속한 대화의 키. threadId 가 없는 옛 메일은 자기 자신이 한 대화다 */
export function threadKeyOf(message: MessageSummary): string {
  // useMessageList 의 msgKey 와 같은 형식이다. 거기서 가져오면 순환 참조가 되어 여기서 만든다
  return message.threadId ?? `${message.mailboxId}:${message.uid}`;
}

/**
 * 정렬이 끝난 목록을 대화로 묶는다. 묶음의 **자리는 대표행의 자리** 다 — 정렬 기준에서
 * 가장 앞선 메일이 목록에 서 있던 그 자리에 대화 전체가 선다. 썬더버드와 같은 규칙이고,
 * 이래야 정렬을 바꿨을 때 대화들이 납득 가능한 순서로 다시 선다.
 *
 * 한 페이지만 받아 둔 상태에서는 같은 대화의 뒷 메일이 아직 안 왔을 수 있다. 더 받으면
 * 그 메일이 제 대화에 들어가고 묶음이 다시 그려진다 — 이 함수는 누적된 목록 전체를 매번
 * 다시 묶으므로 중간 상태가 남지 않는다.
 */
export function groupThreads(sorted: MessageSummary[]): ThreadGroup[] {
  const byKey = new Map<string, ThreadGroup>();
  const order: ThreadGroup[] = [];

  for (const message of sorted) {
    const key = threadKeyOf(message);
    const seen = message.flags.includes('\\Seen');
    const existing = byKey.get(key);
    if (existing) {
      existing.messages.push(message);
      existing.count += 1;
      if (!seen) existing.unseen += 1;
      if (message.hasAttachment) existing.hasAttachment = true;
      if (message.flags.includes('\\Flagged')) existing.flagged = true;
      continue;
    }
    const group: ThreadGroup = {
      key,
      messages: [message],
      head: message,
      count: 1,
      unseen: seen ? 0 : 1,
      hasAttachment: message.hasAttachment,
      flagged: message.flags.includes('\\Flagged'),
    };
    byKey.set(key, group);
    order.push(group);
  }

  return order;
}

/** 목록에 그릴 한 줄. 대화를 접었다 폈다 하면 이 배열만 바뀐다 */
export interface ThreadRow {
  message: MessageSummary;
  /**
   * 두 통 이상인 대화의 **접힌 대표행** 일 때만 채워진다. 펼침 화살표를 그리고, 체크 · 끌기 ·
   * 굵게가 대화 전체로 움직이는 것도 이것이 있는 줄이다
   */
  group: ThreadGroup | null;
  /**
   * 이 줄이 속한 대화가 두 통 이상이면 채워진다 — **묶어 보지 않을 때도** 채워진다. 통수
   * 배지는 이것으로 그린다: 묶기를 켜야만 통수가 보이면, 끈 상태에서는 눈앞의 메일에
   * 뒷이야기가 있다는 것을 알 길이 없다.
   */
  thread: ThreadGroup | null;
  /** 펼쳐진 대화의 아래쪽 줄인가. 들여쓰기만 다르다 */
  child: boolean;
}

/** 묶음 + 펼친 목록 → 그릴 줄들. 접힌 대화는 대표행 한 줄만 낸다 */
export function threadRows(groups: ThreadGroup[], expanded: ReadonlySet<string>): ThreadRow[] {
  const rows: ThreadRow[] = [];
  for (const group of groups) {
    const single = group.count === 1;
    const head: ThreadRow = { message: group.head, group: null, thread: null, child: false };
    if (!single) {
      head.group = group;
      head.thread = group;
    }
    rows.push(head);
    if (!single && expanded.has(group.key)) {
      for (const message of group.messages) {
        // 펼친 자식 줄에는 통수를 적지 않는다 — 대표행에 한 번 있으면 된다
        if (message !== group.head) rows.push({ message, group: null, thread: null, child: true });
      }
    }
  }
  return rows;
}

/**
 * 묶지 않을 때의 줄들. 그리는 쪽이 한 가지 모양만 다루게 한다.
 *
 * 접지는 않지만 **대화가 두 통 이상이면 통수는 알려 준다** — groups 를 받는 이유다. 줄마다
 * 그 대화 전체의 통수가 붙으므로, 묶기를 켜지 않고도 답장이 오간 메일을 알아볼 수 있다.
 */
export function flatRows(messages: MessageSummary[], groups: ThreadGroup[]): ThreadRow[] {
  const byKey = new Map(groups.filter((group) => group.count > 1).map((group) => [group.key, group]));
  return messages.map((message) => ({
    message,
    group: null,
    thread: byKey.get(threadKeyOf(message)) ?? null,
    child: false,
  }));
}

/**
 * 대화의 **마지막 메일**. 통수 배지를 눌러 대화 내용을 볼 때 원문을 받아 파싱할 대상이다 —
 * 답장은 원문을 인용해 쌓이므로 마지막 한 통 안에 대화가 통째로 들어 있다
 * (features/message/conversation.ts).
 *
 * 대표행(head)을 쓰지 않는 이유: 대표행은 **지금 정렬에서 가장 앞선 메일**이라 크기순으로
 * 보고 있으면 제일 큰 메일이다. 그 메일이 대화의 끝은 아니다.
 */
export function threadNewest(group: ThreadGroup): MessageSummary {
  return group.messages.reduce((latest, message) => (sentOrReceived(message) > sentOrReceived(latest) ? message : latest));
}

function sentOrReceived(message: MessageSummary): number {
  const stamp = message.sentAt ?? message.receivedAt;
  const time = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}
