import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDate, friendlyTime, friendlyRange, chronologicalSlots } from '../src/conversationFormatting.js';

test('customer dates and times use natural Spanish without changing internal values', () => {
  assert.equal(friendlyDate('2026-10-12'), 'lunes 12 de octubre');
  assert.equal(friendlyTime('14:00'), '2 de la tarde');
  assert.equal(friendlyTime('02:00'), '2 de la madrugada');
  assert.equal(friendlyTime('16:30'), '4:30 de la tarde');
  assert.equal(friendlyRange('16:00', 1), '4 de la tarde a 5 de la tarde');
  assert.equal(friendlyRange('23:00', 3), '11 de la noche a 2 de la madrugada');
});

test('following-day midnight slots follow afternoon and evening of the requested date', () => {
  const slots = [{ fecha: '2026-10-13', inicio: '00:00' }, { fecha: '2026-10-12', inicio: '16:00' }, { fecha: '2026-10-12', inicio: '12:00' }];
  assert.deepEqual(chronologicalSlots(slots).map(slot => slot.inicio), ['12:00', '16:00', '00:00']);
  assert.equal(slots[0].inicio, '00:00');
});
