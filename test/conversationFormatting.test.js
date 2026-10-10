import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDate, friendlyTime, friendlyRange, chronologicalSlots, availabilityRanges, numericBookingSummary } from '../src/conversationFormatting.js';

test('payment summary uses numeric date and times across midnight', () => {
  assert.equal(numericBookingSummary({ nombre: 'Fútbol 7/8', fecha: '2026-10-11', hora_inicio: '23:00', duracion: 2 }), 'Fútbol 7/8 · 11-10-2026 · 23:00 a 01:00 (2 hs)');
});

test('customer dates and times use natural Spanish without changing internal values', () => {
  assert.equal(friendlyDate('2026-10-12'), 'lunes 12 de octubre');
  assert.equal(friendlyTime('14:00'), '14');
  assert.equal(friendlyTime('02:00'), '2');
  assert.equal(friendlyTime('16:30'), '16:30');
  assert.equal(friendlyRange('16:00', 1), '16 a 17');
  assert.equal(friendlyRange('23:00', 3), '23 a 2');
});

test('following-day midnight slots follow afternoon and evening of the requested date', () => {
  const slots = [{ fecha: '2026-10-13', inicio: '00:00' }, { fecha: '2026-10-12', inicio: '16:00' }, { fecha: '2026-10-12', inicio: '12:00' }];
  assert.deepEqual(chronologicalSlots(slots).map(slot => slot.inicio), ['12:00', '16:00', '00:00']);
  assert.equal(slots[0].inicio, '00:00');
});

test('daily ranges merge consecutive slots, preserve gaps and cross midnight', () => {
  const hours = [7, 8, 9, 10, 11, 14, 15, 16, 17, 20, 21, 22, 23, 24, 25];
  const slots = hours.map(hour => ({ fecha: hour >= 24 ? '2026-10-13' : '2026-10-12', inicio: `${String(hour % 24).padStart(2, '0')}:00` }));
  assert.deepEqual(availabilityRanges(slots, 1), [
    'de 7 a 12',
    'de 14 a 18',
    'de 20 a 2'
  ]);
});

test('overlapping two-hour slots merge but adjacent fixed birthday blocks stay separate', () => {
  assert.deepEqual(availabilityRanges([{ fecha: '2026-10-12', inicio: '14:00' }, { fecha: '2026-10-12', inicio: '15:00' }], 2), ['de 14 a 17']);
  assert.deepEqual(availabilityRanges([{ fecha: '2026-10-12', inicio: '14:00', fin: '17:00' }, { fecha: '2026-10-12', inicio: '17:00', fin: '20:00' }], 3, false), ['de 14 a 17', 'de 17 a 20']);
});
