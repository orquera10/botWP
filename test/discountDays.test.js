import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsDiscountDays, findDiscountDays } from '../src/discountDays.js';
import { handleAiConversation } from '../src/aiConversation.js';

const now = Date.UTC(2026, 9, 10, 15);
const timeZone = 'America/Argentina/Buenos_Aires';
test('recognizes questions about discount days and another day in discount context', () => {
  assert.equal(wantsDiscountDays('vos decime qué días hay canchas con descuento'), true);
  assert.equal(wantsDiscountDays('y para otro día?', [{ role: 'user', parts: [{ text: 'otra cancha con descuento' }] }]), true);
  assert.equal(wantsDiscountDays('y para otro día?', [{ role: 'user', parts: [{ text: 'quiero cancha a las 15' }] }]), false);
  assert.equal(wantsDiscountDays('qué días hay descuentos en Fútbol 5?'), true);
});

test('checks seven dates and returns only real discounts on available slots', async () => {
  const queries = [];
  const result = await findDiscountDays({ now, timeZone, courts: [{ id: 1, nombre: 'Fútbol 5' }, { id: 2, nombre: 'Cancha Promo' }], api: {
    consultarDisponibilidad: async args => {
      queries.push(args);
      if (args.cancha === 2) return [];
      return [{ fecha: args.fecha, inicio: '14:00', total: args.fecha === '2026-10-13' ? 100 : 200, total_base: 200, minimo_senia: 30 }];
    }
  } });
  assert.equal(queries.length, 14);
  assert.equal(result.dias_revisados.length, 7);
  assert.deepEqual(result.opciones.map(o => o.fecha), ['2026-10-13']);
  assert.equal(result.opciones[0].tarifas[0].ahorro, 100);
  assert.equal(result.opciones[0].nombre, 'Fútbol 5');
});

test('another discount day excludes the previously requested date and preserves lookup failures', async () => {
  const result = await findDiscountDays({ now, timeZone, excludeDate: '2026-10-10', courts: [{ id: 1, nombre: 'Fútbol 5' }], api: { consultarDisponibilidad: async () => { throw new Error('network'); } } });
  assert.equal(result.dias_revisados.includes('2026-10-10'), false);
  assert.equal(result.consultas_fallidas, 6);
  assert.deepEqual(result.opciones, []);
});

test('Gemini receives verified discount dates instead of asking the client to choose a date first', async () => {
  let calls = 0;
  const output = await handleAiConversation({ text: 'vos decime qué días hay canchas con descuento', now, state: { updatedAt: now, requestedDate: '2026-10-20' }, reservasApi: {
    listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 6' }],
    consultarDisponibilidad: async ({ fecha }) => fecha === '2026-10-13' ? [{ fecha, inicio: '14:00', total: 100, total_base: 200 }] : []
  }, fetchImpl: async (_url, options) => {
    calls++;
    const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
    assert.match(prompt, /NO pidas una fecha/);
    assert.match(prompt, /martes 13 de octubre/);
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'El martes 13 hay descuento en Fútbol 6 de 14 a 15: $100. ¿Te sirve?' }] } }] }) };
  } });
  assert.equal(calls, 1);
  assert.equal(output.state.requestedDate, '2026-10-20');
  assert.match(output.replies[0], /martes 13/);
  assert.equal(output.state.pending, undefined);
});
