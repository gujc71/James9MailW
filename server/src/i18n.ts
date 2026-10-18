/**
 * 서버가 사용자에게 돌려주는 문구 (ko · en).
 *
 * 오류 메시지는 라우트·서비스에서 "키" 로만 던지고(errors.ts 의 HttpError.message),
 * app.ts 의 errorHandler 가 요청 로케일로 번역해 내보낸다. 카탈로그에 없는 문자열은
 * (James 응답처럼 그때그때 만들어지는 값) 그대로 통과한다.
 *
 * 로케일은 클라이언트가 붙이는 x-locale 헤더 > 세션 > 기본값(en) 순으로 정한다.
 */
export type Locale = 'ko' | 'en';

export const DEFAULT_LOCALE: Locale = 'en';

const ko = {
  // ---------------------------------------------------------------- 공통 · 인증
  'err.badInput': '입력값이 올바르지 않습니다',
  'err.fileTooLarge': '파일이 너무 큽니다',
  'err.internal': '서버 오류가 발생했습니다',
  'err.schemaOutdated': 'DB 업데이트가 필요합니다. 관리자가 {script} 를 실행해야 합니다',
  'err.loginRequired': '로그인이 필요합니다',
  'err.forbidden': '권한이 없습니다',
  'err.notFound': '대상을 찾을 수 없습니다',
  'err.cursorExpired': '동기화 커서가 만료되었습니다',
  'err.cursorExpiredFull': '동기화 커서가 만료되었습니다. 전체 재동기화가 필요합니다',
  'err.adminOnly': '관리자만 사용할 수 있습니다',
  'err.badCredentials': '아이디 또는 비밀번호가 올바르지 않습니다',
  'err.accountSuspended': '중지된 계정입니다. 관리자에게 문의하세요',
  'err.currentPwWrong': '현재 비밀번호가 올바르지 않습니다',
  'err.pwPolicy': '비밀번호는 {len}자 이상, 특수문자 {spec}자 이상이어야 합니다',
  'err.pwMinLen': '비밀번호는 {len}자 이상이어야 합니다',
  'err.pwMinSpec': '특수문자를 {spec}자 이상 포함해야 합니다',
  'err.noPhotoFile': '사진 파일이 없습니다',
  'err.photoTooBig': '사진은 {mb}MB 이하여야 합니다',
  'err.photoType': 'PNG · JPG · GIF · WEBP 이미지만 등록할 수 있습니다',
  'err.noPhoto': '사진이 없습니다',
  'err.tooManyAttempts': '시도가 너무 많습니다. {min}분 후에 다시 시도하세요',
  'err.csrf': '잘못된 요청입니다. 화면을 새로 고친 뒤 다시 시도하세요',

  // ---------------------------------------------------------------- James 연동
  'err.jamesUnreachable': '메일 서버 관리 기능에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요',
  'err.jamesRouteMissing':
    '메일 서버가 이 기능을 지원하지 않습니다. 관리자에게 문의하세요',
  'err.jamesFailed': '메일 서버가 요청을 처리하지 못했습니다',
  'err.sieveRouteMissing': '메일 서버가 규칙 저장을 지원하지 않습니다. 관리자에게 문의하세요',
  'err.sieveSaveFailed': '규칙을 저장하지 못했습니다. 입력값을 확인해 주세요',

  // ---------------------------------------------------------------- 관리자
  'err.noLogoFile': '로고 파일이 없습니다',
  'err.imageOnly': '이미지 파일만 등록할 수 있습니다',
  'err.logoTooBig': '로고는 2MB 이하여야 합니다',
  'err.noLogo': '로고가 없습니다',
  'err.nameMin2': '사용자 이름은 2자 이상이어야 합니다',
  'err.accountMin4': '계정은 4자 이상이어야 합니다',
  'err.accountTaken': '이미 사용 중인 계정입니다',
  'err.userNotFound': '계정을 찾을 수 없습니다',
  'err.quotaTooSmall': '현재 사용 용량보다 작은 값은 지정할 수 없습니다',
  'err.aliasNotFound': '알리아스를 찾을 수 없습니다',
  'err.aliasMin4': '알리아스 계정은 4자 이상이어야 합니다',
  'err.aliasIsUser': '실제 계정과 같은 주소는 쓸 수 없습니다',
  'err.notMyAlias': '{address} 로는 발신할 수 없습니다. 알리아스 설정이 바뀌었는지 확인하세요.',

  // ---------------------------------------------------------------- 편지함 · 메일
  'err.mailboxNotFound': '편지함을 찾을 수 없습니다',
  'err.namedBoxNotFound': '{name} 편지함을 찾을 수 없습니다',
  'err.parentNotFound': '상위 편지함을 찾을 수 없습니다',
  'err.pickTargetBox': '저장할 편지함을 선택하세요',
  'err.targetBoxNotFound': '저장 편지함을 찾을 수 없습니다',
  'err.dotInName': '편지함 이름에 . 은 쓸 수 없습니다 (계층 구분자입니다)',
  'err.systemBoxRename': '기본 편지함은 이름을 바꿀 수 없습니다',
  'err.systemBoxDelete': '기본 편지함은 삭제할 수 없습니다',
  'err.trashNotFound': '지운 편지함을 찾을 수 없습니다',
  'err.sentBoxNotFound': '보낸 편지함을 찾을 수 없습니다',
  'err.draftBoxNotFound': '임시 보관함을 찾을 수 없습니다',
  'err.noMoveToDrafts': '임시 보관함으로는 옮길 수 없습니다',
  'err.noCopyToDrafts': '임시 보관함으로는 복사할 수 없습니다',
  'err.mailNotFound': '메일을 찾을 수 없습니다',
  'err.noReadReceiptRequest': '이 메일에는 수신확인 요청이 없습니다',
  'err.readReceiptRejected': '{address} 로 수신확인 회신을 보내지 못했습니다',
  'err.emptyMailPath': '메일 원문 경로가 비어 있습니다',
  'err.outsideRoot': '저장 루트 밖의 경로입니다',
  'err.rawFileMissing': '메일 원문 파일이 없습니다',
  'err.nothingToRecall': '회수할 수 있는 메일이 없습니다',

  // ---------------------------------------------------------------- 첨부 · 메일쓰기
  'err.largeLimit': '대용량 첨부는 {mb}MB 까지 올릴 수 있습니다',
  'err.attachNotFound': '첨부를 찾을 수 없습니다',
  'err.attachSent': '이미 발송된 첨부는 삭제할 수 없습니다',
  'err.attachGone': '첨부를 찾을 수 없거나 보관 기간이 지났습니다',
  'err.attachCountLimit': '첨부파일은 {n}개까지 첨부할 수 있습니다',
  'err.attachSizeLimit': '일반 첨부 총용량이 제한({mb}MB)을 넘습니다. 대용량 첨부로 전환하세요',
  'err.notMyLargeAttach': '본인이 업로드한 대용량 첨부만 사용할 수 있습니다',
  'err.badAddressTo': '받는 사람 주소 형식이 올바르지 않습니다: {address}',
  'err.badAddressCc': '참조 주소 형식이 올바르지 않습니다: {address}',
  'err.badAddressBcc': '숨은참조 주소 형식이 올바르지 않습니다: {address}',
  'err.needRecipient': '받는 사람을 입력하세요',
  'err.replyTargetNotFound': '답장 대상 메일을 찾을 수 없습니다',
  'err.forwardTargetNotFound': '전달 대상 메일을 찾을 수 없습니다',
  'err.badSignature': '사용할 수 없는 서명입니다',
  'err.signScopeOff': '서명 사용이 꺼져 있습니다. 환경설정에서 켜 주세요',
  'err.smtpUnavailable': '메일 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'err.draftFailed': '임시저장에 실패했습니다',
  'err.appendFailed': '편지함에 넣지 못했습니다',
  'err.badAppointment': '약속 일시가 올바르지 않습니다',

  // ---------------------------------------------------------------- 개인 설정 · 규칙
  'err.badEmail': '메일 주소 형식이 올바르지 않습니다',
  'err.contactEmpty': '이름 · 메일 · 전화 중 하나는 적어야 합니다',
  'err.groupName': '그룹 이름을 적어 주세요',
  'err.contactPhoto': '사진이 너무 크거나 지원하지 않는 형식입니다',
  'err.importTooMany': '한 번에 가져올 수 있는 연락처는 5000개까지입니다',
  'err.importFormat': '.vcf 또는 .csv 파일만 가져올 수 있습니다',
  'err.badDomain': '도메인 형식이 올바르지 않습니다',
  'err.needPassword': '비밀번호를 입력하세요',
  'err.externalNotFound': '외부메일 계정을 찾을 수 없습니다',
  'err.externalHostBlocked': '이 서버 주소로는 외부메일을 가져올 수 없습니다',
  'err.badLoginId': '아이디·비밀번호에 줄바꿈 문자를 쓸 수 없습니다',
  'err.externalRunning': '이 계정은 이미 가져오는 중입니다',
  'err.dropInvalid': '메일 주소나 도메인 형식이 올바르지 않습니다',
  'err.dropExists': '이미 수신거부 목록에 있습니다',
  'err.dropLimit': '수신거부는 {n}개까지 등록할 수 있습니다',
  'err.internalUserNotBlockable': '내부 사용자는 수신거부 대상이 아닙니다',
  'err.internalDomainNotBlockable': '내부 도메인은 수신거부 대상이 아닙니다',
  'err.ruleConflict': '다른 곳에서 규칙이 먼저 저장되었습니다. 새로 고친 뒤 다시 시도하세요',
  'err.ruleTooBig': '규칙이 너무 많습니다 ({bytes} 바이트, 한계 {limit}). 규칙을 줄여 주세요',

  // ---------------------------------------------------------------- 발송 결과 안내
  'warn.quotaLow': '{address} 의 편지함 용량이 부족합니다. 반송될 수 있습니다.',
  'warn.partialFail': '일부 수신자에게 발송하지 못했습니다: {list}',
  'warn.allFail': '수신자를 찾을 수 없어 발송하지 못했습니다: {list}',
  'warn.noticeSuffix': ' 자세한 내용은 받은 편지함의 안내메일을 확인하세요.',
  'warn.sentCopyFailed': '발송은 되었지만 보낸편지함에 사본을 저장하지 못했습니다. 메일은 정상 발송됐습니다.',

  // ---------------------------------------------------------------- 메일 본문 · 안내메일
  'mail.noSubject': '(제목 없음)',
  'mail.large.title': '대용량 첨부파일',
  'mail.large.expire': '{date} 까지 내려받을 수 있습니다.',
  'mail.notice.from': '메일 전송 시스템',
  'mail.notice.subject': '[발송 실패] {subject}',
  'mail.notice.intro': '보내신 메일 <b>{subject}</b> 을(를) 아래 수신자에게 전달하지 못했습니다.',
  'mail.notice.to': '받는 사람',
  'mail.notice.why': '사유',
  'mail.notice.reason': '수신 거부',
  'mail.notice.hint': '주소를 잘못 입력했거나 사용이 중지된 계정일 수 있습니다. 주소를 확인해 주세요.',
  'mail.notice.auto': '이 메일은 메일 시스템이 자동으로 보낸 것이라 답장할 수 없습니다.',

  // 수신확인 요청(MDN) 회신 (feature-gap.md 4-4). 본문은 text/plain 파트라 태그를 쓰지 않는다
  'mail.mdn.subject': '[수신확인] {subject}',
  'mail.mdn.body':
    '보내신 메일 "{subject}" 을(를) {reader} 님이 {when} 에 읽었습니다.\n\n' +
    '이 회신은 수신확인 요청에 따라 받는 사람이 직접 눌러 보낸 것입니다. ' +
    '메일이 화면에 표시되었다는 뜻이고, 내용까지 읽었음을 보증하지는 않습니다.',

  // ---------------------------------------------------------------- 기본 편지함 이름
  'mailbox.INBOX': '받은 편지함',
  'mailbox.Sent': '보낸 편지함',
  'mailbox.Drafts': '임시 보관함',
  'mailbox.Trash': '지운 편지함',
  'mailbox.Spam': '스팸 편지함',
  'mailbox.Outbox': '보낼 편지함',
  'mailbox.Archive': '보관함',

  // ---------------------------------------------------------------- 캘린더
  'cal.defaultName': '홈',
  'err.calNotFound': '캘린더를 찾을 수 없습니다',
  'err.calReadonly': '읽기 전용 캘린더입니다',
  'err.calItemNotFound': '일정을 찾을 수 없습니다',
  'err.calBadTime': '날짜 · 시각 형식이 올바르지 않습니다',
  'err.calEndBeforeStart': '종료가 시작보다 앞설 수 없습니다',
  'err.calBadRule': '반복 규칙이 올바르지 않습니다',
  'err.calBadTimezone': '알 수 없는 시간대입니다',
  'err.calBadScope': '반복 일정의 대상 회차가 올바르지 않습니다',
  'err.calBadHours': '하루의 끝은 시작보다 뒤여야 합니다',
  'err.calBadUrl': 'http(s) 또는 webcal 주소를 입력하세요',
  'err.calFetchFailed': '캘린더를 받아 오지 못했습니다 (HTTP {status})',
  'err.calParseFailed': 'iCalendar(.ics) 형식을 읽을 수 없습니다',
  'err.calTooLarge': '캘린더 파일이 너무 큽니다 (10MB 까지)',
  'err.calLastCalendar': '쓸 수 있는 캘린더가 하나는 있어야 합니다',
  'err.calInviteFailed': '저장했지만 초대 메일을 보내지 못했습니다',
  'err.calReplyFailed': '응답했지만 주최자에게 회신 메일을 보내지 못했습니다',
  'mail.cal.untitled': '(제목 없음)',
  'mail.cal.allDay': '종일',
  'mail.cal.when': '일시',
  'mail.cal.where': '장소',
  'mail.cal.organizer': '주최자',
  'mail.cal.attendees': '참석자',
  'mail.cal.description': '설명',
  'mail.cal.inviteIntro': '일정에 초대합니다. 메일 프로그램의 캘린더에서 참석 여부를 알려 주세요.',
  'mail.cal.cancelIntro': '아래 일정이 취소되었습니다.',
  'mail.cal.cancelSubject': '[취소] {title}',
  'mail.cal.updateSubject': '[변경] {title}',
  'mail.cal.reply.ACCEPTED': '수락: {title}',
  'mail.cal.reply.TENTATIVE': '미정: {title}',
  'mail.cal.reply.DECLINED': '거절: {title}',
  'mail.cal.replyBody.ACCEPTED': '{who} 님이 "{title}" 초대를 수락했습니다.',
  'mail.cal.replyBody.TENTATIVE': '{who} 님이 "{title}" 초대에 미정으로 응답했습니다.',
  'mail.cal.replyBody.DECLINED': '{who} 님이 "{title}" 초대를 거절했습니다.',
} as const;

export type MessageKey = keyof typeof ko;

const en: Record<MessageKey, string> = {
  'err.badInput': 'The input is not valid',
  'err.fileTooLarge': 'The file is too large',
  'err.internal': 'A server error occurred',
  'err.schemaOutdated': 'The database needs an update. An administrator must run {script}',
  'err.loginRequired': 'Sign-in required',
  'err.forbidden': 'You do not have permission',
  'err.notFound': 'Not found',
  'err.cursorExpired': 'The sync cursor has expired',
  'err.cursorExpiredFull': 'The sync cursor has expired. A full resync is required',
  'err.adminOnly': 'Administrators only',
  'err.badCredentials': 'The user name or password is incorrect',
  'err.accountSuspended': 'This account is suspended. Please contact an administrator',
  'err.currentPwWrong': 'The current password is incorrect',
  'err.pwPolicy':
    'The password must be at least {len} characters and contain at least {spec} special character(s)',
  'err.pwMinLen': 'The password must be at least {len} characters',
  'err.pwMinSpec': 'The password must contain at least {spec} special character(s)',
  'err.noPhotoFile': 'No photo file was sent',
  'err.photoTooBig': 'The photo must be {mb}MB or smaller',
  'err.photoType': 'Only PNG, JPG, GIF and WEBP images can be uploaded',
  'err.noPhoto': 'There is no photo',
  'err.tooManyAttempts': 'Too many attempts. Please try again in {min} minutes',
  'err.csrf': 'Invalid request. Please reload the page and try again',

  'err.jamesUnreachable': 'Cannot reach the mail server management service. Please try again later',
  'err.jamesRouteMissing':
    'The mail server does not support this feature. Please contact your administrator',
  'err.jamesFailed': 'The mail server could not process the request',
  'err.sieveRouteMissing':
    'The mail server does not support saving rules. Please contact your administrator',
  'err.sieveSaveFailed': 'Failed to save the rules. Please check your input',

  'err.noLogoFile': 'No logo file was sent',
  'err.imageOnly': 'Only image files can be uploaded',
  'err.logoTooBig': 'The logo must be 2MB or smaller',
  'err.noLogo': 'There is no logo',
  'err.nameMin2': 'The user name must be at least 2 characters',
  'err.accountMin4': 'The account must be at least 4 characters',
  'err.accountTaken': 'That account is already taken',
  'err.userNotFound': 'That account was not found',
  'err.quotaTooSmall': 'The quota cannot be smaller than the space already used',
  'err.aliasNotFound': 'That alias was not found',
  'err.aliasMin4': 'The alias must be at least 4 characters',
  'err.aliasIsUser': 'An address that belongs to a real account cannot be used',
  'err.notMyAlias': 'You cannot send as {address}. Check whether the alias settings have changed.',

  'err.mailboxNotFound': 'That mailbox was not found',
  'err.namedBoxNotFound': 'The mailbox {name} was not found',
  'err.parentNotFound': 'The parent mailbox was not found',
  'err.pickTargetBox': 'Choose the mailbox to store it in',
  'err.targetBoxNotFound': 'The target mailbox was not found',
  'err.dotInName': 'A mailbox name cannot contain "." (it separates the hierarchy)',
  'err.systemBoxRename': 'Default mailboxes cannot be renamed',
  'err.systemBoxDelete': 'Default mailboxes cannot be deleted',
  'err.trashNotFound': 'The trash mailbox was not found',
  'err.sentBoxNotFound': 'The sent mailbox was not found',
  'err.draftBoxNotFound': 'The drafts mailbox was not found',
  'err.noMoveToDrafts': 'Messages cannot be moved into Drafts',
  'err.noCopyToDrafts': 'Messages cannot be copied into Drafts',
  'err.mailNotFound': 'That message was not found',
  'err.noReadReceiptRequest': 'This message does not ask for a read receipt',
  'err.readReceiptRejected': 'The read receipt could not be sent to {address}',
  'err.emptyMailPath': 'The path to the original message is empty',
  'err.outsideRoot': 'That path is outside the storage root',
  'err.rawFileMissing': 'The original message file is missing',
  'err.nothingToRecall': 'There is no message that can be recalled',

  'err.largeLimit': 'Large attachments can be up to {mb}MB',
  'err.attachNotFound': 'That attachment was not found',
  'err.attachSent': 'An attachment that has been sent cannot be deleted',
  'err.attachGone': 'The attachment was not found, or it is past its retention period',
  'err.attachCountLimit': 'You can attach up to {n} file(s)',
  'err.attachSizeLimit':
    'The attachments exceed the {mb}MB limit. Switch them to large attachments',
  'err.notMyLargeAttach': 'Only large attachments you uploaded yourself can be used',
  'err.badAddressTo': 'A To address is not valid: {address}',
  'err.badAddressCc': 'A Cc address is not valid: {address}',
  'err.badAddressBcc': 'A Bcc address is not valid: {address}',
  'err.needRecipient': 'Enter at least one recipient',
  'err.replyTargetNotFound': 'The message being replied to was not found',
  'err.forwardTargetNotFound': 'The message being forwarded was not found',
  'err.badSignature': 'That signature cannot be used',
  'err.signScopeOff': 'Signatures are turned off — enable them in settings',
  'err.smtpUnavailable': 'Could not reach the mail server. Please try again in a moment.',
  'err.draftFailed': 'Failed to save the draft',
  'err.appendFailed': 'Could not put it into the mailbox',
  'err.badAppointment': 'The appointment date is not valid',

  'err.badEmail': 'That is not a valid mail address',
  'err.contactEmpty': 'Enter at least a name, mail address or phone number',
  'err.groupName': 'Enter a group name',
  'err.contactPhoto': 'The photo is too large or in an unsupported format',
  'err.importTooMany': 'You can import up to 5000 contacts at a time',
  'err.importFormat': 'Only .vcf or .csv files can be imported',
  'err.badDomain': 'That is not a valid domain',
  'err.needPassword': 'Enter the password',
  'err.externalNotFound': 'That external mail account was not found',
  'err.externalHostBlocked': 'Mail cannot be fetched from this server address',
  'err.badLoginId': 'The login ID and password cannot contain line breaks',
  'err.externalRunning': 'This account is already being fetched',
  'err.dropInvalid': 'That is not a valid address or domain',
  'err.dropExists': 'It is already on the block list',
  'err.dropLimit': 'You can block up to {n} entries',
  'err.internalUserNotBlockable': 'Internal users cannot be blocked',
  'err.internalDomainNotBlockable': 'Internal domains cannot be blocked',
  'err.ruleConflict': 'The rules were saved elsewhere first. Refresh and try again',
  'err.ruleTooBig': 'There are too many rules ({bytes} bytes, limit {limit}). Please remove some',

  'warn.quotaLow': 'The mailbox of {address} is short of space, so the message may bounce.',
  'warn.partialFail': 'The message could not be delivered to some recipients: {list}',
  'warn.allFail': 'No recipient could be found, so nothing was sent: {list}',
  'warn.noticeSuffix': ' See the notification mail in your inbox for details.',
  'warn.sentCopyFailed':
    'The message was sent, but a copy could not be saved to your sent mailbox. The mail itself went out normally.',

  'mail.noSubject': '(No subject)',
  'mail.large.title': 'Large attachments',
  'mail.large.expire': 'Available for download until {date}.',
  'mail.notice.from': 'Mail delivery system',
  'mail.notice.subject': '[Delivery failed] {subject}',
  'mail.notice.intro': 'Your message <b>{subject}</b> could not be delivered to the recipients below.',
  'mail.notice.to': 'Recipient',
  'mail.notice.why': 'Reason',
  'mail.notice.reason': 'Rejected',
  'mail.notice.hint':
    'The address may be mistyped, or the account may be suspended. Please check the address.',
  'mail.notice.auto': 'This message was sent automatically by the mail system; you cannot reply to it.',

  'mail.mdn.subject': '[Read receipt] {subject}',
  'mail.mdn.body':
    '{reader} read your message "{subject}" at {when}.\n\n' +
    'This receipt was sent because you asked for one and the recipient confirmed it. ' +
    'It means the message was displayed; it does not guarantee that it was read.',

  'mailbox.INBOX': 'Inbox',
  'mailbox.Sent': 'Sent',
  'mailbox.Drafts': 'Drafts',
  'mailbox.Trash': 'Trash',
  'mailbox.Spam': 'Spam',
  'mailbox.Outbox': 'Outbox',
  'mailbox.Archive': 'Archive',

  'cal.defaultName': 'Home',
  'err.calNotFound': 'Calendar not found',
  'err.calReadonly': 'This calendar is read-only',
  'err.calItemNotFound': 'Event not found',
  'err.calBadTime': 'The date or time is not valid',
  'err.calEndBeforeStart': 'The end cannot be earlier than the start',
  'err.calBadRule': 'The repeat rule is not valid',
  'err.calBadTimezone': 'Unknown time zone',
  'err.calBadScope': 'The occurrence of the repeating event is not valid',
  'err.calBadHours': 'The end of the day must be after its start',
  'err.calBadUrl': 'Enter an http(s) or webcal address',
  'err.calFetchFailed': 'Could not download the calendar (HTTP {status})',
  'err.calParseFailed': 'Could not read the iCalendar (.ics) data',
  'err.calTooLarge': 'The calendar file is too large (up to 10MB)',
  'err.calLastCalendar': 'At least one writable calendar must remain',
  'err.calInviteFailed': 'Saved, but the invitation could not be sent',
  'err.calReplyFailed': 'Answered, but the reply to the organizer could not be sent',
  'mail.cal.untitled': '(No title)',
  'mail.cal.allDay': 'All day',
  'mail.cal.when': 'When',
  'mail.cal.where': 'Where',
  'mail.cal.organizer': 'Organizer',
  'mail.cal.attendees': 'Attendees',
  'mail.cal.description': 'Description',
  'mail.cal.inviteIntro': 'You are invited to the event below. Please answer from the calendar of your mail program.',
  'mail.cal.cancelIntro': 'The event below has been cancelled.',
  'mail.cal.cancelSubject': 'Cancelled: {title}',
  'mail.cal.updateSubject': 'Updated: {title}',
  'mail.cal.reply.ACCEPTED': 'Accepted: {title}',
  'mail.cal.reply.TENTATIVE': 'Tentative: {title}',
  'mail.cal.reply.DECLINED': 'Declined: {title}',
  'mail.cal.replyBody.ACCEPTED': '{who} has accepted the invitation "{title}".',
  'mail.cal.replyBody.TENTATIVE': '{who} has tentatively accepted the invitation "{title}".',
  'mail.cal.replyBody.DECLINED': '{who} has declined the invitation "{title}".',
};

const dict: Record<Locale, Record<string, string>> = { ko, en };

export type MessageParams = Record<string, string | number>;

/** 카탈로그에 없는 키는 그대로 돌려준다 (James 응답처럼 그때 만들어진 문장) */
export function t(locale: Locale, key: string, params?: MessageParams): string {
  const template = dict[locale]?.[key] ?? (ko as Record<string, string>)[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** 요청 로케일: 클라이언트 헤더 > 세션 > 기본값 */
export function localeOf(request: {
  headers?: Record<string, unknown>;
  session?: { locale?: Locale } | null;
}): Locale {
  const header = request.headers?.['x-locale'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === 'ko' || value === 'en') return value;
  const session = request.session?.locale;
  if (session === 'ko' || session === 'en') return session;
  return DEFAULT_LOCALE;
}
