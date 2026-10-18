/**
 * SMTP 제출.
 *
 * 587 은 비활성이고 25 는 authorizedAddresses=127.0.0.0/8 무인증 릴레이이므로
 * 웹서버가 localhost 에서 25 로 제출한다. 사용자 비밀번호가 없어 사용자 명의로
 * SMTP AUTH 를 할 수 없기 때문이다. 대신 **From 헤더 = 세션 사용자(또는 알리아스)**
 * 검증을 웹서버가 대신 수행한다. 이 검증이 빠지면 발신자 위조가 가능하다
 * (webmail-issues.md 1-2).
 */
import nodemailer from 'nodemailer';
import { createReadStream } from 'node:fs';
import { config } from '../config.js';
import { stripBccHeader } from '../mime/stripBcc.js';

const transporter = nodemailer.createTransport({
  host: config.james.smtpHost,
  port: config.james.smtpPort,
  secure: false,
  ignoreTLS: true,
  // maxmessagesize=0(무제한) 이라 40MB 급도 제출된다. 소켓 타임아웃만 넉넉히 둔다.
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 10 * 60_000,
  pool: true,
  maxConnections: 4,
});

export interface SubmitParams {
  /** 스테이징에 써 둔 원문(.part) 경로. Bcc 를 포함한다 */
  rawPath: string;
  envelopeFrom: string;
  /** 봉투 수신자 = to + cc + bcc 전부 (webmail-issues.md 3-2) */
  envelopeTo: string[];
}

/** RCPT TO 단계에서 메일 서버가 거부한 수신자 (550 5.1.1 Unknown user 등) */
export interface RejectedRecipient {
  address: string;
  /** 서버가 돌려준 응답 한 줄. 사용자에게 그대로 보여주지 말고 안내 문구로 감싼다 */
  response: string;
}

/**
 * 봉투 수신자가 **전부** 거부돼 한 통도 나가지 않은 경우.
 *
 * nodemailer 는 이때만 예외를 던진다(smtp-connection 의 "all recipients were rejected").
 * 일부만 거부되면 남은 수신자에게 DATA 를 그대로 진행하고 거부된 주소는
 * SubmitResult.rejectedDetail 로만 돌아온다 — 조용히 지나가지 않도록 호출자가 반드시 본다.
 */
export class AllRecipientsRejectedError extends Error {
  constructor(readonly rejected: RejectedRecipient[]) {
    super(`all recipients rejected: ${rejected.map((r) => r.address).join(', ')}`);
    this.name = 'AllRecipientsRejectedError';
  }
}

export interface SubmitResult {
  accepted: string[];
  rejected: string[];
  /** 거부된 수신자와 그 사유. rejected 와 같은 목록에 응답 줄이 붙은 것 */
  rejectedDetail: RejectedRecipient[];
  response: string;
}

/** nodemailer 가 붙이는 봉투 오류 필드 (문서화돼 있지 않아 좁게 읽는다) */
interface EnvelopeError extends Error {
  code?: string;
  recipient?: string;
  response?: string;
  rejectedErrors?: EnvelopeError[];
}

function rejectedFrom(errors: EnvelopeError[] | undefined): RejectedRecipient[] {
  return (errors ?? [])
    .filter((error) => typeof error.recipient === 'string')
    .map((error) => ({
      address: error.recipient!,
      response: (error.response ?? error.message ?? '').trim(),
    }));
}

export async function submit(params: SubmitParams): Promise<SubmitResult> {
  let info;
  try {
    info = await transporter.sendMail({
      envelope: { from: params.envelopeFrom, to: params.envelopeTo },
      raw: createReadStream(params.rawPath).pipe(stripBccHeader()),
    });
  } catch (cause) {
    const error = cause as EnvelopeError;
    const rejected = rejectedFrom(error.rejectedErrors);
    // 수신자 거부와 연결 실패·타임아웃을 가른다. 앞은 사용자 잘못이라 안내메일을 보내고,
    // 뒤는 서버 문제라 그대로 올려 503 이 된다.
    if (error.code === 'EENVELOPE' && rejected.length > 0) {
      throw new AllRecipientsRejectedError(rejected);
    }
    throw cause;
  }
  return {
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
    rejectedDetail: rejectedFrom((info as { rejectedErrors?: EnvelopeError[] }).rejectedErrors),
    response: info.response ?? '',
  };
}

export async function verifySmtp(): Promise<boolean> {
  try {
    await transporter.verify();
    return true;
  } catch {
    return false;
  }
}

export function closeSmtp(): void {
  transporter.close();
}
