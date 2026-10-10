import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDate, friendlyTime, friendlyRange, chronologicalSlots, availabilityRanges, pricedAvailabilityRanges, numericBookingSummary } from '../src/conversationFormatting.js';

test('prices split availability by actual tariff and preserve occupied gaps', () => {
  const slots = [13, 14, 16, 17, 18].map(hour => ({ fecha: '2026-10-12', inicio: `${hour}:00`, total: hour < 16 ? 100 : 200, total_base: 200, minimo_senia: hour < 16 ? 30 : 60 }));
  const tariffs = pricedAvailabilityRanges(slots, 1);
  assert.deepEqual(tariffs.map(t => t.franjas), [['de 13 a 15'], ['de 16 a 19']]);
  assert.deepEqual(tariffs.map(t => t.total), [100, 200]);
  assert.equal(tariffs[0].ahorro, 100);
  assert.equal(tariffs[0].tipo_precio, 'descuento');
  assert.equal(tariffs[1].tipo_precio, 'tarifa_base');
});

test('multi-hour totals are not multiplied or presented as hourly prices, and higher tariffs are not discounts', () => {
  const tariffs = pricedAvailabilityRanges([{ fecha: '2026-10-12', inicio: '17:00', fin: '19:00', total: 450, total_base: 400, minimo_senia: 135 }], 2);
  assert.equal(tariffs[0].total, 450);
  assert.equal(tariffs[0].duracion, 2);
  assert.equal(tariffs[0].ahorro, 0);
  assert.equal(tariffs[0].tipo_precio, 'tarifa_superior_a_base');
  assert.deepEqual(tariffs[0].inicios_disponibles, [{ fecha: '2026-10-12', hora: '17:00' }]);
  assert.deepEqual(pricedAvailabilityRanges([], 1), []);
  assert.deepEqual(pricedAvailabilityRanges([{ fecha: '2026-10-12', inicio: '17:00' }], 1), []);
});

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
