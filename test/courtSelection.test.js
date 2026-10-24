import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCourtSelection, isGeneralDiscountQuery } from '../src/courtSelection.js';
import { handleAiConversation } from '../src/aiConversation.js';

test('promotion queries mean time-based discounts unless a specific court is named', () => {
  for (const text of ['tenés alguna cancha con promoción?', 'alguna cancha con promo para mañana', 'hay descuentos?', 'qué horarios son más baratos?']) assert.equal(isGeneralDiscountQuery(text), true, text);
  for (const text of ['quiero la Cancha Promo', 'Cancha Promo tiene descuento?', 'promociones en Fútbol 5']) assert.equal(isGeneralDiscountQuery(text), false, text);
});

test('a general discount request asks for a date before looking up prices', async () => {
  const output = await handleAiConversation({ text: 'tenés cancha con promoción?', reservasApi: { listarCanchas: () => assert.fail('Need date') }, fetchImpl: () => assert.fail('Need date') });
  assert.deepEqual(output.replies, ['¿Para qué día buscás? Así veo qué horarios tienen descuento.']);
});

test('general promotions search all available courts and identify real discounts, not the Promo court', async () => {
  const queries = [];
  let prompt;
  const output = await handleAiConversation({ text: 'tenés alguna cancha con promoción para mañana?', now: Date.UTC(2026, 9, 10, 15), reservasApi: {
    listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }, { id: 2, nombre: 'Cancha Promo' }, { id: 3, nombre: 'Fútbol 6' }],
    consultarDisponibilidad: async args => {
      queries.push(args.cancha);
      return [{ fecha: args.fecha, inicio: '14:00', total: args.cancha === 1 ? 100 : 80, total_base: args.cancha === 1 ? 200 : 80, minimo_senia: 30 }];
    }
  }, fetchImpl: async (_url, options) => {
    prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'En Fútbol 5, de 14 a 15 sale $100 en vez de $200. ¿Te sirve?' }] } }] }) };
  } });
  assert.deepEqual(queries, [1, 2, 3]);
  const data = JSON.parse(prompt.split('Franjas disponibles con ahorro comprobado: ')[1].split('. Respondé primero')[0]);
  assert.deepEqual(data.map(c => c.nombre), ['Fútbol 5']);
  assert.equal(data[0].tarifas[0].ahorro, 100);
  assert.match(output.replies[0], /Fútbol 5/);
  assert.equal(output.state.pending, undefined);
});

test('generic day request verifies football and birthday options without selecting a court or listing its hours', async () => {
  for (const text of ['quiero cancha para mñn', 'Hola, quiero una cancha para mañana.', 'tenés cancha para el martes?']) {
    const queries = [];
    const requests = [];
    const output = await handleAiConversation({ text, now: Date.UTC(2026, 9, 10, 15), state: { updatedAt: Date.UTC(2026, 9, 10, 15), availability: { cancha: 3, fecha: '2026-10-11' } }, reservasApi: {
      listarCanchas: async () => [{ id: 1, nombre: 'Fútbol 5' }, { id: 2, nombre: 'Cancha Promo' }, { id: 3, nombre: 'Cumpleaños', duracion_fija: 3 }],
      consultarDisponibilidad: async args => { queries.push(args); return args.cancha === 2 ? [] : [{ fecha: args.fecha, inicio: '17:00' }]; }
    }, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hay Fútbol 5 y cumpleaños. ¿Cuántos van a jugar o es para un cumple?' }] } }] }) };
    } });
    assert.deepEqual(queries.map(q => q.duracion), [1, 1, 3]);
    assert.deepEqual(output.state.dayOptions.opciones.map(o => o.disponible), [true, true]);
    assert.deepEqual(output.state.dayOptions.no_disponibles, [2]);
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
  assert.deepEqual(output.state.dayOptions.opciones, []);
  assert.deepEqual(output.state.dayOptions.no_disponibles, [1]);
  assert.equal(output.state.dayOptions.consultas_fallidas, 1);
});

test('explicit or previously supplied players and court types do not trigger another count question', () => {
  for (const text of [
    'somos 10 y quiero cancha mañana',
    'quiero cancha de fútbol 5',
    'quiero cancha para cumpleaños',
    'quiero cancha para 16 personas',
    'qué tipos de cancha tenés?',
    'tenés cancha grande para mañana a las 21?',
    'quiero una f6 para hoy a las 20',
    'hay fut 5 para mañana?',
    'busco cancha para jugar 8x8 mañana',
    'queremos jugar 5 pa 5 hoy',
    'cancha entera para el viernes',
    'queremos alquilar dos canchas para un torneo'
  ]) assert.equal(needsCourtSelection(text), false, text);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'user', parts: [{ text: 'somos 10' }] }]), false);
  assert.equal(needsCourtSelection('quiero cancha mañana', [{ role: 'model', parts: [{ text: '¿Cuántos van a jugar?' }] }, { role: 'user', parts: [{ text: '10' }] }]), false);
});

test('requested hour when occupied across all courts alerts that the specific hour is occupied', async () => {
  let promptText = '';
  const output = await handleAiConversation({
    text: 'hola tenes turno para mñn a las 18:30',
    now: Date.UTC(2026, 9, 21, 11),
    reservasApi: {
      listarCanchas: async () => [
        { id: 1, nombre: 'Fútbol 5' },
        { id: 2, nombre: 'Fútbol 7/8' },
        { id: 3, nombre: 'Cumpleaños', duracion_fija: 3 }
      ],
      consultarDisponibilidad: async ({ fecha, cancha }) => {
        // Slots only at 12:00 to 17:00, 18:30 is occupied
        return [
          { fecha, inicio: '12:00', fin: '13:00' },
          { fecha, inicio: '16:00', fin: '17:00' }
        ];
      }
    },
    fetchImpl: async (_url, options) => {
      promptText = JSON.parse(options.body).systemInstruction.parts[0].text;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'A las 18:30 está ocupado en todas las canchas. Tenemos de 12 a 17. ¿Cuántos van a jugar o les sirve otro horario?' }] } }]
        })
      };
    }
  });

  assert.equal(output.state.dayOptions.hora_solicitada, '18:30');
  assert.equal(output.state.dayOptions.hora_disponible, false);
  assert.deepEqual(output.state.dayOptions.opciones_con_hora, []);
  assert.match(promptText, /18:30.*ocupado/);
  assert.match(output.replies[0], /18:30 está ocupado/);
});

test('requested hour when available confirms availability for that specific hour', async () => {
  let promptText = '';
  const output = await handleAiConversation({
    text: 'hola tenes turno para mñn a las 15:00',
    now: Date.UTC(2026, 9, 21, 11),
    reservasApi: {
      listarCanchas: async () => [
        { id: 1, nombre: 'Fútbol 5' },
        { id: 2, nombre: 'Fútbol 7/8' }
      ],
      consultarDisponibilidad: async ({ fecha, cancha }) => {
        return [{ fecha, inicio: '15:00', fin: '16:00' }];
      }
    },
    fetchImpl: async (_url, options) => {
      promptText = JSON.parse(options.body).systemInstruction.parts[0].text;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Para mañana a las 15:00 tenemos disponible en Fútbol 5 y Fútbol 7/8. ¿Cuántos van a jugar?' }] } }]
        })
      };
    }
  });

  assert.equal(output.state.dayOptions.hora_solicitada, '15:00');
  assert.equal(output.state.dayOptions.hora_disponible, true);
  assert.equal(output.state.dayOptions.opciones_con_hora.length, 2);
  assert.match(promptText, /15:00.*hay lugar/);
  assert.match(output.replies[0], /15:00 tenemos disponible/);
});

test('follow-up hour proposals in active turno inquiry keep needing court selection and check all courts', async () => {
  const history = [
    { role: 'user', parts: [{ text: 'hola tenes turno para mñn a las 18:30' }] },
    { role: 'model', parts: [{ text: 'A las 18:30 está ocupado en todas las canchas. Tenemos de 12:00 a 17:00. ¿Te sirve alguno o cuántos van a jugar?' }] }
  ];

  assert.equal(needsCourtSelection('A las 16.30', history), true);
  assert.equal(needsCourtSelection('16?', history), true);
  assert.equal(needsCourtSelection('a las 15:00', history), true);
  assert.equal(needsCourtSelection('Yo quiero para hoy', history), true);

  // But once court or player count is supplied, court selection is resolved:
  assert.equal(needsCourtSelection('somos 10', history), false);
  assert.equal(needsCourtSelection('quiero fútbol 5', history), false);

  // A negation of promo court does not count as selecting Cancha Promo:
  assert.equal(needsCourtSelection('Yo no quiero cancha promo', history), true);

  // Verify conversation execution with "A las 16.30":
  let promptText = '';
  const output = await handleAiConversation({
    text: 'A las 16.30',
    now: Date.UTC(2026, 9, 21, 11),
    state: {
      updatedAt: Date.UTC(2026, 9, 21, 11),
      requestedDate: '2026-10-22',
      history
    },
    reservasApi: {
      listarCanchas: async () => [
        { id: 5, nombre: 'Fútbol 5' },
        { id: 6, nombre: 'Fútbol 6' },
        { id: 7, nombre: 'Fútbol 7/8' },
        { id: 11, nombre: 'Cancha Promo' }
      ],
      consultarDisponibilidad: async ({ fecha, cancha }) => {
        // Fútbol 5 has 16:30 free
        if (cancha === 5) return [{ fecha, inicio: '16:30', fin: '17:30' }];
        return [];
      }
    },
    fetchImpl: async (_url, options) => {
      promptText = JSON.parse(options.body).systemInstruction.parts[0].text;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Para mañana a las 16:30 hay disponibilidad en Fútbol 5. ¿Cuántos van a jugar?' }] } }]
        })
      };
    }
  });

  assert.equal(output.state.dayOptions.hora_solicitada, '16:30');
  assert.equal(output.state.dayOptions.hora_disponible, true);
  assert.match(promptText, /16:30.*hay lugar in|16:30.*Fútbol 5/);
  assert.doesNotMatch(output.replies[0], /Cancha Promo/);
});

test('date parsing supports Spanish month names and typos like psrs el 27 de noviembre', async () => {
  const courts = [{ id: 8, nombre: 'Cumpleaños', duracion_fija: 3 }];
  const output = await handleAiConversation({
    text: 'Si psrs el 27 de noviembre quería reservar',
    now: new Date('2026-10-24T12:00:00-03:00').getTime(),
    state: {
      updatedAt: new Date('2026-10-24T12:00:00-03:00').getTime(),
      availability: { fecha: '2026-10-24', cancha: 8, nombre: 'Cumpleaños', duracion: 3 },
      history: [
        { role: 'user', parts: [{ text: 'hola tienen para cumple hoy?' }] },
        { role: 'model', parts: [{ text: 'Para hoy tenemos disponible de 13 a 16 o de 21 a 00:00. ¿Te sirve alguno?' }] }
      ]
    },
    reservasApi: {
      listarCanchas: async () => courts,
      consultarDisponibilidad: async ({ fecha, cancha }) => {
        assert.equal(fecha, '2026-11-27');
        assert.equal(cancha, 8);
        return [{ fecha, inicio: '13:00', fin: '16:00' }];
      }
    },
    fetchImpl: async (_url, options) => {
      const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
      assert.match(prompt, /2026-11-27/);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: '¡Dale! Para el viernes 27 de noviembre tenemos disponible de 13 a 16. ¿Te sirve?' }] } }]
        })
      };
    }
  });

  assert.equal(output.state.requestedDate, '2026-11-27');
  assert.equal(output.state.availability.cancha, 8);
  assert.equal(output.state.dayOptions, undefined);
  assert.match(output.replies[0], /27 de noviembre/);

  // Subsequent multi-line message about son's birthday preserves date and does not ask date again
  const followUp = await handleAiConversation({
    text: 'Es un cumple\nDe mi hijo\nQueria consultarte',
    now: new Date('2026-10-24T12:01:00-03:00').getTime(),
    state: output.state,
    reservasApi: {
      listarCanchas: async () => courts,
      consultarDisponibilidad: async ({ fecha, cancha }) => {
        assert.equal(fecha, '2026-11-27');
        return [{ fecha, inicio: '13:00', fin: '16:00' }];
      }
    },
    fetchImpl: async (_url, options) => {
      const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
      assert.match(prompt, /2026-11-27/);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: '¡Qué bueno! Para el cumple de tu hijo tenemos disponible de 13 a 16. ¿Te sirve?' }] } }]
        })
      };
    }
  });

  assert.equal(followUp.state.requestedDate, '2026-11-27');
  assert.equal(followUp.state.availability.cancha, 8);
});



