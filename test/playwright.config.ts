/**
 * james9Mail 기능별 테스트 설정.
 *
 * 프로젝트(계층)가 세 개다. 의존성이 다르므로 섞지 않는다.
 *
 *  - mock : 클라이언트만 띄우고 /api/** 를 전부 가로채 화면을 검증한다.
 *           DB · James · 파일시스템이 없어도 돌아간다. 커밋마다 돌릴 계층.
 *  - api  : 브라우저 없이 실서버(4000) 엔드포인트를 검증한다. MariaDB 필요,
 *           쓰기 스펙은 James WebAdmin 도 필요하다.
 *  - e2e  : 로그인부터 발송·수신까지 전 구간. MariaDB + James 가 다 떠 있어야 한다.
 *
 * 실행
 *   npm test                 mock 계층 (기본)
 *   npm run test:ui          mock 계층을 UI 모드로 (눈으로 보며 만들 때)
 *   npm run test:headed      mock 계층을 실제 브라우저 창으로
 *   J9_BACKEND=1 npm run test:api
 *   J9_BACKEND=1 npm run test:e2e
 *
 * 환경변수
 *   J9_WEB          클라이언트 주소 (기본 http://localhost:5173)
 *   J9_API          웹서버 주소 (기본 http://127.0.0.1:4000)
 *   J9_BACKEND=1    웹서버(4000)까지 함께 띄운다. api · e2e 계층에 필요하다
 *   J9_NO_SERVE=1   dev 서버를 띄우지 않는다 (이미 띄워 둔 경우)
 *   J9_SLOWMO       조작 사이 지연(ms). 시연할 때 300 정도
 *   J9_ADMIN_USER / J9_ADMIN_PW   api · e2e 가 쓰는 관리자 계정
 *                                 (기본 admin@example.com / TEST1234 — 02-seed.sql)
 */
import { defineConfig, devices } from '@playwright/test';

const WEB = process.env.J9_WEB ?? 'http://localhost:5173';
const API = process.env.J9_API ?? 'http://127.0.0.1:4000';
const withBackend = process.env.J9_BACKEND === '1';
const slowMo = Number(process.env.J9_SLOWMO ?? 0);

const servers = [
  {
    command: 'npm --prefix ../client run dev',
    url: WEB,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  ...(withBackend
    ? [
        {
          command: 'npm --prefix ../server run dev',
          url: `${API}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : []),
];

export default defineConfig({
  testDir: './specs',
  // 화면 스펙은 서로를 건드리지 않으므로 병렬로 돌린다.
  // e2e 계층만 프로젝트 설정에서 직렬로 묶는다 (계정을 공유한다)
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['html', { open: 'never' }], ['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: WEB,
    // 실패한 것만 되감아 볼 수 있게 남긴다. 본문(iframe) 스펙은 트레이스에
    // blob 리소스가 재생되지 않으므로 스크린샷을 따로 남긴다 (pages/helpers.ts)
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    launchOptions: slowMo ? { slowMo } : undefined,
    // 창 크기를 고정한다. 720px 미만이면 사이드바가 접히는 분기가 있다 (App.tsx)
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Seoul',
  },

  projects: [
    {
      name: 'mock',
      testDir: './specs/mock',
      use: { ...devices['Desktop Chrome'], baseURL: WEB },
    },
    {
      name: 'api',
      testDir: './specs/api',
      // 브라우저를 쓰지 않는다. baseURL 만 웹서버로 돌려 request 픽스처가 쓰게 한다
      use: { baseURL: API },
    },
    {
      name: 'e2e',
      testDir: './specs/e2e',
      // 같은 계정의 편지함을 함께 만지므로 한 워커로 직렬 실행한다
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: WEB },
    },
  ],

  webServer: process.env.J9_NO_SERVE === '1' ? undefined : servers,
});
