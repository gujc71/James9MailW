/**
 * 메일쓰기는 multipart/form-data 로 보낸다 (첨부 스트림 때문에: webmail-issues 3-5).
 * 그래서 mockApi 가 기록한 요청 본문은 JSON 이 아니라 원문 문자열이다.
 * 스펙에서 "받는사람에 무엇이 실렸나" 를 보려면 그 문자열에서 필드를 꺼내야 한다.
 */

/** multipart 본문에서 이름이 name 인 일반 필드 값을 꺼낸다 */
export function formField(body: unknown, name: string): string | null {
  if (typeof body !== 'string') return null;
  const pattern = new RegExp(
    `name="${name}"(?:;[^\\r\\n]*)?\\r?\\n(?:[^\\r\\n]+\\r?\\n)*\\r?\\n([\\s\\S]*?)\\r?\\n--`,
  );
  const match = pattern.exec(body);
  return match ? (match[1] ?? null) : null;
}

/** multipart 본문에 담긴 첨부 파일 이름들 */
export function formFileNames(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  return [...body.matchAll(/name="attachments";\s*filename="([^"]+)"/g)].map((match) => match[1] ?? '');
}
