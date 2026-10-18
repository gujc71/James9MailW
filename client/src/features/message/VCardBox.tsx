/**
 * 연락처 상자 (USR-1.4 v-Card).
 *
 * v-Card 첨부는 .vcf 파일로 내걸어 봐야 내려받아 다른 앱으로 열기 전에는 아무것도 알 수 없다.
 * 썬더버드처럼 이름 · 메일 · 전화를 읽기 화면에 바로 펼쳐 보여 준다. 파싱은 워커가
 * 끝내 놓고(mime/vcard.ts), 여기서는 그리기만 한다.
 */
import type { VCardContact } from '../../mime/parser';
import { useT, type MessageKey } from '../../i18n';

interface Props {
  contacts: VCardContact[];
}

/** 전화 갈래별 라벨 */
const TEL_LABELS: Record<VCardContact['tels'][number]['kind'], MessageKey> = {
  work: 'read.vcardWork',
  home: 'read.vcardHome',
  cell: 'read.vcardCell',
  fax: 'read.vcardFax',
  tel: 'read.vcardTel',
};

export function VCardBox({ contacts }: Props) {
  const t = useT();
  if (contacts.length === 0) return null;

  return (
    <div className="vcards">
      {contacts.map((contact, index) => {
        // 대표 메일은 이름 옆에 붙이고, 나머지만 아래 항목으로 내린다 (썬더버드와 같은 배치)
        const [primaryEmail, ...otherEmails] = contact.emails;
        const fields: { key: MessageKey; value: string; href?: string }[] = [
          ...(contact.title ? [{ key: 'read.vcardTitle' as MessageKey, value: contact.title }] : []),
          ...(contact.org ? [{ key: 'read.vcardOrg' as MessageKey, value: contact.org }] : []),
          ...otherEmails.map((email) => ({
            key: 'read.vcardEmail' as MessageKey,
            value: email,
            href: `mailto:${email}`,
          })),
          ...contact.tels.map((tel) => ({
            key: TEL_LABELS[tel.kind],
            value: tel.value,
            href: `tel:${tel.value.replace(/[^\d+]/g, '')}`,
          })),
          ...contact.addresses.map((address) => ({ key: 'read.vcardAddress' as MessageKey, value: address })),
          ...contact.urls.map((url) => ({
            key: 'read.vcardUrl' as MessageKey,
            value: url,
            href: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          })),
          ...(contact.bday ? [{ key: 'read.vcardBday' as MessageKey, value: contact.bday }] : []),
          ...(contact.note ? [{ key: 'read.vcardNote' as MessageKey, value: contact.note }] : []),
        ];

        return (
          <div className="vcard-box" key={index}>
            {contact.photo ? (
              <img className="vcard-photo" src={contact.photo} alt="" />
            ) : (
              <Silhouette />
            )}
            <div className="vcard-main">
              <div className="vcard-head">
                <span className="vcard-name">{contact.name || primaryEmail}</span>
                {primaryEmail && contact.name && (
                  <a className="vcard-mail" href={`mailto:${primaryEmail}`}>
                    &lt;{primaryEmail}&gt;
                  </a>
                )}
              </div>
              {fields.length > 0 && (
                <dl className="vcard-fields">
                  {fields.map((field, fieldIndex) => (
                    <div key={fieldIndex}>
                      <dt>{t(field.key)}</dt>
                      <dd>
                        {field.href ? (
                          <a href={field.href} rel="noopener noreferrer" target="_blank">
                            {field.value}
                          </a>
                        ) : (
                          field.value
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 사진이 없는 카드의 기본 그림 */
function Silhouette() {
  return (
    <svg className="vcard-photo" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="4" fill="#e5e7eb" />
      <circle cx="20" cy="15" r="6.5" fill="#9ca3af" />
      <path d="M7 38c1.5-8 6.8-12 13-12s11.5 4 13 12z" fill="#9ca3af" />
    </svg>
  );
}
