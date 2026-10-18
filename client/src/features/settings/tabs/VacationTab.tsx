/** 부재중 응답 (USR-19). 한 건만 설정되고, 자동분류의 자동회신과는 함께 쓸 수 없다. */
import { useRef } from 'react';
import { HtmlEditor, type HtmlEditorHandle } from '../../compose/editor/HtmlEditor';
import { RulePage } from '../rules/RulePage';
import type { Vacation } from '../rules/types';
import { useRules } from '../rules/useRules';
import { t, useT } from '../../../i18n';

/** 아직 한 건도 없을 때 쓰는 기본값. 이름·제목은 지금 언어로 만든다 */
function emptyVacation(): Vacation {
  return {
    enabled: true,
    name: t('vacation.name'),
    order: 99,
    subject: t('vacation.defaultSubject'),
    body: '',
    days: 3,
    startDate: null,
    endDate: null,
  };
}

export function VacationTab() {
  const t = useT();
  const { model, msg, update, save } = useRules();
  // 본문 HTML 의 원본은 메일쓰기와 같은 에디터가 쥐고 있다 (model.vacation.body 는 뒤처진 사본)
  const bodyRef = useRef<HtmlEditorHandle>(null);

  if (!model) return <div className="tab">{t('common.loading')}</div>;

  const vacation = model.vacation;
  const setVacation = (patch: Partial<Vacation>) =>
    update({ vacation: { ...(vacation ?? emptyVacation()), ...patch } });
  /** 에디터의 onChange 는 잠시 묶여서 올라온다. 저장·해제 직전에는 그 순간의 값을 직접 읽는다 */
  const currentBody = () => bodyRef.current?.getHtml() ?? vacation?.body ?? '';

  return (
    <RulePage
      title={t('settings.vacation')}
      notes={[t('rules.noteVacationConflict')]}
      msg={msg}
      onSave={() => {
        void save({ vacation: { ...(vacation ?? emptyVacation()), body: currentBody() } });
      }}
    >
      <label className="checkbox">
        <input
          type="checkbox"
          checked={Boolean(vacation?.enabled)}
          // 끄면 에디터가 화면에서 빠진다. 빠지기 전에 쓰던 본문을 건져 둔다
          onChange={(e) => setVacation({ enabled: e.target.checked, body: currentBody() })}
        />
        {t('common.use')}
      </label>
      {vacation?.enabled && (
        <>
          <div className="form-row">
            <label>{t('vacation.period')}</label>
            <input
              type="date"
              value={vacation.startDate ?? ''}
              onChange={(e) => setVacation({ startDate: e.target.value || null })}
            />
            ~
            <input
              type="date"
              value={vacation.endDate ?? ''}
              onChange={(e) => setVacation({ endDate: e.target.value || null })}
            />
          </div>
          <div className="form-row">
            <label>{t('common.subject')}</label>
            <input
              value={vacation.subject}
              onChange={(e) => setVacation({ subject: e.target.value })}
              placeholder={t('vacation.defaultSubject')}
            />
          </div>
          <HtmlEditor
            ref={bodyRef}
            initialHtml={vacation.body}
            onChange={(html) => setVacation({ body: html })}
            placeholder={t('vacation.bodyPlaceholder')}
          />
        </>
      )}
    </RulePage>
  );
}
