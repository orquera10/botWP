import test from 'node:test';
import assert from 'node:assert/strict';
import { activateLegacyFallback, prepareAiRetry, hasPendingCheckout, applyResponseModeRevision } from '../src/aiFallback.js';
import { handleAiConversation } from '../src/aiConversation.js';

const now = Date.UTC(2026, 9, 11, 15);
test('the very next message retries AI after a provider failure without waiting', async () => {
  const input = { now, text: 'hola', canonicalJid: '5493881234567@s.whatsapp.net', retryDelay: async () => {} };
  const failed = await handleAiConversation({ ...input, fetchImpl: async () => ({ ok: false, status: 503 }) });
  const state = activateLegacyFallback({ ...failed.state, history: [{ role: 'model', parts: [{ text: 'Elegí una cancha del menú.' }] }] }, now);
  assert.equal(state.fallbackMode, true);
  const retry = prepareAiRetry(state);
  assert.equal(retry.fallbackMode, undefined);
  assert.deepEqual(retry.history, state.history);
  assert.deepEqual(retry.quota, state.quota);
  let calls = 0;
  const recovered = await handleAiConversation({ ...input, now: now + 1000, text: 'Fútbol 5', state: retry, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '¡Dale! ¿Para qué día buscás?' }] } }] }) }; } });
  assert.equal(calls, 1);
  assert.equal(recovered.fallback, undefined);
  assert.equal(recovered.state.fallbackMode, undefined);
  assert.match(recovered.replies[0], /qué día/);
});
test('explicitly saving AI retries it without losing pending payments, registration or quota', () => {
  const original = { fallbackMode: true, fallbackReason: 'HTTP 503', updatedAt: now, responseModeRevision: 'old', checkout: { ticketId: 7 }, registration: { phase: 'code' }, quota: { calls: 20 } };
  const state = applyResponseModeRevision(original, 'new');
  assert.deepEqual(state.checkout, original.checkout);
  assert.deepEqual(state.registration, original.registration);
  assert.deepEqual(state.quota, original.quota);
  assert.equal(original.fallbackMode, true);
  assert.equal(applyResponseModeRevision(original, 'old'), original);
  assert.equal(applyResponseModeRevision(original, undefined), original);
});
test('fallback survives persistence and keeps checkout without an old draft', () => {
  const checkout = { ticketId: 7, status: 'pendiente_pago', createdAt: now };
  const restored = JSON.parse(JSON.stringify(activateLegacyFallback({ pending: { cancha: 1 }, checkout }, now)));
  assert.equal(restored.pending, undefined);
  assert.deepEqual(restored.checkout, checkout);
  assert.equal(hasPendingCheckout(restored, now + 9 * 60_000), true);
  assert.equal(hasPendingCheckout(restored, now + 10 * 60_000), false);
  assert.equal(hasPendingCheckout({ checkout: { ...checkout, status: 'confirmada' } }, now), false);
});
test('provider failure and local quota explicitly request fallback', async () => {
  const input = { now, text: 'hola', canonicalJid: '5493881234567@s.whatsapp.net', retryDelay: async () => {}, fetchImpl: async () => ({ ok: false, status: 503 }) };
  assert.equal((await handleAiConversation(input)).fallback, true);
  assert.equal((await handleAiConversation({ ...input, state: { updatedAt: now, quota: { start: now, calls: 100000 } } })).fallback, true);
});

test('new mode revision survives a quota fallback, without bypassing the call limit', async () => {
  const output = await handleAiConversation({ now, text: 'hola', businessSettings: { aiModeRevision: 'chosen-ai' }, state: { updatedAt: now, quota: { start: now, calls: 100000 } }, fetchImpl: () => assert.fail('Quota must still prevent provider calls') });
  assert.equal(output.fallbackReason, 'quota');
  assert.equal(output.state.responseModeRevision, 'chosen-ai');
  const fallback = activateLegacyFallback(output.state, now);
  assert.equal(applyResponseModeRevision(fallback, 'chosen-ai'), fallback);
});
test('an uncertain reservation write never activates fallback or repeats the write', async () => {
  let writes = 0;
  const output = await handleAiConversation({ now, text: 'dale', canonicalJid: '5493881234567@s.whatsapp.net', state: { updatedAt: now, pending: { cancha: 1 } }, reservasApi: { crearReserva: async () => { writes++; throw new Error('timeout'); } } });
  assert.equal(writes, 1);
  assert.equal(output.fallback, undefined);
  assert.equal(output.state.pending, undefined);
});
