/**
 * 테스트용 원문(.eml) 생성기.
 *
 * 이 앱은 원문을 파일 그대로 받아 **브라우저가** 파싱한다 (mime/parse.worker.ts).
 * 그래서 읽기 화면 스펙의 입력은 화면 조작이 아니라 원문 그 자체다 — 멀티파트·인라인
 * 이미지·한글 인코딩 제목·TNEF 를 여기서 만들어 넣고 화면이 어떻게 그리는지 본다.
 *
 * 줄 끝은 반드시 CRLF 다. LF 로 만들면 헤더와 본문 경계를 파서가 못 찾는다.
 */

const CRLF = '\r\n';

function join(lines: string[]): string {
  return lines.join(CRLF);
}

/** 한글 제목은 RFC 2047 로 인코딩해야 한다 (=?UTF-8?B?...?=) */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

export interface SimpleEmlOptions {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
  messageId?: string;
  /** Importance 헤더. 읽기 화면·목록의 중요도 표시에 쓰인다 */
  importance?: 'high';
}

/** 평문 또는 HTML 한 덩이만 담은 가장 단순한 메일 */
export function simpleEml(options: SimpleEmlOptions = {}): string {
  const {
    from = 'user2@example.com',
    to = 'user1@example.com',
    subject = 'Test message',
    date = 'Sat, 26 Sep 2026 09:00:00 +0900',
    text,
    html,
    messageId = '<simple@example.com>',
    cc,
    importance,
  } = options;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...(importance ? ['Importance: high', 'X-Priority: 1'] : []),
  ];

  if (html) {
    return join([
      ...headers,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      '',
    ]);
  }

  return join([
    ...headers,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text ?? 'Hello from the mock server.', 'utf8').toString('base64'),
    '',
  ]);
}

export interface AttachmentSpec {
  filename: string;
  mimeType: string;
  /** base64 로 실을 내용 */
  content: string;
  /** cid 를 주면 인라인 이미지가 된다 (본문에서 cid: 로 참조) */
  contentId?: string;
}

/** 1x1 투명 PNG. 인라인 이미지·첨부 스펙의 기본 재료 */
export const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/QAAAAA=';

/** multipart/mixed (+ 인라인이 있으면 related) 로 첨부를 붙인 메일 */
export function multipartEml(options: SimpleEmlOptions & { attachments: AttachmentSpec[] }): string {
  const {
    from = 'user2@example.com',
    to = 'user1@example.com',
    subject = 'With attachments',
    date = 'Sat, 26 Sep 2026 09:00:00 +0900',
    html = '<p>본문</p>',
    messageId = '<multipart@example.com>',
    attachments,
  } = options;

  const boundary = 'j9-boundary-0001';
  const parts: string[] = [];

  parts.push(
    join([
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      '',
    ]),
  );

  for (const attachment of attachments) {
    const disposition = attachment.contentId ? 'inline' : 'attachment';
    parts.push(
      join([
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: ${disposition}; filename="${attachment.filename}"`,
        ...(attachment.contentId ? [`Content-ID: <${attachment.contentId}>`] : []),
        '',
        attachment.content,
        '',
      ]),
    );
  }

  return join([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
    `--${boundary}--`,
    '',
  ]);
}

/** winmail.dat 첨부. 읽기 화면이 TNEF 경고를 띄우는지 본다 (read.warnTnef) */
export function tnefEml(): string {
  return multipartEml({
    subject: 'Sent from Outlook',
    html: '<p>본문은 winmail.dat 안에 있다</p>',
    attachments: [
      {
        filename: 'winmail.dat',
        mimeType: 'application/ms-tnef',
        content: Buffer.from('fake tnef payload', 'utf8').toString('base64'),
      },
    ],
  });
}

/** 원격 이미지가 들어 있는 메일. 기본 차단 배너를 검증한다 (read.remoteBlocked) */
export function remoteImageEml(): string {
  return simpleEml({
    subject: 'Newsletter',
    html: '<p>추적 픽셀</p><img src="https://tracker.example.com/pixel.gif" width="1" height="1">',
  });
}

/**
 * 약속메일(iCalendar). 읽기 화면의 참석 응답 영역을 검증한다.
 *
 * 일정은 **첨부 파트**로 붙인다. 읽기 화면은 파싱된 첨부 중 text/calendar 를 찾아
 * 일시·장소·내용을 뽑기 때문에(mime/parse.worker.ts), multipart/alternative 의 대안 본문으로
 * 넣으면 파서가 본문으로 삼아 버려 일정이 잡히지 않는다.
 * 이 파트는 약속 상자로 펼쳐 보여 주므로 첨부 목록에는 뜨지 않는다 (useMessageBody.ts).
 */
export function calendarEml(): string {
  const ics = join([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:appointment-1@example.com',
    'DTSTART:20261001T140000',
    'DTEND:20261001T150000',
    'SUMMARY:Sprint review',
    'LOCATION:Meeting room A',
    // 쉼표는 ICS 규칙대로 이스케이프해서 넣는다. 읽기 화면이 되돌려 보여 줘야 한다
    'DESCRIPTION:Quarterly planning\\, bring notes',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);

  return multipartEml({
    subject: '회의 요청',
    messageId: '<calendar@example.com>',
    html: '<p>Sprint review</p>',
    attachments: [
      {
        filename: 'invite.ics',
        mimeType: 'text/calendar',
        content: Buffer.from(ics, 'utf8').toString('base64'),
      },
    ],
  });
}

/**
 * v-Card(.vcf) 첨부. 읽기 화면은 파일을 내걸지 않고 연락처 상자로 펼친다
 * (mime/vcard.ts → features/message/VCardBox.tsx).
 *
 * 한글 이름은 옛 메일 앱이 쓰던 vCard 2.1 · QUOTED-PRINTABLE 로 싣는다 — 그대로 글자로
 * 읽으면 "ì´" 처럼 깨지므로 바이트로 되돌려야 한다.
 */
export function vcardEml(options: { quotedPrintable?: boolean } = {}): string {
  const lines = options.quotedPrintable
    ? [
        'BEGIN:VCARD',
        'VERSION:2.1',
        `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${quotedPrintable('관리자')}`,
        'EMAIL;INTERNET:admin@example.com',
        'END:VCARD',
      ]
    : [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'N:관리자;;;;',
        'FN:관리자',
        'ORG:구름주식회사;개발팀',
        'TITLE:팀장',
        'EMAIL;TYPE=INTERNET:admin@example.com',
        'TEL;TYPE=CELL:010-1234-5678',
        'END:VCARD',
      ];

  return multipartEml({
    subject: 'dddddddddd',
    messageId: '<vcard@example.com>',
    html: '<p>dddddd</p>',
    attachments: [
      {
        filename: 'admin.vcf',
        mimeType: 'text/vcard',
        content: Buffer.from(join([...lines, '']), 'utf8').toString('base64'),
      },
    ],
  });
}

/** 한 글자씩 UTF-8 바이트로 풀어 =XX 로 적는다 (vCard 2.1) */
function quotedPrintable(text: string): string {
  return [...Buffer.from(text, 'utf8')]
    .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/**
 * 답장이 세 번 오간 대화 — 인용이 `<blockquote>` 로 세 겹 쌓인 메일이다.
 * 목록의 통수 배지를 눌러 뽑아내는 "대화 내용"의 입력이다
 * (client/src/features/message/conversation.ts).
 *
 * 머리말을 **영문 꼴과 한글 꼴 둘 다** 섞어 둔 것은 실제 원문이 그렇기 때문이다 —
 * 답장을 쓴 사람의 화면 언어가 그때그때 달라 `wrote:` 와 `님이 작성:` 이 한 메일에 같이 있다.
 * 서명 구분선(`<hr>`)도 두 단계에 넣어, 서명이 본문으로 섞여 들어오지 않는지 본다.
 *
 * text/plain 파트도 함께 싣는다. 우리 에디터가 만드는 평문 대안에는 인용 부호(`>`)도
 * 들여쓰기도 없어서 단계를 알 수 없다 — 화면이 HTML 쪽을 보는지 확인하는 대조군이다.
 */
export function replyChainEml(): string {
  const html = [
    '<p dir="ltr"><span style="white-space: pre-wrap;">eeeeeeeeeeeeee</span></p>',
    '<p dir="ltr"><span style="white-space: pre-wrap;">On 2026-10-02 21:23, 관리자 &lt;admin@example.com&gt; wrote:</span></p>',
    '<blockquote dir="ltr">',
    '<p dir="ltr"><span style="white-space: pre-wrap;">cccccccccccc</span></p>',
    '<p dir="ltr"><span style="white-space: pre-wrap;">2026-10-02 21:22, 테스트 &lt;user1@example.com&gt; 님이 작성:</span></p>',
    '<blockquote dir="ltr">',
    '<p dir="ltr"><span style="white-space: pre-wrap;">sssssssssss</span></p>',
    '<p dir="ltr"><span style="white-space: pre-wrap;">On 2026-09-30 21:35, 관리자 &lt;admin@example.com&gt; wrote:</span></p>',
    '<blockquote dir="ltr">',
    '<p dir="ltr"><span style="white-space: pre-wrap;">aaaaaaaaaaaaaaaaaaaa</span></p>',
    '<hr><p><br></p>',
    '<p dir="ltr"><span style="white-space: pre-wrap;">signature-oldest</span></p>',
    '</blockquote>',
    '</blockquote>',
    '<hr><p><br></p>',
    '<p dir="ltr"><span style="white-space: pre-wrap;">signature-middle</span></p>',
    '</blockquote>',
  ].join('');

  const text = [
    'eeeeeeeeeeeeee',
    'On 2026-10-02 21:23, 관리자 <admin@example.com> wrote:',
    'cccccccccccc',
    '2026-10-02 21:22, 테스트 <user1@example.com> 님이 작성:',
    'sssssssssss',
    'On 2026-09-30 21:35, 관리자 <admin@example.com> wrote:',
    'aaaaaaaaaaaaaaaaaaaa',
  ].join(CRLF);

  const boundary = 'j9-alt-0001';
  return join([
    'From: =?UTF-8?B?' + Buffer.from('테스트', 'utf8').toString('base64') + '?= <user1@example.com>',
    'To: admin@example.com',
    'Subject: ' + encodeSubject('Re: Re: Re: aaaaaaaaaa'),
    // 한국(Asia/Seoul)에서 보면 2026-10-02 21:30 이다. 테스트 브라우저 시간대가 그렇다
    'Date: Fri, 02 Oct 2026 12:30:40 +0000',
    'Message-ID: <chain-last@example.com>',
    'In-Reply-To: <chain-3@example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ]);
}

/**
 * 우리 웹메일로 쓴 답장 한 통. 서명이 **구분선 없이** `div.j9-signature` 로 본문 끝에 붙는다
 * (server/src/services/compose.ts 가 보낼 때 그렇게 감싼다).
 *
 * 대화 보기가 서명을 떼어 내는 길이 두 가지라서 둘 다 재료가 필요하다 — `<hr>` 쪽은
 * replyChainEml 이, 이쪽은 이 원문이 맡는다. 구분선만 보고 있으면 우리가 보낸 메일의 서명이
 * 고스란히 본문으로 섞여 들어온다.
 */
export function ownSignatureEml(): string {
  const html = [
    '<p dir="ltr">답장 한 줄</p>',
    '<p dir="ltr">On 2026-10-02 21:23, 관리자 &lt;admin@example.com&gt; wrote:</p>',
    '<blockquote dir="ltr"><p dir="ltr">물어본 내용</p></blockquote>',
    '<div class="j9-signature"><p>홍길동 드림</p><p>02-000-0000</p></div>',
  ].join('');

  return simpleEml({
    from: '=?UTF-8?B?' + Buffer.from('테스트', 'utf8').toString('base64') + '?= <user1@example.com>',
    subject: 'Re: 서명 붙은 답장',
    date: 'Fri, 02 Oct 2026 12:30:40 +0000',
    messageId: '<own-signature@example.com>',
    html,
  });
}
