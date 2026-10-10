import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCourtSelection } from '../src/courtSelection.js';
import { handleAiConversation } from '../src/aiConversation.js';

test('generic booking asks for players before consulting slots or Gemini', async () => {
  for (const text of ['quiero cancha para mñn', 'Hola, quiero una cancha para mañana.', 'tenés cancha para el martes?']) {
    const output = await handleAiConversation({ text, now: Date.UTC(2026, 9, 10, 15), state: { updatedAt: Date.UTC(2026, 9, 10, 15), availability: { cancha: 3, fecha: '2026-10-11' } }, reservasApi: { listarCanchas: () => assert.fail('Must first ask players'), consultarDisponibilidad: () => assert.fail('No availability lookup') }, fetchImpl: () => assert.fail('No invented court') });
    assert.deepEqual(output.replies, ['¡Dale! ¿Cuántos van a jugar?']);
    assert.equal(output.state.history.at(-2).parts[0].text, text);
  }
});

test('explicit or previously supplied players and court types do not trigger another count question', () => {
  for (const text of ['somos 10 y quiero cancha mañana', 'quiero cancha de fútbol 5', 'quiero cancha para cumpleaños', 'quiero cancha para 16 personas', 'qué tipos de cancha tenés?']) assert.equal(needsCourtSelection(text), false, text);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'user', parts: [{ text: 'somos 10' }] }]), false);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'model', parts: [{ text: '¿Cuántos van a jugar?' }] }, { role: 'user', parts: [{ text: '10' }] }]), false);
});
