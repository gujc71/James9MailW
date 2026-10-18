# James9Mail 기능별 테스트

Playwright(TypeScript). **계층이 세 개**고, 각 계층은 필요한 것이 다르다.

| 프로젝트 | 무엇을 보나 | 필요한 것 | 언제 돌리나 |
|---|---|---|---|
| `mock` | 화면 전부 — 9개 설정 탭 · 6개 관리자 탭 · 목록 · 읽기 · 쓰기 · 조작 | **없음** (클라이언트만) | 커밋마다 |
| `api` | 엔드포인트 계약 · 권한 · 입력 검증 · Sieve 왕복 | MariaDB (+ 쓰기는 James) | PR 마다 |
| `e2e` | 로그인 → 발송 → 수신 → 읽기 → 수신확인 전 구간 | MariaDB + James(WebAdmin·SMTP) | 야간 · 릴리스 전 |

`mock` 계층이 `/api/**` 를 전부 가로채기 때문에 DB·James·파일시스템 없이도 화면을 끝까지 검증한다.
셋 중 하나만 내려가도 화면과 무관한 이유로 빨개지는 일을 여기서 막는다.

## 실행

```bash
cd test
npm install
npx playwright install chromium

npm test              # mock 계층 (기본)
npm run test:ui       # 눈으로 보면서 만들 때 — 단계별 타임 트래블 + 셀렉터 집기
npm run test:headed   # 실제 브라우저 창으로 (시연용)
npm run report        # 마지막 실행 결과 (실패는 스크린샷·비디오·트레이스 첨부)

J9_BACKEND=1 npm run test:api    # 웹서버까지 함께 띄운다
J9_BACKEND=1 npm run test:e2e
npm run typecheck
```

필요한 것이 떠 있지 않으면 `api`·`e2e` 스펙은 **실패가 아니라 건너뛴다**. 리포트에 무엇이 없어서
못 돌렸는지 남는다 — "환경이 없어서 빨간 것" 과 "코드가 틀려서 빨간 것" 을 섞지 않는다.

### 환경변수

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `J9_WEB` | 클라이언트 주소 | `http://localhost:5173` |
| `J9_API` | 웹서버 주소 | `http://127.0.0.1:4000` |
| `J9_BACKEND=1` | 웹서버(4000)도 함께 띄운다 | 끔 |
| `J9_NO_SERVE=1` | dev 서버를 띄우지 않는다 (이미 띄워 둔 경우) | 끔 |
| `J9_SLOWMO` | 조작 사이 지연(ms). 시연할 때 `300` | `0` |
| `J9_ADMIN_USER` / `J9_ADMIN_PW` | api·e2e 가 쓰는 관리자 계정 | `admin@example.com` / `TEST1234` |

## 구조

```
test/
  playwright.config.ts   프로젝트 3개(mock·api·e2e), webServer, 리포터
  fixtures/
    index.ts             mock 계층 픽스처 (state · page · shell · pageErrors)
    mockApi.ts           /api/** 를 전부 받는 가짜 서버 + 상태
    factories.ts         응답 만들기. 타입은 client/src/api/types.ts 에서 그대로 가져온다
    eml.ts               원문(.eml) 생성기 — 멀티파트 · 인라인이미지 · TNEF · 한글제목 · 일정
    multipart.ts         발송 요청(multipart)에서 필드 꺼내기
    api.ts               api 계층 픽스처 (로그인된 요청 컨텍스트 · 건너뛰기 판정)
    e2e.ts               e2e 계층 픽스처 (UI 로그인 · 발송 마무리 · 건너뛰기 판정)
  pages/                 화면별 POM (Shell · Mailbox · Reading · Compose · Settings · Admin · Receipts)
  specs/mock|api|e2e/
```

## 이 앱을 테스트할 때 걸리는 것들

만들면서 실제로 부딪힌 것만 적는다.

- **`/api/**` 를 글롭으로 가로채면 안 된다.** dev 서버는 소스 모듈도 서빙해서 `/src/api/client.ts`
  같은 주소가 존재한다. 글롭으로 잡으면 앱 번들까지 가로채 화면이 아예 뜨지 않는다.
  `page.route((url) => url.pathname.startsWith('/api/'), ...)` 로 **pathname** 을 본다.
- **본문은 sandbox iframe 안에 있다.** 본문 글자는 `frameLocator('iframe[title="mail-body"]')`
  로 들어가야 보인다. 또 `blob:`·`srcdoc` 이라 **Trace Viewer 스냅샷에서는 본문이 비어 보인다** —
  읽기 스펙은 `attachBodyShot()` 으로 스크린샷을 따로 남긴다.
- **화면 문구는 영어로 고정한다.** 기본 언어가 영어라도 `localStorage('j9-locale')` 와 `/api/me` 의
  `locale` 이 화면을 바꾼다. 픽스처가 진입 전에 `en` 으로 못박는다.
- **`data-testid` 가 한 곳도 없다.** 그래서 셀렉터는 role·텍스트·클래스에 기댄다. 설정·관리자의
  입력칸은 `<label>` 이 `<input>` 을 감싸지 않는 `.form-row` 구조라 `getByLabel` 이 통하지 않는다 —
  `pages/helpers.ts` 의 `formRowInput()` 을 쓴다.
- **`confirm()`·`prompt()` 는 Playwright 가 기본적으로 거절한다.** 그대로 두면 삭제·비우기·편지함
  추가가 조용히 아무 일도 하지 않는다. `acceptDialogs(page)` 를 먼저 부른다.
- **드롭다운 메뉴는 body 로 포털 렌더된다.** 버튼 주변에서 찾으면 안 되고 `ul.menu-list` 를 본다.
  위치를 잰 뒤 한 번 움직이고, 뒤쪽 표가 다시 그려지면 통째로 떨어져 나가므로 `pickFromMenu()` 가
  "열고 고르기" 를 통째로 재시도한다.
- **버튼 이름은 부분 일치가 기본이다.** `name: 'Delete'` 는 `Delete permanently` 까지 잡고,
  `name: 'Mail'` 은 사이트 이름 `James9Mail` 까지 잡는다. 문자열에는 `exact: true` 를 쓴다.
- **저장이 끝나야 화면이 바뀌는 곳이 있다.** 규칙의 "사용" 체크박스는 저장 → 재조회 뒤에 값이
  바뀌므로 `uncheck()` 가 아니라 `click()` 한 뒤 결과를 확인한다.
- **토스트는 1.2초 만에 사라진다.** 토스트로 단정하는 대신 서버로 나간 요청이나 화면 상태를 본다.
- **목록은 가상 스크롤이다.** 보이는 행만 DOM 에 있으므로 "몇 통" 을 세지 않고 있어야 할 메일이
  보이는지로 확인한다.
- **동기화 폴링은 30초 간격이다.** e2e 에서 새 메일을 기다릴 때는 폴링을 기다리지 말고 화면을
  다시 연다.

## 테스트 데이터

`mock` 계층은 테스트마다 `state` 를 새로 만들고 브라우저 컨텍스트도 매번 새것이라 서로 간섭하지
않는다. Dexie 미러(IndexedDB)가 남으면 목록 단정이 오염되므로 `storageState` 로 재사용하지 않는다.

`api`·`e2e` 계층은 `server/sql/02-seed.sql` 의 세 계정(`admin@` · `user1@` · `user2@example.com`,
비밀번호 `TEST1234`)을 쓴다. e2e 가 만드는 편지함·메일 제목에는 실행 꼬리표(`e2e-<시각>`)가 붙어
이전 실행이 남긴 것과 섞이지 않는다.

여러 워커로 e2e 를 돌리면 같은 계정의 편지함을 함께 만지게 되므로 `e2e` 프로젝트는 워커 1개로
직렬 실행한다. 병렬이 필요해지면 `POST /api/admin/users` 로 워커마다 계정을 만들어 쓰고 끝에
지우는 방식으로 넓힌다.

## 이 테스트를 만들다 찾아 고친 결함

둘 다 고쳤고, 되돌아가지 않도록 스펙이 지키고 있다.

- **약속메일의 일시·장소가 나오지 않았다.** `mime/parse.worker.ts` 가 첨부 내용을
  `instanceof ArrayBuffer` 로만 보고 아니면 `String(content)` 로 바꿨다. postal-mime 은
  `Uint8Array` 를 주므로 text/calendar 파트가 `"66,69,71,…"` 같은 숫자 나열이 되어 DTSTART 를
  못 찾았다 — 일정 상자는 뜨지만 안이 비어 있었다. 뷰가 가리키는 구간만 잘라 쓰도록 고쳤다
  (`toArrayBuffer`). → `specs/mock/reading.spec.ts` "약속메일이 일시·장소를 보여 준다"
- **"스팸함에 저장" 규칙이 다시 읽을 때 처리 종류를 잃었다.** Sieve 로는 그냥 `fileinto` 라
  `sieve/parse.ts` 가 늘 `FILEINTO` 로 돌려줬고, 수정 팝업은 "휴지통으로 이동" 으로 잡혔다.
  구분이 실제로 있는 수신거부 화면에 한해 대상이 `Spam` 이면 `SPAM` 으로 되살린다.
  → `specs/api/rules-roundtrip.spec.ts` 세 스펙(수신거부 세 처리 · 휴지통 유지 · 자동분류 유지)

## 넓힐 때

- 화면을 새로 만들면 먼저 `mock` 에 스펙을 붙인다. 응답 타입은 `factories.ts` 에 모으고
  `client/src/api/types.ts` 에서 가져온다 — 서버 응답 모양이 바뀌면 타입 오류로 먼저 드러난다.
- `mockApi.ts` 가 처리하지 않은 경로는 `state.unhandled` 에 쌓이고 404 가 된다. 새 엔드포인트가
  생기면 조용히 통과하지 않고 여기에 남는다.
- 셀렉터가 자꾸 흔들리는 자리부터 `data-testid` 를 붙이는 편이 싸다. 전부 붙일 필요는 없고,
  i18n 으로 글자가 바뀌는 요소와 같은 이름이 여럿인 요소만.
