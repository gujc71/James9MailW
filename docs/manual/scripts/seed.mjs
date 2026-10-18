// 매뉴얼 캡처용 샘플 데이터 만들기 (admin / user1 / user2). MANUAL_LOCALE=ko|en
// 다른 언어의 샘플이 남아 있으면 그림에 섞이므로 먼저 cleanup.mjs 를 돌린다.
import { login, sleep, SEEN, FLAGGED } from './api.mjs';
import { DATA } from './data.mjs';

const LOCALE = process.env.MANUAL_LOCALE === 'en' ? 'en' : 'ko';
const D = DATA[LOCALE];

const admin = await login('admin', LOCALE);
const u1 = await login('user1', LOCALE);
const u2 = await login('user2', LOCALE);

// 표시 이름을 언어에 맞춘다. 보낸 메일의 발신자 이름에 들어가므로 발송보다 먼저 한다
await admin.put('/api/me/profile', { displayName: D.names.admin });
await u1.put('/api/me/profile', { displayName: D.names.user1 });
await u2.put('/api/me/profile', { displayName: D.names.user2 });
// user3 은 비밀번호를 모를 수 있어 관리자 API 로 바꾼다 (관리자 화면 · 알리아스 그림에 보인다). 없으면 건너뛴다
if ((await admin.get('/api/admin/users/exists?userName=user3%40example.com')).exists) {
  await admin.put('/api/admin/users/user3%40example.com', { displayName: D.names.user3 });
}

const addr = (user) => `${D.names[user]} <${user}@example.com>`;

async function send(api, mail) {
  const fd = new FormData();
  for (const k of ['to', 'cc']) if (mail[k]) fd.append(k, JSON.stringify(mail[k]));
  fd.append('subject', mail.subject);
  fd.append('html', mail.html);
  for (const k of ['important', 'readReceipt']) if (mail[k]) fd.append(k, 'true');
  if (mail.inReplyTo) fd.append('inReplyTo', mail.inReplyTo);
  if (mail.appointment) fd.append('appointment', JSON.stringify(mail.appointment));
  for (const a of mail.attachments ?? []) fd.append('attachments', new Blob([a.body], { type: a.type }), a.name);
  await api.post('/api/compose/send', fd);
  console.log('sent:', mail.subject);
  await sleep(800);
}

/** 받은 쪽 목록에 나타날 때까지 기다린다 */
async function find(api, match) {
  for (let i = 0; i < 15; i++) {
    const hit = (await api.messages()).find(match);
    if (hit) return hit;
    await sleep(1000);
  }
  throw new Error('message not found');
}

await send(admin, {
  to: [addr('user1'), addr('user2')],
  subject: D.notice.subject,
  important: true,
  html: D.notice.html,
});

await send(u2, {
  to: [addr('user1')],
  subject: D.q3.subject,
  readReceipt: true,
  html: D.q3.html,
  attachments: [{ name: D.q3.file, type: 'text/csv', body: D.q3.csv }],
});

// 대화: user1 → user2 → user1 → user2
await send(u1, {
  to: [addr('user2')],
  cc: [addr('admin')],
  subject: D.kickoff.subject,
  readReceipt: true,
  html: D.kickoff.html,
});
const re = `Re: ${D.kickoff.subject}`;
let parent = await find(u2, (m) => m.subject === D.kickoff.subject && m.from === 'user1@example.com');
await send(u2, { to: [addr('user1')], subject: re, inReplyTo: parent.mailId, html: D.kickoff.replies[0] });
parent = await find(u1, (m) => m.subject === re && m.from === 'user2@example.com');
await send(u1, { to: [addr('user2')], subject: re, inReplyTo: parent.mailId, html: D.kickoff.replies[1] });
parent = await find(u2, (m) => m.subject === re && m.from === 'user1@example.com');
await send(u2, { to: [addr('user1')], subject: re, inReplyTo: parent.mailId, html: D.kickoff.replies[2] });

const day = (d, h) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
await send(u2, {
  to: [addr('user1'), addr('admin')],
  subject: D.review.subject,
  appointment: { start: day(2, 14), end: day(2, 15), location: D.review.location, description: D.review.description },
  html: D.review.html,
});

await send(admin, { to: [addr('user1')], subject: D.news.subject, html: D.news.html });
await send(u2, { to: [addr('user1')], subject: D.lunch.subject, html: D.lunch.html });

// 공지는 읽음 + 별표, 점심은 읽음
const notice = await find(u1, (m) => m.subject === D.notice.subject);
await u1.post('/api/messages/flags', { mailboxId: notice.mailboxId, uids: [notice.uid], add: [SEEN, FLAGGED] });
const lunch = await find(u1, (m) => m.subject === D.lunch.subject);
await u1.post('/api/messages/flags', { mailboxId: lunch.mailboxId, uids: [lunch.uid], add: [SEEN] });

// 수신확인 그림용: user2 만 킥오프 메일을 읽는다 (admin 은 안 읽음 → 회수 가능)
const kick = await find(u2, (m) => m.subject === D.kickoff.subject && m.from === 'user1@example.com');
await u2.post('/api/messages/flags', { mailboxId: kick.mailboxId, uids: [kick.uid], add: [SEEN] });

console.log(`done (${LOCALE})`);
