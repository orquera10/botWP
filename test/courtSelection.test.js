import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCourtSelection } from '../src/courtSelection.js';
import { handleAiConversation } from '../src/aiConversation.js';

test('generic day request verifies football and birthday options without selecting a court or listing its hours', async () => {
  for (const text of ['quiero cancha para mñn', 'Hola, quiero una cancha para mañana.', 'tenés cancha para el martes?']) {
    const queries = [];
    const requests = [];
    const output = await handleAiConversation({ text, now: Date.UTC(2026, 9, 10, 15), state: { updatedAt: Date.UTC(2026, 9, 10, 15), availability: { cancha: 3, fecha: '2026-10-11' } }, reservasApi: {
      listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }, { id: 2, nombre: 'Fútbol 6' }, { id: 3, nombre: 'Cumpleaños', duracion_fija: 3 }],
      consultarDisponibilidad: async args => { queries.push(args); return args.cancha === 2 ? [] : [{ fecha: args.fecha, inicio: '17:00' }]; }
    }, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hay Fútbol 5 y cumpleaños. ¿Cuántos van a jugar o es para un cumple?' }] } }] }) };
    } });
    assert.deepEqual(queries.map(q => q.duracion), [1, 1, 3]);
    assert.deepEqual(output.state.dayOptions.opciones.map(o => o.disponible), [true, false, true]);
    assert.equal(output.state.availability, undefined);
    assert.match(requests[0].systemInstruction.parts[0].text, /Falta definir actividad o cantidad de jugadores/);
    assert.deepEqual(output.replies, ['Hay Fútbol 5 y cumpleaños. ¿Cuántos van a jugar o es para un cumple?']);
    assert.equal(output.state.history.at(-2).parts[0].text, text);
  }
});

test('without a date the bot asks players without claiming any availability', async () => {
  const output = await handleAiConversation({ text: 'quiero cancha', reservasApi: { listarCanchas: () => assert.fail('No date yet') }, fetchImpl: () => assert.fail('No lookup') });
  assert.deepEqual(output.replies, ['¡Dale! ¿Cuántos van a jugar?']);
});

test('failed court lookups are not reported as available or unavailable', async () => {
  const output = await handleAiConversation({ text: 'hay turno para mañana?', now: Date.UTC(2026, 9, 10, 15), reservasApi: {
    listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }, { id: 2, nombre: 'Cumpleaños', duracion_fija: 3 }],
    consultarDisponibilidad: async ({ cancha }) => { if (cancha === 2) throw new Error('network'); return []; }
  }, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '¿Buscás jugar o es para un cumple?' }] } }] }) }) });
  assert.deepEqual(output.state.dayOptions.opciones, [{ cancha: 1, nombre: 'Fútbol 5', disponible: false }]);
  assert.equal(output.state.dayOptions.consultas_fallidas, 1);
});

test('explicit or previously supplied players and court types do not trigger another count question', () => {
  for (const text of ['somos 10 y quiero cancha mañana', 'quiero cancha de fútbol 5', 'quiero cancha para cumpleaños', 'quiero cancha para 16 personas', 'qué tipos de cancha tenés?']) assert.equal(needsCourtSelection(text), false, text);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'user', parts: [{ text: 'somos 10' }] }]), false);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'model', parts: [{ text: '¿Cuántos van a jugar?' }] }, { role: 'user', parts: [{ text: '10' }] }]), false);
});
