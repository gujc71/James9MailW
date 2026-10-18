/** 로그인 화면 (설계서 슬라이드 3). 언어 선택 + 아이디 저장 */
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { Me } from '../../api/types';
import { DEFAULT_LOCALE, getLocale, setLocale, useT, type Locale } from '../../i18n';

const STORE_KEY = 'j9-login';

function loadSavedUser(): string {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return (JSON.parse(raw) as { userName?: string }).userName ?? '';
  } catch {
    // 비공개 창 등에서 접근 불가
  }
  return '';
}

export function Login({ onLoggedIn }: { onLoggedIn: (me: Me) => void }) {
  const t = useT();
  const savedUser = loadSavedUser();
  const [userName, setUserName] = useState(savedUser);
  const [password, setPassword] = useState('');
  // 언어는 i18n 모듈이 들고 있다. 고르는 즉시 이 화면부터 바뀐다
  const locale: Locale = getLocale();
  const [remember, setRemember] = useState(Boolean(savedUser));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { userName, password, locale });
      const me = await api.get<Me>('/api/me');
      setLocale(me.locale ?? DEFAULT_LOCALE);
      try {
        if (remember) localStorage.setItem(STORE_KEY, JSON.stringify({ userName }));
        else localStorage.removeItem(STORE_KEY);
      } catch {
        // 저장 실패는 무시
      }
      onLoggedIn(me);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>James9Mail</h1>
        <div className="locale-tabs">
          <button type="button" className={locale === 'ko' ? 'active' : ''} onClick={() => setLocale('ko')}>
            한글
          </button>
          <button type="button" className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>
            English
          </button>
        </div>
        <label>
          {t('login.userName')}
          <input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="user@example.com"
            autoComplete="username"
            autoFocus
          />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t('login.remember')}
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '…' : t('login.signIn')}
        </button>
      </form>
    </div>
  );
}
