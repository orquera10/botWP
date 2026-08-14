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

function mainMenuState() {
  return {
    step: 'main_menu',
    data: { pushName: baseInput.pushName },
    updatedAt: new Date().toISOString()
  };
}

test('un saludo presenta al asistente y no inicia el registro', async () => {
  const result = await handleReservationFlow({
    ...baseInput,
    text: 'hola',
    reservasApi: fakeApi()
  });

  assert.equal(result.state?.step, 'main_menu');
  assert.match(result.replies[0], /asistente virtual de La Toxica/i);
  assert.match(result.replies[0], /1\. Buscar un turno/i);
  assert.doesNotMatch(result.replies[0], /Pasame tu nombre/i);

  const directIntent = await handleReservationFlow({
    ...baseInput,
    text: 'quiero saber si hay turno disponible',
    reservasApi: fakeApi()
  });
  assert.equal(directIntent.state?.step, 'main_menu');
  assert.match(directIntent.replies[0], /asistente virtual de La Toxica/i);
  assert.doesNotMatch(directIntent.replies[0], /numero de telefono/i);
});

test('un pedido de registro en el primer contacto tambien pasa por el menu principal', async () => {
  const registrationResult = await handleRegistrationFlow({
    ...baseInput,
    text: 'quiero registrarme',
    reservasApi: fakeApi()
  });
  assert.equal(registrationResult.handled, false);

  const menuResult = await handleReservationFlow({
    ...baseInput,
    text: 'quiero registrarme',
    reservasApi: fakeApi()
  });
  assert.equal(menuResult.state?.step, 'main_menu');
  assert.match(menuResult.replies[0], /asistente virtual/i);
});

test('la opcion 1 posterga el registro hasta despues de elegir el horario', async () => {
  const slots = [{
    fecha: todayIsoInBusinessTimeZone(),
    inicio: '18:00',
    fin: '19:00',
    label: '18:00 a 19:00'
  }];
  const api = fakeApi({
    listarCanchas: async () => [{ id: 1, nombre: 'Cancha 1' }],
    consultarDisponibilidad: async () => slots
  });
  const started = await handleReservationFlow({
    ...baseInput,
    state: mainMenuState(),
    text: '1',
    reservasApi: api
  });
  assert.equal(started.state?.step, 'ask_cancha');
  assert.doesNotMatch(started.replies[0], /numero de telefono/i);

  const court = await handleReservationFlow({ ...baseInput, state: started.state, text: '1', reservasApi: api });
  const duration = await handleReservationFlow({ ...baseInput, state: court.state, text: '1', reservasApi: api });
  const date = await handleReservationFlow({ ...baseInput, state: duration.state, text: 'hoy', reservasApi: api });
  assert.equal(date.state?.step, 'ask_slot');
  assert.doesNotMatch(date.replies[0], /registr/i);

  const selected = await handleReservationFlow({ ...baseInput, state: date.state, text: '1', reservasApi: api });
  assert.equal(selected.state?.step, 'ask_phone');
  assert.equal(selected.state?.data?.intent, 'reservation_after_availability');
  assert.equal(selected.state?.data?.slot?.inicio, '18:00');
  assert.match(selected.replies[0], /Para terminar de preparar la reserva necesito algunos datos/i);
});

test('las opciones 3 y 4 activan consulta y productos desde el menu', async () => {
  const queryResult = await handleReservationFlow({
    ...baseInput,
    state: mainMenuState(),
    text: '3',
    reservasApi: fakeApi()
  });
  assert.equal(queryResult.state?.step, 'ask_phone');
  assert.equal(queryResult.state?.data?.intent, 'query');
  assert.doesNotMatch(queryResult.replies[0], /asistente virtual/i);

  const productResult = await handleReservationFlow({
    ...baseInput,
    state: mainMenuState(),
    text: '4',
    businessSettings: { catalogUrl: 'https://ejemplo.com/catalogo' },
    reservasApi: fakeApi()
  });
  assert.equal(productResult.state?.step, 'main_menu');
  assert.match(productResult.replies[0], /https:\/\/ejemplo\.com\/catalogo/);
});

test('mis reservas guia la vinculacion por email cuando el telefono no existe', async () => {
  let phoneLinked = false;
  const client = {
    nombre: 'Cliente Existente',
    email: 'cliente@example.com',
    telefono: '5493884104530'
  };
  const api = fakeApi({
    consultarCliente: async ({ telefono, email }) => {
      if (email === client.email || (telefono === client.telefono && phoneLinked)) {
        return { exists: true, cliente: client };
      }
      return { exists: false };
    },
    crearCliente: async () => {
      phoneLinked = true;
      return { created: false, cliente: client };
    },
    consultarTurnos: async () => ({
      turnos: [{
        ticket_id: 10,
        cancha: 'Cancha 1',
        fecha: todayIsoInBusinessTimeZone(),
        hora_inicio: '18:00',
        hora_fin: '19:00',
        estado: 'confirmado'
      }]
    })
  });

  const menuChoice = await handleReservationFlow({
    ...baseInput,
    state: mainMenuState(),
    text: '3',
    reservasApi: api
  });
  const phoneResult = await handleReservationFlow({
    ...baseInput,
    state: menuChoice.state,
    text: '+54 9 388 410-4530',
    reservasApi: api
  });

  assert.equal(phoneResult.targetFlow, 'registration');
  assert.equal(phoneResult.state?.step, 'ask_register_email');
  assert.match(phoneResult.replies[0], /Para consultar tus reservas primero necesito vincularlo/i);

  const linked = await handleRegistrationFlow({
    ...baseInput,
    state: phoneResult.state,
    text: 'cliente@example.com',
    reservasApi: api
  });
  assert.equal(phoneLinked, true);
  assert.equal(linked.state, null);
  assert.match(linked.replies[0], /asocie el telefono/i);
  assert.match(linked.replies[0], /estas son tus ultimas reservas/i);
  assert.match(linked.replies[0], /Cancha 1/);
});

test('la opcion 2 consulta disponibilidad sin pedir datos y luego ofrece reservar', async () => {
  const canchas = [{ id: 1, nombre: 'Cancha 1' }];
  const slots = [{ fecha: todayIsoInBusinessTimeZone(), inicio: '18:00', fin: '19:00', label: '18:00 a 19:00' }];
  const api = fakeApi({
    listarCanchas: async () => canchas,
    consultarDisponibilidad: async () => slots
  });

  const started = await handleReservationFlow({
    ...baseInput,
    state: mainMenuState(),
    text: '2',
    reservasApi: api
  });
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
  assert.equal(accepted.state?.step, 'ask_phone');
  assert.equal(accepted.state?.data?.intent, 'availability_registration_check');
  assert.match(accepted.replies[0], /verificar si ya estas registrado/i);
  assert.match(accepted.replies[0], /Pasame tu numero de telefono/i);

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
    state: accepted.state,
    text: '+54 9 388 410-4530',
    reservasApi: registrationApi
  });
  assert.equal(identified.targetFlow, 'registration');
  assert.equal(identified.state?.step, 'ask_register_email');
  assert.match(identified.replies[0], /Para continuar con la reserva tenes que registrarte/i);
  assert.match(identified.replies[0], /pasame tu correo electronico/i);

  const emailed = await handleRegistrationFlow({
    ...baseInput,
    state: identified.state,
    text: 'juan@example.com',
    reservasApi: registrationApi
  });
  assert.equal(emailed.state?.step, 'ask_register_name');
  assert.match(emailed.replies[0], /No encontre ningun cliente con ese email/i);

  const registered = await handleRegistrationFlow({
    ...baseInput,
    state: emailed.state,
    text: 'Juan Perez',
    reservasApi: registrationApi
  });
  assert.equal(registered.targetFlow, 'reservation');
  assert.equal(registered.state?.step, 'ask_slot');

  const selected = await handleReservationFlow({
    ...baseInput,
    state: registered.state,
    text: '1',
    reservasApi: registrationApi
  });
  assert.equal(selected.state?.step, 'ask_terms');
  assert.equal(selected.state?.data?.slot?.inicio, '18:00');
});

test('si el telefono no existe pero el email si, asocia el telefono sin pedir nombre', async () => {
  const existingClient = { nombre: 'Cliente Existente', email: 'cliente@example.com' };
  const api = fakeApi({
    consultarCliente: async ({ email }) => email
      ? { exists: true, cliente: existingClient }
      : { exists: false },
    crearCliente: async ({ telefono }) => ({
      created: false,
      cliente: { ...existingClient, telefono }
    })
  });
  const result = await handleRegistrationFlow({
    ...baseInput,
    state: {
      step: 'ask_register_email',
      data: {
        phone: '5493884104530',
        after: 'availability_choose_slot',
        reservationData: {
          canchas: [{ id: 1, nombre: 'Cancha 1' }],
          cancha: { id: 1, nombre: 'Cancha 1' },
          duracion: 1,
          fecha: todayIsoInBusinessTimeZone(),
          slots: [{ inicio: '18:00', fin: '19:00', label: '18:00 a 19:00' }]
        }
      },
      updatedAt: new Date().toISOString()
    },
    text: 'cliente@example.com',
    reservasApi: api
  });

  assert.equal(result.targetFlow, 'reservation');
  assert.equal(result.state?.step, 'ask_slot');
  assert.equal(result.state?.data?.nombre, 'Cliente Existente');
  assert.doesNotMatch(result.replies[0], /nombre y apellido/i);
  assert.match(result.replies[0], /asocie el telefono/i);
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

test('advierte que el link de Mercado Pago vence a los 10 minutos', async () => {
  const result = await handleReservationFlow({
    ...baseInput,
    state: {
      step: 'ask_confirm',
      data: {
        phone: '5493884104530',
        nombre: 'Juan Perez',
        email: 'juan@example.com',
        cancha: { id: 1, nombre: 'Cancha 1' },
        fecha: todayIsoInBusinessTimeZone(),
        duracion: 1,
        slot: {
          fecha: todayIsoInBusinessTimeZone(),
          inicio: '18:00',
          fin: '19:00',
          label: '18:00 a 19:00'
        }
      },
      updatedAt: new Date().toISOString()
    },
    text: 'si',
    canonicalJid: '5493884104530@s.whatsapp.net',
    reservasApi: fakeApi({
      crearReserva: async () => ({
        reserva: {
          cancha: 'Cancha 1',
          fecha: todayIsoInBusinessTimeZone(),
          hora_inicio: '18:00',
          hora_fin: '19:00'
        },
        mercadopago: { init_point: 'https://mercadopago.example/pagar' }
      })
    })
  });

  assert.equal(result.state, null);
  assert.match(result.replies[0], /permanecera activo durante 10 minutos/i);
  assert.match(result.replies[0], /turno se cancelara automaticamente/i);
  assert.match(result.replies[0], /tendras que solicitarlo nuevamente/i);
});
