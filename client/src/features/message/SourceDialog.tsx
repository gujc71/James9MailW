/** 원문 보기 (5-2). 받은 eml 원문을 헤더까지 그대로 팝업에 펼쳐 준다 */
import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { loadRawText } from './useMessageBody';
import { useT } from '../../i18n';

export function SourceDialog({
  mailboxId,
  uid,
  mailId,
  downloadUrl,
  onClose,
}: {
  mailboxId: string;
  uid: number;
  mailId: string;
  downloadUrl: string;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadRawText(mailboxId, uid, mailId)
      .then((raw) => {
        if (!cancelled) setText(raw);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [mailboxId, uid, mailId]);

  async function copy() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // 클립보드 권한이 없으면(비 https 등) 사용자가 직접 선택해 복사하면 된다
    }
  }

  return (
    <Modal
      title={t('read.viewSource')}
      onClose={onClose}
      width={880}
      footer={
        <>
          <button className="btn" onClick={copy} disabled={text === null}>
            {copied ? t('read.sourceCopied') : t('read.sourceCopy')}
          </button>
          <button className="btn" onClick={() => window.location.assign(downloadUrl)}>
            {t('read.saveEml')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      {error ? (
        <div className="error">{error}</div>
      ) : text === null ? (
        <div className="reading-status">{t('read.sourceLoading')}</div>
      ) : (
        <pre className="mail-source">{text}</pre>
      )}
    </Modal>
  );
}
