/** 워커를 감싸 Promise 로 파싱 결과를 돌려준다 */
import type { ParsedMail, ParseRequest, ParseResponse } from './parse.worker.js';
import { t } from '../i18n';

export type { ParsedMail, ParsedAttachment } from './parse.worker.js';
export type { VCardContact, VCardTel } from './vcard';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (m: ParsedMail) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ParseResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok && event.data.mail) entry.resolve(event.data.mail);
    else entry.reject(new Error(event.data.error ?? t('read.parseFailed')));
  };
  return worker;
}

export function parseMail(raw: ArrayBuffer): Promise<ParsedMail> {
  const id = nextId++;
  const request: ParseRequest = { id, raw };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // raw 를 transfer 하면 호출자 쪽 버퍼가 비므로 복사본을 넘긴다
    ensureWorker().postMessage(request, [raw.slice(0)]);
  });
}
