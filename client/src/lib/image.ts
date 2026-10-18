/**
 * 올린 사진을 화면에 쓰는 크기로 줄인다. 휴대폰 사진은 수 MB 라 그대로 두면
 * 서버 상한에 걸리고, 목록·vCard 동기화도 무거워진다.
 *
 * 표시 크기(styles.css) 기준, 고해상도 화면(2배)까지 선명하게:
 *  - 프로필·연락처 사진: 가장 크게 그리는 곳이 84px 원 → 정사각형 192px 로 가운데를 잘라 낸다
 *  - 사이트 로고: 상단 막대 높이 28px · 미리보기 60×240 → 480×120 상자 안으로 비율 유지
 */
export const AVATAR_PX = 192;
export const LOGO_BOX = { width: 480, height: 120 };

interface ResizeOptions {
  width: number;
  height: number;
  /** true 면 width×height 를 꽉 채우도록 가운데를 잘라 낸다(object-fit: cover). 아니면 상자 안에 맞춘다 */
  cover?: boolean;
}

/**
 * 투명도가 있을 수 있는 PNG·WEBP 는 PNG 로, 나머지는 JPEG 로 다시 굽는다(GIF 는 첫 프레임만 남는다).
 * 이미 충분히 작으면(잘라 낼 것도 없으면) 원본을 그대로 돌려준다.
 */
export async function resizeImage(file: Blob, { width, height, cover = false }: ResizeOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const sw = bitmap.width;
    const sh = bitmap.height;
    // 원본에서 쓸 영역(가운데 자르기)과 결과 크기
    let sx = 0;
    let sy = 0;
    let cw = sw;
    let ch = sh;
    if (cover) {
      const ratio = width / height;
      if (sw / sh > ratio) cw = Math.round(sh * ratio);
      else ch = Math.round(sw / ratio);
      sx = Math.round((sw - cw) / 2);
      sy = Math.round((sh - ch) / 2);
    }
    const scale = Math.min(1, width / cw, height / ch);
    if (scale === 1 && cw === sw && ch === sh) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/png' || file.type === 'image/webp' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    return blob ?? file;
  } finally {
    bitmap.close();
  }
}

/** vCard PHOTO 처럼 data: URI 가 필요한 곳에 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
