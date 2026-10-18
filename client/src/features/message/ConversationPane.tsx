/**
 * 대화 내용 보기 (feature-gap 2-2). 목록의 통수 배지를 누르면 읽기 영역에 이것이 뜬다.
 *
 * 대화의 **마지막 메일 원문 하나**를 받아 인용 단계를 갈라(conversation.ts), 주고받은 메일을
 * **메신저처럼** 늘어놓는다 — 사진 · 보낸 날짜 · 말풍선이 한 줄이고, **오래된 것이 위, 최근이
 * 아래**다. 메일 목록이 최근순인 것과 반대인데, 대화는 읽는 순서가 곧 시간 순서라서 그렇다.
 *
 * **남이 보낸 메일이 왼쪽, 내가 보낸 메일이 오른쪽**이다. 가름은 주소로 한다 — 계정과
 * 알리아스(Me.aliases) 를 모두 내 것으로 본다. 알리아스로 보낸 답장이 남의 말로 보이면
 * 대화가 통째로 어긋나 읽힌다.
 *
 * **내 말에는 사진을 붙이지 않는다.** 오른쪽에 선 것이 이미 나라는 표시이고, 같은 얼굴이
 * 줄마다 반복되면 정작 봐야 할 상대의 얼굴이 묻힌다.
 *
 * **서명은 보여 주지 않는다** — 파서가 떼어 둔 것을 다시 붙이지 않는다. 오간 말을 훑는
 * 자리라서, 통마다 되풀이되는 서명이 끼면 정작 한 줄짜리 본문이 묻힌다.
 *
 * 긴 본문은 `PREVIEW_LIMIT` 자에서 자르고, 가리키면 전문을 풍선으로 띄운다.
 *
 * 본문은 **글자만** 보여 준다. 말풍선마다 iframe 을 띄우지 않는다 — 여기서 보려는 것은 오간
 * 말이고, 서식까지 그대로 봐야 하면 메일을 열면 된다. 글자로 꽂으므로(React 가 이스케이프한다)
 * 원격 이미지 · 스크립트가 끼어들 자리도 없다.
 */
import { useMemo, useState } from 'react';
import type { Me, MessageSummary } from '../../api/types';
import { threadNewest, type ThreadGroup } from '../mailbox/thread';
import { useMessageBody } from './useMessageBody';
import { parseConversation, type ConversationEntry } from './conversation';
import { useT } from '../../i18n';

interface Props {
  group: ThreadGroup;
  me: Me;
  /** 마지막 메일을 읽기 화면으로 연다 */
  onOpenMessage: (message: MessageSummary) => void;
}

/**
 * 말풍선에 그대로 세우는 본문의 길이. 넘으면 잘라 보여 주고 **가리키면 전문**이 뜬다.
 * 대화를 훑는 자리라서 긴 메일 한 통이 화면을 다 먹으면 앞뒤 말이 한눈에 들어오지 않는다.
 */
const PREVIEW_LIMIT = 100;

/** 내 주소들. 계정 하나와 보낼 수 있는 알리아스 전부다 */
function myAddresses(me: Me): Set<string> {
  return new Set([me.userName.toLowerCase(), ...me.aliases.map((alias) => alias.address.toLowerCase())]);
}

/**
 * 주소 → 프로필 사진. 인용문에는 사진이 없으므로 **같은 대화의 메일들**에서 모은다 —
 * 목록이 아바타에 쓰는 그 값이다(MessageSummary.fromPhoto · toPhoto). 사내 계정이 아니면
 * 사진이 없고, 그때는 이름 첫 글자로 그린다. 내 사진은 담지 않는다 — 내 말에는 안 그린다
 */
function photoBook(group: ThreadGroup): Map<string, string> {
  const book = new Map<string, string>();
  for (const message of group.messages) {
    if (message.from && message.fromPhoto) book.set(message.from.toLowerCase(), message.fromPhoto);
    if (message.to && message.toPhoto) book.set(message.to.toLowerCase(), message.toPhoto);
  }
  return book;
}

export function ConversationPane({ group, me, onOpenMessage }: Props) {
  const t = useT();
  const newest = useMemo(() => threadNewest(group), [group]);
  const { body, loading, error } = useMessageBody(newest.mailboxId, newest.uid, newest.mailId);
  // 파싱은 최근 → 오래된 순으로 나온다. 메신저는 반대 순서로 읽는다
  const entries = useMemo(() => (body ? parseConversation(body.mail).slice().reverse() : []), [body]);
  const mine = useMemo(() => myAddresses(me), [me]);
  const photos = useMemo(() => photoBook(group), [group]);
  // 사진 파일이 사라진 URL 은 한 번 실패하면 이름 첫 글자로 되돌린다 (목록과 같은 처리)
  const [brokenPhotos, setBrokenPhotos] = useState<Set<string>>(new Set());

  return (
    <div className="reading conv">
      <div className="reading-toolbar">
        <button className="btn" onClick={() => onOpenMessage(newest)}>
          {t('conv.openLast')}
        </button>
      </div>

      <h2 className="reading-subject">{newest.subject || t('common.noSubject')}</h2>
      {loading && <div className="reading-status">{t('read.parsing')}</div>}
      {error && <div className="error">{error}</div>}
      {body && entries.length <= 1 && <div className="reading-status">{t('conv.noQuote')}</div>}

      <div className="chat">
        {entries.map((entry, index) => {
          const own = isMine(entry, mine);
          const photo = own || !entry.address ? undefined : photos.get(entry.address.toLowerCase());
          const who = entry.name || entry.address || t('conv.unknownSender');
          return (
            <div key={index} className={`chat-row ${own ? 'own' : ''}`}>
              {own ? null : photo && !brokenPhotos.has(photo) ? (
                <img
                  className="avatar photo"
                  src={photo}
                  alt=""
                  onError={() => setBrokenPhotos((prev) => new Set(prev).add(photo))}
                />
              ) : (
                <span className="avatar" aria-hidden>
                  {(who || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="chat-main">
                <div className="chat-head">
                  {/* 이름만 세우고 주소는 힌트로 둔다 — 줄마다 주소가 길게 늘어서면 말이 안 보인다 */}
                  <span className="conv-who" title={entry.address ?? undefined}>
                    {who}
                  </span>
                  <span
                    className={`conv-when ${entry.exact ? '' : 'quoted'}`}
                    title={entry.exact ? undefined : t('conv.quotedTime')}
                  >
                    {entry.date ?? t('conv.unknownDate')}
                  </span>
                </div>
{/* 서명은 그리지 않는다 — 파서가 떼어 둔 것을 여기서 다시 붙이지 않는다 (conversation.ts) */}
                <div className="chat-bubble">
                  {entry.body ? (
                    <p
                      className={`conv-body ${entry.body.length > PREVIEW_LIMIT ? 'clipped' : ''}`}
                      // 자르지 않은 본문에는 달지 않는다 — 보이는 글자가 그대로 또 뜨는 풍선은 방해만 된다
                      title={entry.body.length > PREVIEW_LIMIT ? entry.body : undefined}
                    >
                      {entry.body.length > PREVIEW_LIMIT ? `${entry.body.slice(0, PREVIEW_LIMIT)}…` : entry.body}
                    </p>
                  ) : (
                    <p className="conv-body empty">{t('conv.emptyBody')}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 내가 보낸 메일인가. 주소를 못 읽은 단계는 남의 것으로 둔다 — 내 말로 둔갑하지 않게 */
function isMine(entry: ConversationEntry, mine: ReadonlySet<string>): boolean {
  return entry.address ? mine.has(entry.address.toLowerCase()) : false;
}
