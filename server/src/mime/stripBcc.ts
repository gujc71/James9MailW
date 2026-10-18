/**
 * SMTP 제출용 raw 에서 Bcc 헤더만 제거한다.
 *
 * Sent 사본에는 Bcc 를 **남기고**(발신자가 자기 Bcc 를 보고, JAMES_MAIL_RECIPIENTS 에
 * bcc 행이 생긴다) 제출분에서만 뺀다. 그 외 바이트는 동일해야 한다
 * (webmail-issues.md 2-6, 3-2 / webmail-architecture.md 2.3).
 *
 * 헤더 영역(첫 빈 줄 앞)만 손대고, folded continuation 줄까지 함께 지운다.
 */
import { Transform, type TransformCallback } from 'node:stream';

export class StripBccTransform extends Transform {
  private buffer = '';
  private inHeaders = true;
  private droppingFoldedHeader = false;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.inHeaders) {
      this.push(chunk);
      callback();
      return;
    }

    this.buffer += chunk.toString('latin1');
    let out = '';

    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      // 줄바꿈을 포함해 한 줄씩 떼어 낸다 (CRLF 든 LF 든 바이트 그대로 유지)
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);

      const bare = line.replace(/\r?\n$/, '');
      if (bare === '') {
        // 헤더 끝. 이후는 손대지 않고 그대로 흘린다.
        out += line;
        this.inHeaders = false;
        out += this.buffer;
        this.buffer = '';
        break;
      }

      const isContinuation = line.startsWith(' ') || line.startsWith('\t');
      if (this.droppingFoldedHeader && isContinuation) continue;
      this.droppingFoldedHeader = false;

      if (/^bcc\s*:/i.test(bare)) {
        this.droppingFoldedHeader = true;
        continue;
      }
      out += line;
    }

    if (out) this.push(Buffer.from(out, 'latin1'));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer) this.push(Buffer.from(this.buffer, 'latin1'));
    callback();
  }
}

export function stripBccHeader(): Transform {
  return new StripBccTransform();
}
