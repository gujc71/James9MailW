/**
 * 수신거부 (USR-20). 지정된 메일 계정이나 도메인에서 오는 메일을 완전 삭제 · 삭제함 · 스팸함으로 처리한다.
 * 사용/사용 안 함 은 GU_USER_SETTING.REJECT_USE_YN 에 저장되고, 목록의 스팸차단 메뉴 노출도 이 값을 따른다.
 */
import type { Mailbox, Me } from '../../../api/types';
import { RuleListPage } from '../rules/RuleListPage';
import { UseToggle } from './UseToggle';
import { useT } from '../../../i18n';

export function RejectTab({ me, mailboxes, onMeChanged }: { me: Me; mailboxes: Mailbox[]; onMeChanged: (me: Me) => void }) {
  const t = useT();
  return (
    <RuleListPage
      title={t('settings.reject')}
      mode="reject"
      listKey="rejects"
      notes={[t('rules.noteReject')]}
      addLabel={t('reject.add')}
      emptyText={t('reject.empty')}
      description={t('reject.description')}
      mailboxes={mailboxes}
      header={<UseToggle label={t('settings.reject')} me={me} settingKey="rejectUseYn" onMeChanged={onMeChanged} />}
      makeRule={(order) => ({
        screen: 'REJECT',
        order,
        enabled: true,
        name: t('reject.ruleName', { n: order }),
        conditions: [{ field: 'FROM', values: [] }],
        action: { type: 'DELETE' },
      })}
    />
  );
}
