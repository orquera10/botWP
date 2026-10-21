import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingWeekday, slotMatchesHour } from '../src/conversationDates.js';

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

test('slotMatchesHour checks whether target hour falls within slot start and end', () => {
  const slot = { inicio: '18:00', fin: '19:00' };
  assert.equal(slotMatchesHour(slot, '18:00'), true);
  assert.equal(slotMatchesHour(slot, '18:30'), true);
  assert.equal(slotMatchesHour(slot, '18:59'), true);
  assert.equal(slotMatchesHour(slot, '19:00'), false);
  assert.equal(slotMatchesHour(slot, '17:59'), false);
  assert.equal(slotMatchesHour(slot, null), false);
  assert.equal(slotMatchesHour(null, '18:00'), false);

  // Missing fin defaults to 1 hour after inicio
  const slotNoFin = { inicio: '18:00' };
  assert.equal(slotMatchesHour(slotNoFin, '18:30'), true);
  assert.equal(slotMatchesHour(slotNoFin, '19:30'), false);

  // Midnight crossing slot (23:00 to 00:00)
  const midnightSlot = { inicio: '23:00', fin: '00:00' };
  assert.equal(slotMatchesHour(midnightSlot, '23:30'), true);
  assert.equal(slotMatchesHour(midnightSlot, '22:30'), false);
});

