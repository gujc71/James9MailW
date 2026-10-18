-- web.md 10 절 초기 데이터

INSERT IGNORE INTO GU_SITE_CONFIG
    (CONFIG_ID, SITE_NAME, SITE_LOGO_PATH,
     ATTACH_MAX_SIZE, ATTACH_MAX_COUNT, LARGE_MAX_SIZE, LARGE_KEEP_DAYS,
     PASSWORD_MIN_LEN, PASSWORD_MIN_SPEC, UPDATE_DATE)
VALUES
    (1, 'James9Mail', NULL,
     31457280, 10, 104857600, 30,
     8, 2, NOW());

-- 신규 계정의 기본 편지함 용량(1GB). USER / DOMAIN 행이 없는 계정에는 이 GLOBAL 행이 적용된다.
INSERT IGNORE INTO JAMES_QUOTA_LIMIT (QUOTA_SCOPE, IDENTIFIER, QUOTA_TYPE, QUOTA_LIMIT)
VALUES ('GLOBAL', 'default_key', 'SIZE', 1073741824);

INSERT IGNORE INTO GU_SYNC_MARKER (MARKER_KEY, MARKER_VAL) VALUES ('tombstone_pruned_seq', 0);

-- ================================================================ 계정 시드
-- admin / user1 / user2 계정과 각 계정의 기본 편지함.
-- James 테이블(JAMES_USER / JAMES_MAILBOX)에 직접 넣지만 웹 전용 컬럼과 값 형식은
-- JPAUser / 실제 스키마와 같게 맞췄다. 재실행해도 중복되지 않도록 IGNORE / NOT EXISTS 로 감쌌다.

-- 발신/수신 도메인. 이미 있으면 무시된다.
INSERT IGNORE INTO JAMES_DOMAIN (DOMAIN_NAME) VALUES ('example.com');

-- ---------------------------------------------------------------- 1. 계정
--   USER_NAME  : full address. 이 값이 곧 비밀번호 해시의 salt 다.
--   PASSWORD   : 평문을 PBKDF2-SHA512(iter=1000, keySize=512bit) 로 해시한 뒤 base64.
--                James MimeUtility 처럼 76자마다 CRLF 를 넣고 끝에도 CRLF 를 붙인다
--                (server/src/auth/password.ts 의 hashPassword 와 동일한 규칙).
--                세 계정 모두 평문 비밀번호는 TEST1234 다.
--   IS_ADMIN   : 'Y' 면 관리자 화면 접근 가능.
--   USER_STATUS: 'Y' 사용(로그인 가능). NULL 도 사용으로 취급되지만 명시한다.
-- 계정이 이미 있으면 IGNORE 로 건너뛰면 예전 비밀번호가 남으므로, 인증에 쓰이는 컬럼만
-- 덮어써서 재실행할 때마다 위 비밀번호로 맞춘다. 표시 이름·등록일은 손대지 않는다.
INSERT INTO JAMES_USER
    (USER_NAME, PASSWORD_HASH_ALGORITHM, PASSWORD, version,
     IS_ADMIN, USER_DISPLAY_NAME, USER_DATE, USER_STATUS)
VALUES
    ('admin@example.com', 'PBKDF2-SHA512',
     CONCAT('sGNoD525NNkQUkq6mtdfgGI21HTEqN9dhjCEyevoO5gLP+g2ygs0t5gqNo1fln+eWJ3aLB+eKFX2',
            CHAR(13, 10), 'fWmpKBTOhg==', CHAR(13, 10)),
     1, 'Y', '관리자', NOW(), 'Y'),
    ('user1@example.com', 'PBKDF2-SHA512',
     CONCAT('HYq+D0n+6qjMOB8eXFTlTKeYCbYFQGyKMauL0WcvPAmlAI/2PhbT02WdaapZY8bWhAhFKyaJdc3c',
            CHAR(13, 10), 'rexMfnRazA==', CHAR(13, 10)),
     1, 'N', '사용자1', NOW(), 'Y'),
    ('user2@example.com', 'PBKDF2-SHA512',
     CONCAT('MJhGBP9dnOkiXJ+SGSsR7qYC0U1xU3YtOlsJH8L+mYfZsp3/IAjDScK6h/lo46woTfuPn+f0RYtT',
            CHAR(13, 10), 'LiCu3W4dkg==', CHAR(13, 10)),
     1, 'N', '사용자2', NOW(), 'Y')
ON DUPLICATE KEY UPDATE
    PASSWORD                = VALUES(PASSWORD),
    PASSWORD_HASH_ALGORITHM = VALUES(PASSWORD_HASH_ALGORITHM),
    IS_ADMIN                = VALUES(IS_ADMIN),
    USER_STATUS             = VALUES(USER_STATUS);

-- ---------------------------------------------------------------- 2. 기본 편지함
-- 요청은 INBOX / Sent / Draft / Trash / Junk 였으나, 이 시스템은 편지함 역할(임시 저장,
-- 스팸 이동 등)을 이름으로 판별하므로(repositories/mailboxes.ts SYSTEM_MAILBOXES) 실제
-- 인식하는 이름인 Drafts / Spam 으로 만든다. 화면에는 "임시 보관함 / 스팸 편지함"으로 표시된다.
--   MAILBOX_NAMESPACE   : #private  (개인 네임스페이스)
--   MAILBOX_UID_VALIDITY: 편지함마다 서로 다른 임의의 양수 (IMAP 재검증용)
--   *_UID / *_MODSEQ / *_COUNT / *_SIZE : 빈 편지함이므로 0
--   MAILBOX_ORDER       : 트리 표시 순서 1..5
--   MAILBOX_TYPE        : 'b' 기본 편지함
INSERT INTO JAMES_MAILBOX
    (MAILBOX_ID, MAILBOX_NAME, MAILBOX_NAMESPACE, USER_NAME,
     MAILBOX_UID_VALIDITY, MAILBOX_LAST_UID, MAILBOX_HIGHEST_MODSEQ,
     MAILBOX_MESSAGE_COUNT, MAILBOX_SIZE, MAILBOX_ORDER, MAILBOX_TYPE)
SELECT * FROM (
    SELECT 'efa54949-345b-49aa-85ee-90beaa297418' AS id, 'INBOX'  AS nm, '#private' AS ns, 'admin@example.com' AS un,
           4117944702 AS uv, 0 AS luid, 0 AS modseq, 0 AS cnt, 0 AS sz, 1 AS ord, 'b' AS typ UNION ALL
    SELECT '48991d2f-ad0e-4059-a936-c02e60112cfc', 'Sent',   '#private', 'admin@example.com', 1093929003, 0, 0, 0, 0, 2, 'b' UNION ALL
    SELECT '7e65ab63-0f82-4da7-81f3-6c5dd2ba8c58', 'Drafts', '#private', 'admin@example.com', 4080645774, 0, 0, 0, 0, 3, 'b' UNION ALL
    SELECT 'a476cff3-b153-4cea-b799-16278b36e764', 'Trash',  '#private', 'admin@example.com', 1027022110, 0, 0, 0, 0, 4, 'b' UNION ALL
    SELECT '70c5f786-3357-4b7c-9bf2-326d7d624e68', 'Spam',   '#private', 'admin@example.com', 4092235386, 0, 0, 0, 0, 5, 'b'
) AS seed
WHERE NOT EXISTS (
    SELECT 1 FROM JAMES_MAILBOX
    WHERE USER_NAME = 'admin@example.com' AND MAILBOX_NAMESPACE = '#private'
);

INSERT INTO JAMES_MAILBOX
    (MAILBOX_ID, MAILBOX_NAME, MAILBOX_NAMESPACE, USER_NAME,
     MAILBOX_UID_VALIDITY, MAILBOX_LAST_UID, MAILBOX_HIGHEST_MODSEQ,
     MAILBOX_MESSAGE_COUNT, MAILBOX_SIZE, MAILBOX_ORDER, MAILBOX_TYPE)
SELECT * FROM (
    SELECT '624095a7-b45a-4e1b-a616-e0400db56473' AS id, 'INBOX'  AS nm, '#private' AS ns, 'user1@example.com' AS un,
           552954755 AS uv, 0 AS luid, 0 AS modseq, 0 AS cnt, 0 AS sz, 1 AS ord, 'b' AS typ UNION ALL
    SELECT '8f7405b3-519e-4e27-aa1a-5b0948511769', 'Sent',   '#private', 'user1@example.com', 1703809882, 0, 0, 0, 0, 2, 'b' UNION ALL
    SELECT '47597620-ac7e-4cf3-b5ce-e2befecd46fe', 'Drafts', '#private', 'user1@example.com',  288963882, 0, 0, 0, 0, 3, 'b' UNION ALL
    SELECT '5bc05519-bdc7-482a-8311-60fdb60bfea1', 'Trash',  '#private', 'user1@example.com', 1130063540, 0, 0, 0, 0, 4, 'b' UNION ALL
    SELECT 'e9af9101-c97c-4547-be73-72a0be614506', 'Spam',   '#private', 'user1@example.com', 1882552586, 0, 0, 0, 0, 5, 'b'
) AS seed
WHERE NOT EXISTS (
    SELECT 1 FROM JAMES_MAILBOX
    WHERE USER_NAME = 'user1@example.com' AND MAILBOX_NAMESPACE = '#private'
);

INSERT INTO JAMES_MAILBOX
    (MAILBOX_ID, MAILBOX_NAME, MAILBOX_NAMESPACE, USER_NAME,
     MAILBOX_UID_VALIDITY, MAILBOX_LAST_UID, MAILBOX_HIGHEST_MODSEQ,
     MAILBOX_MESSAGE_COUNT, MAILBOX_SIZE, MAILBOX_ORDER, MAILBOX_TYPE)
SELECT * FROM (
    SELECT '4f017cc4-6678-4281-a233-f2478ecb7ab5' AS id, 'INBOX'  AS nm, '#private' AS ns, 'user2@example.com' AS un,
           1411456848 AS uv, 0 AS luid, 0 AS modseq, 0 AS cnt, 0 AS sz, 1 AS ord, 'b' AS typ UNION ALL
    SELECT 'a188be11-79db-4dd6-b041-6081a7bccabb', 'Sent',   '#private', 'user2@example.com',  322176378, 0, 0, 0, 0, 2, 'b' UNION ALL
    SELECT '0088a750-a226-4626-8885-4aacd0321a31', 'Drafts', '#private', 'user2@example.com',  680692037, 0, 0, 0, 0, 3, 'b' UNION ALL
    SELECT '15f53194-e999-40ac-b4fc-ea3c8d451b7a', 'Trash',  '#private', 'user2@example.com',    5138445, 0, 0, 0, 0, 4, 'b' UNION ALL
    SELECT '55693409-d267-4b80-8b42-1abc3825d2e2', 'Spam',   '#private', 'user2@example.com',  245238561, 0, 0, 0, 0, 5, 'b'
) AS seed
WHERE NOT EXISTS (
    SELECT 1 FROM JAMES_MAILBOX
    WHERE USER_NAME = 'user2@example.com' AND MAILBOX_NAMESPACE = '#private'
);
