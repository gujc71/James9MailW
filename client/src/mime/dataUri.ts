/**
 * 파싱한 파트 바이트를 data: URI 로 만든다.
 *
 * 인라인 이미지에는 blob: URL 을 쓸 수 없다. 본문은 sandbox iframe 안에서 그려지는데
 * (allow-same-origin 을 주지 않으므로 opaque origin), 그 안에서는 부모 문서가 만든
 * blob: URL 을 열 수 없다 — CSP 로 blob: 을 허용해도 origin 이 달라 막힌다.
 * 첨부 다운로드처럼 **부모 문서**가 쓰는 자리에서는 blob: 이 맞다 (메모리를 덜 쓴다).
 */

/** ArrayBuffer -> base64. 큰 파트에서 인자 개수 한계에 걸리지 않게 잘라 넣는다 */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function toDataUri(mimeType: string, buffer: ArrayBuffer): string {
  return `data:${mimeType || 'application/octet-stream'};base64,${toBase64(buffer)}`;
}
