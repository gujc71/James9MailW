/**
 * 포워딩 (USR-21). 수신 메일을 지정한 주소로 재전송한다. 사본 보관을 끄면 로컬에 남지 않는다.
 * 조건 없음 = 수신한 모든 메일, 기간 없음 = 무제한.
 */
import type { Mailbox, Me } from '../../../api/types';
import { RuleListPage } from '../rules/RuleListPage';
import { UseToggle } from './UseToggle';
import { useT } from '../../../i18n';

export function ForwardTab({ me, mailboxes, onMeChanged }: { me: Me; mailboxes: Mailbox[]; onMeChanged: (me: Me) => void }) {
  const t = useT();
  return (
    <RuleListPage
      title={t('settings.forward')}
      mode="forward"
      listKey="forwards"
      notes={[t('rules.noteForward')]}
      addLabel={t('forward.add')}
      emptyText={t('forward.empty')}
      description={t('forward.description')}
      mailboxes={mailboxes}
      header={<UseToggle label={t('settings.forward')} me={me} settingKey="forwardUseYn" onMeChanged={onMeChanged} />}
      makeRule={(order) => ({
        screen: 'FORWARD',
        order,
        enabled: true,
        name: t('forward.ruleName', { n: order }),
        conditions: [],
        action: { type: 'FORWARD', address: '', keepCopy: true },
        startDate: null,
        endDate: null,
      })}
    />
  );
}
