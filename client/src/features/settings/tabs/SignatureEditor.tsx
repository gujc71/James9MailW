/**
 * 서명 한 건을 쓰는 팝업 (USR-17). 서명관리 목록에서 [추가] 를 누르거나 행을 고르면 열린다.
 *
 * 내용은 메일쓰기와 같은 리치 텍스트 에디터로 쓴다 — 서명은 그대로 본문에 들어가는 HTML 이라
 * 여기서 본 모양이 메일에서 나올 모양이다. 에디터가 원본을 쥐고 있으므로(HtmlEditor 주석)
 * 저장 직전에 ref 로 그 순간의 값을 읽는다.
 *
 * 편집 중 값은 팝업 안에만 둔다. 취소하면 목록은 그대로다.
 */
import { useRef, useState } from 'react';
import type { Signature } from '../../../api/types';
import { Modal } from '../../common/Modal';
import { HtmlEditor, type HtmlEditorHandle } from '../../compose/editor/HtmlEditor';
import { useT } from '../../../i18n';

export interface SignatureDraft {
  name: string;
  content: string;
}

export function SignatureEditor({
  signature,
  placeholder,
  onSave,
  onClose,
}: {
  /** 고칠 서명. null 이면 새로 쓰는 것이다 */
  signature: Signature | null;
  placeholder: string;
  /** 저장. 성공하면 null, 실패하면 팝업에 띄울 오류 문구를 돌려준다 */
  onSave: (draft: SignatureDraft) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(signature?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HtmlEditorHandle>(null);

  async function submit() {
    if (!name.trim()) {
      setError(t('signature.needName'));
      return;
    }
    setBusy(true);
    const problem = await onSave({
      name: name.trim(),
      content: contentRef.current?.getHtml() ?? signature?.content ?? '',
    });
    setBusy(false);
    setError(problem);
  }

  return (
    <Modal
      title={t(signature ? 'signature.editTitle' : 'signature.addTitle')}
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
      <div className="rule-form sig-form">
        <div className="form-row">
          <label>{t('signature.nameRequired')}</label>
          <input
            value={name}
            autoFocus
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('signature.namePlaceholder')}
          />
        </div>
        <div className="form-row sig-body">
          <label>{t('signature.content')}</label>
          <HtmlEditor
            initialHtml={signature?.content ?? ''}
            onChange={() => undefined}
            placeholder={placeholder}
            ref={contentRef}
          />
        </div>
      </div>
    </Modal>
  );
}
