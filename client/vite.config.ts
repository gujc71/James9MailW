import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 /api · /large · /dav 를 Node 서버(4000)로 프록시한다.
// 배포 시에는 Node 서버가 dist 를 정적 서빙하므로 프록시가 필요 없다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite 기본 CORS 는 모든 OPTIONS 를 프록시보다 먼저 204 로 끝내 버린다. 그러면 CalDAV 의
    // OPTIONS 응답(DAV: calendar-access)이 썬더버드에 닿지 않는다. 화면은 프록시로 같은 출처라 필요 없다
    cors: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/large': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      // CalDAV (썬더버드 등 외부 캘린더 프로그램)
      '/dav': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/.well-known/caldav': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      // 썬더버드에 서버 주소만 넣으면 루트로 PROPFIND 한다. 그것만 넘기고 화면(GET /)은 Vite 가 준다
      '^/$': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        bypass: (req) => (req.method === 'PROPFIND' ? undefined : req.url),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  worker: { format: 'es' },
});
