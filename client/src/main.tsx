import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { applyUnseenBadge } from './lib/notify';
import { adoptSiteTheme, applyCachedTheme } from './lib/theme';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

// 강조색은 관리자 설정 값이다 (ADM-2). 로그인 화면도 --accent 를 쓰므로 세션 전에 칠해야 한다.
// 지난번 색을 먼저 얹어 기본 보라가 번쩍이는 것을 막고, 공개 엔드포인트 응답으로 다시 칠한다.
applyCachedTheme();
fetch('/api/site/theme')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => data && adoptSiteTheme(data.theme))
  .catch(() => undefined);

// 파비콘은 index.html 에 파일로 두지 않고 캔버스로 그린다 (8-3). 로그인 화면에도 아이콘은 있어야 하므로
// 배지 없는 기본 아이콘을 먼저 깔아 둔다 — 로그인 뒤에는 Shell 이 안 읽은 수를 얹는다
applyUnseenBadge(0);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
