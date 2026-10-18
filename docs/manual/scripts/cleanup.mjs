// seed.mjs · cap-*.mjs 가 만든 샘플(모든 언어)만 지운다
//  - 메일: 제목으로 찾아 완전 삭제
//  - 캘린더: 샘플 일정 · 태스크를 제목으로 찾아 삭제 (약속메일 수락으로 생긴 일정 포함)
import { login } from './api.mjs';
import { DATA } from './data.mjs';

const subjects = new Set();
const calTitles = new Set();
for (const d of Object.values(DATA)) {
  for (const k of ['notice', 'q3', 'kickoff', 'review', 'news', 'lunch']) subjects.add(d[k].subject);
  calTitles.add(d.review.subject);
  calTitles.add(d.calendar.event);
  for (const task of d.calendar.tasks) calTitles.add(task);
}
const prefixes = /^((Re|Fwd|Accepted|수락):\s*)+/i;

for (const user of ['admin', 'user1', 'user2']) {
  const api = await login(user);

  // 메일
  const byBox = {};
  for (const m of await api.messages()) {
    if (subjects.has((m.subject ?? '').replace(prefixes, ''))) (byBox[m.mailboxId] ??= []).push(m.uid);
  }
  for (const [mailboxId, uids] of Object.entries(byBox)) {
    await api.post('/api/messages/delete', { mailboxId, uids, permanent: true });
    console.log(`${user}: ${uids.length} mail(s) deleted`);
  }

  // 일정 · 태스크
  const from = new Date(); from.setMonth(from.getMonth() - 3);
  const to = new Date(); to.setMonth(to.getMonth() + 6);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const occ = await api.get(`/api/calendar/occurrences?from=${ymd(from)}&to=${ymd(to)}`);
  const tasks = await api.get('/api/calendar/tasks');
  const items = new Map();
  for (const o of [...(Array.isArray(occ) ? occ : []), ...(Array.isArray(tasks) ? tasks : tasks?.tasks ?? [])]) {
    if (calTitles.has(o.title)) items.set(o.itemId ?? o.id, o.title);
  }
  for (const [id, title] of items) {
    await api.del(`/api/calendar/items/${encodeURIComponent(id)}?scope=all&notify=0`);
    console.log(`${user}: calendar item deleted — ${title}`);
  }
}
