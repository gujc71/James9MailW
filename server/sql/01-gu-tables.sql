-- 웹 전용 테이블. web.md 2~10 절 + webmail-architecture.md 2.4(툼스톤) + webmail-issues.md 7-9(감사로그).
-- James 테이블은 건드리지 않는다. OpenJPA buildSchema 가 James 스키마를 재생성하므로
-- James 테이블을 가리키는 FK 도 걸지 않는다 (web.md 9 절).

-- ---------------------------------------------------------------- 2. 사이트 / 사용자

CREATE TABLE IF NOT EXISTS GU_SITE_CONFIG (
    CONFIG_ID          INTEGER      NOT NULL,          -- 항상 1
    SITE_NAME          VARCHAR(100) NOT NULL,
    SITE_LOGO_PATH     VARCHAR(512),
    SITE_THEME         VARCHAR(1000),     -- 강조색 토큰 JSON. 기본값과 같은 항목은 담지 않는다
    ATTACH_MAX_SIZE    BIGINT       NOT NULL,          -- 일반 첨부 총용량 제한, 바이트
    ATTACH_MAX_COUNT   INTEGER      NOT NULL,
    LARGE_MAX_SIZE     BIGINT       NOT NULL,
    LARGE_KEEP_DAYS    INTEGER      NOT NULL,
    PASSWORD_MIN_LEN   INTEGER      NOT NULL,
    PASSWORD_MIN_SPEC  INTEGER      NOT NULL,
    UPDATE_DATE        DATETIME(0)  NOT NULL,
    PRIMARY KEY (CONFIG_ID)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS GU_USER_SETTING (
    USER_NAME        VARCHAR(100) NOT NULL,
    LIST_PAGE_SIZE   INTEGER      NOT NULL,
    SEND_CONFIRM_YN  CHAR(1)      NOT NULL,
    SIGN_POSITION    CHAR(1)      NOT NULL,            -- 안 씀: 서명 위치 선택 폐기 후 남은 컬럼, 늘 B
    COMPANY_SIGN_YN  CHAR(1)      NOT NULL,            -- 안 씀: 전사 서명 폐기 후 남은 컬럼, 늘 N
    PERSONAL_SIGN_YN CHAR(1)      NOT NULL,
    VCARD_YN         CHAR(1)      NOT NULL,
    REJECT_USE_YN    CHAR(1)      NOT NULL,
    VACATION_USE_YN  CHAR(1)      NOT NULL,
    FORWARD_USE_YN   CHAR(1)      NOT NULL,
    UPDATE_DATE      DATETIME(0),
    PRIMARY KEY (USER_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 3. 서명

CREATE TABLE IF NOT EXISTS GU_SIGNATURE (
    SIGNATURE_ID BIGINT       NOT NULL AUTO_INCREMENT,
    USER_NAME    VARCHAR(100),                         -- 서명 주인. 폐기된 전사 서명 행만 null 이다
    SIGN_SCOPE   CHAR(1)      NOT NULL,                -- 안 씀: 전사 서명 폐기 후 남은 컬럼, 새 행은 늘 P
    SIGN_NAME    VARCHAR(100) NOT NULL,
    SIGN_CONTENT MEDIUMTEXT   NOT NULL,
    IS_DEFAULT   CHAR(1)      NOT NULL,
    SORT_ORDER   INTEGER      NOT NULL,
    REG_DATE     DATETIME(0)  NOT NULL,
    UPDATE_DATE  DATETIME(0),
    PRIMARY KEY (SIGNATURE_ID),
    KEY IDX_SIGNATURE_USER (USER_NAME, SIGN_SCOPE, SORT_ORDER)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 4. 주소록

CREATE TABLE IF NOT EXISTS GU_ADDRESS_BOOK (
    ADDRESS_ID   BIGINT       NOT NULL AUTO_INCREMENT,
    USER_NAME    VARCHAR(100) NOT NULL,
    CONTACT_NAME VARCHAR(100),
    MAIL_ADDRESS VARCHAR(255) NOT NULL,
    USE_COUNT    INTEGER      NOT NULL,
    LAST_USED_AT DATETIME(0),
    REG_DATE     DATETIME(0)  NOT NULL,
    UPDATE_DATE  DATETIME(0),
    PRIMARY KEY (ADDRESS_ID),
    UNIQUE UX_ADDRESS_BOOK (USER_NAME, MAIL_ADDRESS),
    KEY IDX_ADDRESS_BOOK_NAME   (USER_NAME, CONTACT_NAME),
    KEY IDX_ADDRESS_BOOK_RECENT (USER_NAME, LAST_USED_AT)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ------------------------------------------------- 4-1. 최근 발송 주소 (주소록과 별개)

-- 메일쓰기의 "최근에 발송한 계정 10개" 드롭다운용. 주소록은 외부 주소만 모으지만(USR-1.4)
-- 이 표는 내부·외부를 가리지 않고 최근에 보낸 주소를 주소당 한 행으로 남긴다.
CREATE TABLE IF NOT EXISTS GU_RECENT_RECIPIENT (
    RECENT_ID    BIGINT       NOT NULL AUTO_INCREMENT,
    USER_NAME    VARCHAR(100) NOT NULL,
    CONTACT_NAME VARCHAR(100),
    MAIL_ADDRESS VARCHAR(255) NOT NULL,
    LAST_USED_AT DATETIME(0)  NOT NULL,
    PRIMARY KEY (RECENT_ID),
    UNIQUE UX_RECENT_RECIPIENT (USER_NAME, MAIL_ADDRESS),
    KEY IDX_RECENT_RECIPIENT_USED (USER_NAME, LAST_USED_AT)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 5. 외부메일 가져오기

CREATE TABLE IF NOT EXISTS GU_EXTERNAL_EMAIL (
    EXTERNAL_ID       BIGINT       NOT NULL AUTO_INCREMENT,
    USER_NAME         VARCHAR(100) NOT NULL,
    EXTERNAL_NAME     VARCHAR(100) NOT NULL,
    SERVER_HOST       VARCHAR(255) NOT NULL,
    SERVER_PORT       INTEGER      NOT NULL,
    PROTOCOL          VARCHAR(4)   NOT NULL,           -- POP3, IMAP
    SECURITY_TYPE     VARCHAR(5)   NOT NULL,           -- PLAIN, SSL
    LOGIN_ID          VARCHAR(255) NOT NULL,
    LOGIN_PASSWD      VARCHAR(512) NOT NULL,           -- AES-256-GCM 암호화 저장
    TARGET_MAILBOX_ID VARCHAR(36)  NOT NULL,
    LAST_RUN_AT       DATETIME(0),
    REG_DATE          DATETIME(0)  NOT NULL,
    UPDATE_DATE       DATETIME(0),
    PRIMARY KEY (EXTERNAL_ID),
    KEY IDX_EXTERNAL_EMAIL_USER (USER_NAME, REG_DATE)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS GU_EXTERNAL_EMAIL_LOG (
    LOG_ID      BIGINT      NOT NULL AUTO_INCREMENT,
    EXTERNAL_ID BIGINT      NOT NULL,
    START_TIME  DATETIME(0) NOT NULL,
    END_TIME    DATETIME(0),
    MAIL_COUNT  INTEGER     NOT NULL,
    RUN_STATUS  VARCHAR(10) NOT NULL,                  -- RUNNING, DONE, FAIL
    ERROR_MSG   VARCHAR(500),
    PRIMARY KEY (LOG_ID),
    KEY IDX_EXTERNAL_LOG_ACCOUNT (EXTERNAL_ID, START_TIME),
    CONSTRAINT FK_EXTERNAL_LOG FOREIGN KEY (EXTERNAL_ID)
        REFERENCES GU_EXTERNAL_EMAIL (EXTERNAL_ID) ON DELETE CASCADE
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 6. 업로드 / 대용량 첨부 / 약속메일

CREATE TABLE IF NOT EXISTS GU_MAIL_UPLOAD (
    UPLOAD_ID    BIGINT       NOT NULL AUTO_INCREMENT,
    USER_NAME    VARCHAR(100) NOT NULL,
    MAILBOX_ID   VARCHAR(36)  NOT NULL,
    MAILBOX_NAME VARCHAR(200) NOT NULL,                -- 실행 시점 이름, 이후 바뀔 수 있다
    FILE_COUNT   INTEGER      NOT NULL,
    DONE_COUNT   INTEGER      NOT NULL,
    RUN_STATUS   VARCHAR(10)  NOT NULL,
    RUN_DATE     DATETIME(0)  NOT NULL,
    PRIMARY KEY (UPLOAD_ID),
    KEY IDX_MAIL_UPLOAD_USER (USER_NAME, RUN_DATE)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS GU_LARGE_ATTACH (
    ATTACH_ID    VARCHAR(36)  NOT NULL,                -- uuid, 다운로드 토큰 겸용
    MAIL_ID      VARCHAR(36),                          -- 발송 전에는 null
    USER_NAME    VARCHAR(100) NOT NULL,
    FILE_NAME    VARCHAR(500) NOT NULL,
    FILE_SIZE    BIGINT       NOT NULL,
    FILE_PATH    VARCHAR(512) NOT NULL,                -- 대용량 첨부 루트 기준 상대경로
    CONTENT_TYPE VARCHAR(100),
    DOWN_COUNT   INTEGER      NOT NULL,
    EXPIRE_DATE  DATETIME(0)  NOT NULL,
    REG_DATE     DATETIME(0)  NOT NULL,
    PRIMARY KEY (ATTACH_ID),
    KEY IDX_LARGE_ATTACH_MAIL   (MAIL_ID),
    KEY IDX_LARGE_ATTACH_EXPIRE (EXPIRE_DATE)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS GU_CALENDAR_RESPONSE (
    MAIL_ID       VARCHAR(36)  NOT NULL,
    USER_NAME     VARCHAR(100) NOT NULL,
    RESPONSE_TYPE VARCHAR(10)  NOT NULL,               -- ACCEPT, TENTATIVE, DECLINE, APPLIED(받은 REPLY 를 캘린더에 반영함)
    RESPONSE_DATE DATETIME(0)  NOT NULL,
    PRIMARY KEY (MAIL_ID, USER_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 7. 알리아스

CREATE TABLE IF NOT EXISTS GU_MAIL_ALIAS (
    ALIAS_USER   VARCHAR(100) NOT NULL,
    ALIAS_DOMAIN VARCHAR(100) NOT NULL,
    ALIAS_NAME   VARCHAR(100) NOT NULL,
    ALIAS_STATUS CHAR(1)      NOT NULL,                -- Y 사용, N 중지
    REG_DATE     DATETIME(0)  NOT NULL,
    UPDATE_DATE  DATETIME(0),
    PRIMARY KEY (ALIAS_DOMAIN, ALIAS_USER),
    KEY IDX_MAIL_ALIAS_NAME (ALIAS_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- 등록된 실제 계정은 JAMES_RECIPIENT_REWRITE 가 그대로 들고 있다. 중지해도 행을 지우지 않고
-- 그 표의 ALIAS_STATUS 만 'N' 으로 바꾼다 — james9Mail 의 JPARecipientRewrite 가 배달 경로에서
-- 그 행을 건너뛴다. 컬럼은 OpenJPA buildSchema 가 만든다 (webmail-issues.md 7-4).

-- ---------------------------------------------------------------- 동기화 보조 (webmail-architecture.md 2.4)

-- James 는 expunge 시 JAMES_MAIL_OWNER 행을 하드 삭제하므로 MODSEQ 커서에 잡히지 않는다.
-- 커스텀 MailboxListener 가 이 표에 삭제 사실을 남긴다. 없으면 클라이언트에 유령 메일이 남는다.
CREATE TABLE IF NOT EXISTS GU_MESSAGE_TOMBSTONE (
    SEQ        BIGINT      NOT NULL AUTO_INCREMENT,
    MAILBOX_ID VARCHAR(36) NOT NULL,
    MAIL_UID   BIGINT      NOT NULL,
    MAIL_ID    VARCHAR(36) NOT NULL,                   -- 이동 시 새 UID 와 묶는 데 사용
    DELETED_AT DATETIME(6) NOT NULL,
    PRIMARY KEY (SEQ),
    KEY IDX_TOMBSTONE_MB_SEQ (MAILBOX_ID, SEQ),
    KEY IDX_TOMBSTONE_DELETED (DELETED_AT)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- 보관기간(30일)이 지나 잘라낸 마지막 SEQ. 이보다 오래된 커서로 동기화 요청이 오면
-- 클라이언트가 전체 재동기화해야 하므로 HTTP 410 을 돌려준다.
CREATE TABLE IF NOT EXISTS GU_SYNC_MARKER (
    MARKER_KEY VARCHAR(50) NOT NULL,
    MARKER_VAL BIGINT      NOT NULL,
    PRIMARY KEY (MARKER_KEY)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 관리자 감사 (webmail-issues.md 7-9)

CREATE TABLE IF NOT EXISTS GU_ADMIN_AUDIT (
    AUDIT_ID    BIGINT       NOT NULL AUTO_INCREMENT,
    ADMIN_NAME  VARCHAR(100) NOT NULL,
    ACTION      VARCHAR(50)  NOT NULL,
    TARGET      VARCHAR(500),
    REMOTE_ADDR VARCHAR(64),
    REG_DATE    DATETIME(0)  NOT NULL,
    PRIMARY KEY (AUDIT_ID),
    KEY IDX_ADMIN_AUDIT_DATE (REG_DATE)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 수신확인 요청(MDN) 응답 (feature-gap.md 4-4)

-- 받은 메일의 Disposition-Notification-To 요청에 "읽었다" 회신(MDN)을 보낸 기록.
-- 한 통을 여러 번 열어도 회신은 한 번만 나가야 하므로 (MAIL_ID, USER_NAME) 으로 막는다.
-- JAMES_MAIL_RECEIPT(내부 전용 수신확인)와는 방향이 반대인 별개의 표다 — 그쪽은 내가
-- 보낸 메일을 남이 읽었는지이고, 이쪽은 남이 보낸 메일을 내가 읽었다고 알려 준 기록이다.
CREATE TABLE IF NOT EXISTS GU_MDN_SENT (
    MAIL_ID   VARCHAR(36)  NOT NULL,
    USER_NAME VARCHAR(100) NOT NULL,
    SENT_TO   VARCHAR(320) NOT NULL,                   -- 회신을 보낸 주소 (요청 헤더의 값)
    SENT_DATE DATETIME(0)  NOT NULL,
    PRIMARY KEY (MAIL_ID, USER_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- 기존 설치용 컬럼 추가
-- 01 은 여러 번 돌려도 되어야 하므로 information_schema 로 있는지 보고 붙인다.
-- MySQL 8 은 ADD COLUMN IF NOT EXISTS 를 받지 않는다.

SET @sql := (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GU_SITE_CONFIG' AND COLUMN_NAME = 'SITE_THEME') = 0,
    'ALTER TABLE GU_SITE_CONFIG ADD COLUMN SITE_THEME VARCHAR(1000) NULL AFTER SITE_LOGO_PATH',
    'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE JAMES_USER ADD IS_ADMIN CHAR(1);
ALTER TABLE JAMES_USER ADD USER_DISPLAY_NAME varchar(30) ;
ALTER TABLE JAMES_USER ADD USER_PHOTO varchar(50) ;
ALTER TABLE JAMES_USER ADD USER_DATE datetime; 
