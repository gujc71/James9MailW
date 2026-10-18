/**
 * 캘린더 순수 함수 단위 테스트 (반복 펼치기 · 시간대 · iCalendar). DB 없이 돈다 (`npm test`).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { parseWall, formatWall, wallToUtc, utcToWall, convertWall, normalizeTimeZone } = await import(
  '../src/calendar/time.js'
);
const { parseRule, formatRule, occurrences, lastOccurrence, untilWall } = await import('../src/calendar/recur.js');
const { parseCalendar, serializeCalendar, foldLine, parseDuration } = await import('../src/calendar/ical.js');

function expand(start: string, rrule: string, until: string, tz = 'Asia/Seoul', exdates: string[] = []): string[] {
  const rule = parseRule(rrule)!;
  const out: string[] = [];
  for (const at of occurrences({
    start: parseWall(start),
    rule,
    tz,
    exdates: exdates.map(parseWall),
    windowEnd: parseWall(until),
  })) {
    out.push(formatWall(at, start.length === 10));
  }
  return out;
}

describe('time', () => {
  test('wall round trip', () => {
    assert.equal(formatWall(parseWall('2026-10-07T09:30')), '2026-10-07T09:30');
    assert.equal(formatWall(parseWall('2026-10-07'), true), '2026-10-07');
  });

  test('Seoul is UTC+9 without DST', () => {
    const utc = wallToUtc(parseWall('2026-10-07T09:00'), 'Asia/Seoul');
    assert.equal(new Date(utc).toISOString(), '2026-10-07T00:00:00.000Z');
    assert.equal(formatWall(utcToWall(utc, 'Asia/Seoul')), '2026-10-07T09:00');
  });

  test('New York DST offsets', () => {
    assert.equal(new Date(wallToUtc(parseWall('2026-07-01T09:00'), 'America/New_York')).toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(new Date(wallToUtc(parseWall('2026-12-01T09:00'), 'America/New_York')).toISOString(), '2026-12-01T14:00:00.000Z');
  });

  test('convertWall', () => {
    assert.equal(convertWall('2026-10-07T09:00', 'Asia/Seoul', 'UTC'), '2026-10-07T00:00');
    assert.equal(convertWall('2026-10-07', 'Asia/Seoul', 'UTC'), '2026-10-07');
  });

  test('normalizeTimeZone', () => {
    assert.equal(normalizeTimeZone('Korea Standard Time', 'UTC'), 'Asia/Seoul');
    assert.equal(normalizeTimeZone('/mozilla.org/20050126_1/Asia/Tokyo', 'UTC'), 'Asia/Tokyo');
    assert.equal(normalizeTimeZone('Nowhere/Land', 'UTC'), 'UTC');
  });
});

describe('recurrence', () => {
  test('daily with count', () => {
    assert.deepEqual(expand('2026-10-01T09:00', 'FREQ=DAILY;COUNT=3', '2027-01-01'), [
      '2026-10-01T09:00',
      '2026-10-02T09:00',
      '2026-10-03T09:00',
    ]);
  });

  test('weekdays', () => {
    // 2026-10-02 은 금요일
    assert.deepEqual(expand('2026-10-02T09:00', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-07T23:59'), [
      '2026-10-02T09:00',
      '2026-10-05T09:00',
      '2026-10-06T09:00',
      '2026-10-07T09:00',
    ]);
  });

  test('biweekly with exdate', () => {
    assert.deepEqual(expand('2026-10-05T10:00', 'FREQ=WEEKLY;INTERVAL=2', '2026-11-30', 'Asia/Seoul', ['2026-10-19T10:00']), [
      '2026-10-05T10:00',
      '2026-11-02T10:00',
      '2026-11-16T10:00',
      '2026-11-30T10:00',
    ].filter((v) => v <= '2026-11-30T00:00'));
  });

  test('monthly last friday', () => {
    assert.deepEqual(expand('2026-10-30T15:00', 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', '2027-12-31'), [
      '2026-10-30T15:00',
      '2026-11-27T15:00',
      '2026-12-25T15:00',
    ]);
  });

  test('monthly on the 31st skips short months', () => {
    assert.deepEqual(expand('2026-01-31', 'FREQ=MONTHLY;COUNT=3', '2027-12-31'), ['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  test('yearly', () => {
    assert.deepEqual(expand('2024-02-29', 'FREQ=YEARLY;COUNT=2', '2040-01-01'), ['2024-02-29', '2028-02-29']);
  });

  test('until in UTC', () => {
    const list = expand('2026-10-01T09:00', 'FREQ=DAILY;UNTIL=20261003T000000Z', '2027-01-01');
    assert.deepEqual(list, ['2026-10-01T09:00', '2026-10-02T09:00', '2026-10-03T09:00']);
    assert.equal(formatWall(untilWall('20261003T000000Z', 'Asia/Seoul')!), '2026-10-03T09:00');
  });

  test('wall clock survives DST', () => {
    const list = expand('2026-10-30T09:00', 'FREQ=WEEKLY;COUNT=2', '2027-01-01', 'America/New_York');
    assert.deepEqual(list, ['2026-10-30T09:00', '2026-11-06T09:00']);
    const utc = list.map((v) => new Date(wallToUtc(parseWall(v), 'America/New_York')).toISOString().slice(11, 16));
    assert.deepEqual(utc, ['13:00', '14:00']);
  });

  test('lastOccurrence', () => {
    const rule = parseRule('FREQ=DAILY;COUNT=5')!;
    assert.equal(formatWall(lastOccurrence(parseWall('2026-10-01T09:00'), rule, 'UTC')!), '2026-10-05T09:00');
    assert.equal(lastOccurrence(parseWall('2026-10-01T09:00'), parseRule('FREQ=DAILY')!, 'UTC'), null);
  });

  test('format round trip', () => {
    assert.equal(formatRule(parseRule('RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO;COUNT=4')!), 'FREQ=MONTHLY;INTERVAL=2;COUNT=4;BYDAY=2MO');
    assert.equal(parseRule('FREQ=HOURLY'), null);
  });
});

describe('icalendar', () => {
  const sample = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:abc@example.com',
    'DTSTART;TZID=Asia/Seoul:20261007T090000',
    'DTEND;TZID=Asia/Seoul:20261007T103000',
    'SUMMARY:주간 회의\\, 팀',
    'DESCRIPTION:첫 줄\\n둘째 줄',
    'RRULE:FREQ=WEEKLY;BYDAY=WE',
    'EXDATE;TZID=Asia/Seoul:20261014T090000',
    'CATEGORIES:업무,회의',
    'ORGANIZER;CN=Boss:mailto:Boss@example.com',
    'ATTENDEE;CN="Kim";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:kim@example.com',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID:task1',
    'DUE;VALUE=DATE:20261010',
    'SUMMARY:보고서',
    'PERCENT-COMPLETE:50',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  test('parse', () => {
    const cal = parseCalendar(sample, 'UTC');
    assert.equal(cal.method, 'REQUEST');
    assert.equal(cal.items.length, 2);
    const event = cal.items[0]!;
    assert.equal(event.title, '주간 회의, 팀');
    assert.equal(event.description, '첫 줄\n둘째 줄');
    assert.equal(event.tzid, 'Asia/Seoul');
    assert.equal(event.start, '2026-10-07T09:00');
    assert.equal(event.end, '2026-10-07T10:30');
    assert.deepEqual(event.exdates, ['2026-10-14T09:00']);
    assert.deepEqual(event.categories, ['업무', '회의']);
    assert.equal(event.organizer, 'boss@example.com');
    assert.equal(event.attendees[0]!.name, 'Kim');
    assert.deepEqual(event.alarms, [{ offsetMin: 15, related: 'S' }]);
    const task = cal.items[1]!;
    assert.equal(task.type, 'T');
    assert.equal(task.due, '2026-10-10');
    assert.equal(task.percent, 50);
  });

  test('utc times become default-zone walls', () => {
    const cal = parseCalendar('BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261007T000000Z\r\nDURATION:PT1H\r\nEND:VEVENT', 'Asia/Seoul');
    assert.equal(cal.items[0]!.start, '2026-10-07T09:00');
    assert.equal(cal.items[0]!.end, '2026-10-07T10:00');
  });

  test('serialize and parse back', () => {
    const cal = parseCalendar(sample, 'UTC');
    const text = serializeCalendar(cal.items, { method: 'REQUEST' });
    assert.match(text, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Seoul/);
    const back = parseCalendar(text, 'UTC');
    assert.equal(back.items[0]!.title, '주간 회의, 팀');
    assert.equal(back.items[0]!.start, '2026-10-07T09:00');
    assert.equal(back.items[0]!.rrule, 'FREQ=WEEKLY;BYDAY=WE');
    // 초대 메일에는 알림을 싣지 않는다
    assert.equal(back.items[0]!.alarms.length, 0);
  });

  test('fold keeps lines under 75 octets', () => {
    const folded = foldLine(`DESCRIPTION:${'가'.repeat(60)}`);
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
    assert.equal(folded.replace(/\r\n /g, ''), `DESCRIPTION:${'가'.repeat(60)}`);
  });

  test('duration', () => {
    assert.equal(parseDuration('-PT15M'), -15);
    assert.equal(parseDuration('P1DT2H'), 1560);
    assert.equal(parseDuration('P2W'), 20160);
  });
});

describe('icalendar X- properties (CalDAV)', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:x-1',
    'DTSTART;TZID=Asia/Seoul:20261007T090000',
    'SUMMARY:알림',
    'X-MOZ-LASTACK:20261007T000000Z',
    'X-MOZ-SNOOZE-TIME:20261007T001000Z',
    'BEGIN:VALARM',
    'X-ALARM-ONLY:1',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('kept only when asked, and only at component level', () => {
    assert.equal(parseCalendar(text, 'UTC').items[0]!.extra, undefined);
    const item = parseCalendar(text, 'UTC', { keepExtra: true }).items[0]!;
    assert.deepEqual(item.extra, ['X-MOZ-LASTACK:20261007T000000Z', 'X-MOZ-SNOOZE-TIME:20261007T001000Z']);
  });

  test('written back with a fixed DTSTAMP', () => {
    const item = parseCalendar(text, 'UTC', { keepExtra: true }).items[0]!;
    const stamp = new Date('2026-10-01T00:00:00Z');
    const out = serializeCalendar([{ ...item, stamp }]);
    assert.match(out, /X-MOZ-LASTACK:20261007T000000Z/);
    assert.match(out, /DTSTAMP:20261001T000000Z/);
    assert.equal(serializeCalendar([{ ...item, stamp }]), out);
  });
});
