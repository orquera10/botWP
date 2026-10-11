import test from 'node:test';
import assert from 'node:assert/strict';
import { activateLegacyFallback, useLegacyFallback, hasPendingCheckout } from '../src/aiFallback.js';
import { handleAiConversation } from '../src/aiConversation.js';

const now = Date.UTC(2026, 9, 11, 15);
test('fallback survives persistence and keeps checkout without an old draft', () => {
  const checkout = { ticketId: 7, status: 'pendiente_pago', createdAt: now };
  const restored = JSON.parse(JSON.stringify(activateLegacyFallback({ pending: { cancha: 1 }, checkout }, now)));
  assert.equal(restored.pending, undefined);
  assert.deepEqual(restored.checkout, checkout);
  assert.equal(useLegacyFallback(restored, now + 29 * 60_000), true);
  assert.equal(useLegacyFallback(restored, now + 30 * 60_000), false);
  assert.equal(hasPendingCheckout(restored, now + 9 * 60_000), true);
  assert.equal(hasPendingCheckout(restored, now + 10 * 60_000), false);
  assert.equal(hasPendingCheckout({ checkout: { ...checkout, status: 'confirmada' } }, now), false);
});
test('provider failure and local quota explicitly request fallback', async () => {
  const input = { now, text: 'hola', canonicalJid: '5493881234567@s.whatsapp.net', retryDelay: async () => {}, fetchImpl: async () => ({ ok: false, status: 503 }) };
  assert.equal((await handleAiConversation(input)).fallback, true);
  assert.equal((await handleAiConversation({ ...input, state: { updatedAt: now, quota: { start: now, calls: 100000 } } })).fallback, true);
});
test('an uncertain reservation write never activates fallback or repeats the write', async () => {
  let writes = 0;
  const output = await handleAiConversation({ now, text: 'dale', canonicalJid: '5493881234567@s.whatsapp.net', state: { updatedAt: now, pending: { cancha: 1 } }, reservasApi: { crearReserva: async () => { writes++; throw new Error('timeout'); } } });
  assert.equal(writes, 1);
  assert.equal(output.fallback, undefined);
  assert.equal(output.state.pending, undefined);
});
