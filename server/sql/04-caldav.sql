-- CalDAV (썬더버드 등 외부 캘린더 프로그램에서 일정 관리). 이미 설치된 DB 에 덧붙인다.
-- 여러 번 돌려도 된다 (MariaDB 의 IF NOT EXISTS). 새로 설치할 때도 03 · 06 다음에 돌린다.

-- 사용자가 개인 정보 관리에서 "외부에서 일정 관리 사용" 을 켰는지. 끄면 /dav/ 접속을 막는다
ALTER TABLE GU_USER_SETTING
    ADD COLUMN IF NOT EXISTS CALDAV_USE_YN CHAR(1) NOT NULL DEFAULT 'N';

-- DAV_NAME     : 외부 프로그램이 정한 자원 이름(…/123/<이름>.ics). NULL 이면 '<UID>.ics'
-- EXTRA_PROPS  : 외부 프로그램이 붙인 X- 속성 원문(줄바꿈으로 묶는다). 썬더버드의 알림 확인 시각
--                (X-MOZ-LASTACK) · 다시 알림(X-MOZ-SNOOZE-TIME) 이 빠지면 알림이 계속 다시 뜬다
ALTER TABLE CAL_ITEM
    ADD COLUMN IF NOT EXISTS DAV_NAME VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS EXTRA_PROPS MEDIUMTEXT NULL;

-- ETag · CTag 를 수정 시각으로 만든다. 초 단위면 1초 안에 두 번 고친 것을 놓친다
ALTER TABLE CAL_ITEM MODIFY UPDATE_DATE DATETIME(3) NOT NULL;

CREATE INDEX IF NOT EXISTS IX_CAL_ITEM_DAV ON CAL_ITEM (CALENDAR_ID, DAV_NAME);
