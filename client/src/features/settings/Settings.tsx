/**
 * 사용자 설정 (USR-13). 상단·사이드는 메일 메인화면과 같고(App 이 그린다), 이 컴포넌트는
 * ③ 설정 메뉴(탭) + ④ 설정 화면을 그린다.
 * 탭: 개인정보 · 서명 · 주소록 · 편지함 관리 · 자동분류 · 부재중 · 수신거부 · 포워딩 · 외부메일 · 메일 업로드.
 *
 * 규칙 네 화면은 페이지가 나뉘어 있지만 저장은 같은 Sieve 스크립트 하나로 들어간다
 * (각 화면이 읽어온 모델 전체를 다시 보낸다 → rules/useRules.ts).
 * 목록형 세 화면(자동분류 · 수신거부 · 포워딩)은 규칙 목록을 보여주고, 행을 고르거나
 * 추가 버튼을 누르면 뜨는 팝업에서 규칙 한 건씩 저장한다 (rules/RuleListPage.tsx).
 */
import type { Mailbox, Me } from '../../api/types';
import { useT, type MessageKey } from '../../i18n';
import { ProfileTab } from './tabs/ProfileTab';
import { MailboxTab } from './tabs/MailboxTab';
import { SignatureTab } from './tabs/SignatureTab';
import { AddressBookTab } from './tabs/AddressBookTab';
import { FilterTab } from './tabs/FilterTab';
import { VacationTab } from './tabs/VacationTab';
import { RejectTab } from './tabs/RejectTab';
import { ForwardTab } from './tabs/ForwardTab';
import { ExternalMailTab } from './tabs/ExternalMailTab';
import { UploadTab } from './tabs/UploadTab';

export type SettingsTab =
  | 'profile'
  | 'mailbox'
  | 'signature'
  | 'addressbook'
  | 'filter'
  | 'vacation'
  | 'reject'
  | 'forward'
  | 'external'
  | 'upload';

const TABS: { key: SettingsTab; label: MessageKey }[] = [
  { key: 'profile', label: 'settings.profile' },
  { key: 'signature', label: 'settings.signature' },
  { key: 'addressbook', label: 'settings.addressbook' },
  { key: 'mailbox', label: 'settings.mailbox' },
  { key: 'filter', label: 'settings.filter' },
  { key: 'vacation', label: 'settings.vacation' },
  { key: 'reject', label: 'settings.reject' },
  { key: 'forward', label: 'settings.forward' },
  { key: 'external', label: 'settings.external' },
  { key: 'upload', label: 'settings.upload' },
];

/** 주소 해시(#/settings/mailbox)에서 읽은 탭 이름을 검사한다 (lib/hashRoute.ts) */
export function isSettingsTab(value: string | null): value is SettingsTab {
  return TABS.some((item) => item.key === value);
}

export function Settings({
  me,
  tab,
  onTab,
  mailboxes,
  onMailboxesChanged,
  onMeChanged,
}: {
  me: Me;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  mailboxes: Mailbox[];
  onMailboxesChanged: () => void;
  onMeChanged: (me: Me) => void;
}) {
  const t = useT();
  return (
    <div className="settings-main">
      <nav className="settings-tabs">
        {TABS.map((item) => (
          <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => onTab(item.key)}>
            {t(item.label)}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === 'profile' && <ProfileTab me={me} onMeChanged={onMeChanged} />}
        {tab === 'mailbox' && <MailboxTab mailboxes={mailboxes} onChanged={onMailboxesChanged} />}
        {tab === 'signature' && <SignatureTab me={me} onMeChanged={onMeChanged} />}
        {tab === 'addressbook' && <AddressBookTab me={me} onMeChanged={onMeChanged} />}
        {tab === 'filter' && <FilterTab mailboxes={mailboxes} />}
        {tab === 'vacation' && <VacationTab />}
        {tab === 'reject' && <RejectTab me={me} mailboxes={mailboxes} onMeChanged={onMeChanged} />}
        {tab === 'forward' && <ForwardTab me={me} mailboxes={mailboxes} onMeChanged={onMeChanged} />}
        {tab === 'external' && <ExternalMailTab mailboxes={mailboxes} />}
        {tab === 'upload' && <UploadTab mailboxes={mailboxes} />}
      </div>
    </div>
  );
}
