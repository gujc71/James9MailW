/**
 * 메일 목록 + 가상 스크롤 (USR-4). 기본은 수신일시/발송일시 최근순이고, 정렬은 화면에서
 * 고른다 (2-1). 크기순으로 볼 때는 날짜 자리에 크기를 보여 준다 — 무엇으로 줄 섰는지
 * 보이지 않으면 "큰 메일부터 정리" 가 되지 않는다.
 * 행을 끌어 사이드 편지함에 놓으면 이동한다 (체크된 메일이 있으면 그 묶음이 함께 이동).
 */
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessageSummary, MailboxRole } from '../../api/types';
import { formatBytes, formatListDate, displayAddress } from '../../lib/format';
import { DRAG_MIME } from './Sidebar';
import { msgKey } from './useMessageList';
import { showsRecipient, type ListSort } from './listSort';
import { flatRows, threadRows, type ThreadGroup } from './thread';
import { useT } from '../../i18n';

interface Props {
  messages: MessageSummary[];
  /** 대화 묶음. 접는 것은 threaded 일 때만이지만, 통수 배지는 끈 상태에서도 이것으로 그린다 */
  threads: ThreadGroup[];
  /** 대화로 묶어 보는 중인가 (2-2) */
  threaded: boolean;
  role: MailboxRole | null;
  sort: ListSort;
  activeKey: string | null;
  selected: Set<string>;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** 이 기기에 받아 둔 메일(Dexie 미러)로 그리는 중인가 (8-5) */
  offline: boolean;
  /** 그 미러가 편지함 전체가 아닐 수 있는가 */
  partial: boolean;
  onOpen: (message: MessageSummary) => void;
  /** 통수 배지를 눌렀다 — 읽기 영역에 대화 내용을 펼친다 (ConversationPane) */
  onOpenThread: (thread: ThreadGroup) => void;
  /** 여러 개가 오면 대화 한 묶음을 통째로 고른 것이다 (대표행 체크박스) */
  onToggleSelect: (keys: string[]) => void;
  onToggleStar: (message: MessageSummary) => void;
  onLoadMore: () => void;
}

export function MessageList({
  messages,
  threads,
  threaded,
  role,
  sort,
  activeKey,
  selected,
  hasMore,
  loading,
  error,
  offline,
  partial,
  onOpen,
  onOpenThread,
  onToggleSelect,
  onToggleStar,
  onLoadMore,
}: Props) {
  const t = useT();
  const parentRef = useRef<HTMLDivElement>(null);
  // 사진 파일이 사라진 URL 은 한 번 실패하면 이름 첫 글자로 되돌린다
  const [brokenPhotos, setBrokenPhotos] = useState<Set<string>>(new Set());
  /**
   * 펼쳐 둔 대화. 화면에만 있는 상태라 새로 고치면 다 접힌다. 편지함을 옮겨도 남는데,
   * 키가 대화 id 라서 남은 키가 걸리는 경우는 **같은 대화가 그 편지함에도 있을 때** 뿐이다 —
   * 그때는 펼쳐져 있는 편이 맞다.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /**
   * 그릴 줄들. 펼침은 **삼각형을 누른 것만** 이다 — 메일을 열었다고 그 대화가 따라 펼쳐지면
   * 목록을 훑는 동안 줄이 늘었다 줄었다 하고, 아래쪽 줄을 누르려던 손이 빗나간다.
   */
  const rows = useMemo(
    () => (threaded ? threadRows(threads, expanded) : flatRows(messages, threads)),
    [threaded, messages, threads, expanded],
  );

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 8,
  });

  // 보낸 편지함은 받는 사람, 그 외는 보낸 사람을 보여 준다 (설계서 USR-4).
  // 정렬도 같은 열을 봐야 하므로 판단은 listSort 에 모아 두었다
  const showRecipient = showsRecipient(role);

  function onScroll() {
    const el = parentRef.current;
    // 조회 오류가 있으면 자동 로드를 멈추고 [더보기] 로 수동 로드한다 (USR-4)
    if (!el || loading || !hasMore || error) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) onLoadMore();
  }

  /**
   * 끈 것이 무엇인지. 체크된 메일이 있으면 그 묶음, 접힌 대화의 대표행이면 대화 전체,
   * 그 외에는 끈 메일 하나다. 접힌 줄을 끌었을 때 보이지 않는 답장만 남으면
   * "옮겼는데 반만 갔다" 가 된다.
   */
  function draggedOf(message: MessageSummary, group: ThreadGroup | null): MessageSummary[] {
    if (selected.has(msgKey(message))) return messages.filter((m) => selected.has(msgKey(m)));
    return group ? group.messages : [message];
  }

  function onDragStart(event: DragEvent, message: MessageSummary, group: ThreadGroup | null) {
    // 체크된 메일이 여러 편지함에 걸쳐 있을 수 있어 (편지함, uid) 쌍으로 넘긴다
    const refs = draggedOf(message, group).map((m) => ({ mailboxId: m.mailboxId, uid: m.uid }));
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ refs }));
    event.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div className="list" ref={parentRef} onScroll={onScroll}>
      {/* 오프라인 읽기 (8-5). 목록이 미러에서 왔다는 것과, 그것이 전부가 아닐 수 있다는 것을 알린다 */}
      {offline && <div className="offline-note">{t(partial ? 'list.offlinePartial' : 'list.offline')}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const { message, group, thread, child } = row;
          const key = msgKey(message);
          // 접힌 대화는 안에 안 읽은 메일이 하나라도 있으면 굵게 — 대표행만 읽었다고
          // 흐려지면 "읽을 것이 남아 있다" 가 목록에서 사라진다
          const seen = group ? group.unseen === 0 : message.flags.includes('\\Seen');
          const flagged = group ? group.flagged : message.flags.includes('\\Flagged');
          const starred = message.flags.includes('\\Flagged');
          const hasAttachment = group ? group.hasAttachment : message.hasAttachment;
          const groupKeys = group ? group.messages.map(msgKey) : [key];
          const checked = groupKeys.every((k) => selected.has(k));
          const who = showRecipient
            ? displayAddress(message.toDisplay, message.to)
            : displayAddress(message.fromDisplay, message.from);
          const initial = (who || '?').replace(/^"?\s*/, '').charAt(0).toUpperCase();
          // 아바타도 이름과 같은 쪽을 보여 준다 — 보낸 편지함은 받는 사람, 그 외는 보낸 사람
          const photo = showRecipient ? message.toPhoto : message.fromPhoto;
          return (
            <div
              key={key}
              className={`row ${seen ? '' : 'unseen'} ${activeKey === key ? 'active' : ''} ${child ? 'thread-child' : ''}`}
              style={{ transform: `translateY(${item.start}px)`, height: item.size }}
              onClick={() => onOpen(message)}
              draggable
              onDragStart={(e) => onDragStart(e, message, group)}
            >
              <input
                type="checkbox"
                checked={checked}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleSelect(groupKeys)}
              />
              {/* 묶어 보는 동안에는 삼각형이 없는 줄도 자리를 비워 둔다. 아바타가 줄마다
                  들쭉날쭉하면 목록을 세로로 훑기 어렵다 */}
              {threaded && !group && <span className="thread-toggle empty" aria-hidden />}
              {group && (
                <button
                  className={`thread-toggle ${expanded.has(group.key) ? 'open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(group.key);
                  }}
                  title={t(expanded.has(group.key) ? 'list.threadCollapse' : 'list.threadExpand')}
                  aria-expanded={expanded.has(group.key)}
                >
                  ▸
                </button>
              )}
              {photo && !brokenPhotos.has(photo) ? (
                <img
                  className="avatar photo"
                  src={photo}
                  alt=""
                  onError={() => setBrokenPhotos((prev) => new Set(prev).add(photo))}
                />
              ) : (
                <span className="avatar" aria-hidden>
                  {initial}
                </span>
              )}
              <div className="row-main">
                <div className="row-top">
                  <span className="who">{who || t('common.noAddress')}</span>
                  {/* 통수 배지는 묶어 보지 않을 때도 두 통 이상이면 붙는다. 안 읽은 통수는
                      접혀 있을 때만 — 펼쳐져 있으면 안 읽은 줄이 굵게 그대로 보인다.
                      누르면 읽기 영역에 대화 내용이 펼쳐진다 (삼각형은 목록을 접고 펴는 것이고,
                      배지는 오간 말을 한 화면에 보여 준다 — 하는 일이 달라 따로 둔다) */}
                  {thread && (
                    <button
                      className={`thread-count ${group && group.unseen > 0 ? 'has-unseen' : ''}`}
                      title={`${t('list.threadOf', { n: thread.count })} — ${t('list.threadRead')}`}
                      onClick={(e) => {
                        // 행 클릭(메일 열기)으로 번지지 않게 한다. 배지는 대화 내용 보기다
                        e.stopPropagation();
                        onOpenThread(thread);
                      }}
                    >
                      {group && group.unseen > 0 ? `${group.count} (${group.unseen})` : thread.count}
                    </button>
                  )}
                  <span className="date">
                    {sort.key === 'size'
                      ? formatBytes(message.size)
                      : formatListDate(showRecipient ? message.sentAt : message.receivedAt)}
                  </span>
                </div>
                <div className="row-subject">
                  <button
                    className={`star ${starred ? 'on' : ''} ${flagged && !starred ? 'in-thread' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStar(message);
                    }}
                    title={t('list.flagged')}
                  >
                    ★
                  </button>
                  {message.importance === 'high' && (
                    <span className="prio" title={t('list.importance')} aria-label={t('list.importance')}>
                      !
                    </span>
                  )}
                  {hasAttachment && <span className="clip">📎</span>}
                  {message.subject || t('common.noSubject')}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {loading && <div className="list-status">{t('common.loading')}</div>}
      {error && <div className="list-status error">{error}</div>}
      {!loading && hasMore && (
        <button className="more" onClick={onLoadMore}>
          {t('common.more')}
        </button>
      )}
      {!loading && !error && messages.length === 0 && <div className="list-status">{t('list.empty')}</div>}
    </div>
  );
}
