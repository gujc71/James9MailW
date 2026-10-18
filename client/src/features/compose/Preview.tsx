/** 발송 전 미리보기 (USR-1.4.3). 수신자에게 보이는 형태로 sandbox iframe 에 그린다 */
import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { Modal } from '../common/Modal';
import { useT } from '../../i18n';

export function Preview({
  from,
  to,
  cc,
  subject,
  html,
  signatureHtml,
  attachments,
  onClose,
}: {
  from: string;
  to: string;
  cc: string;
  subject: string;
  html: string;
  signatureHtml: string | null;
  attachments: string[];
  onClose: () => void;
}) {
  const t = useT();
  const srcDoc = useMemo(() => {
    // 서명은 발송 경로(server/src/services/compose.ts decorateBody)와 같이 본문 맨 끝에 붙인다 —
    // 미리보기가 실제로 나갈 메일과 달라지면 미리 볼 이유가 없다
    const combined = signatureHtml
      ? `${html}<div class="j9-signature">${signatureHtml}</div>`
      : html;
    const clean = DOMPurify.sanitize(combined, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    });
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; script-src 'none'">
      <style>body{margin:0;padding:12px;font-family:system-ui,'Malgun Gothic',sans-serif;font-size:14px;line-height:1.6;color:#111;word-break:break-word}img{max-width:100%}</style>
      </head><body>${clean}</body></html>`;
  }, [html, signatureHtml]);

  return (
    <Modal
      title={t('compose.preview')}
      onClose={onClose}
      width={720}
      footer={<button className="btn" onClick={onClose}>{t('common.close')}</button>}
    >
      <div className="reading-meta">
        <div>
          {t('common.from')}: {from}
        </div>
        <div>
          {t('common.to')}: {to || '-'}
        </div>
        {cc && (
          <div>
            {t('common.cc')}: {cc}
          </div>
        )}
        <div>
          {t('common.subject')}: {subject || t('common.noSubject')}
        </div>
        {attachments.length > 0 && (
          <div>
            {t('preview.attachments')}: {attachments.join(', ')}
          </div>
        )}
      </div>
      <iframe title="preview" sandbox="" srcDoc={srcDoc} style={{ width: '100%', height: 360, border: 'none' }} />
    </Modal>
  );
}
