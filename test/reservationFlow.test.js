import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRegistrationFlow, handleReservationFlow } from '../src/reservationFlow.js';
import {
  addDaysToIso,
  formatIsoDateForUser,
  todayIsoInBusinessTimeZone
} from '../src/dateUtils.js';

function fakeApi(overrides = {}) {
  return {
    configured: () => true,
    ...overrides
  };
}

const baseInput = {
  state: null,
  canonicalJid: '123456789@lid',
  pushName: 'Joaquin',
  businessName: 'La Toxica',
  businessSettings: {},
  registrationAvailable: true
};

test('un saludo presenta al asistente y no inicia el registro', async () => {
  const result = await handleReservationFlow({
    ...baseInput,
    text: 'hola',
    reservasApi: fakeApi()
  });

  assert.equal(result.state, null);
  assert.match(result.replies[0], /asistente virtual de La Toxica/i);
  assert.match(result.replies[0], /1\. Buscar un turno/i);
  assert.doesNotMatch(result.replies[0], /Pasame tu nombre/i);
});

test('la opcion 1 inicia la reserva y explica el pedido de telefono para un LID', async () => {
  const result = await handleReservationFlow({
    ...baseInput,
    text: '1',
    reservasApi: fakeApi()
  });

  assert.equal(result.state?.step, 'ask_phone');
  assert.equal(result.state?.data?.intent, 'reservation');
  assert.match(result.replies[0], /asistente virtual de La Toxica/i);
  assert.match(result.replies[0], /Para continuar con la reserva necesito algunos datos/i);
  assert.match(result.replies[0], /WhatsApp no me lo proporciono automaticamente/i);
});

test('las opciones 3 y 4 activan consulta y productos desde el menu', async () => {
  const queryResult = await handleReservationFlow({
    ...baseInput,
    text: '3',
    reservasApi: fakeApi()
  });
  assert.equal(queryResult.state?.step, 'ask_phone');
  assert.equal(queryResult.state?.data?.intent, 'query');

  const productResult = await handleReservationFlow({
    ...baseInput,
    text: '4',
    businessSettings: { catalogUrl: 'https://ejemplo.com/catalogo' },
    reservasApi: fakeApi()
  });
  assert.equal(productResult.state, null);
  assert.match(productResult.replies[0], /https:\/\/ejemplo\.com\/catalogo/);
});

test('la opcion 2 consulta disponibilidad sin pedir datos y luego ofrece reservar', async () => {
  const canchas = [{ id: 1, nombre: 'Cancha 1' }];
  const slots = [{ fecha: todayIsoInBusinessTimeZone(), inicio: '18:00', fin: '19:00', label: '18:00 a 19:00' }];
  const api = fakeApi({
    listarCanchas: async () => canchas,
    consultarDisponibilidad: async () => slots
  });

  const started = await handleReservationFlow({ ...baseInput, text: '2', reservasApi: api });
  assert.equal(started.state?.step, 'ask_cancha');
  assert.equal(started.state?.data?.availabilityOnly, true);

  const court = await handleReservationFlow({ ...baseInput, state: started.state, text: '1', reservasApi: api });
  const duration = await handleReservationFlow({ ...baseInput, state: court.state, text: '1', reservasApi: api });
  const availability = await handleReservationFlow({
    ...baseInput,
    state: duration.state,
    text: 'hoy',
    reservasApi: api
  });

  assert.equal(availability.state?.step, 'ask_availability_reserve');
  assert.match(availability.replies[0], /¿Queres reservar uno de estos horarios\?/i);
  assert.doesNotMatch(availability.replies[0], /numero de contacto/i);

  const accepted = await handleReservationFlow({
    ...baseInput,
    state: availability.state,
    text: '1',
    reservasApi: api
  });
  assert.equal(accepted.state?.step, 'ask_slot');

  const selected = await handleReservationFlow({
    ...baseInput,
    state: accepted.state,
    text: '1',
    reservasApi: api
  });
  assert.equal(selected.state?.step, 'ask_phone');
  assert.equal(selected.state?.data?.intent, 'reservation_after_availability');
  assert.equal(selected.state?.data?.slot?.inicio, '18:00');
  assert.match(selected.replies[0], /Para terminar de preparar la reserva necesito algunos datos/i);
  assert.match(selected.replies[0], /Primero, pasame tu numero de telefono/i);

  const registrationApi = fakeApi({
    consultarCliente: async () => ({ exists: false }),
    crearCliente: async ({ nombre, email, telefono }) => ({
      created: true,
      cliente: { nombre, email, telefono }
    }),
    listarTerminos: async () => ['La seña confirma el turno.']
  });
  const identified = await handleReservationFlow({
    ...baseInput,
    state: selected.state,
    text: '+54 9 388 410-4530',
    reservasApi: registrationApi
  });
  assert.equal(identified.targetFlow, 'registration');
  assert.equal(identified.state?.step, 'ask_register_name');
  assert.match(identified.replies[0], /necesito dos datos mas para terminar la reserva/i);
  assert.match(identified.replies[0], /pasame tu nombre y apellido/i);

  const named = await handleRegistrationFlow({
    ...baseInput,
    state: identified.state,
    text: 'Juan Perez',
    reservasApi: registrationApi
  });
  const registered = await handleRegistrationFlow({
    ...baseInput,
    state: named.state,
    text: 'juan@example.com',
    reservasApi: registrationApi
  });
  assert.equal(registered.targetFlow, 'reservation');
  assert.equal(registered.state?.step, 'ask_terms');
  assert.equal(registered.state?.data?.slot?.inicio, '18:00');
  assert.match(named.replies[0], /Para terminar, pasame tu email/i);
});

test('una opcion numerica dentro de una reserva sigue siendo una seleccion', async () => {
  const canchas = [{ id: 1, nombre: 'Cancha 1' }, { id: 2, nombre: 'Cancha 2' }];
  const result = await handleReservationFlow({
    ...baseInput,
    state: {
      step: 'ask_cancha',
      data: { phone: '5493884104530', canchas },
      updatedAt: new Date().toISOString()
    },
    text: '2',
    canonicalJid: '5493884104530@s.whatsapp.net',
    reservasApi: fakeApi()
  });

  assert.equal(result.state?.step, 'ask_duracion');
  assert.equal(result.state?.data?.cancha?.id, 2);
});

test('muestra ejemplos dinamicos en dd/mm/aaaa y dd/mm', async () => {
  const today = formatIsoDateForUser(todayIsoInBusinessTimeZone());
  const result = await handleReservationFlow({
    ...baseInput,
    state: {
      step: 'ask_duracion',
      data: { phone: '5493884104530', cancha: { id: 1, nombre: 'Cancha 1' } },
      updatedAt: new Date().toISOString()
    },
    text: '1',
    canonicalJid: '5493884104530@s.whatsapp.net',
    reservasApi: fakeApi()
  });

  assert.equal(result.state?.step, 'ask_fecha');
  assert.match(result.replies[0], new RegExp(today.replaceAll('/', '\\/')));
  assert.match(result.replies[0], /"hoy" o "mañana"/i);
});

test('acepta dd/mm/aaaa, dd/mm, hoy y mañana', async (t) => {
  const todayIso = todayIsoInBusinessTimeZone();
  const todayUser = formatIsoDateForUser(todayIso);
  const tomorrowIso = addDaysToIso(todayIso, 1);
  const cases = [
    [todayUser, todayIso],
    [todayUser.slice(0, 5), todayIso],
    ['hoy', todayIso],
    ['mañana', tomorrowIso]
  ];

  for (const [input, expected] of cases) {
    await t.test(input, async () => {
      let requestedDate = '';
      const result = await handleReservationFlow({
        ...baseInput,
        state: {
          step: 'ask_fecha',
          data: {
            phone: '5493884104530',
            cancha: { id: 1, nombre: 'Cancha 1' },
            duracion: 1
          },
          updatedAt: new Date().toISOString()
        },
        text: input,
        canonicalJid: '5493884104530@s.whatsapp.net',
        reservasApi: fakeApi({
          consultarDisponibilidad: async ({ fecha }) => {
            requestedDate = fecha;
            return [{ fecha, inicio: '18:00', fin: '19:00', label: '18:00 a 19:00' }];
          }
        })
      });

      assert.equal(requestedDate, expected);
      assert.equal(result.state?.step, 'ask_slot');
    });
  }
});
