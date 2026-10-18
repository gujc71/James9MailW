/**
 * 관리자 화면 (ADM-1 ~ ADM-6).
 * 상단 GNB + 좌측 LNB(현황 · 기본 설정 · 사용자 관리 · 알리아스 메일 · 메일 로그 · 수신거부).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { BodyViewer } from '../message/BodyViewer';
import { buildLoadedBody, type LoadedBody } from '../message/useMessageBody';
import { LOGO_BOX, resizeImage } from '../../lib/image';
import { formatBytes, formatFullDate, displayAddress, displayNameOnly } from '../../lib/format';
import { Menu } from '../common/Menu';
import { Modal } from '../common/Modal';
import { EMAIL_RE } from '../common/AddressBook';
import { clearAddressSuggestCache } from '../compose/useAddressSuggest';
import { t, useT, type MessageKey } from '../../i18n';
import {
  THEME_DEFAULT,
  THEME_KEYS,
  adoptSiteTheme,
  applyTheme,
  deriveTheme,
  isTooLightForWhiteText,
  normalizeTheme,
  type SiteTheme,
  type ThemeKey,
} from '../../lib/theme';

/** 좌측 LNB 탭. 주소 해시(#/admin/users)에 그대로 실리는 이름이다 */
export type AdminTab = 'overview' | 'site' | 'users' | 'aliases' | 'mails' | 'droplist';
const ADMIN_TABS: { key: AdminTab; label: MessageKey }[] = [
  { key: 'overview', label: 'admin.overview' },
  { key: 'site', label: 'admin.site' },
  { key: 'users', label: 'admin.users' },
  { key: 'aliases', label: 'admin.aliases' },
  { key: 'mails', label: 'admin.mails' },
  { key: 'droplist', label: 'admin.droplist' },
];

export function isAdminTab(value: string | null): value is AdminTab {
  return ADMIN_TABS.some((item) => item.key === value);
}

const PAGE = 50;
const MB = 1024 * 1024;

/** 어느 탭인지는 App 이 주소 해시에서 읽어 넘겨 준다 (lib/hashRoute.ts) */
export function Admin({ tab, onTab }: { tab: AdminTab; onTab: (tab: AdminTab) => void }) {
  const t = useT();
  return (
    <div className="settings-body">
      <nav className="settings-nav">
        {ADMIN_TABS.map((item) => (
          <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => onTab(item.key)}>
            {t(item.label)}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === 'overview' && <Overview />}
        {tab === 'site' && <Site />}
        {tab === 'users' && <Users />}
        {tab === 'aliases' && <Aliases />}
        {tab === 'mails' && <Mails />}
        {tab === 'droplist' && <DropList />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 공통: 라인 차트

function LineChart({ points, height = 160 }: { points: { label: string; value: number }[]; height?: number }) {
  const t = useT();
  if (points.length === 0) return <div className="hint">{t('admin.noData')}</div>;
  const width = 640;
  const padX = 32;
  const padY = 20;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: padX + i * stepX,
    y: height - padY - (p.value / max) * (height - padY * 2),
    ...p,
  }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  return (
    <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#e1e4e8" />
      <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="#e1e4e8" />
      <text x={padX - 4} y={padY + 4} fontSize="10" textAnchor="end" fill="#6b7280">
        {max}
      </text>
      <path d={path} fill="none" stroke="#2563eb" strokeWidth="2" />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r="3" fill="#2563eb">
            <title>
              {c.label}: {c.value}
            </title>
          </circle>
          {i % labelEvery === 0 && (
            <text x={c.x} y={height - 4} fontSize="10" textAnchor="middle" fill="#6b7280">
              {c.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- ADM-1 현황

function Overview() {
  const t = useT();
  const [data, setData] = useState<{
    totals: { users: number; mailboxBytes: number; mails: number };
    weekly: { date: string; count: number }[];
  } | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hourly, setHourly] = useState<{ hour: number; count: number }[]>([]);
  const [totalQuota, setTotalQuota] = useState<number | null>(null);

  useEffect(() => {
    void api.get<typeof data>('/api/admin/overview').then(setData);
    void api
      .get<{ defaultQuota: number | null }>('/api/admin/site')
      .then((s) => setTotalQuota(s.defaultQuota))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void api.get<{ hour: number; count: number }[]>(`/api/admin/hourly?date=${date}`).then(setHourly);
  }, [date]);

  if (!data) return <div className="tab">{t('common.loading')}</div>;
  return (
    <div className="tab">
      <h2>{t('admin.overview')}</h2>
      <div className="stat-cards">
        <div className="stat">
          <span className="stat-num">{data.totals.users}</span>
          <span>{t('admin.totalUsers')}</span>
        </div>
        <div className="stat">
          <span className="stat-num">{formatBytes(data.totals.mailboxBytes)}</span>
          <span>
            {t('admin.usedSize')}
            {totalQuota ? t('admin.perAccountDefault', { size: formatBytes(totalQuota) }) : ''}
          </span>
        </div>
        <div className="stat">
          <span className="stat-num">{data.totals.mails}</span>
          <span>{t('admin.mailCount')}</span>
        </div>
      </div>
      <h3>{t('admin.weeklyChart')}</h3>
      <LineChart points={data.weekly.map((w) => ({ label: w.date.slice(5), value: w.count }))} />
      <h3>
        {t('admin.hourlyChart')}{' '}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="inline-date" />
      </h3>
      <LineChart points={hourly.map((h) => ({ label: t('admin.hourLabel', { h: h.hour }), value: h.count }))} />
      <p className="hint">{t('admin.statsNote')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- ADM-2 기본 설정

/** 강조색 항목 이름. 무슨 색인지 알려면 쓰이는 곳을 적어야 한다 */
const THEME_LABEL: Record<ThemeKey, MessageKey> = {
  accent: 'admin.themeAccent',
  accentHover: 'admin.themeHover',
  accentText: 'admin.themeText',
  accentPale: 'admin.themePale',
  accentSoft: 'admin.themeSoft',
  accentSoft2: 'admin.themeSoft2',
  gradFrom: 'admin.themeGradFrom',
  gradTo: 'admin.themeGradTo',
  syntaxField: 'admin.themeSyntax',
};

/** 기준색(accent) 은 따로 그리므로 격자에는 파생 여덟 개만 둔다 */
const DERIVED_KEYS = THEME_KEYS.filter((key) => key !== 'accent');
const HEX_RE = /^#[0-9a-f]{6}$/;

interface SiteData {
  site: { siteName: string; logoPath: string | null; theme: SiteTheme };
  domains: string[];
  defaultQuota: number | null;
  domainQuotas: { domain: string; limit: number | null }[];
}

function Site() {
  const t = useT();
  const [data, setData] = useState<SiteData | null>(null);
  const [siteName, setSiteName] = useState('');
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [quotaMb, setQuotaMb] = useState('');
  const [theme, setTheme] = useState<SiteTheme>(THEME_DEFAULT);
  /**
   * hex 를 손으로 입력하는 중에는 아직 색이 아니다 ('#4f4'). 확정된 색과 따로 담아 두고
   * 여섯 자리가 차면 theme 에 옮긴다. 칸을 벗어나면 확정된 색으로 되돌린다.
   */
  const [hexDraft, setHexDraft] = useState<Partial<Record<ThemeKey, string>>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const savedTheme = useRef<SiteTheme>(THEME_DEFAULT);

  const load = useCallback(
    () =>
      api.get<SiteData>('/api/admin/site').then((d) => {
        setData(d);
        setSiteName(d.site.siteName);
        setLogoPath(d.site.logoPath);
        savedTheme.current = normalizeTheme(d.site.theme);
        setTheme(savedTheme.current);
        setHexDraft({});
        setQuotaMb(d.defaultQuota && d.defaultQuota > 0 ? String(Math.round(d.defaultQuota / MB)) : '');
      }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(file.type)) return setMsg(t('profile.imageOnly'));
    // SVG 는 벡터라 줄일 것이 없다(서버가 받지도 않는다)
    const logo = file.type === 'image/svg+xml' ? file : await resizeImage(file, LOGO_BOX).catch(() => file);
    if (logo.size > 2 * MB) return setMsg(t('admin.logoTooBig'));
    const form = new FormData();
    form.append('logo', logo, file.name);
    try {
      const res = await api.form<{ logoPath: string }>('/api/admin/site/logo', form);
      setLogoPath(res.logoPath);
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('admin.logoUploadFailed'));
    }
  }

  /**
   * 고르는 동안 미리보기뿐 아니라 화면 전체가 새 색으로 보이게 얹는다. 저장 전이므로
   * localStorage 에는 담지 않고(applyTheme), 저장하지 않고 화면을 떠나면 서버 값으로 되돌린다.
   */
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(
    () => () => {
      applyTheme(savedTheme.current);
    },
    [],
  );

  function pickColor(key: ThemeKey, value: string) {
    setTheme((old) => ({ ...old, [key]: value }));
    setHexDraft((old) => ({ ...old, [key]: undefined }));
  }

  /** 입력 중인 hex. 여섯 자리가 차면 색으로 확정한다 */
  function typeHex(key: ThemeKey, raw: string) {
    const text = ('#' + raw.replace(/[^0-9a-fA-F]/g, '')).slice(0, 7).toLowerCase();
    setHexDraft((old) => ({ ...old, [key]: text }));
    if (HEX_RE.test(text)) setTheme((old) => ({ ...old, [key]: text }));
  }

  /** 기준색에서 나머지 여덟 색을 계산해 채운다 */
  function fillFromAccent() {
    setTheme(deriveTheme(theme.accent));
    setHexDraft({});
    setMsg(null);
  }

  function resetTheme() {
    setTheme(THEME_DEFAULT);
    setHexDraft({});
    setMsg(null);
  }

  async function save() {
    setMsg(null);
    const mb = Number(quotaMb);
    if (quotaMb !== '' && (!Number.isInteger(mb) || mb < 1 || mb > 1024 * 1024))
      return setMsg(t('admin.badQuota'));
    try {
      await api.put('/api/admin/site', {
        siteName: siteName.trim() || 'James9Mail',
        logoPath,
        theme,
        ...(quotaMb !== '' ? { defaultQuotaBytes: mb * MB } : {}),
      });
      // 저장한 색을 이 화면에 바로 얹는다. 다른 접속자는 다음 새로고침에 따라온다
      adoptSiteTheme(theme);
      setMsg(t('admin.siteSaved'));
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  if (!data) return <div className="tab">{t('common.loading')}</div>;
  return (
    <div className="tab">
      <h2>{t('admin.siteTitle')}</h2>
      <div className="form-row">
        <label>{t('admin.siteLogo')}</label>
        <input type="file" accept="image/*" onChange={(e) => uploadLogo(e.target.files?.[0])} />
        {logoPath && (
          <button className="link danger" onClick={() => setLogoPath(null)}>
            {t('admin.removeLogo')}
          </button>
        )}
      </div>
      <div className="form-row">
        <label>{t('admin.logoPreview')}</label>
        {logoPath ? (
          <img className="logo-preview" src={logoPath} alt={t('admin.logoAlt')} />
        ) : (
          <span className="hint">{t('admin.noneDefault')}</span>
        )}
      </div>
      <div className="form-row">
        <label>{t('admin.siteName')}</label>
        <input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="James9Mail" />
      </div>
      <div className="form-row">
        <label>{t('admin.siteDomain')}</label>
        <span>{data.domains.length ? data.domains.join(', ') : t('admin.noDomain')}</span>
      </div>
      <div className="form-row">
        <label>{t('admin.defaultQuota')}</label>
        <input value={quotaMb} onChange={(e) => setQuotaMb(e.target.value.replace(/\D/g, ''))} placeholder="UNLIMIT" />
        <span>MB</span>
        <span className="hint">{t('admin.blankUnlimited')}</span>
      </div>
      {data.domainQuotas.length > 0 && (
        <p className="hint">
          {t('admin.domainQuotaNote', {
            list: data.domainQuotas
              .map((d) => `${d.domain}=${d.limit === null ? 'UNLIMIT' : formatBytes(d.limit)}`)
              .join(', '),
          })}
        </p>
      )}
      <h3>{t('admin.themeTitle')}</h3>
      <p className="hint">{t('admin.themeHint')}</p>
      <div className="form-row">
        <label>{t('admin.themeAccent')}</label>
        <span className="color-pick">
          <input
            type="color"
            value={theme.accent}
            aria-label={t('admin.themeAccent')}
            onChange={(e) => pickColor('accent', e.target.value)}
          />
          <input
            className="hex"
            value={hexDraft.accent ?? theme.accent}
            spellCheck={false}
            onChange={(e) => typeHex('accent', e.target.value)}
            onBlur={() => setHexDraft((old) => ({ ...old, accent: undefined }))}
          />
        </span>
        <button className="btn" onClick={fillFromAccent}>
          {t('admin.themeDerive')}
        </button>
        <button className="link" onClick={resetTheme}>
          {t('admin.themeReset')}
        </button>
      </div>
      {isTooLightForWhiteText(theme.accent) && <div className="warn">{t('admin.themeContrast')}</div>}
      <div className="theme-grid">
        {DERIVED_KEYS.map((key) => (
          <span key={key} className="theme-item">
            <span className="theme-item-name">{t(THEME_LABEL[key])}</span>
            <span className="color-pick">
              <input
                type="color"
                value={theme[key]}
                aria-label={t(THEME_LABEL[key])}
                onChange={(e) => pickColor(key, e.target.value)}
              />
              <input
                className="hex"
                value={hexDraft[key] ?? theme[key]}
                spellCheck={false}
                onChange={(e) => typeHex(key, e.target.value)}
                onBlur={() => setHexDraft((old) => ({ ...old, [key]: undefined }))}
              />
            </span>
          </span>
        ))}
      </div>
      <div className="form-row">
        <label>{t('admin.themePreview')}</label>
        <span className="theme-preview">
          {/* 실제 버튼과 글자가 겹치면 테스트 셀렉터가 흔들린다 — 미리보기 전용 라벨을 쓴다 */}
          <button className="primary" type="button" tabIndex={-1}>
            {t('admin.themeButtonSample')}
          </button>
          <button className="btn active" type="button" tabIndex={-1}>
            {t('admin.themeChipSample')}
          </button>
          <a href="#/admin/site" onClick={(e) => e.preventDefault()}>
            {t('admin.themeLinkSample')}
          </a>
          <span className="theme-swatch grad" />
          <span className="theme-swatch soft" />
          <span className="theme-swatch ring" />
        </span>
      </div>
      {msg && <div className="info">{msg}</div>}
      <div className="modal-actions left">
        <button className="primary" onClick={save}>
          {t('common.save')}
        </button>
        <button className="btn" onClick={() => void load()}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ADM-3 사용자 관리

interface AdminUser {
  userName: string;
  displayName: string | null;
  status: string;
  used: number;
  limit: number | null;
  unlimited: boolean;
  regDate: string | null;
}

function Users() {
  const t = useT();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [quotaOf, setQuotaOf] = useState<AdminUser | null>(null);
  const [editOf, setEditOf] = useState<AdminUser | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ keyword: applied, limit: String(PAGE), offset: String(offset) });
        const r = await api.get<{ users: AdminUser[]; total: number }>(`/api/admin/users?${qs}`);
        setUsers((prev) => (offset === 0 ? r.users : [...prev, ...r.users]));
        setTotal(r.total);
      } catch (cause) {
        setMsg(cause instanceof ApiError ? cause.message : t('common.queryFailed'));
      } finally {
        setLoading(false);
      }
    },
    [applied],
  );
  useEffect(() => {
    void load(0);
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      // 계정을 중지·삭제했으면 자동완성이 들고 있는 목록도 낡았다
      clearAddressSuggestCache();
      await load(0);
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    }
  }

  return (
    <div className="tab">
      <h2>{t('admin.users')}</h2>
      <p className="hint">{t('admin.usersDescription')}</p>
      <div className="toolbar">
        <div className="search">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setApplied(keyword)}
            placeholder={t('addressbook.searchPlaceholder')}
          />
          <button className="btn" onClick={() => setApplied(keyword)}>{t('common.search')}</button>
        </div>
        <button className="primary" onClick={() => setAddOpen(true)}>
          {t('admin.addUser')}
        </button>
      </div>
      {msg && <div className="error">{msg}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('admin.account')}</th>
            <th>{t('admin.used')}</th>
            <th>{t('admin.quota')}</th>
            <th>{t('common.registeredDate')}</th>
            <th>{t('common.status')}</th>
            <th>{t('admin.options')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.userName} className="clickable" onClick={() => setEditOf(u)} title={t('admin.clickToEditUser')}>
              <td>{u.displayName ?? '-'}</td>
              <td>{u.userName}</td>
              <td>{formatBytes(u.used)}</td>
              <td>{u.unlimited || u.limit === null ? 'UNLIMIT' : formatBytes(u.limit)}</td>
              <td>{u.regDate?.slice(0, 10)}</td>
              <td>{t(u.status === 'N' ? 'admin.suspended' : 'admin.active')}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <Menu
                  label="▼"
                  buttonClassName="tb"
                  align="right"
                  items={[
                    {
                      label: t(u.status === 'N' ? 'admin.activateAction' : 'admin.suspendAction'),
                      onClick: () =>
                        void act(() =>
                          api.post(`/api/admin/users/${encodeURIComponent(u.userName)}/status`, {
                            status: u.status === 'N' ? 'Y' : 'N',
                          }),
                        ),
                    },
                    { label: t('admin.changeQuota'), onClick: () => setQuotaOf(u) },
                    {
                      label: t('common.delete'),
                      danger: true,
                      onClick: () => {
                        if (confirm(t('admin.confirmDeleteUser', { user: u.userName })))
                          void act(() => api.del(`/api/admin/users/${encodeURIComponent(u.userName)}`));
                      },
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <div className="list-status">{t('common.loading')}</div>}
      {!loading && users.length < total && (
        <button className="more" onClick={() => load(users.length)}>
          {t('admin.moreCount', { n: users.length, total })}
        </button>
      )}

      {addOpen && (
        <UserAddModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void load(0);
          }}
        />
      )}
      {quotaOf && (
        <QuotaModal
          user={quotaOf}
          onClose={() => setQuotaOf(null)}
          onSaved={() => {
            setQuotaOf(null);
            void load(0);
          }}
        />
      )}
      {editOf && (
        <UserEditModal
          user={editOf}
          onClose={() => setEditOf(null)}
          onSaved={() => {
            setEditOf(null);
            void load(0);
          }}
        />
      )}
    </div>
  );
}

function UserAddModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [domains, setDomains] = useState<string[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [checked, setChecked] = useState<string | null>(null); // 중복검사 통과한 계정
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ domains: string[] }>('/api/admin/site').then((d) => {
      setDomains(d.domains);
      setDomain(d.domains[0] ?? '');
    });
  }, []);

  const userName = domain ? `${local.trim()}@${domain}` : local.trim();

  /** 중복검사. 통과하면 checked 에 그 계정을 남겨 저장 때 다시 묻지 않는다 */
  async function check(): Promise<boolean> {
    setMsg(null);
    if (local.trim().length < 4) {
      setMsg(t('admin.accountMin4'));
      return false;
    }
    if (!EMAIL_RE.test(userName)) {
      setMsg(t(domains.length > 0 ? 'admin.badAccount' : 'admin.accountWithDomain'));
      return false;
    }
    setBusy(true);
    try {
      const r = await api.get<{ exists: boolean }>(`/api/admin/users/exists?userName=${encodeURIComponent(userName)}`);
      if (r.exists) {
        setChecked(null);
        setMsg(t('admin.accountTaken'));
        return false;
      }
      setChecked(userName);
      setMsg(t('admin.accountAvailable'));
      return true;
    } catch (cause) {
      setChecked(null);
      setMsg(cause instanceof ApiError ? cause.message : t('admin.checkFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setMsg(null);
    if (displayName.trim().length < 2) return setMsg(t('admin.nameMin2'));
    if (!password) return setMsg(t('admin.needPassword'));
    if (password !== confirmPw) return setMsg(t('admin.pwMismatch'));
    // 중복검사 버튼을 누르지 않았거나 그 뒤 계정을 고쳤으면 여기서 대신 확인한다
    if (checked !== userName && !(await check())) return;
    setBusy(true);
    try {
      await api.post('/api/admin/users', { userName, displayName: displayName.trim(), password });
      onSaved();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('admin.registerFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('admin.addUserTitle')}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy} onClick={save}>
            {t('admin.register')}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('admin.userName')}</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={30} />
      </div>
      <div className="form-row">
        <label>{t('admin.account')}</label>
        <input value={local} onChange={(e) => setLocal(e.target.value)} placeholder={t('admin.min4')} style={{ width: 120 }} />
        {domains.length > 0 ? (
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.map((d) => (
              <option key={d} value={d}>
                @{d}
              </option>
            ))}
          </select>
        ) : (
          <span className="hint">{t('admin.enterWithDomain')}</span>
        )}
        <button className="tb" disabled={busy} onClick={() => void check()}>
          {t('admin.checkDuplicate')}
        </button>
      </div>
      <div className="form-row">
        <label>{t('admin.password')}</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="form-row">
        <label>{t('admin.passwordConfirm')}</label>
        <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
      </div>
      <p className="hint">{t('admin.userAddNote')}</p>
      {msg && <div className={checked === userName ? 'info' : 'error'}>{msg}</div>}
    </Modal>
  );
}

/**
 * ADM-3.3 사용자 정보 수정. 리스트의 행을 클릭하면 열린다.
 * 등록 화면과 같은 입력 구성이고 계정(userName)만 잠근다 — James 의 식별자라
 * 바꾸려면 삭제 후 재등록이다. 비밀번호 칸을 비워 두면 비밀번호는 건드리지 않는다.
 */
function UserEditModal({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const at = user.userName.lastIndexOf('@');
  const local = at > 0 ? user.userName.slice(0, at) : user.userName;
  const domain = at > 0 ? user.userName.slice(at + 1) : '';

  async function save() {
    setMsg(null);
    if (displayName.trim().length < 2) return setMsg(t('admin.nameMin2'));
    if (password && password !== confirmPw) return setMsg(t('admin.pwMismatch'));
    setSaving(true);
    try {
      await api.put(`/api/admin/users/${encodeURIComponent(user.userName)}`, {
        displayName: displayName.trim(),
        ...(password ? { password } : {}),
      });
      onSaved();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={t('admin.editUserTitle')}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={saving} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('admin.userName')}</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={30} />
      </div>
      <div className="form-row">
        <label>{t('admin.account')}</label>
        <input value={local} disabled style={{ width: 120 }} />
        {domain ? <span>@{domain}</span> : null}
      </div>
      <div className="form-row">
        <label>{t('admin.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('external.pwOnlyChange')}
          autoComplete="new-password"
        />
      </div>
      <div className="form-row">
        <label>{t('admin.passwordConfirm')}</label>
        <input
          type="password"
          value={confirmPw}
          disabled={!password}
          onChange={(e) => setConfirmPw(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <p className="hint">{t('admin.userEditNote')}</p>
      {msg && <div className="error">{msg}</div>}
    </Modal>
  );
}

function QuotaModal({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'value' | 'default' | 'unlimited'>('value');
  const [mb, setMb] = useState(user.limit && user.limit > 0 ? String(Math.round(user.limit / MB)) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const usedMb = Math.ceil(user.used / MB);
  const tooSmall = mode === 'value' && mb !== '' && Number(mb) * MB < user.used;

  async function save() {
    setMsg(null);
    const limitBytes = mode === 'default' ? null : mode === 'unlimited' ? -1 : Number(mb) * MB;
    if (mode === 'value' && (!mb || !Number.isInteger(Number(mb)) || Number(mb) < 1)) return setMsg(t('admin.numbersOnly'));
    if (tooSmall) return setMsg(t('admin.quotaTooSmall'));
    try {
      await api.put(`/api/admin/users/${encodeURIComponent(user.userName)}/quota`, { limitBytes });
      onSaved();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  return (
    <Modal
      title={t('admin.changeQuota')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('admin.targetAccount')}</label>
        <span>{user.userName}</span>
      </div>
      <div className="form-row">
        <label>{t('admin.currentQuota')}</label>
        <span>{user.unlimited || user.limit === null ? 'UNLIMIT' : `${Math.round(user.limit / MB).toLocaleString()} MB`}</span>
      </div>
      <div className="form-row">
        <label>{t('admin.currentUsed')}</label>
        <span>{usedMb.toLocaleString()} MB</span>
      </div>
      <div className="form-row">
        <label>{t('admin.newQuota')}</label>
        <input
          value={mb}
          disabled={mode !== 'value'}
          onChange={(e) => {
            setMb(e.target.value.replace(/\D/g, ''));
            setMode('value');
          }}
          style={{ width: 120 }}
        />
        <span>MB</span>
      </div>
      <div className="form-row">
        <label></label>
        <label className="checkbox">
          <input type="radio" checked={mode === 'value'} onChange={() => setMode('value')} />
          {t('admin.enterDirect')}
        </label>
        <label className="checkbox">
          <input type="radio" checked={mode === 'default'} onChange={() => setMode('default')} />
          {t('admin.useDefault')}
        </label>
        <label className="checkbox">
          <input type="radio" checked={mode === 'unlimited'} onChange={() => setMode('unlimited')} />
          {t('common.unlimited')}
        </label>
      </div>
      {tooSmall && <div className="warn">{t('admin.smallerThanUsed', { size: usedMb.toLocaleString() })}</div>}
      {msg && <div className="error">{msg}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- ADM-4 알리아스

interface Alias {
  aliasAddress: string;
  aliasName: string;
  status: string;
  regDate: string | null;
  targets: string[];
}

function Aliases() {
  const t = useT();
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ alias: Alias | null } | null>(null);

  const load = useCallback(
    () => api.get<Alias[]>(`/api/admin/aliases?keyword=${encodeURIComponent(applied)}`).then(setAliases),
    [applied],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      // 알리아스를 중지·삭제했으면 자동완성이 들고 있는 목록도 낡았다
      clearAddressSuggestCache();
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    }
  }

  return (
    <div className="tab tab-wide">
      <h2>{t('admin.aliases')}</h2>
      <p className="hint">{t('admin.aliasDescription')}</p>
      <div className="toolbar">
        <div className="search">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setApplied(keyword)}
            placeholder={t('admin.aliasSearchPlaceholder')}
          />
          <button className="btn" onClick={() => setApplied(keyword)}>{t('common.search')}</button>
        </div>
        <button className="primary" onClick={() => setEditing({ alias: null })}>
          {t('admin.addAlias')}
        </button>
      </div>
      {msg && <div className="error">{msg}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('admin.aliasAddress')}</th>
            <th>{t('admin.aliasTargets')}</th>
            <th>{t('common.registeredDate')}</th>
            <th>{t('common.status')}</th>
            <th>{t('admin.functions')}</th>
          </tr>
        </thead>
        <tbody>
          {aliases.map((a) => (
            <tr key={a.aliasAddress}>
              <td>
                <button className="link" onClick={() => setEditing({ alias: a })}>
                  {a.aliasName}
                </button>
              </td>
              <td>{a.aliasAddress}</td>
              <td>{a.targets.join(', ')}</td>
              <td>{a.regDate?.slice(0, 10)}</td>
              <td>{t(a.status === 'N' ? 'admin.suspended' : 'admin.active')}</td>
              <td>
                {/* 사용자 관리와 같은 옵션 버튼. 지금 상태의 반대만 내놓아 누른 그대로 바뀐다 */}
                <Menu
                  label="▼"
                  buttonClassName="tb"
                  align="right"
                  items={[
                    {
                      label: t(a.status === 'N' ? 'admin.activateAction' : 'admin.suspendAction'),
                      onClick: () =>
                        void act(() =>
                          api.post(`/api/admin/aliases/${encodeURIComponent(a.aliasAddress)}/status`, {
                            status: a.status === 'N' ? 'Y' : 'N',
                          }),
                        ),
                    },
                    {
                      label: t('common.delete'),
                      danger: true,
                      onClick: () => {
                        if (confirm(t('admin.confirmDeleteAlias', { alias: a.aliasAddress })))
                          void act(() => api.del(`/api/admin/aliases/${encodeURIComponent(a.aliasAddress)}`));
                      },
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
          {aliases.length === 0 && (
            <tr>
              <td colSpan={6} className="hint">
                {t('admin.noAliases')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <AliasModal
          alias={editing.alias}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AliasModal({ alias, onClose, onSaved }: { alias: Alias | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [domains, setDomains] = useState<string[]>([]);
  const [aliasName, setAliasName] = useState(alias?.aliasName ?? '');
  const [local, setLocal] = useState(alias?.aliasAddress.split('@')[0] ?? '');
  const [domain, setDomain] = useState(alias?.aliasAddress.split('@')[1] ?? '');
  const [checked, setChecked] = useState<string | null>(alias?.aliasAddress ?? null);
  const [targets, setTargets] = useState<Set<string>>(new Set(alias?.targets ?? []));
  const [userKeyword, setUserKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [candidates, setCandidates] = useState<AdminUser[]>([]);
  /** 오른쪽 목록은 검색 결과와 무관하게 유지되므로 한 번 본 이름은 따로 쌓아 둔다. */
  const [names, setNames] = useState<Record<string, string>>({});
  const [leftChecked, setLeftChecked] = useState<Set<string>>(new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ domains: string[] }>('/api/admin/site').then((d) => {
      setDomains(d.domains);
      if (!alias) setDomain(d.domains[0] ?? '');
    });
  }, [alias]);

  useEffect(() => {
    void api
      // 중지된 계정은 메일을 받지 못하므로 대상 후보에서 뺀다
      .get<{ users: AdminUser[] }>(`/api/admin/users?keyword=${encodeURIComponent(applied)}&activeOnly=1&limit=200`)
      .then((r) => {
        setCandidates(r.users);
        setNames((prev) => {
          const next = { ...prev };
          for (const u of r.users) if (u.displayName) next[u.userName] = u.displayName;
          return next;
        });
        setLeftChecked(new Set());
      });
  }, [applied]);

  const aliasAddress = alias ? alias.aliasAddress : domain ? `${local.trim()}@${domain}` : local.trim();

  async function check() {
    setMsg(null);
    if (local.trim().length < 4) return setMsg(t('admin.aliasMin4'));
    if (!EMAIL_RE.test(aliasAddress)) return setMsg(t('admin.badAccount'));
    const r = await api.get<{ exists: boolean; reason: string | null }>(
      `/api/admin/aliases/exists?aliasAddress=${encodeURIComponent(aliasAddress)}`,
    );
    if (r.exists) {
      setChecked(null);
      setMsg(t(r.reason === 'USER' ? 'admin.aliasDupUser' : 'admin.aliasDup'));
    } else {
      setChecked(aliasAddress);
      setMsg(t('admin.accountAvailable'));
    }
  }

  async function save() {
    setMsg(null);
    if (!aliasName.trim()) return setMsg(t('admin.needAliasName'));
    if (targets.size === 0) return setMsg(t('admin.needTargets'));
    try {
      if (alias) {
        await api.put(`/api/admin/aliases/${encodeURIComponent(alias.aliasAddress)}`, {
          aliasName: aliasName.trim(),
          targets: [...targets],
        });
      } else {
        await api.post('/api/admin/aliases', { aliasAddress, aliasName: aliasName.trim(), targets: [...targets] });
      }
      onSaved();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  }

  function toggleIn(set: Set<string>, put: (s: Set<string>) => void, address: string) {
    const next = new Set(set);
    next.has(address) ? next.delete(address) : next.add(address);
    put(next);
  }

  /** 왼쪽에서 체크한 계정을 오른쪽(선택 목록)으로 옮긴다. */
  function add() {
    if (leftChecked.size === 0) return;
    setTargets((prev) => new Set([...prev, ...leftChecked]));
    setLeftChecked(new Set());
  }

  /** 오른쪽에서 체크한 계정을 선택 목록에서 뺀다. */
  function remove() {
    if (rightChecked.size === 0) return;
    setTargets((prev) => new Set([...prev].filter((a) => !rightChecked.has(a))));
    setRightChecked(new Set());
  }

  const memo = useMemo(() => [...targets].sort(), [targets]);
  /** 이미 선택한 계정은 왼쪽 후보에서 감춰 같은 줄이 양쪽에 겹쳐 보이지 않게 한다. */
  const available = useMemo(() => candidates.filter((u) => !targets.has(u.userName)), [candidates, targets]);

  return (
    <Modal
      title={t(alias ? 'admin.editAliasTitle' : 'admin.addAliasTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={checked !== aliasAddress} onClick={save}>
            {t(alias ? 'common.save' : 'admin.register')}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>{t('admin.aliasName')}</label>
        <input value={aliasName} onChange={(e) => setAliasName(e.target.value)} />
      </div>
      <div className="form-row nowrap">
        <label>{t('admin.aliasAddress')}</label>
        <input value={local} disabled={Boolean(alias)} onChange={(e) => setLocal(e.target.value)} style={{ width: 110 }} />
        {domains.length > 0 ? (
          <select
            value={domain}
            disabled={Boolean(alias)}
            onChange={(e) => setDomain(e.target.value)}
            style={{ minWidth: 0, flex: '0 1 auto' }}
          >
            {domains.map((d) => (
              <option key={d} value={d}>
                @{d}
              </option>
            ))}
          </select>
        ) : (
          <span className="hint">{t('admin.enterWithDomain')}</span>
        )}
        {!alias && (
          <button className="tb" onClick={check} style={{ flexShrink: 0 }}>
            {t('admin.checkDuplicate')}
          </button>
        )}
      </div>
      <div className="form-row nowrap">
        <label>{t('admin.aliasTargetsLabel')}</label>
        <input
          value={userKeyword}
          onChange={(e) => setUserKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setApplied(userKeyword)}
          placeholder={t('admin.accountSearch')}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="tb" onClick={() => setApplied(userKeyword)} style={{ flexShrink: 0 }}>
          {t('common.search')}
        </button>
      </div>
      <div className="transfer">
        <div className="picker-list boxed">
          {available.map((u) => (
            <label key={u.userName} className="checkbox">
              <input
                type="checkbox"
                checked={leftChecked.has(u.userName)}
                onChange={() => toggleIn(leftChecked, setLeftChecked, u.userName)}
              />
              {u.displayName ?? '-'} &lt;{u.userName}&gt;
            </label>
          ))}
          {available.length === 0 && <span className="hint">{t('admin.noResults')}</span>}
        </div>
        <div className="transfer-actions">
          <button className="tb" onClick={add} disabled={leftChecked.size === 0} title={t('admin.addTarget')}>
            &gt;
          </button>
          <button className="tb" onClick={remove} disabled={rightChecked.size === 0} title={t('admin.removeTarget')}>
            &lt;
          </button>
        </div>
        <div className="picker-list boxed">
          {memo.map((address) => (
            <label key={address} className="checkbox">
              <input
                type="checkbox"
                checked={rightChecked.has(address)}
                onChange={() => toggleIn(rightChecked, setRightChecked, address)}
              />
              {names[address] ?? '-'} &lt;{address}&gt;
            </label>
          ))}
          {memo.length === 0 && <span className="hint">{t('admin.noTargetsYet')}</span>}
        </div>
      </div>
      <p className="hint">{t('admin.selected', { list: memo.length ? memo.join(', ') : t('common.none') })}</p>
      <p className="hint">{t('admin.aliasNote')}</p>
      {msg && <div className={checked === aliasAddress ? 'info' : 'error'}>{msg}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- ADM-5 메일 로그

interface MailLog {
  mailId: string;
  subject: string | null;
  date: string | null;
  from: string | null;
  /** 발신자 표시이름(MAIL_FROM_DISP). 있으면 이름을 보여 주고 계정은 힌트로 돌린다 */
  fromDisplay: string | null;
  to: string | null;
  toDisplay: string | null;
  /** II 내부메일 · IO 외부로 발송 · OI 외부에서 수신 (JAMES_MAIL.MAIL_TYPE) */
  mailType: string | null;
  recipientCount: number;
}

type MailType = 'II' | 'IO' | 'OI';
const MAIL_TYPE_LABEL: Record<MailType, MessageKey> = {
  II: 'admin.typeInternal',
  IO: 'admin.typeOutbound',
  OI: 'admin.typeInbound',
};

/** 모르는 값은 그대로 보여 준다 — 판정이 안 된 메일(빈 값)은 빈 칸이 된다 */
function mailTypeLabel(value: string | null): string {
  if (!value) return '';
  const key = MAIL_TYPE_LABEL[value as MailType];
  return key ? t(key) : value;
}

function Mails() {
  const t = useT();
  const [mails, setMails] = useState<MailLog[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MailLog | null>(null);
  const [field, setField] = useState<'all' | 'from' | 'to' | 'subject'>('all');
  const [type, setType] = useState<'all' | MailType>('all');
  const [keyword, setKeyword] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [applied, setApplied] = useState({ field: 'all', type: 'all', keyword: '', fromDate: '', toDate: '' });
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({
          field: applied.field,
          type: applied.type,
          limit: String(PAGE),
          offset: String(offset),
        });
        if (applied.keyword) qs.set('keyword', applied.keyword);
        if (applied.fromDate) qs.set('fromDate', applied.fromDate);
        if (applied.toDate) qs.set('toDate', applied.toDate);
        const page = await api.get<MailLog[]>(`/api/admin/mails?${qs}`);
        setMails((prev) => (offset === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE);
      } catch (cause) {
        setMsg(cause instanceof ApiError ? cause.message : t('common.queryFailed'));
        setHasMore(true);
      } finally {
        setLoading(false);
      }
    },
    [applied],
  );
  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <div className="tab tab-wide">
      <h2>{t('admin.mails')}</h2>
      <div className="toolbar">
        <div className="search">
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="all">{t('common.all')}</option>
            <option value="II">{t('admin.typeInternal')}</option>
            <option value="IO">{t('admin.typeOutbound')}</option>
            <option value="OI">{t('admin.typeInbound')}</option>
          </select>
          <select value={field} onChange={(e) => setField(e.target.value as typeof field)}>
            <option value="all">{t('common.all')}</option>
            <option value="from">{t('admin.sender')}</option>
            <option value="to">{t('admin.recipient')}</option>
            <option value="subject">{t('common.subject')}</option>
          </select>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('admin.keyword')} />
          <span className="hint">{t('admin.period')}</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          ~
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <button className="btn" onClick={() => setApplied({ field, type, keyword, fromDate, toDate })}>
            {t('common.search')}
          </button>
        </div>
        <button
          className="danger tb"
          disabled={selected.size === 0}
          onClick={async () => {
            if (!confirm(t('admin.confirmDeleteMails', { n: selected.size }))) return;
            setMsg(null);
            try {
              await api.post('/api/admin/mails/delete', { mailIds: [...selected] });
              setSelected(new Set());
              await load(0);
            } catch (cause) {
              setMsg(cause instanceof ApiError ? cause.message : t('common.deleteFailed'));
            }
          }}
        >
          {t('common.delete')}
        </button>
      </div>
      {msg && <div className="error">{msg}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={mails.length > 0 && selected.size === mails.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(mails.map((m) => m.mailId)) : new Set())}
              />
            </th>
            <th>{t('common.subject')}</th>
            <th>{t('common.date')}</th>
            <th>{t('admin.sender')}</th>
            <th>{t('admin.recipient')}</th>
            <th>{t('admin.recipientCount')}</th>
            <th>{t('admin.mailType')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {mails.map((m) => (
            <tr key={m.mailId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(m.mailId)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      next.has(m.mailId) ? next.delete(m.mailId) : next.add(m.mailId);
                      return next;
                    })
                  }
                />
              </td>
              <td>{m.subject}</td>
              <td>{formatFullDate(m.date)}</td>
              <td title={m.from ?? undefined}>{displayNameOnly(m.fromDisplay, m.from)}</td>
              <td title={m.to ?? undefined}>{displayNameOnly(m.toDisplay, m.to)}</td>
              <td>{m.recipientCount}</td>
              <td>{mailTypeLabel(m.mailType)}</td>
              <td>
                <button className="link" onClick={() => setViewing(m)}>
                  {t('admin.viewMail')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <div className="list-status">{t('common.loading')}</div>}
      {!loading && hasMore && (
        <button className="more" onClick={() => load(mails.length)}>
          {t('common.more')}
        </button>
      )}
      {viewing && <MailViewModal mail={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * ADM-5 메일 읽기. 관리자 원문 API 로 바이트만 받아 사용자 읽기 화면과 같은 경로로
 * (워커 파싱 → sandbox iframe) 보여 준다. 서버가 플래그를 건드리지 않으므로
 * 수신자의 수신확인은 찍히지 않는다 (2-16). 원문 파일은 푸터에서 따로 내려받는다.
 */
function MailViewModal({ mail, onClose }: { mail: MailLog; onClose: () => void }) {
  const t = useT();
  const [body, setBody] = useState<LoadedBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlsRef = useRef<string[]>([]);
  const rawUrl = `/api/admin/mails/${encodeURIComponent(mail.mailId)}/raw`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(rawUrl, { credentials: 'include' });
        if (!response.ok) throw new Error(t('read.rawFailed'));
        const { body: loaded, urls } = await buildLoadedBody(await response.arrayBuffer());
        if (cancelled) {
          for (const url of urls) URL.revokeObjectURL(url);
          return;
        }
        urlsRef.current = urls;
        setBody(loaded);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('read.rawFailed'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawUrl, t]);

  // 첨부 blob URL 은 팝업을 닫을 때 회수한다
  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  /**
   * 읽기 화면은 목록과 달리 원문 헤더를 그대로 보여 준다 — 이름만 남기지 않는다.
   * 파싱이 끝나면 eml 헤더의 이름·계정을, 그 전에는 로그 행의 값을 쓴다.
   */
  const from = body
    ? displayAddress(body.mail.from?.name ?? null, body.mail.from?.address ?? null)
    : displayAddress(mail.fromDisplay, mail.from);
  const to = body
    ? body.mail.to.map((recipient) => displayAddress(recipient.name, recipient.address)).join(', ')
    : displayAddress(mail.toDisplay, mail.to);

  return (
    <Modal
      title={mail.subject || t('common.noSubject')}
      onClose={onClose}
      width={880}
      className="mail-view"
      footer={
        <>
          <button className="btn" onClick={() => window.location.assign(rawUrl)}>
            {t('read.saveEml')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className="reading-meta">
        <div>
          {t('admin.sender')}: {from}
        </div>
        <div className="reading-meta-row">
          <span className="meta-to" title={to}>
            {t('admin.recipient')}: {to}
          </span>
          <span className="meta-date">
            {t('common.date')}: {formatFullDate(mail.date)}
          </span>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!error && !body && <div className="reading-status">{t('read.parsing')}</div>}
      {body && (
        <>
          {body.mail.warnings.map((warning, index) => (
            <div key={index} className="warn">
              {t(warning as MessageKey)}
            </div>
          ))}
          {body.attachmentUrls.length > 0 && (
            <div className="attachments">
              <strong>{t('read.attachments')}</strong>
              <ul>
                {body.attachmentUrls.map((attachment, index) => (
                  <li key={index}>
                    {/* blob: 첨부는 다운로드만 허용한다. 새 탭으로 열지 않는다 (2-3) */}
                    <a href={attachment.url} download={attachment.filename}>
                      {attachment.filename}
                    </a>
                    <span className="size">{formatBytes(attachment.size)}</span>
                    <a className="link" href={attachment.url} download={attachment.filename}>
                      {t('read.savePc')}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <BodyViewer mail={body.mail} cidUrls={body.cidUrls} />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- ADM-6 수신거부

interface DropEntry {
  id: number;
  type: string;
  entity: string;
}

function DropList() {
  const t = useT();
  const [rows, setRows] = useState<DropEntry[]>([]);
  const [type, setType] = useState<'ALL' | 'DOMAIN' | 'ADDRESS'>('ALL');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [entity, setEntity] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.get<DropEntry[]>(`/api/admin/droplist?type=${type}`).then(setRows), [type]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setMsg(null);
    const value = entity.trim();
    if (value.length < 3) return setMsg(t('admin.needEntity'));
    if (value.includes('@') && !EMAIL_RE.test(value)) return setMsg(t('addressbook.invalidEmail'));
    try {
      await api.post('/api/admin/droplist', { entity: value });
      setEntity('');
      setAddOpen(false);
      await load();
    } catch (cause) {
      setMsg(cause instanceof ApiError ? cause.message : t('admin.addFailed'));
    }
  }

  async function removeSelected() {
    if (selected.size === 0) return;
    if (!confirm(t('admin.confirmDeleteN', { n: selected.size }))) return;
    for (const id of selected) await api.del(`/api/admin/droplist/${id}`).catch(() => undefined);
    setSelected(new Set());
    await load();
  }

  return (
    <div className="tab">
      <h2>{t('admin.droplist')}</h2>
      <p className="hint">{t('admin.dropDescription')}</p>
      <div className="toolbar">
        <div className="search">
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="ALL">{t('common.all')}</option>
            <option value="DOMAIN">{t('admin.domain')}</option>
            <option value="ADDRESS">{t('admin.account')}</option>
          </select>
        </div>
        <button className="danger tb" disabled={selected.size === 0} onClick={removeSelected}>
          {t('common.delete')}
        </button>
        <button className="primary" onClick={() => setAddOpen(true)}>
          {t('common.add')}
        </button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={rows.length > 0 && selected.size === rows.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              />
            </th>
            <th>{t('admin.blockedEntity')}</th>
            <th>{t('admin.kind')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                      return next;
                    })
                  }
                />
              </td>
              <td>{r.entity}</td>
              <td>{t(r.type === 'DOMAIN' ? 'admin.domain' : 'admin.account')}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="hint">
                {t('admin.noDropEntries')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {addOpen && (
        <Modal
          title={t('admin.blockedEntity')}
          onClose={() => setAddOpen(false)}
          width={420}
          footer={
            <>
              <button className="primary" onClick={add}>
                {t('common.save')}
              </button>
              <button className="btn" onClick={() => setAddOpen(false)}>{t('common.close')}</button>
            </>
          }
        >
          <p className="hint">{t('admin.dropHint')}</p>
          <input
            className="wide"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={t('admin.dropPlaceholder')}
            autoFocus
          />
          {msg && <div className="error">{msg}</div>}
        </Modal>
      )}
    </div>
  );
}
