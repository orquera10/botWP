import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceChatRegistration, fullNameValid } from '../src/chatRegistration.js';
import { handleAiConversation } from '../src/aiConversation.js';
import { handleRegistrationFlow, handleReservationFlow } from '../src/reservationFlow.js';

const now = Date.UTC(2026, 9, 19, 15);
const jid = '123456789012345@lid';
const customer = { id: 9, nombre: 'María Pérez', email: '', telefono: '' };

test('an invented identity failure starts name registration instead of sending the customer away', async () => {
  const output = await handleAiConversation({ now, canonicalJid: jid, text: 'confirmo', reservasApi: { supportsChatIdentity: true, consultarCliente: async () => ({ exists: false }) }, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'No pude identificar tu cuenta automáticamente. Contactá al negocio para generar el link.' }] } }] }) }) });
  assert.equal(output.state.registration.phase, 'name');
  assert.match(output.replies[0], /nombre y apellido/);
  assert.doesNotMatch(output.replies[0], /contact|identificar/);
});

test('an explicit name in the booking message is used directly when the model repeats a fake confirmation', async () => {
  let registrations = 0;
  const output = await handleAiConversation({ now, canonicalJid: jid, text: 'Me reservas cancha Fútbol 5 para mañana\nA nombre de Nestor Cano', reservasApi: { supportsChatIdentity: true, consultarCliente: async () => ({ exists: false }), registrarChat: async ({ nombre }) => { registrations++; assert.equal(nombre, 'Nestor Cano'); return { status: 'verification_required', message: 'Te envié un código al correo registrado.' }; } }, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '¿Confirmás estos datos para generar el link de seña?' }] } }] }) }) });
  assert.equal(registrations, 1);
  assert.equal(output.state.registration.phase, 'code');
  assert.match(output.replies[0], /código/);
});

test('a linked LID recovers from a fake confirmation by executing the real draft tool', async () => {
  let calls = 0;
  const api = { supportsChatIdentity: true, consultarCliente: async () => ({ exists: true, cliente: customer }), listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }], consultarDisponibilidad: async () => [{ fecha: '2026-10-20', inicio: '22:00', total: 100, minimo_senia: 30 }] };
  const output = await handleAiConversation({ now, canonicalJid: jid, text: 'confirmo', reservasApi: api, fetchImpl: async (_url, options) => {
    const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
    assert.doesNotMatch(prompt, /Si no se pudo identificar el remitente/);
    calls++;
    const part = calls === 1 ? { text: '¿Confirmás los datos para generar el link de pago?' } : { functionCall: { name: 'preparar_reserva', args: { fecha: '2026-10-20', hora_inicio: '22:00', cancha: 1, duracion: 1 } } };
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [part] } }] }) };
  } });
  assert.equal(calls, 2);
  assert.equal(output.state.pending.hora_inicio, '22:00');
  assert.match(output.replies[0], /Total: \$100/);
});
test('full name is sufficient for a new customer, without email or invented phone', async () => {
  assert.equal(fullNameValid('María Pérez'), true);
  assert.equal(fullNameValid('María'), false);
  assert.equal(fullNameValid('María 123'), false);
  const result = await advanceChatRegistration({ api: { registrarChat: async args => { assert.deepEqual(args, { nombre: 'María Pérez' }); return { status: 'registered', cliente: customer }; } }, text: 'María Pérez' });
  assert.equal(result.customer.exists, true);
  assert.equal(result.customer.email, '');
});
test('existing full name requires verification; the code is only passed to the business API', async () => {
  const api = { registrarChat: async args => args.codigo ? { status: 'registered', cliente: customer } : { status: 'verification_required', message: 'Escribí el código recibido.' } };
  const challenge = await advanceChatRegistration({ api, text: customer.nombre });
  assert.equal(challenge.state.phase, 'code');
  assert.equal(challenge.customer, undefined);
  const result = await handleAiConversation({ now, canonicalJid: jid, text: '123456', state: { updatedAt: now, registration: challenge.state }, reservasApi: { ...api, supportsChatIdentity: true }, fetchImpl: () => assert.fail('Verification code must not reach Gemini') });
  assert.equal(result.state.customer.id, 9);
  assert.equal(result.state.registration, null);
  assert.doesNotMatch(JSON.stringify(result.state), /123456/);
});
test('ambiguous names request one distinguishing detail without linking another customer', async () => {
  const result = await advanceChatRegistration({ api: { registrarChat: async () => ({ status: 'ambiguous', message: 'Indica el correo registrado.' }) }, text: customer.nombre });
  assert.equal(result.state.phase, 'email');
  assert.equal(result.customer, undefined);
});
test('a linked LID with no email can prepare and create the payment without Gemini during confirmation', async () => {
  let writes = 0;
  const api = { supportsChatIdentity: true, consultarCliente: async () => ({ exists: true, cliente: customer }), listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }], consultarDisponibilidad: async () => [{ fecha: '2026-10-20', inicio: '17:00', total: 100, minimo_senia: 30 }], crearReserva: async args => { writes++; assert.equal(args.cliente.telefono, ''); assert.equal(args.cliente.email, ''); return { reserva: { ticket_id: 77 }, mercadopago: { init_point: 'https://example.com/pagar' } }; } };
  const draft = await handleAiConversation({ now, canonicalJid: jid, text: 'quiero reservar Fútbol 5 a las 17', reservasApi: api, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'preparar_reserva', args: { fecha: '2026-10-20', hora_inicio: '17:00', cancha: 1, duracion: 1 } } }] } }] }) }) });
  assert.ok(draft.state.pending);
  assert.doesNotMatch(draft.replies[0], /[Ee]mail/);
  const paid = await handleAiConversation({ now, canonicalJid: jid, text: 'dale', state: draft.state, reservasApi: api, fetchImpl: () => assert.fail('Confirmation must be deterministic') });
  assert.equal(writes, 1);
  assert.match(paid.replies[0], /https:\/\/example.com\/pagar/);
});
test('automatic menu registration also uses full name, preserves selected slot and skips email', async () => {
  const slot = { fecha: '2026-10-20', inicio: '17:00', fin: '18:00', total: 100, minimo_senia: 30 };
  const api = { configured: () => true, supportsChatIdentity: true, registrarChat: async () => ({ status: 'registered', cliente: customer }) };
  const output = await handleRegistrationFlow({ state: { step: 'chat_register_name', updatedAt: new Date().toISOString(), data: { after: 'availability_reservation', phone: jid, reservationData: { fecha: slot.fecha, slot, cancha: { id: 1, nombre: 'Fútbol 5' }, duracion: 1 } } }, text: customer.nombre, canonicalJid: jid, reservasApi: api });
  assert.equal(output.targetFlow, 'reservation');
  assert.equal(output.state.step, 'ask_confirm');
  assert.equal(output.state.data.slot.inicio, '17:00');
  assert.doesNotMatch(output.replies.join(' '), /Pasame un email/);
  const cancelled = await handleReservationFlow({ state: output.state, text: 'cancelar', canonicalJid: jid, reservasApi: api });
  assert.equal(cancelled.state.step, 'main_menu');
});

test('asking price or questions during registration does not block and passes to Gemini instead of repeating name prompt', async () => {
  let geminiCalled = 0;
  const api = { supportsChatIdentity: true, registrarChat: async () => ({ status: 'registered', cliente: customer }) };
  const pendingState = {
    updatedAt: now,
    registration: { phase: 'name' },
    resumeBooking: { fecha: '2026-10-25', hora_inicio: '13:00', cancha: 8, duracion: 3 }
  };
  const response = await handleAiConversation({
    now,
    canonicalJid: jid,
    text: 'Precio',
    state: pendingState,
    reservasApi: api,
    fetchImpl: async () => {
      geminiCalled++;
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'El cumpleaños sale $180.000 por las 3 horas. ¿Me pasás tu nombre y apellido completos para registrarte?' }] } }] }) };
    }
  });
  assert.equal(geminiCalled, 1);
  assert.match(response.replies[0], /180\.000/);
  assert.equal(response.state.registration.phase, 'name');

  // Customer now sends their valid full name
  const registered = await handleAiConversation({
    now,
    canonicalJid: jid,
    text: 'Mariana Gómez',
    state: response.state,
    reservasApi: api,
    fetchImpl: () => assert.fail('Valid full name must register directly without Gemini')
  });
  assert.equal(registered.state.customer.id, 9);
  assert.match(registered.replies[0], /¡Listo, ya te registré! ¿Seguimos con el turno del domingo 25 de octubre a las 13:00\?/);
});

test('asking for afternoon birthday slot maps to 17:00 and composite catalog query does not cut off with direct', async () => {
  let geminiCalls = 0;
  const api = {
    supportsChatIdentity: true,
    listarCanchas: async () => [{ id: 8, nombre: 'Cumpleaños', duracion_fija: 3, tiene_precios_horarios: false }],
    consultarDisponibilidad: async () => [
      { fecha: '2026-10-31', inicio: '13:00', fin: '16:00', total: 180000, minimo_senia: 90000 },
      { fecha: '2026-10-31', inicio: '21:00', fin: '00:00', total: 180000, minimo_senia: 90000 }
    ]
  };

  // Turn 1: user rejects slots and asks for afternoon
  const turn1 = await handleAiConversation({
    now,
    canonicalJid: jid,
    text: 'Ninguno jaja porque es para 5 años y queremos hacerlo en el horario de la tarde',
    state: {
      updatedAt: now,
      requestedDate: '2026-10-31',
      availability: { fecha: '2026-10-31', cancha: 8, canchaNombre: 'Cumpleaños' }
    },
    reservasApi: api,
    fetchImpl: async (_url, options) => {
      geminiCalls++;
      const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
      assert.match(prompt, /Hora solicitada: 17:00/);
      assert.match(prompt, /180 días de anticipación/);
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Para el sábado 31 el horario de la tarde (17 a 20) ya está ocupado. ¿Querés que busquemos para el domingo o el fin de semana siguiente?' }] } }] }) };
    }
  });
  assert.equal(turn1.state.requestedHour, '17:00');
  assert.match(turn1.replies[0], /17 a 20/);

  // Turn 2: user asks for photo, price, and nearby dates
  let round = 0;
  const turn2 = await handleAiConversation({
    now,
    canonicalJid: jid,
    text: 'me pasarías foto del salón la cancha, precio y fechas cercanas ?',
    state: turn1.state,
    businessSettings: { catalogUrl: 'https://latoxica-fc.com/catalogo.php' },
    reservasApi: api,
    fetchImpl: async () => {
      round++;
      if (round === 1) {
        return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'catalogo', args: {} } }] } }] }) };
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'El cumple sale $180.000 por 3 hs e incluye salón inferior y canchas hasta 30 personas. Podés ver fotos en el catálogo: https://latoxica-fc.com/catalogo.php. Para la tarde tenemos libre el domingo 1 de noviembre.' }] } }] }) };
    }
  });
  assert.equal(round, 2, 'Composite catalog query must allow Gemini second round to include price and dates');
  assert.match(turn2.replies[0], /180\.000/);
  assert.match(turn2.replies[0], /catalogo\.php/);
  assert.match(turn2.replies[0], /domingo 1 de noviembre/);
});
