/**
 * 주소록 CSV 가져오기 · 내보내기.
 *  - 내보내기는 썬더버드 CSV 머리글(영문) 그대로 쓴다 — 썬더버드 「가져오기 > 주소록 > CSV」 가 열 이름으로 맞춘다.
 *  - 가져오기는 썬더버드(영문 · 한글) · 아웃룩 · 구글 주소록 CSV 머리글을 알아본다.
 *    아는 머리글이 없으면 메일 주소처럼 생긴 칸을 메일로, 첫 칸을 이름으로 본다.
 *  - 글자셋: UTF-8 이 깨지면 CP949(EUC-KR) 로 다시 읽는다. 한글 윈도우의 아웃룩 · 엑셀이 이렇게 저장한다.
 */
import { EMPTY_FIELDS, type ContactAddress, type ContactFields } from './vcard.js';

// ------------------------------------------------------------------ CSV 문법

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // 구분자: 첫 줄에 탭이 쉼표보다 많으면 탭 (썬더버드 .tab · 엑셀 유니코드 텍스트)
  const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 바이트 → 글자. BOM 을 떼고, UTF-8 로 깨지면 CP949 로 */
export function decodeText(bytes: Buffer): string {
  let buf = bytes;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

// ------------------------------------------------------------------ 머리글

type Column =
  | 'given'
  | 'family'
  | 'display'
  | 'nickname'
  | 'email1'
  | 'email2'
  | 'email3'
  | 'telWork'
  | 'telHome'
  | 'telFax'
  | 'telPager'
  | 'telCell'
  | 'telOther'
  | 'homeStreet'
  | 'homeStreet2'
  | 'homeCity'
  | 'homeRegion'
  | 'homeZip'
  | 'homeCountry'
  | 'workStreet'
  | 'workStreet2'
  | 'workCity'
  | 'workRegion'
  | 'workZip'
  | 'workCountry'
  | 'title'
  | 'department'
  | 'org'
  | 'url1'
  | 'url2'
  | 'birthYear'
  | 'birthMonth'
  | 'birthDay'
  | 'birthday'
  | 'note';

/** 머리글 → 칸. 비교는 소문자 · 공백 · 기호를 뺀 값으로 한다 */
const ALIASES: Record<Column, string[]> = {
  given: ['First Name', 'Given Name', '이름(First Name)', '이름'],
  family: ['Last Name', 'Family Name', 'Surname', '성'],
  display: ['Display Name', 'Name', 'Full Name', '표시 이름', '표시이름', '전체 이름'],
  nickname: ['Nickname', '별명', '닉네임'],
  email1: ['Primary Email', 'E-mail Address', 'Email', 'E-mail', 'Email Address', 'E-mail 1 - Value', '기본 전자 메일', '기본 이메일', '주 이메일', '전자 메일', '이메일', '메일', '메일 주소', '전자 메일 주소'],
  email2: ['Secondary Email', 'E-mail 2 Address', 'E-mail 2 - Value', '보조 전자 메일', '보조 이메일', '두 번째 이메일', '전자 메일 2'],
  email3: ['E-mail 3 Address', 'E-mail 3 - Value', '전자 메일 3'],
  telWork: ['Work Phone', 'Business Phone', 'Phone 1 - Value', '직장 전화', '회사 전화', '근무처 전화'],
  telHome: ['Home Phone', '집 전화', '자택 전화'],
  telFax: ['Fax Number', 'Business Fax', 'Fax', '팩스 번호', '팩스', '근무처 팩스'],
  telPager: ['Pager Number', 'Pager', '호출기 번호', '호출기'],
  telCell: ['Mobile Number', 'Mobile Phone', 'Cell Phone', '휴대폰 번호', '휴대폰', '휴대 전화', '휴대전화'],
  telOther: ['Phone', 'Other Phone', 'Phone 2 - Value', '전화', '전화번호', '기타 전화'],
  homeStreet: ['Home Address', 'Home Street', '집 주소', '자택 주소'],
  homeStreet2: ['Home Address 2', 'Home Street 2', '집 주소 2'],
  homeCity: ['Home City', '집 시/군/구', '자택 구/군/시'],
  homeRegion: ['Home State', '집 시/도', '자택 시/도'],
  homeZip: ['Home ZipCode', 'Home Postal Code', '집 우편 번호', '자택 우편 번호'],
  homeCountry: ['Home Country', 'Home Country/Region', '집 국가', '자택 국가/지역'],
  workStreet: ['Work Address', 'Business Street', '직장 주소', '근무지 주소', '근무처 주소'],
  workStreet2: ['Work Address 2', 'Business Street 2', '직장 주소 2', '근무지 주소 2'],
  workCity: ['Work City', 'Business City', '직장 시/군/구', '근무지 구/군/시'],
  workRegion: ['Work State', 'Business State', '직장 시/도', '근무지 시/도'],
  workZip: ['Work ZipCode', 'Business Postal Code', '직장 우편 번호', '근무지 우편 번호'],
  workCountry: ['Work Country', 'Business Country/Region', '직장 국가', '근무지 국가/지역'],
  title: ['Job Title', 'Title', 'Organization 1 - Title', '직함', '직위', '직책'],
  department: ['Department', 'Organization 1 - Department', '부서'],
  org: ['Organization', 'Company', 'Organization 1 - Name', '조직', '회사', '회사 이름', '회사명'],
  url1: ['Web Page 1', 'Web Page', 'Website 1 - Value', '웹 페이지 1', '웹 페이지', '홈페이지'],
  url2: ['Web Page 2', 'Website 2 - Value', '웹 페이지 2'],
  birthYear: ['Birth Year', '생년', '생일 연도'],
  birthMonth: ['Birth Month', '생월', '생일 월'],
  birthDay: ['Birth Day', '생일 일'],
  birthday: ['Birthday', '생일'],
  note: ['Notes', 'Note', '메모', '참고'],
};

const norm = (h: string) => h.toLowerCase().replace(/[\s\-_/().:]+/g, '');

const LOOKUP = new Map<string, Column>();
for (const [column, names] of Object.entries(ALIASES) as [Column, string[]][]) {
  for (const n of names) if (!LOOKUP.has(norm(n))) LOOKUP.set(norm(n), column);
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function birthdayOf(year: string, month: string, day: string, whole: string): string {
  const pad = (v: string) => v.trim().padStart(2, '0');
  if (month.trim() && day.trim()) {
    return /^\d{4}$/.test(year.trim()) ? `${year.trim()}-${pad(month)}-${pad(day)}` : `--${pad(month)}-${pad(day)}`;
  }
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(whole.trim());
  return m ? `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}` : '';
}

/** CSV 글자 → 연락처 필드 목록. 이름도 메일도 전화도 없는 줄은 버린다 */
export function contactsFromCsv(text: string): ContactFields[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => LOOKUP.get(norm(h)) ?? null);
  // 성 · 표시 이름 칸이 없는 '이름' 칸은 이름 전체다 (썬더버드 한글판의 '이름' 은 First Name 이다)
  if (header.includes('given') && !header.includes('family') && !header.includes('display')) {
    header[header.indexOf('given')] = 'display';
  }
  const known = header.some(Boolean);
  const body = known ? rows.slice(1) : rows;
  const out: ContactFields[] = [];
  for (const row of body) {
    const get = (column: Column) => {
      const i = header.indexOf(column);
      return i >= 0 ? (row[i] ?? '').trim() : '';
    };
    let fields: ContactFields;
    if (known) {
      const emails = (['email1', 'email2', 'email3'] as const)
        .map(get)
        .flatMap((v) => v.split(/[;,\s]+/))
        .filter((v) => EMAIL_RE.test(v));
      const phones = (
        [
          ['telCell', 'cell'],
          ['telWork', 'work'],
          ['telHome', 'home'],
          ['telFax', 'fax'],
          ['telPager', 'pager'],
          ['telOther', 'other'],
        ] as const
      )
        .map(([column, type]) => ({ type, value: get(column) }))
        .filter((p) => p.value);
      const address = (prefix: 'home' | 'work'): ContactAddress | null => {
        const a: ContactAddress = {
          type: prefix,
          poBox: '',
          extended: get(`${prefix}Street2`),
          street: get(`${prefix}Street`),
          locality: get(`${prefix}City`),
          region: get(`${prefix}Region`),
          postalCode: get(`${prefix}Zip`),
          country: get(`${prefix}Country`),
        };
        return [a.extended, a.street, a.locality, a.region, a.postalCode, a.country].some(Boolean) ? a : null;
      };
      fields = {
        ...EMPTY_FIELDS,
        displayName: get('display'),
        givenName: get('given'),
        familyName: get('family'),
        nickname: get('nickname'),
        emails: [...new Set(emails)].map((value) => ({ type: 'other', value })),
        phones,
        org: get('org'),
        department: get('department'),
        title: get('title'),
        addresses: [address('work'), address('home')].filter((a): a is ContactAddress => a !== null),
        birthday: birthdayOf(get('birthYear'), get('birthMonth'), get('birthDay'), get('birthday')),
        urls: [get('url1'), get('url2')].filter(Boolean),
        note: get('note'),
      };
    } else {
      // 머리글을 모르면: 메일처럼 생긴 칸은 메일, 그 앞의 첫 칸은 이름
      const emails = row.map((v) => v.trim()).filter((v) => EMAIL_RE.test(v));
      const name = row.map((v) => v.trim()).find((v) => v && !EMAIL_RE.test(v)) ?? '';
      fields = { ...EMPTY_FIELDS, displayName: name, emails: emails.map((value) => ({ type: 'other', value })) };
    }
    if (fields.displayName || fields.givenName || fields.familyName || fields.emails.length || fields.phones.length) {
      out.push(fields);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 내보내기

/** 썬더버드 CSV 머리글 순서 그대로 */
const TB_HEADER = [
  'First Name',
  'Last Name',
  'Display Name',
  'Nickname',
  'Primary Email',
  'Secondary Email',
  'Screen Name',
  'Work Phone',
  'Home Phone',
  'Fax Number',
  'Pager Number',
  'Mobile Number',
  'Home Address',
  'Home Address 2',
  'Home City',
  'Home State',
  'Home ZipCode',
  'Home Country',
  'Work Address',
  'Work Address 2',
  'Work City',
  'Work State',
  'Work ZipCode',
  'Work Country',
  'Job Title',
  'Department',
  'Organization',
  'Web Page 1',
  'Web Page 2',
  'Birth Year',
  'Birth Month',
  'Birth Day',
  'Custom 1',
  'Custom 2',
  'Custom 3',
  'Custom 4',
  'Notes',
];

export function contactsToCsv(list: ContactFields[]): string {
  const lines = [TB_HEADER.join(',')];
  for (const f of list) {
    if (f.kind === 'group') continue;
    const phone = (type: string) => f.phones.find((p) => p.type === type)?.value ?? '';
    const home = f.addresses.find((a) => a.type === 'home');
    const work = f.addresses.find((a) => a.type === 'work') ?? f.addresses.find((a) => a.type === 'other');
    const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.birthday);
    const partial = /^--(\d{2})-(\d{2})$/.exec(f.birthday);
    const [year, month, day] = full
      ? [full[1]!, full[2]!, full[3]!]
      : partial
        ? ['', partial[1]!, partial[2]!]
        : ['', '', ''];
    const otherPhone = phone('other');
    const cells = [
      f.givenName,
      f.familyName,
      f.displayName,
      f.nickname,
      f.emails[0]?.value ?? '',
      f.emails[1]?.value ?? '',
      '',
      phone('work') || otherPhone,
      phone('home'),
      phone('fax'),
      phone('pager'),
      phone('cell'),
      home?.street ?? '',
      home?.extended ?? '',
      home?.locality ?? '',
      home?.region ?? '',
      home?.postalCode ?? '',
      home?.country ?? '',
      work?.street ?? '',
      work?.extended ?? '',
      work?.locality ?? '',
      work?.region ?? '',
      work?.postalCode ?? '',
      work?.country ?? '',
      f.title,
      f.department,
      f.org,
      f.urls[0] ?? '',
      f.urls[1] ?? '',
      year,
      month,
      day,
      '',
      '',
      '',
      '',
      f.note,
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
