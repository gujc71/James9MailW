/**
 * 주소록 순수 함수 단위 테스트 (vCard 읽기 · 쓰기 · CSV · CardDAV 필터). DB 없이 돈다 (`npm test`).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCard, fieldsOf, mergeFields, indexOf, splitCardTexts, foldLine, ensureUid, uidOf, EMPTY_FIELDS } = await import(
  '../src/contacts/vcard.js'
);
const { parseCsv, contactsFromCsv, contactsToCsv, decodeText } = await import('../src/contacts/csv.js');
const { matchesFilter } = await import('../src/services/carddav.js');

const TB_CARD = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:1f0c1c4e-aaaa-bbbb-cccc-0123456789ab',
  'FN:홍길동',
  'N:홍;길동;;;',
  'EMAIL;PREF=1:hong@example.com',
  'EMAIL;TYPE=work:gd.hong@corp.example',
  'TEL;TYPE=cell:010-1234-5678',
  'ORG:예제 주식회사;개발팀',
  'TITLE:책임',
  'NOTE:첫 줄\\n둘째\\, 줄',
  'BDAY;VALUE=DATE:19900102',
  'X-MOZ-HTML:TRUE',
  'item1.URL:https://example.com',
  'END:VCARD',
  '',
].join('\r\n');

describe('vcard read', () => {
  test('fields from a Thunderbird 4.0 card', () => {
    const card = parseCard(TB_CARD)!;
    const f = fieldsOf(card);
    assert.equal(f.kind, 'individual');
    assert.equal(f.displayName, '홍길동');
    assert.equal(f.familyName, '홍');
    assert.equal(f.givenName, '길동');
    assert.deepEqual(
      f.emails.map((e: { value: string }) => e.value),
      ['hong@example.com', 'gd.hong@corp.example'],
    );
    assert.equal(f.emails[1].type, 'work');
    assert.deepEqual(f.phones, [{ type: 'cell', value: '010-1234-5678' }]);
    assert.equal(f.org, '예제 주식회사');
    assert.equal(f.department, '개발팀');
    assert.equal(f.note, '첫 줄\n둘째, 줄');
    assert.equal(f.birthday, '1990-01-02');
    assert.deepEqual(f.urls, ['https://example.com']);
    assert.equal(uidOf(card), '1f0c1c4e-aaaa-bbbb-cccc-0123456789ab');
  });

  test('index: primary mail first, name falls back to N', () => {
    const idx = indexOf({ ...EMPTY_FIELDS, displayName: 'a@b.com', familyName: 'Kim', givenName: 'Min', emails: [{ type: 'other', value: 'a@b.com' }] });
    assert.equal(idx.name, 'Min Kim');
    assert.deepEqual(idx.emails, ['a@b.com']);
  });

  test('apple style group', () => {
    const card = parseCard(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Team\r\nN:Team;;;;\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:abc\r\nX-ADDRESSBOOKSERVER-MEMBER:mailto:x@y.com\r\nEND:VCARD\r\n',
    )!;
    const f = fieldsOf(card);
    assert.equal(f.kind, 'group');
    assert.deepEqual(f.members, ['abc', 'mailto:x@y.com']);
  });

  test('2.1 quoted printable', () => {
    const card = parseCard('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=ED=99=8D=EA=B8=B8=\r\n=EB=8F=99\r\nEMAIL;INTERNET:a@b.com\r\nEND:VCARD\r\n')!;
    assert.equal(fieldsOf(card).displayName, '홍길동');
    assert.equal(card.version, '2.1');
  });

  test('split several cards', () => {
    assert.equal(splitCardTexts(TB_CARD + TB_CARD.replace('홍길동', '김철수')).length, 2);
  });
});

describe('vcard write', () => {
  test('unchanged parts keep their original lines', () => {
    const card = parseCard(TB_CARD)!;
    const f = fieldsOf(card);
    const out = mergeFields(card, { ...f, title: '수석' }, 'ignored');
    assert.match(out, /TITLE:수석/);
    assert.match(out, /EMAIL;PREF=1:hong@example.com/);
    assert.match(out, /X-MOZ-HTML:TRUE/);
    assert.match(out, /item1.URL:https:\/\/example.com/);
    assert.match(out, /BDAY;VALUE=DATE:19900102/);
    assert.doesNotMatch(out, /TITLE:책임/);
    // 읽어 보면 고친 값만 다르다
    const again = fieldsOf(parseCard(out)!);
    assert.deepEqual({ ...again, title: '책임' }, f);
  });

  test('changed emails rewritten, middle name kept', () => {
    const card = parseCard('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u1\r\nFN:A B\r\nN:B;A;M;Dr.;\r\nEMAIL;TYPE=INTERNET:a@b.com\r\nEND:VCARD\r\n')!;
    const f = fieldsOf(card);
    const out = mergeFields(card, { ...f, givenName: 'Al', emails: [{ type: 'work', value: 'al@b.com' }] }, 'u1');
    assert.match(out, /N:B;Al;M;Dr\.;/);
    assert.match(out, /EMAIL;TYPE=INTERNET,WORK,PREF:al@b.com/);
    assert.doesNotMatch(out, /a@b\.com/);
  });

  test('new contact is 4.0 with UID, new group is apple-style 3.0', () => {
    const contact = mergeFields(null, { ...EMPTY_FIELDS, displayName: 'X', emails: [{ type: 'other', value: 'x@y.com' }] }, 'uid-1');
    assert.match(contact, /^BEGIN:VCARD\r\nVERSION:4.0\r\n/);
    assert.match(contact, /UID:uid-1/);
    assert.match(contact, /EMAIL;PREF=1:x@y.com/);
    const group = mergeFields(null, { ...EMPTY_FIELDS, kind: 'group', displayName: 'Team', members: ['uid-1', 'mailto:z@y.com'] }, 'g-1');
    assert.match(group, /VERSION:3.0/);
    assert.match(group, /X-ADDRESSBOOKSERVER-KIND:group/);
    assert.match(group, /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:uid-1/);
    assert.match(group, /X-ADDRESSBOOKSERVER-MEMBER:mailto:z@y.com/);
    assert.deepEqual(fieldsOf(parseCard(group)!).members, ['uid-1', 'mailto:z@y.com']);
  });

  test('escaping round trip', () => {
    const fields = { ...EMPTY_FIELDS, displayName: 'a;b,c\\d', note: 'line1\nline2' };
    const back = fieldsOf(parseCard(mergeFields(null, fields, 'u'))!);
    assert.equal(back.displayName, 'a;b,c\\d');
    assert.equal(back.note, 'line1\nline2');
  });

  test('folding stays within 75 bytes and unfolds back', () => {
    const line = `NOTE:${'가'.repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75);
    assert.equal(folded.replace(/\r\n /g, ''), line);
  });

  test('ensureUid adds UID only when missing', () => {
    const card = parseCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A\r\nEND:VCARD\r\n')!;
    assert.match(ensureUid(card, 'zz'), /UID:zz/);
  });
});

describe('csv', () => {
  test('quoted cells and newlines', () => {
    assert.deepEqual(parseCsv('a,"b ""q"",c","x\ny"\r\n1,2,3\n'), [
      ['a', 'b "q",c', 'x\ny'],
      ['1', '2', '3'],
    ]);
  });

  test('thunderbird export round trip', () => {
    const fields = {
      ...EMPTY_FIELDS,
      displayName: '홍길동',
      familyName: '홍',
      givenName: '길동',
      emails: [
        { type: 'other', value: 'hong@example.com' },
        { type: 'other', value: 'h2@example.com' },
      ],
      phones: [{ type: 'cell', value: '010-1' }],
      org: 'ACME',
      department: 'Dev',
      title: 'Lead',
      birthday: '1990-01-02',
      note: 'n, "q"',
    };
    const back = contactsFromCsv(contactsToCsv([fields]));
    assert.equal(back.length, 1);
    assert.equal(back[0].displayName, '홍길동');
    assert.equal(back[0].givenName, '길동');
    assert.deepEqual(
      back[0].emails.map((e: { value: string }) => e.value),
      ['hong@example.com', 'h2@example.com'],
    );
    assert.deepEqual(back[0].phones, [{ type: 'cell', value: '010-1' }]);
    assert.equal(back[0].birthday, '1990-01-02');
    assert.equal(back[0].note, 'n, "q"');
  });

  test('outlook headers and korean simple sheet', () => {
    const outlook = contactsFromCsv('First Name,Last Name,E-mail Address,Mobile Phone,Company\nMin,Kim,min@x.com,010,ACME\n');
    assert.equal(outlook[0].givenName, 'Min');
    assert.equal(outlook[0].emails[0].value, 'min@x.com');
    assert.equal(outlook[0].org, 'ACME');
    const korean = contactsFromCsv('이름,이메일,휴대폰\n홍길동,hong@x.com,010\n');
    assert.equal(korean[0].displayName, '홍길동');
    assert.equal(korean[0].emails[0].value, 'hong@x.com');
  });

  test('unknown headers: mail-looking cells', () => {
    const rows = contactsFromCsv('Kim,kim@x.com\nLee,lee@x.com\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].displayName, 'Lee');
  });

  test('cp949 bytes decode', () => {
    const bytes = Buffer.from([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]); // 홍길동 (CP949)
    assert.equal(decodeText(bytes), '홍길동');
    assert.equal(decodeText(Buffer.from('﻿홍', 'utf8')), '홍');
  });
});

describe('carddav filter', () => {
  const card = parseCard(TB_CARD)!;
  test('text-match contains / equals / negate', () => {
    const f = (name: string, text: string, matchType = 'contains', negate = false) => ({
      test: 'anyof' as const,
      props: [{ name, test: 'anyof' as const, isNotDefined: false, textMatches: [{ text, matchType, negate }] }],
    });
    assert.ok(matchesFilter(card, f('EMAIL', 'corp.example')));
    assert.ok(matchesFilter(card, f('FN', '홍길동', 'equals')));
    assert.ok(!matchesFilter(card, f('FN', '홍', 'equals')));
    assert.ok(!matchesFilter(card, f('FN', '길', 'contains', true)));
    assert.ok(matchesFilter(card, { test: 'anyof', props: [{ name: 'NICKNAME', test: 'anyof', isNotDefined: true, textMatches: [] }] }));
  });
});
