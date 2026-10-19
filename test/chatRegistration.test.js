import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceChatRegistration, fullNameValid } from '../src/chatRegistration.js';
import { handleAiConversation } from '../src/aiConversation.js';
import { handleRegistrationFlow, handleReservationFlow } from '../src/reservationFlow.js';

const now = Date.UTC(2026, 9, 19, 15);
const jid = '123456789012345@lid';
const customer = { id: 9, nombre: 'María Pérez', email: '', telefono: '' };
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
