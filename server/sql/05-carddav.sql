-- CardDAV (썬더버드 등 외부 프로그램에서 주소록 관리) · 연락처 상세 필드 · 그룹.
-- 이미 설치된 DB 에 덧붙인다. 여러 번 돌려도 된다 (MariaDB 의 IF NOT EXISTS).
-- 새로 설치할 때도 03 다음에 돌린다.
--   mysql -uroot -p james_db < server/sql/05-carddav.sql

-- 사용자가 개인 환경설정 > 주소록에서 "외부에서 주소록 관리" 를 켰는지. 끄면 /dav/addressbooks/ 를 막는다
ALTER TABLE GU_USER_SETTING
    ADD COLUMN IF NOT EXISTS CARDDAV_USE_YN CHAR(1) NOT NULL DEFAULT 'N';

-- 주소록 한 행 = vCard 한 장 (연락처 또는 그룹).
-- CONTACT_UID  : vCard UID. 외부 프로그램이 정한 값을 그대로 지켜야 다시 동기화할 때 같은 연락처로 알아본다.
--                그룹 멤버(MEMBER:urn:uuid:…)도 이 값으로 가리킨다
-- DAV_NAME     : 외부 프로그램이 정한 자원 이름(…/contacts/<이름>.vcf). NULL 이면 '<UID>.vcf'
-- CONTACT_KIND : I 개인, G 그룹(배포 리스트)
-- VCARD_DATA   : vCard 원문. 서버가 해석하지 않는 속성(X-…, 사진 등)도 그대로 돌려주려고 원문을 둔다.
--                NULL 이면(예전 행) 이름 · 메일로 만들어 준다
-- CONTACT_NAME · MAIL_ADDRESS · ORG_NAME · PHONE : 원문에서 뽑은 목록 · 검색용 값. MAIL_ADDRESS 는 대표 메일
-- UPDATE_DATE  : ETag · CTag 의 바탕. 내용이 바뀔 때만 고친다(사용 횟수 · 최종 사용시각은 건드리지 않는다).
--                초 단위면 1초 안에 두 번 고친 것을 놓친다
ALTER TABLE GU_ADDRESS_BOOK
    ADD COLUMN IF NOT EXISTS CONTACT_UID  VARCHAR(255) NULL AFTER USER_NAME,
    ADD COLUMN IF NOT EXISTS DAV_NAME     VARCHAR(255) NULL AFTER CONTACT_UID,
    ADD COLUMN IF NOT EXISTS CONTACT_KIND CHAR(1)      NOT NULL DEFAULT 'I' AFTER DAV_NAME,
    ADD COLUMN IF NOT EXISTS ORG_NAME     VARCHAR(255) NULL AFTER MAIL_ADDRESS,
    ADD COLUMN IF NOT EXISTS PHONE        VARCHAR(100) NULL AFTER ORG_NAME,
    ADD COLUMN IF NOT EXISTS VCARD_DATA   MEDIUMTEXT   NULL AFTER PHONE,
    MODIFY MAIL_ADDRESS VARCHAR(255) NULL,
    MODIFY UPDATE_DATE  DATETIME(3)  NULL;

UPDATE GU_ADDRESS_BOOK SET CONTACT_UID = UUID() WHERE CONTACT_UID IS NULL;
UPDATE GU_ADDRESS_BOOK SET UPDATE_DATE = REG_DATE WHERE UPDATE_DATE IS NULL;

-- 메일이 없는 연락처 · 같은 메일을 가진 연락처 둘 · 메일이 여러 개인 연락처가 모두 있을 수 있으므로
-- (사용자, 메일) 유일 키를 풀고 (사용자, UID) 를 유일하게 한다
ALTER TABLE GU_ADDRESS_BOOK
    MODIFY CONTACT_UID VARCHAR(255) NOT NULL,
    MODIFY UPDATE_DATE DATETIME(3)  NOT NULL,
    DROP INDEX IF EXISTS UX_ADDRESS_BOOK,
    ADD UNIQUE INDEX IF NOT EXISTS UX_ADDRESS_BOOK_UID (USER_NAME, CONTACT_UID),
    ADD INDEX IF NOT EXISTS IDX_ADDRESS_BOOK_MAIL (USER_NAME, MAIL_ADDRESS),
    ADD INDEX IF NOT EXISTS IDX_ADDRESS_BOOK_DAV (USER_NAME, DAV_NAME);

-- 연락처의 메일 주소 전부 (대표 메일 포함). 자동완성 · 이름 찾기 · 발송 시 수집이 이 표로 찾는다.
-- 원문(VCARD_DATA)을 쓸 때마다 다시 만든다
CREATE TABLE IF NOT EXISTS GU_ADDRESS_EMAIL (
    ADDRESS_ID   BIGINT       NOT NULL,
    SORT_ORDER   INTEGER      NOT NULL,
    USER_NAME    VARCHAR(100) NOT NULL,
    MAIL_ADDRESS VARCHAR(255) NOT NULL,
    PRIMARY KEY (ADDRESS_ID, SORT_ORDER),
    KEY IDX_ADDRESS_EMAIL_MAIL (USER_NAME, MAIL_ADDRESS)
) ENGINE = innodb DEFAULT CHARSET = utf8mb4;

INSERT IGNORE INTO GU_ADDRESS_EMAIL (ADDRESS_ID, SORT_ORDER, USER_NAME, MAIL_ADDRESS)
SELECT ADDRESS_ID, 0, USER_NAME, MAIL_ADDRESS
FROM GU_ADDRESS_BOOK
WHERE MAIL_ADDRESS IS NOT NULL;
