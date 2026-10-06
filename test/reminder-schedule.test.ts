import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReminder, validSchedule, type ReminderSchedule } from '../src/reminder-schedule.js';

const daily: ReminderSchedule = { frequency: 'daily', time: '09:00', timezone: 'Europe/London' };
const next = (schedule: ReminderSchedule, after: string) => new Date(nextReminder(schedule, Date.parse(after))).toISOString();

test('calendar schedules preserve local time across midnight and DST changes', () => {
  assert.equal(next(daily, '2026-03-28T10:00:00Z'), '2026-03-29T08:00:00.000Z');
  assert.equal(next(daily, '2026-10-24T10:00:00Z'), '2026-10-25T09:00:00.000Z');
  assert.equal(next({ ...daily, timezone: 'Asia/Kathmandu' }, '2026-01-01T03:15:00Z'), '2026-01-02T03:15:00.000Z');
  assert.equal(next({ ...daily, frequency: 'weekly', weekday: 1 }, '2026-01-05T09:00:00Z'), '2026-01-12T09:00:00.000Z');
});

test('nonexistent DST times are skipped and ambiguous times run only once', () => {
  const schedule = { ...daily, time: '01:30' };
  assert.equal(next(schedule, '2026-03-28T02:00:00Z'), '2026-03-30T00:30:00.000Z');
  assert.equal(next(schedule, '2026-10-25T00:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(next(schedule, '2026-10-25T00:45:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(next({ ...schedule, frequency: 'weekly', weekday: 7 }, '2026-03-22T02:00:00Z'), '2026-04-05T00:30:00.000Z');
});

test('schedule validation rejects malformed times, timezones and weekday combinations', () => {
  assert.ok(validSchedule(daily));
  for (const schedule of [null, [], { ...daily, frequency: 'monthly' }, { ...daily, time: '24:00' },
    { ...daily, time: '9:00' }, { ...daily, timezone: 'Not/AZone' }, { ...daily, weekday: 1 },
    { ...daily, frequency: 'weekly' }, { ...daily, frequency: 'weekly', weekday: 0 }, { ...daily, extra: true }]) {
    assert.equal(validSchedule(schedule), false);
  }
});
