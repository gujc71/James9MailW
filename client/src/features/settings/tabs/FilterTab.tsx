/** 자동분류 (USR-3.4). 조건에 맞는 수신 메일을 지정한 편지함으로 넣는다 (Apache James Sieve). */
import type { Mailbox } from '../../../api/types';
import { RuleListPage } from '../rules/RuleListPage';
import { useT } from '../../../i18n';

export function FilterTab({ mailboxes }: { mailboxes: Mailbox[] }) {
  const t = useT();
  const inbox = mailboxes.find((b) => b.role === 'INBOX')?.name ?? 'INBOX';
  return (
    <RuleListPage
      title={t('settings.filter')}
      mode="filter"
      listKey="filters"
      notes={[t('rules.noteVacationConflict'), t('rules.noteAttach')]}
      addLabel={t('filter.add')}
      emptyText={t('filter.empty')}
      description={t('filter.description')}
      mailboxes={mailboxes}
      makeRule={(order) => ({
        screen: 'FILTER',
        order,
        enabled: true,
        name: t('filter.ruleName', { n: order }),
        conditions: [{ field: 'SUBJECT', values: [] }],
        action: { type: 'FILEINTO', mailboxName: inbox },
      })}
    />
  );
}
