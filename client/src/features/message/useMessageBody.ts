/**
 * 원문을 받아(캐시 우선) 워커로 파싱하고, 첨부는 blob URL, 인라인 이미지는 data: URI 로 만든다.
 *
 * 원문은 fetch 로만 읽는다(2-2). 캐시는 Dexie bodies 에 둔다(2-9). 같은 mailId 면
 * 편지함이 달라도 재사용한다(3.8).
 */
import { useEffect, useRef, useState } from 'react';
import { parseMail, type ParsedMail } from '../../mime/parser';
import { toDataUri } from '../../mime/dataUri';
import { db, findBodyByMailId, putBody } from '../../db/schema';
import { t } from '../../i18n';

/**
 * 본문에 data: 로 심을 인라인 이미지 한 장의 상한. 넘으면 첨부 목록으로 돌린다 —
 * 수십 MB 를 base64 로 부풀려 srcdoc 문자열에 싣는 것보다 낫다.
 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export interface LoadedBody {
  mail: ParsedMail;
  cidUrls: Map<string, string>;
  attachmentUrls: { filename: string; mimeType: string; size: number; url: string }[];
}

async function fetchRaw(mailboxId: string, uid: number, mailId: string): Promise<ArrayBuffer> {
  const cached = (await db.bodies.get(`${mailboxId}:${uid}`)) ?? (await findBodyByMailId(mailId));
  if (cached) {
    await db.bodies.update(cached.key, { lastAccessed: Date.now() });
    return cached.raw.slice(0);
  }
  let response: Response;
  try {
    response = await fetch(`/api/messages/${encodeURIComponent(mailboxId)}/${uid}/raw`, {
      credentials: 'include',
    });
  } catch (cause) {
    // 캐시에 없고 네트워크도 없으면 열 방법이 없다. "불러오지 못했습니다" 보다
    // 왜 안 열리는지를 말해 준다 (8-5 오프라인 읽기)
    if (!navigator.onLine) throw new Error(t('read.offlineNoBody'));
    throw cause;
  }
  if (!response.ok) throw new Error(t('read.rawFailed'));
  const raw = await response.arrayBuffer();
  await putBody({ key: `${mailboxId}:${uid}`, mailboxId, uid, mailId, raw });
  return raw.slice(0);
}

/**
 * 파싱 결과를 화면이 바로 쓸 수 있게 만든다.
 *  - 첨부는 blob URL (부모 문서가 내려받기·미리보기에 쓴다). 회수 목록을 함께 돌려준다.
 *  - 인라인 이미지는 **data: URI**. 본문은 sandbox iframe(opaque origin) 안에서 그려지고
 *    그 안에서는 부모가 만든 blob: URL 을 열 수 없다 (mime/dataUri.ts 주석 참고).
 *    이것 때문에 읽기 화면의 cid: 인라인 이미지가 늘 깨져 보였다.
 */
export async function buildLoadedBody(raw: ArrayBuffer): Promise<{ body: LoadedBody; urls: string[] }> {
  const mail = await parseMail(raw);
  const cidUrls = new Map<string, string>();
  const attachmentUrls: LoadedBody['attachmentUrls'] = [];
  const urls: string[] = [];
  for (const attachment of mail.attachments) {
    // 약속 상자가 일시·장소·내용을 이미 펼쳐 보여 주는 일정 파트는 첨부로 또 내걸지 않는다.
    // 전달할 때는 원본 그대로 실어 보내야 하니 mail.attachments 에는 남겨 둔다 (quote.ts)
    if (attachment.isCalendar) continue;
    // 연락처 상자로 펼친 v-Card 도 마찬가지다 — 화면에 내용이 이미 있는데 .vcf 파일까지
    // 내걸지 않는다 (features/message/VCardBox.tsx)
    if (attachment.isVCard) continue;
    if (attachment.inline && attachment.contentId && attachment.size <= MAX_INLINE_BYTES) {
      cidUrls.set(attachment.contentId, toDataUri(attachment.mimeType, attachment.content));
      continue;
    }
    const blob = new Blob([attachment.content], { type: attachment.mimeType });
    const url = URL.createObjectURL(blob);
    urls.push(url);
    // 상한을 넘은 인라인 이미지도 첨부로 내려 보낸다. 본문에서는 빠지지만 열어 볼 수는 있다
    attachmentUrls.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url,
    });
  }
  return { body: { mail, cidUrls, attachmentUrls }, urls };
}

export function useMessageBody(
  mailboxId: string | null,
  uid: number | null,
  mailId: string | null,
): { body: LoadedBody | null; loading: boolean; error: string | null } {
  const [body, setBody] = useState<LoadedBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!mailboxId || uid === null || !mailId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    // 이전 blob URL 회수
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];

    (async () => {
      try {
        const raw = await fetchRaw(mailboxId, uid, mailId);
        const { body: loaded, urls } = await buildLoadedBody(raw);
        if (cancelled) {
          for (const url of urls) URL.revokeObjectURL(url);
          return;
        }
        urlsRef.current.push(...urls);
        setBody(loaded);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mailboxId, uid, mailId]);

  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  return { body, loading, error };
}

/**
 * 원문 보기(5-2)용. 캐시(Dexie) 를 먼저 보는 같은 경로로 원문 바이트를 받아 텍스트로 푼다.
 * 8bit 로 실려 온 한국어 레거시 인코딩은 헤더의 charset 을 보고 맞춘다 (webmail-issues.md 2-12).
 */
export async function loadRawText(mailboxId: string, uid: number, mailId: string): Promise<string> {
  const bytes = new Uint8Array(await fetchRaw(mailboxId, uid, mailId));
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  const charset = head.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // TextDecoder 가 모르는 charset(iso-2022-kr 등) 이면 utf-8 로 내려간다
    }
  }
  return new TextDecoder().decode(bytes);
}
