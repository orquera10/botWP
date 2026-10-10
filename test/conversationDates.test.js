import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingWeekday } from '../src/conversationDates.js';

const zone = 'America/Argentina/Buenos_Aires';
test('weekday requests resolve using the current local day instead of a stale reservation date', () => {
  const now = Date.UTC(2026, 9, 10, 15);
  for (const text of ['martes que viene', 'martes q viene te dije', 'somos 10 y queremos para el martes q viene']) {
    assert.equal(upcomingWeekday(text, now, zone), '2026-10-13');
  }
  assert.equal(upcomingWeekday('el miércoles', now, zone), '2026-10-14');
  assert.equal(upcomingWeekday('sábado que viene', now, zone), '2026-10-17');
  assert.equal(upcomingWeekday('el lunes que viene', Date.UTC(2026, 11, 31, 15), zone), '2027-01-04');
  assert.equal(upcomingWeekday('el martes pasado', now, zone), null);
});
