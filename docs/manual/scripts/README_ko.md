# 매뉴얼 화면 캡처 스크립트

[한국어 매뉴얼](../ko/README.adoc) · [영어 매뉴얼](../en/README.adoc)의 그림(`../ko/images`, `../en/images`)을 Playwright 로 다시 찍는 스크립트입니다.
화면이 바뀌면 이 스크립트를 돌려 그림을 새로 만듭니다.

## 준비

- 웹메일 서버(4000) · Vite 개발 서버(5173) · James9Mail · MariaDB 가 떠 있어야 합니다.
- 테스트 계정 `admin` · `user1` · `user2`(`@example.com`, 비밀번호 `TEST1234`)가 있어야 합니다(`server/sql/02-seed.sql`).

```bash
cd docs/manual/scripts
npm install
npx playwright install chromium
```

## 실행

언어마다 샘플 데이터(메일 제목 · 본문, 일정, 계정 표시 이름)가 다릅니다. 한 언어를 찍기 전에 다른 언어의 샘플을
지워야 그림에 섞이지 않으므로, 보통은 한 번에 처리하는 `all:*` 명령을 씁니다.

```bash
npm run all:ko     # 샘플 정리 → 한국어 샘플 → 한국어 캡처 → ../ko/images
npm run all:en     # 샘플 정리 → 영어 샘플   → 영어 캡처   → ../en/images
```

> 마지막에 돌린 언어의 샘플이 테스트 계정에 남습니다. 평소 상태(한국어)로 두려면 `all:ko` 를 마지막에 돌리세요.

| 명령 | 내용 |
|---|---|
| `npm run cleanup` | 모든 언어의 샘플 메일 · 일정 · 태스크를 제목으로 찾아 지웁니다 |
| `npm run seed` / `seed:en` | 한국어 / 영어 샘플을 만듭니다. 계정 표시 이름도 바꿉니다(관리자·사용자1·사용자2·사용자3 ↔ Admin·User 1·User 2·User 3). user3 은 계정이 있을 때만 관리자 API 로 바꿉니다 |
| `npm run capture` / `capture:en` | 한국어 / 영어 화면을 모두 찍습니다 |

장별로 찍으려면 `MANUAL_LOCALE` 을 주고 스크립트를 직접 실행합니다.

| 스크립트 | 내용 | 그림 |
|---|---|---|
| `cap-mail.mjs` | 1장 · 2장 (로그인, 화면 구성, 목록, 읽기) | `01-*`, `02-*` |
| `cap-compose.mjs` | 3장 (메일쓰기, 수신 확인). **실제 발송은 하지 않습니다** | `03-*`, `02-appointment-done` |
| `cap-cal.mjs` | 4장 (캘린더, 태스크, CalDAV) | `04-*` |
| `cap-settings.mjs` | 5장 개인환경설정 · 관리자 화면. **저장 버튼은 누르지 않습니다** | `05-*`, `A-*` |

```bash
MANUAL_LOCALE=en node cap-cal.mjs     # 예: 영어 캘린더 그림만 다시 찍기
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MANUAL_LOCALE` | `ko` | `ko` 또는 `en`. 화면 언어 · 샘플 데이터 · 저장 폴더 |
| `MANUAL_WEB_URL` | `http://localhost:5173/` | 캡처할 웹메일 화면 주소 |
| `MANUAL_API_URL` | `http://127.0.0.1:4000` | seed · cleanup 이 부르는 API 서버 |
| `MANUAL_PASSWORD` | `TEST1234` | 테스트 계정 비밀번호 |

## 캡처가 테스트 데이터에 남기는 것

- `cap-compose.mjs` — user1 이 디자인 리뷰 초대에 **참석**으로 응답합니다(캘린더에 일정이 들어감).
- `cap-cal.mjs` — user1 캘린더에 반복 일정(주간 팀 회의)과 태스크 3개를 만듭니다. 이미 있으면 다시 만들지 않습니다.
- CalDAV · CardDAV 사용 체크는 안내 창을 찍은 뒤 원래대로 되돌립니다.
- 위 일정 · 태스크는 `cleanup` 이 함께 지웁니다.

## 스크립트 구성

| 파일 | 역할 |
|---|---|
| `lib.mjs` | 브라우저 열기 · 로그인(언어 선택) · 해시 이동 · 빨간 번호 표시(`mark`) · 영역 캡처(`shot`) · 화면 문구 찾기(`t`, `exact`) |
| `i18n.mjs` | `client/src/i18n.ts` 의 ko · en 사전을 읽습니다. 스크립트는 화면 문구를 직접 쓰지 않고 i18n 키로 찾습니다 |
| `data.mjs` | 언어별 샘플 데이터(메일 · 일정 · 태스크 · 입력값) |
| `api.mjs` | API 직접 호출 도우미(로그인 · 요청) |
| `seed.mjs` / `cleanup.mjs` | 샘플 만들기 / 지우기 |
| `cap-*.mjs` | 장별 캡처 |

> **화면 문구가 바뀌면** — 스크립트는 i18n 키로 버튼을 찾으므로 문구만 바뀌면 고칠 것이 없습니다. 키 이름이 바뀌면
> `cap-*.mjs` 의 `t('...')` 를 고칩니다. 사이드 메뉴 편지함은 언어와 상관없는 `title`(INBOX · Sent …)로 찾습니다.

> **API 를 직접 부를 때 주의** — 쓰기 요청에는 `x-requested-with` 헤더가 필요합니다(CSRF 방어). 읽음 플래그는
> 반드시 `"\\Seen"`(역슬래시 포함)으로 보내야 합니다. `"Seen"` 으로 보내면 오류 없이 사용자 키워드로 저장되어
> 읽음 처리도 수신확인(READ_DATE)도 되지 않습니다. 셸 한 줄 명령(`node -e "..."`)은 역슬래시가 빠지기 쉬우니 파일로 작성하세요.
