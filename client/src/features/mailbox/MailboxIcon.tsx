/** 편지함 트리의 역할별 아이콘. 개인 편지함은 모두 폴더 아이콘, null 은 "전체 메일" */
import type { MailboxRole } from '../../api/types';

const PATHS: Record<MailboxRole | 'all', string> = {
  all: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v.51l8 5.33 8-5.33V6H4zm16 2.9-7.45 4.97a1 1 0 0 1-1.1 0L4 8.9V18h16V8.9z',
  INBOX: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z',
  Sent: 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
  Drafts: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  Trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  Spam: 'M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm1-4.3h-2V7h2v6z',
  Outbox: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10zM8 10h3v3h2v-3h3l-4-4-4 4z',
  Archive: 'M20.54 5.23 19.15 3.55A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A1.99 1.99 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  personal: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
};

export function MailboxIcon({ role }: { role: MailboxRole | null }) {
  return (
    <svg className="mbox-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={PATHS[role ?? 'all'] ?? PATHS.personal} />
    </svg>
  );
}
