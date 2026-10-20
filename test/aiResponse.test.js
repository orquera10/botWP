import test from 'node:test';
import assert from 'node:assert/strict';
import { incompleteModelText } from '../src/aiResponse.js';
import { handleAiConversation } from '../src/aiConversation.js';

test('detects clear truncation while allowing concise complete answers', () => {
  for (const value of ['Tiene costo adicional. ¿Querés', 'Puedo ayudarte con', 'Los horarios son:']) assert.equal(incompleteModelText(value), true);
  for (const value of ['¡Hola!', 'Está disponible', 'Sale $100', '¿Qué horario te sirve?', 'Tiene costo adicional.']) assert.equal(incompleteModelText(value), false);
});
test('truncated provider text retries without sending or saving the incomplete reply', async () => {
  let calls = 0;
  const result = await handleAiConversation({ text: 'Cuánto sale la vajilla', canonicalJid: '5493881234567@s.whatsapp.net', retryDelay: async () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: ++calls === 1 ? 'Tiene costo adicional. ¿Querés' : 'Tiene costo adicional; consultá al negocio por el importe.' }] } }] }) }) });
  assert.equal(calls, 2);
  assert.equal(result.state.quota.calls, 2);
  assert.doesNotMatch(JSON.stringify(result.state.history), /¿Querés/);
  assert.match(result.replies[0], /importe\.$/);
});
