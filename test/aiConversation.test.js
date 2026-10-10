import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiConversation, serializeAiConversation } from '../src/aiConversation.js';

const now = Date.UTC(2026, 9, 10, 15);
const base = { now, text: 'Quiero reservar', canonicalJid: '5493881234567@s.whatsapp.net', businessName: 'La Tóxica' };
const pending = { fecha: '2026-10-11', hora_inicio: '20:00', cancha: 1, duracion: 1, cliente: { nombre: 'Ana', email: 'ana@example.com' } };
const call = (name, args = {}) => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
const reply = text => ({ role: 'model', parts: [{ text }] });
function fakeGemini(contents, requests = []) {
  return async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.match(url, /generativelanguage.googleapis.com/);
    const content = contents.shift();
    assert.ok(content, 'Unexpected extra Gemini call');
    return { ok: true, json: async () => ({ candidates: [{ content }] }) };
  };
}

test('draft verifies slots and terms and does not write until next explicit acceptance', async () => {
  let writes = 0;
  const api = {
    listarCanchas: async () => [{ id: 1, nombre: 'Cancha 1' }],
    consultarDisponibilidad: async () => [{ fecha: pending.fecha, inicio: '20:00', label: '20 a 21', total: 30000, minimo_senia: 10000 }],
    listarTerminos: async () => ['Condición de prueba'],
    crearReserva: async payload => { writes++; assert.equal(payload.cliente.telefono, '5493881234567'); return { mercadopago: { init_point: 'https://pago.example' } }; }
  };
  const args = { ...pending, nombre: 'Ana', email: 'ana@example.com' };
  const draft = await handleAiConversation({ ...base, reservasApi: api, fetchImpl: fakeGemini([call('preparar_reserva', args)]) });
  assert.equal(writes, 0);
  assert.match(draft.replies[0], /Condición de prueba/);
  assert.ok(draft.state.pending);
  const confirmed = await handleAiConversation({ ...base, text: 'Sí, acepto', state: draft.state, reservasApi: api, fetchImpl: () => assert.fail('Confirmation must not call Gemini') });
  assert.equal(writes, 1);
  assert.equal(confirmed.state.pending, undefined);
  assert.match(confirmed.replies[0], /https:\/\/pago.example/);
});

test('expired or ambiguous confirmations cannot write', async () => {
  for (const [text, updatedAt] of [['sí', now - 31 * 60_000], ['sí pero a las 22', now]]) {
    const result = await handleAiConversation({ ...base, text, state: { updatedAt, pending }, reservasApi: { crearReserva: () => assert.fail('Unexpected write') }, fetchImpl: fakeGemini([reply('¿A las 22?')]) });
    assert.equal(result.state.pending, undefined);
  }
});

test('queries ignore model supplied third-party identity and forbidden functions', async () => {
  const requests = [];
  const result = await handleAiConversation({ ...base, reservasApi: { consultarTurnos: async args => { assert.deepEqual(args, { telefono: '5493881234567' }); return { turnos: [] }; } }, fetchImpl: fakeGemini([call('mis_turnos', { telefono: 'otro' }), call('cancelar'), reply('No tenés turnos.')], requests) });
  assert.equal(result.replies[0], 'No tenés turnos.');
  assert.match(JSON.stringify(requests[2]), /Función no permitida/);
});

test('failed reservation consumes confirmation and never retries', async () => {
  let calls = 0;
  const result = await handleAiConversation({ ...base, text: 'confirmo', state: { updatedAt: now, pending }, reservasApi: { crearReserva: async () => { calls++; throw new Error('network'); } } });
  assert.equal(calls, 1);
  assert.equal(result.state.pending, undefined);
  assert.match(result.replies[0], /Consultá tus turnos/);
});

test('hourly cap and repeated unrelated messages avoid Gemini calls', async () => {
  for (const state of [{ updatedAt: now, quota: { start: now, calls: 100000 } }, { updatedAt: now, offTopic: 3 }]) {
    await handleAiConversation({ ...base, text: 'contame un chiste', state, fetchImpl: () => assert.fail('Quota/filter must run before Gemini') });
  }
});

test('same conversation is serialized and a rejection does not block following work', async () => {
  const order = [];
  const first = serializeAiConversation('test', async () => { order.push(1); await new Promise(resolve => setTimeout(resolve, 5)); order.push(2); throw new Error('test'); });
  const second = serializeAiConversation('test', async () => { order.push(3); });
  await Promise.allSettled([first, second]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('registration asks for confirmation and uses sender phone', async () => {
  let registered = false;
  const api = { crearCliente: async args => { registered = true; assert.equal(args.telefono, '5493881234567'); } };
  const prepared = await handleAiConversation({ ...base, reservasApi: api, fetchImpl: fakeGemini([call('preparar_registro', { nombre: 'Ana', email: 'ana@example.com' })]) });
  assert.equal(registered, false);
  assert.equal(prepared.state.pending.kind, 'registration');
  await handleAiConversation({ ...base, text: 'confirmo', state: prepared.state, reservasApi: api });
  assert.equal(registered, true);
});

test('unavailable slot never becomes a pending reservation', async () => {
  const api = { listarCanchas: async () => [{ id: 1 }], consultarDisponibilidad: async () => [] };
  const output = await handleAiConversation({ ...base, reservasApi: api, fetchImpl: fakeGemini([call('preparar_reserva', { ...pending, nombre: 'Ana', email: 'ana@example.com' }), reply('Ese horario no está disponible.')]) });
  assert.equal(output.state.pending, undefined);
});

test('provider error returns fallback without exposing upstream body', async () => {
  const output = await handleAiConversation({ ...base, fetchImpl: async () => ({ ok: false, status: 429, json: () => assert.fail('Do not read error body') }) });
  assert.match(output.replies[0], /No pude completar/);
  assert.equal(output.state.quota.calls, 1);
});

test('unrelated topic uses fixed response and counts strikes', async () => {
  const output = await handleAiConversation({ ...base, text: 'escribime un poema', fetchImpl: fakeGemini([call('fuera_de_tema')]) });
  assert.equal(output.state.offTopic, 1);
  assert.match(output.replies[0], /canchas/);
});
