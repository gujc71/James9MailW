-- 캘린더 · 태스크 (썬더버드 캘린더 기능). 테이블 이름은 모두 CAL_ 로 시작한다.
-- GU_ 테이블과 같이 웹서버만 읽고 쓴다. James 테이블을 가리키는 FK 는 걸지 않는다 (01-gu-tables.sql 머리말).
--
-- 시각은 두 가지로 둔다.
--   *_LOCAL : 일정이 정해진 시간대(TZID)의 벽시계 'YYYY-MM-DDTHH:mm', 종일이면 'YYYY-MM-DD'.
--             반복 규칙(RRULE)은 벽시계 기준으로 펼쳐야 서머타임이 있어도 "매주 월 9시" 가 9시로 남는다.
--   *_UTC   : 기간 조회용으로 미리 풀어 둔 값. 쓸 때마다 서버가 다시 계산한다.

CREATE TABLE IF NOT EXISTS CAL_CALENDAR (
    CALENDAR_ID   BIGINT        NOT NULL AUTO_INCREMENT,
    USER_NAME     VARCHAR(100)  NOT NULL,
    CAL_NAME      VARCHAR(100)  NOT NULL,
    CAL_COLOR     VARCHAR(9)    NOT NULL,              -- #RRGGBB
    CAL_TYPE      VARCHAR(10)   NOT NULL,              -- LOCAL 내 캘린더, ICS 네트워크 구독(읽기 전용)
    SOURCE_URL    VARCHAR(1000),                       -- ICS 구독 주소
    REFRESH_MIN   INTEGER       NOT NULL DEFAULT 60,   -- ICS 새로 고침 간격(분)
    LAST_SYNC     DATETIME(0),
    SYNC_ERROR    VARCHAR(500),
    VISIBLE_YN    CHAR(1)       NOT NULL DEFAULT 'Y',
    READONLY_YN   CHAR(1)       NOT NULL DEFAULT 'N',
    ALARM_YN      CHAR(1)       NOT NULL DEFAULT 'Y',  -- 이 캘린더의 알림을 띄울지
    DEFAULT_YN    CHAR(1)       NOT NULL DEFAULT 'N',  -- 새 일정 · 초대 수락이 들어갈 캘린더
    FEED_TOKEN    VARCHAR(64),                         -- 게시(구독 주소) 토큰. NULL 이면 게시 안 함
    SORT_ORDER    INTEGER       NOT NULL DEFAULT 0,
    REG_DATE      DATETIME(0)   NOT NULL,
    UPDATE_DATE   DATETIME(0)   NOT NULL,
    PRIMARY KEY (CALENDAR_ID),
    KEY IX_CAL_CALENDAR_USER (USER_NAME),
    UNIQUE KEY UX_CAL_CALENDAR_FEED (FEED_TOKEN)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_ITEM (
    ITEM_ID        VARCHAR(36)   NOT NULL,             -- uuidv7
    CALENDAR_ID    BIGINT        NOT NULL,
    USER_NAME      VARCHAR(100)  NOT NULL,
    ITEM_TYPE      CHAR(1)       NOT NULL,             -- E 이벤트(VEVENT), T 태스크(VTODO)
    ICAL_UID       VARCHAR(255)  NOT NULL,
    PARENT_ID      VARCHAR(36),                        -- 반복 일정의 예외 회차면 원본 ITEM_ID
    RECURRENCE_ID  VARCHAR(16),                        -- 예외 회차가 원래 있던 자리 (원본 TZID 벽시계)
    TITLE          VARCHAR(500)  NOT NULL,
    LOCATION       VARCHAR(500),
    DESCRIPTION    MEDIUMTEXT,
    ITEM_URL       VARCHAR(1000),
    ALL_DAY_YN     CHAR(1)       NOT NULL DEFAULT 'N',
    TZID           VARCHAR(64)   NOT NULL,
    START_LOCAL    VARCHAR(16),
    END_LOCAL      VARCHAR(16),                        -- 종일이면 마지막 날의 다음 날 (iCalendar DTEND 와 같다)
    DUE_LOCAL      VARCHAR(16),                        -- 태스크 기한
    START_UTC      DATETIME(0),                        -- 태스크는 시작 또는 기한
    END_UTC        DATETIME(0),
    RANGE_END_UTC  DATETIME(0),                        -- 반복까지 포함한 마지막 끝. NULL 이면 끝이 없다
    COMPLETED_DATE DATETIME(0),
    PERCENT_DONE   INTEGER       NOT NULL DEFAULT 0,
    STATUS         VARCHAR(12),                        -- TENTATIVE CONFIRMED CANCELLED / NEEDS-ACTION IN-PROCESS COMPLETED
    PRIORITY       INTEGER       NOT NULL DEFAULT 0,   -- 0 지정 안 함, 1 높음, 5 보통, 9 낮음
    PRIVACY        VARCHAR(12)   NOT NULL DEFAULT 'PUBLIC',  -- PUBLIC PRIVATE CONFIDENTIAL
    TRANSP         VARCHAR(12)   NOT NULL DEFAULT 'OPAQUE',  -- OPAQUE 바쁨, TRANSPARENT 한가함
    RRULE          VARCHAR(500),
    EXDATES        TEXT,                               -- 빠진 회차 (원본 TZID 벽시계), 쉼표로 묶는다
    CATEGORIES     VARCHAR(1000),                      -- 쉼표로 묶는다
    ORGANIZER      VARCHAR(255),
    SEQUENCE_NO    INTEGER       NOT NULL DEFAULT 0,
    REG_DATE       DATETIME(0)   NOT NULL,
    UPDATE_DATE    DATETIME(0)   NOT NULL,
    PRIMARY KEY (ITEM_ID),
    KEY IX_CAL_ITEM_RANGE (USER_NAME, START_UTC),
    KEY IX_CAL_ITEM_CALENDAR (CALENDAR_ID),
    KEY IX_CAL_ITEM_UID (USER_NAME, ICAL_UID),
    KEY IX_CAL_ITEM_PARENT (PARENT_ID)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_ATTENDEE (
    ITEM_ID     VARCHAR(36)  NOT NULL,
    EMAIL       VARCHAR(255) NOT NULL,
    ATT_NAME    VARCHAR(255),
    ATT_ROLE    VARCHAR(20)  NOT NULL DEFAULT 'REQ-PARTICIPANT',  -- REQ-PARTICIPANT OPT-PARTICIPANT NON-PARTICIPANT CHAIR
    PARTSTAT    VARCHAR(20)  NOT NULL DEFAULT 'NEEDS-ACTION',     -- NEEDS-ACTION ACCEPTED TENTATIVE DECLINED
    RSVP_YN     CHAR(1)      NOT NULL DEFAULT 'Y',
    PRIMARY KEY (ITEM_ID, EMAIL)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_ALARM (
    ALARM_ID    BIGINT       NOT NULL AUTO_INCREMENT,
    ITEM_ID     VARCHAR(36)  NOT NULL,
    OFFSET_MIN  INTEGER      NOT NULL,                 -- 기준 시각보다 몇 분 앞에 울릴지. 음수면 뒤
    RELATED     CHAR(1)      NOT NULL DEFAULT 'S',     -- S 시작 기준, E 끝(태스크는 기한) 기준
    PRIMARY KEY (ALARM_ID),
    KEY IX_CAL_ALARM_ITEM (ITEM_ID)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

-- 회차별 알림 상태. 반복 일정은 회차마다 따로 울리고 따로 끈다
CREATE TABLE IF NOT EXISTS CAL_ALARM_STATE (
    ALARM_ID     BIGINT       NOT NULL,
    OCCUR_KEY    VARCHAR(16)  NOT NULL,                -- 회차 시작 (원본 TZID 벽시계)
    SNOOZE_UNTIL DATETIME(0),                          -- 다시 알림 시각(UTC). NULL 이면 다시 알림 없음
    DISMISSED_YN CHAR(1)      NOT NULL DEFAULT 'N',
    UPDATE_DATE  DATETIME(0)  NOT NULL,
    PRIMARY KEY (ALARM_ID, OCCUR_KEY)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_ATTACH (
    ATTACH_ID   BIGINT        NOT NULL AUTO_INCREMENT,
    ITEM_ID     VARCHAR(36)   NOT NULL,
    ATTACH_URL  VARCHAR(1000) NOT NULL,
    ATTACH_NAME VARCHAR(255),
    PRIMARY KEY (ATTACH_ID),
    KEY IX_CAL_ATTACH_ITEM (ITEM_ID)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_CATEGORY (
    USER_NAME      VARCHAR(100) NOT NULL,
    CATEGORY_NAME  VARCHAR(100) NOT NULL,
    CATEGORY_COLOR VARCHAR(9),
    SORT_ORDER     INTEGER      NOT NULL DEFAULT 0,
    PRIMARY KEY (USER_NAME, CATEGORY_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS CAL_SETTING (
    USER_NAME          VARCHAR(100) NOT NULL,
    TIMEZONE           VARCHAR(64)  NOT NULL,          -- 화면 시간대 (IANA)
    WEEK_START         INTEGER      NOT NULL DEFAULT 0,-- 0 일요일 … 6 토요일
    DAYS_OFF           VARCHAR(20)  NOT NULL DEFAULT '0,6',
    DAY_START_HOUR     INTEGER      NOT NULL DEFAULT 8,
    DAY_END_HOUR       INTEGER      NOT NULL DEFAULT 17,
    VISIBLE_HOURS      INTEGER      NOT NULL DEFAULT 12,
    MULTIWEEK_COUNT    INTEGER      NOT NULL DEFAULT 4,
    PREV_WEEKS         INTEGER      NOT NULL DEFAULT 0,  -- 여러 주 보기에서 앞에 둘 지난 주 수
    WEEKNUM_YN         CHAR(1)      NOT NULL DEFAULT 'Y',
    DEFAULT_LENGTH_MIN INTEGER      NOT NULL DEFAULT 60,
    DEFAULT_ALARM_MIN  INTEGER      NOT NULL DEFAULT -1, -- -1 알림 없음
    ALARM_SOUND_YN     CHAR(1)      NOT NULL DEFAULT 'Y',
    ALARM_POPUP_YN     CHAR(1)      NOT NULL DEFAULT 'Y',
    MISSED_ALARM_YN    CHAR(1)      NOT NULL DEFAULT 'Y',
    UPDATE_DATE        DATETIME(0)  NOT NULL,
    PRIMARY KEY (USER_NAME)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;
