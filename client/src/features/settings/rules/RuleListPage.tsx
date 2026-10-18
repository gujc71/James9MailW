/**
 * 규칙 목록형 화면(자동분류 · 수신거부 · 포워딩)의 본체.
 * 화면마다 편집하는 목록(filters / rejects / forwards)과 새 규칙 기본값만 다르다.
 *
 * 메인은 규칙 목록(표)이고, 행을 고르면 수정 팝업이 · 추가 버튼을 누르면 새 규칙 팝업이 열린다.
 * 저장은 팝업에서 규칙 한 건 단위로 하고, useRules 가 모델 전체를 보내므로 다른 화면 규칙은
 * 그대로 유지된다. 목록의 사용 체크박스와 삭제도 그 자리에서 바로 저장한다.
 */
import { useState, type ReactNode } from 'react';
import type { Mailbox } from '../../../api/types';
import { EMAIL_RE } from '../../common/AddressBook';
import { RuleEditor, type RuleMode } from './RuleEditor';
import { RulePage } from './RulePage';
import { describeAction, describeConditions, describePeriod, type Model, type Rule } from './types';
import { useRules } from './useRules';
import { t, useT } from '../../../i18n';

/** 저장 전 검증 (USR-3.4.1 · USR-21 검증 규칙). 오류 문구를 돌려준다 */
export function validateRule(rule: Rule, mode: RuleMode): string | null {
  if (!rule.name.trim()) return t('rules.needName');
  for (const cond of rule.conditions) {
    if (cond.field !== 'HAS_ATTACH' && cond.values.filter(Boolean).length === 0)
      return t('rules.needValue');
  }
  if (mode !== 'forward' && rule.conditions.length === 0) return t('rules.needCondition');
  if (rule.action.type === 'FORWARD' && !EMAIL_RE.test(rule.action.address))
    return t('rules.badForwardAddress');
  if ((rule.startDate && !rule.endDate) || (!rule.startDate && rule.endDate))
    return t('rules.needBothDates');
  if (rule.startDate && rule.endDate && rule.startDate > rule.endDate)
    return t('rules.startAfterEnd');
  return null;
}

/** 편집 중인 규칙. index 가 -1 이면 새로 추가하는 규칙이다 */
type Editing = { index: number; rule: Rule };

export function RuleListPage({
  title,
  mode,
  listKey,
  notes,
  addLabel,
  emptyText,
  makeRule,
  mailboxes,
  header,
  description,
}: {
  title: string;
  mode: RuleMode;
  listKey: 'filters' | 'rejects' | 'forwards';
  notes: string[];
  addLabel: string;
  emptyText: string;
  makeRule: (order: number) => Rule;
  mailboxes: Mailbox[];
  header?: ReactNode;
  description?: string;
}) {
  const t = useT();
  const { model, msg, setMsg, save } = useRules();
  const [editing, setEditing] = useState<Editing | null>(null);

  if (!model) return <div className="tab">{t('common.loading')}</div>;

  const rules = model[listKey];

  /** 바뀐 목록을 순번 다시 매겨 저장한다 */
  function commit(next: Rule[]) {
    const ordered = next.map((rule, i) => ({ ...rule, order: i + 1 }));
    return save({ [listKey]: ordered } as Partial<Model>);
  }

  /** 팝업의 저장. 검증에 걸리면 저장하지 않고 팝업에 사유를 돌려준다 */
  async function saveRule(edited: Rule): Promise<string | null> {
    const problem = validateRule(edited, mode);
    if (problem) return problem;
    const index = editing?.index ?? -1;
    const next = index < 0 ? [...rules, edited] : rules.map((r, i) => (i === index ? edited : r));
    const failure = await commit(next);
    if (!failure) setEditing(null);
    return failure;
  }

  function remove(index: number) {
    const target = rules[index];
    if (!target || !window.confirm(t('rules.confirmDelete', { name: target.name }))) return;
    void commit(rules.filter((_, i) => i !== index));
  }

  function toggle(index: number, enabled: boolean) {
    void commit(rules.map((r, i) => (i === index ? { ...r, enabled } : r)));
  }

  return (
    <RulePage title={title} notes={notes} msg={msg}>
      {description && <p className="hint">{description}</p>}
      {header}

      <div className="toolbar right">
        <span className="hint">{t('rules.total', { n: rules.length })}</span>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setMsg(null);
            setEditing({ index: -1, rule: makeRule(rules.length + 1) });
          }}
        >
          {addLabel}
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="hint">{emptyText}</p>
      ) : (
        <table className="grid rule-grid">
          <thead>
            <tr>
              <th style={{ width: 48 }}>{t('rules.order')}</th>
              <th style={{ width: 160 }}>{t('rules.name')}</th>
              <th>{t('rules.condition')}</th>
              <th style={{ width: 200 }}>{t('rules.action')}</th>
              {mode === 'forward' && <th style={{ width: 150 }}>{t('rules.period')}</th>}
              <th style={{ width: 56 }}>{t('common.use')}</th>
              <th style={{ width: 84 }} />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule, index) => (
              <tr
                key={index}
                className="clickable"
                title={t('rules.clickToEdit')}
                onClick={() => {
                  setMsg(null);
                  setEditing({ index, rule });
                }}
              >
                <td>{index + 1}</td>
                <td>{rule.name}</td>
                <td>{describeConditions(rule)}</td>
                <td>{describeAction(rule.action, mailboxes)}</td>
                {mode === 'forward' && <td>{describePeriod(rule)}</td>}
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    title={t(rule.enabled ? 'rules.inUse' : 'common.notUse')}
                    onChange={(e) => toggle(index, e.target.checked)}
                  />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="link danger" onClick={() => remove(index)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <RuleEditor
          key={editing.index}
          rule={editing.rule}
          mode={mode}
          title={t(editing.index < 0 ? 'rules.addTitle' : 'rules.editTitle', { title })}
          mailboxes={mailboxes}
          onSave={saveRule}
          onClose={() => setEditing(null)}
        />
      )}
    </RulePage>
  );
}
