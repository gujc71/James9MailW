/**
 * 규칙 한 건을 고치는 팝업. 자동분류 · 수신거부 · 포워딩 세 화면이 같이 쓴다 (POPUP-2 조건 구조).
 * 목록에서 행을 고르거나 추가 버튼을 누르면 열리고, 저장하면 그 규칙 한 건만 반영된다.
 *
 * 조건 행은 최대 5개, 행끼리 AND, 한 행의 값은 콤마 구분(OR).
 *  - filter : 조건 → [편지함](으)로 저장
 *  - reject : 조건 → 완전 삭제 / 삭제함에 저장 / 스팸함에 저장
 *  - forward: 수신한 모든 메일 / 조건 선택 → 포워딩 받을 주소, 기간(무제한 / 기간 선택)
 *
 * 편집 중 값은 이 팝업 안에만 두기 때문에 취소하면 목록은 그대로다.
 */
import { useState } from 'react';
import type { Mailbox } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { FIELDS, fieldLabel, type Field, type Rule } from './types';
import { t, useT } from '../../../i18n';

export type RuleMode = 'filter' | 'reject' | 'forward';

const DEFAULT_FIELD: Record<RuleMode, Field> = { filter: 'SUBJECT', reject: 'FROM', forward: 'SUBJECT' };

function verb(field: Field): string {
  if (field === 'HAS_ATTACH') return t('rules.verbIs');
  return field === 'SUBJECT' || field === 'FROM_NAME' ? t('rules.verbContains') : t('rules.verbIs');
}

export function RuleEditor({
  rule: initial,
  mode,
  title,
  mailboxes,
  onSave,
  onClose,
}: {
  rule: Rule;
  mode: RuleMode;
  title: string;
  mailboxes: Mailbox[];
  /** 저장. 성공하면 null, 실패하면 팝업에 띄울 오류 문구를 돌려준다 */
  onSave: (rule: Rule) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useT();
  const [rule, setRule] = useState<Rule>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onChange = (patch: Partial<Rule>) => setRule((prev) => ({ ...prev, ...patch }));

  const trashName = mailboxes.find((b) => b.role === 'Trash')?.name ?? 'Trash';
  const spamName = mailboxes.find((b) => b.role === 'Spam')?.name ?? 'Spam';
  const allMail = mode === 'forward' && rule.conditions.length === 0;
  const unlimited = !rule.startDate && !rule.endDate;

  const rejectAction =
    rule.action.type === 'DELETE' ? 'DELETE' : rule.action.type === 'SPAM' ? 'SPAM' : 'TRASH';

  function setRejectAction(value: string) {
    if (value === 'DELETE') onChange({ action: { type: 'DELETE' } });
    else if (value === 'SPAM') onChange({ action: { type: 'SPAM', mailboxName: spamName } });
    else onChange({ action: { type: 'FILEINTO', mailboxName: trashName } });
  }

  async function submit() {
    setBusy(true);
    const problem = await onSave(rule);
    setBusy(false);
    setError(problem);
  }

  /**
   * 조건 한 행. 네 칸(항목 · 값 · 서술 · 삭제)을 그리드로 고정해 행끼리 세로로 맞춘다.
   * 첨부파일 조건은 값이 없으므로 값 칸을 빈 칸으로 둔다.
   */
  const conditionRows = rule.conditions.map((cond, ci) => (
    <div className="cond" key={ci}>
      <select
        value={cond.field}
        onChange={(e) => {
          const conds = [...rule.conditions];
          conds[ci] = { ...cond, field: e.target.value as Field };
          onChange({ conditions: conds });
        }}
      >
        {FIELDS.map((field) => (
          <option key={field} value={field}>
            {fieldLabel(field)}
          </option>
        ))}
      </select>
      {cond.field === 'HAS_ATTACH' ? (
        <span />
      ) : (
        <input
          placeholder={t('rules.valuePlaceholder')}
          value={cond.values.join(', ')}
          onChange={(e) => {
            const conds = [...rule.conditions];
            conds[ci] = { ...cond, values: e.target.value.split(',').map((v) => v.trim()) };
            onChange({ conditions: conds });
          }}
        />
      )}
      <span className="hint">{verb(cond.field)}</span>
      <button
        type="button"
        className="link danger"
        disabled={mode !== 'forward' && rule.conditions.length <= 1}
        title={mode !== 'forward' && rule.conditions.length <= 1 ? t('rules.keepOneCondition') : undefined}
        onClick={() => onChange({ conditions: rule.conditions.filter((_, i) => i !== ci) })}
      >
        {t('common.delete')}
      </button>
    </div>
  ));

  const addCondition = () =>
    onChange({ conditions: [...rule.conditions, { field: DEFAULT_FIELD[mode], values: [] }] });

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={680}
      footer={
        <>
          {error && <span className="error">{error}</span>}
          <button className="btn" type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" onClick={submit} disabled={busy}>
            {busy ? t('rules.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {/* 모든 줄을 '라벨 + 내용' 한 가지 틀로 맞춘다. 라디오·날짜는 row-body 안에 묶어 라벨 칸을 넘지 않게 한다 */}
      <div className="rule-form">
        <div className="form-row">
          <label>{t('rules.nameRequired')}</label>
          <input
            value={rule.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={t('rules.name')}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            {t('common.use')}
          </label>
        </div>

        {mode === 'forward' && (
          <div className="form-row">
            <label>{t('rules.forwardHandling')}</label>
            <div className="row-body">
              <label className="checkbox">
                <input type="radio" checked={allMail} onChange={() => onChange({ conditions: [] })} />
                {t('rules.allIncoming')}
              </label>
              <label className="checkbox">
                <input type="radio" checked={!allMail} onChange={() => allMail && addCondition()} />
                {t('rules.pickConditions')}
              </label>
            </div>
          </div>
        )}

        {!allMail && (
          <div className="form-row top">
            <label>{t('rules.condition')}</label>
            <div className="rule-conds">
              {conditionRows}
              {rule.conditions.length < 5 && (
                <button type="button" className="link" onClick={addCondition}>
                  {t('rules.addCondition')}
                </button>
              )}
            </div>
          </div>
        )}

        {mode === 'forward' && rule.action.type === 'FORWARD' && (
          <div className="form-row">
            <label>{t('rules.forwardAddress')}</label>
            <input
              placeholder="user@example.com"
              value={rule.action.address}
              onChange={(e) =>
                onChange({
                  action: {
                    type: 'FORWARD',
                    address: e.target.value,
                    keepCopy: (rule.action as { keepCopy: boolean }).keepCopy,
                  },
                })
              }
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rule.action.keepCopy}
                onChange={(e) =>
                  onChange({
                    action: {
                      type: 'FORWARD',
                      address: (rule.action as { address: string }).address,
                      keepCopy: e.target.checked,
                    },
                  })
                }
              />
              {t('rules.keepCopy')}
            </label>
          </div>
        )}

        {mode === 'reject' && (
          <div className="form-row">
            <label>{t('rules.mailHandling')}</label>
            <select value={rejectAction} onChange={(e) => setRejectAction(e.target.value)}>
              <option value="DELETE">{t('rules.purge')}</option>
              <option value="TRASH">{t('rules.toTrash')}</option>
              <option value="SPAM">{t('rules.toSpam')}</option>
            </select>
          </div>
        )}

        {mode === 'filter' && (
          <div className="form-row">
            <label>{t('rules.mailHandling')}</label>
            <select
              value={rule.action.type === 'FILEINTO' || rule.action.type === 'SPAM' ? rule.action.mailboxName : ''}
              onChange={(e) => onChange({ action: { type: 'FILEINTO', mailboxName: e.target.value } })}
            >
              {mailboxes
                .filter((b) => b.role !== 'Drafts')
                .map((b) => (
                  <option key={b.id} value={b.name}>
                    {b.displayName}
                  </option>
                ))}
            </select>
            <span className="hint">{t('rules.saveIntoSuffix')}</span>
          </div>
        )}

        {mode === 'forward' && (
          <div className="form-row">
            <label>{t('rules.forwardPeriod')}</label>
            <div className="row-body">
              <label className="checkbox">
                <input type="radio" checked={unlimited} onChange={() => onChange({ startDate: null, endDate: null })} />
                {t('common.unlimited')}
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  checked={!unlimited}
                  onChange={() => {
                    const today = new Date().toISOString().slice(0, 10);
                    onChange({ startDate: today, endDate: today });
                  }}
                />
                {t('rules.pickPeriod')}
              </label>
              {!unlimited && (
                <span className="date-range">
                  <input
                    type="date"
                    value={rule.startDate ?? ''}
                    onChange={(e) => onChange({ startDate: e.target.value || null })}
                  />
                  ~
                  <input
                    type="date"
                    value={rule.endDate ?? ''}
                    onChange={(e) => onChange({ endDate: e.target.value || null })}
                  />
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
