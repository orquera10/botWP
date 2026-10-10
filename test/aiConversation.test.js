import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiConversation, serializeAiConversation, normalizeBookingArgs, withFootballCapacity, isAcceptance } from '../src/aiConversation.js';

const now = Date.UTC(2026, 9, 10, 15);
test('accepts natural agreement but excludes questions, conditions and changed booking details', () => {
  for (const text of ['Sí', 'dale', 'ok perfecto', 'de acuerdo', 'Perfecto, muchas gracias!', 'Me parece bien', 'Sí, acepto los términos y condiciones', 'dale y confirmo', '👍', '👍🏻', 'pasame el link para pagar', 'no hay problema']) assert.equal(isAcceptance(text), true, text);
  for (const text of ['no', 'no acepto', 'sí pero a las 22', 'perfecto, mejor mañana', '¿dale?', 'si hay lugar', 'si es para mañana', '21', 'gracias', '¿cuánto es la seña?', 'esperá', 'después confirmo']) assert.equal(isAcceptance(text), false, text);
});
test('football capacity counts both teams and leaves unknown courts unspecified', () => {
  assert.equal(withFootballCapacity({ nombre: 'Fútbol 5' }).jugadores_incluidos, 10);
  assert.equal(withFootballCapacity({ nombre: 'Fútbol 6' }).jugadores_incluidos, 12);
  assert.equal(withFootballCapacity({ nombre: 'Fútbol 7/8' }).jugadores_incluidos, 16);
  assert.equal(withFootballCapacity({ nombre: 'Fútbol 7/8' }).jugadores_por_equipo, 8);
  assert.equal(withFootballCapacity({ nombre: 'Cancha Promo' }).jugadores_incluidos, undefined);
});
const base = { now, text: 'Quiero reservar', canonicalJid: '5493881234567@s.whatsapp.net', businessName: 'La Tóxica' };
const pending = { fecha: '2026-10-11', hora_inicio: '20:00', cancha: 1, duracion: 1, cliente: { nombre: 'Ana', email: 'ana@example.com' } };
test('changing birthday date does not reuse an old checkout or skip summary and terms', async () => {
  let writes = 0;
  const api = {
    listarCanchas: async () => [{ id: 1, nombre: 'Cumpleaños', duracion_fija: 3 }],
    consultarDisponibilidad: async args => {
      assert.equal(args.fecha, '2026-10-24');
      return [{ fecha: args.fecha, inicio: '13:00', label: '13:00 a 16:00', total: 300, minimo_senia: 90 }];
    },
    listarTerminos: async () => ['Condiciones del cumpleaños'],
    crearReserva: async args => {
      writes++;
      assert.equal(args.fecha, '2026-10-24');
      assert.equal(args.hora_inicio, '13:00');
      assert.equal(args.acepta_terminos, true);
      return { reserva: { ticket_id: 456 }, mercadopago: { init_point: 'https://pago.example/nuevo' } };
    }
  };
  const oldState = { updatedAt: now, customer: { exists: true, nombre: 'Ana', email: 'ana@example.com' }, checkout: { ticketId: 123, status: 'pendiente_pago', createdAt: now, url: 'https://pago.example/viejo' }, availability: { fecha: '2026-10-22', cancha: 1, duracion: 3 } };
  const changed = await handleAiConversation({ ...base, text: 'y para el 24?', state: oldState, reservasApi: api, fetchImpl: fakeGemini([call('disponibilidad', { fecha: '2026-10-22', cancha: 1, duracion: 3 }), reply('Hay de 13 a 16.')]) });
  const draft = await handleAiConversation({ ...base, text: 'de 13 a 16', state: changed.state, reservasApi: api, fetchImpl: fakeGemini([call('preparar_reserva', { fecha: '2026-10-21', hora_inicio: '13:00', cancha: 1, duracion: 3 })]) });
  assert.equal(writes, 0);
  assert.match(draft.replies[0], /2026-10-24/);
  assert.match(draft.replies[0], /13:00 a 16:00/);
  assert.match(draft.replies[0], /Condiciones del cumpleaños/);
  assert.doesNotMatch(draft.replies[0], /pago.example\/viejo/);
  const paid = await handleAiConversation({ ...base, text: 'dale', state: draft.state, reservasApi: api });
  assert.equal(writes, 1);
  assert.equal(paid.state.checkout.booking.fecha, '2026-10-24');
  assert.match(paid.replies[0], /pago.example\/nuevo/);
});

test('a previous checkout cannot confirm payment for a newly selected date', async () => {
  const output = await handleAiConversation({ ...base, text: 'ya hice el pago', state: { updatedAt: now, requestedDate: '2026-10-24', checkout: { ticketId: 123, booking: { fecha: '2026-10-21' } } }, reservasApi: { consultarTurnos: () => assert.fail('Must not confirm the old ticket') } });
  assert.match(output.replies[0], /no corresponde a la fecha/);
});
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

test('registered sender data fills reservation without requesting name or email', async () => {
  const requests = [];
  const api = {
    consultarCliente: async args => { assert.deepEqual(args, { telefono: '5493881234567' }); return { exists: true, cliente: { nombre: 'Ana Registrada', email: 'ana@example.com' } }; },
    listarCanchas: async () => [{ id: 1, nombre: 'Cancha 1' }],
    consultarDisponibilidad: async () => [{ fecha: pending.fecha, inicio: pending.hora_inicio, label: '20 a 21', total: 30000, minimo_senia: 10000 }],
    listarTerminos: async () => ['Condiciones']
  };
  const result = await handleAiConversation({ ...base, reservasApi: api, fetchImpl: fakeGemini([call('preparar_reserva', { fecha: pending.fecha, hora_inicio: pending.hora_inicio, cancha: 1, duracion: 1 })], requests) });
  assert.equal(result.state.pending.cliente.nombre, 'Ana Registrada');
  assert.equal(result.state.pending.cliente.email, 'ana@example.com');
  assert.match(requests[0].systemInstruction.parts[0].text, /Ana Registrada/);
  assert.match(result.replies[0], /enlace de Mercado Pago/);
});

test('natural acceptance returns exact Mercado Pago URL and never marks paid', async () => {
  const result = await handleAiConversation({ ...base, text: 'Sí, acepto los términos', state: { updatedAt: now, pending }, reservasApi: {
    crearReserva: async () => ({ reserva: { ticket_id: 123, estado: 'pendiente_pago', senia: 10000 }, mercadopago: { init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=exact' } })
  }, fetchImpl: () => assert.fail('Confirmation should bypass AI') });
  assert.equal(result.state.checkout.status, 'pendiente_pago');
  assert.match(result.replies[0], /pref_id=exact/);
  assert.match(result.replies[0], /Todavía está pendiente/);
});

test('a claim of payment is verified by ticket and sender before confirmation', async () => {
  for (const estado of ['pendiente_pago', 'confirmada']) {
    const result = await handleAiConversation({ ...base, text: 'Ya pagué', state: { updatedAt: now, checkout: { ticketId: 123, status: 'pendiente_pago', createdAt: now, url: 'https://pago.example' } }, reservasApi: {
      consultarTurnos: async args => { assert.equal(args.telefono, '5493881234567'); return { turnos: [{ ticket_id: 123, estado, cancha: 'Fútbol 5', fecha: '11/10', hora_inicio: '20:00', hora_fin: '21:00' }] }; }
    }, fetchImpl: () => assert.fail('Payment verification should bypass AI') });
    if (estado === 'confirmada') assert.match(result.replies[0], /reserva está confirmada en el sistema/);
    else assert.match(result.replies[0], /Todavía está pendiente/);
  }
});

test('catalog URL is delivered literally without audio transcription changes', async () => {
  const url = 'https://example.com/catalogo.php?negocio=la-toxica';
  const result = await handleAiConversation({ ...base, businessSettings: { catalogUrl: url }, fetchImpl: fakeGemini([call('catalogo')]) });
  assert.ok(result.replies[0].includes(url));
});

test('numeric tool strings are normalized and availability context survives next message', async () => {
  assert.deepEqual(normalizeBookingArgs({ cancha: '5', duracion: '1', hora_inicio: '9' }), { cancha: 5, duracion: 1, hora_inicio: '09:00' });
  const requests = [];
  const api = {
    listarCanchas: async () => [{ id: 5, nombre: 'Fútbol 5' }],
    consultarDisponibilidad: async args => { assert.deepEqual(args, { fecha: pending.fecha, cancha: 5, duracion: 1 }); return []; }
  };
  const first = await handleAiConversation({ ...base, reservasApi: api, fetchImpl: fakeGemini([call('disponibilidad', { fecha: pending.fecha, cancha: '5', duracion: '1' }), reply('No hay horarios.')]) });
  assert.equal(first.state.availability.cancha, 5);
  await handleAiConversation({ ...base, text: '21', state: first.state, reservasApi: api, fetchImpl: fakeGemini([reply('Consulto las 21:00.')], requests) });
  assert.match(requests[0].systemInstruction.parts[0].text, /"nombre":"Fútbol 5"/);
});

test('business validation errors remain distinct from technical failures and log only booking parameters', async () => {
  const diagnostics = [];
  const requests = [];
  const api = {
    listarCanchas: async () => [{ id: 5 }],
    consultarDisponibilidad: async () => { const error = new Error('upstream'); error.status = 400; error.data = { message: 'La fecha supera el plazo permitido.' }; throw error; }
  };
  await handleAiConversation({ ...base, reservasApi: api, onDiagnostic: d => diagnostics.push(d), fetchImpl: fakeGemini([call('disponibilidad', { fecha: pending.fecha, cancha: 5, duracion: 1 }), reply('La fecha supera el plazo permitido.')], requests) });
  assert.equal(diagnostics[0].status, 400);
  assert.equal(diagnostics[0].parameters.cancha, 5);
  assert.match(JSON.stringify(requests[1].contents), /La fecha supera el plazo permitido/);
  assert.match(JSON.stringify(requests[1].contents), /validation/);
});
