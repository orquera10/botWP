import {
  consultarCliente,
  consultarDisponibilidad,
  consultarTurnos,
  crearCliente,
  crearReserva,
  listarCanchas,
  listarTerminos,
  reservasApiConfigured,
  withReservasApi
} from './wpReservasApi.js';
import {
  addDaysToIso,
  formatIsoDateForUser,
  todayIsoInBusinessTimeZone,
  validIsoDate
} from './dateUtils.js';
import {
  looksLikeArgentinePhone,
  normalizeArgentinePhone
} from './phoneUtils.js';

const TRIGGER_WORDS = ['reserv', 'turno', 'cancha', 'jugar', 'futbol', 'fútbol', 'cumple'];
const QUERY_TRIGGER_WORDS = [
  'mis reservas',
  'mis turnos',
  'ver reservas',
  'ver turnos',
  'consultar reserva',
  'consultar turno',
  'ultimas reservas',
  'ultimos turnos',
  'proximas reservas'
];
const REGISTER_TRIGGER_WORDS = [
  'registrarme',
  'registro',
  'crear usuario',
  'crear cliente',
  'alta cliente',
  'alta usuario'
];
const PRODUCT_TRIGGER_WORDS = ['productos', 'producto', 'catalogo', 'catálogo'];
const AVAILABILITY_TRIGGER_WORDS = ['disponibilidad', 'ver disponibilidad', 'horarios disponibles'];
const CANCEL_WORDS = ['cancelar', 'salir', 'menu', 'reiniciar'];
const BACK_WORDS = ['volver', 'atras', '0'];
const DEFAULT_FLOW_TIMEOUT_MINUTES = 120;
const FLOW_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.RESERVATION_FLOW_TIMEOUT_MINUTES || DEFAULT_FLOW_TIMEOUT_MINUTES)
);

function phoneFromJid(jid) {
  if (!jid?.endsWith('@s.whatsapp.net')) return '';
  return String(jid.split('@')[0] || '').replace(/\D/g, '');
}

function phoneRequestMessage(purpose = 'continuar', businessName = 'el negocio') {
  if (['empezar la reserva', 'completar la reserva'].includes(purpose)) {
    const reservationProgress = purpose === 'completar la reserva'
      ? 'Para terminar de preparar la reserva necesito algunos datos.'
      : 'Para continuar con la reserva necesito algunos datos.';
    return [
      `Hola 👋 Soy el asistente virtual de ${businessName}.`,
      reservationProgress,
      'Primero, pasame tu numero de telefono. Podes escribirlo como 388 410-4530 o enviarlo con +54 9.',
      'WhatsApp no me lo proporciono automaticamente. Si ya estas registrado, no voy a pedirte nuevamente los datos que tenemos.'
    ].join('\n');
  }

  return [
    `Hola 👋 Soy el asistente virtual de ${businessName}.`,
    `Para ${purpose} necesito asociar un numero de contacto. WhatsApp no me lo proporciono automaticamente.`,
    'Escribilo como lo usas normalmente, por ejemplo: 388 410-4530. Tambien podes enviarlo con +54 9.'
  ].join('\n');
}

function normalizeText(text) {
  return String(text || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function renderBusinessText(template, { businessName, name, catalogUrl = '' }) {
  return String(template || '')
    .replaceAll('{businessName}', businessName)
    .replaceAll('{name}', name || '')
    .replaceAll('{catalogUrl}', catalogUrl);
}

function buildWelcomeMessage(businessSettings, businessName, name) {
  const template = businessSettings.welcomeMessage || '¡Hola, {name}! Bienvenido a {businessName}.';
  const catalogUrl = String(businessSettings.catalogUrl || '').trim();
  const welcome = renderBusinessText(template, { businessName, name, catalogUrl })
    .replace('¡Hola, !', '¡Hola!');
  const normalized = normalizeText(welcome);

  if (normalized.includes('asistente virtual') || /\bbot\b/.test(normalized)) {
    return welcome;
  }

  return `${welcome}\nSoy el asistente virtual de ${businessName}.`;
}

function hasReservationIntent(text) {
  const normalized = normalizeText(text);
  return TRIGGER_WORDS.some((word) => normalized.includes(word));
}

function hasQueryIntent(text) {
  const normalized = normalizeText(text);
  return QUERY_TRIGGER_WORDS.some((word) => normalized.includes(normalizeText(word)));
}

function hasRegisterIntent(text) {
  const normalized = normalizeText(text);
  return REGISTER_TRIGGER_WORDS.some((word) => normalized.includes(normalizeText(word)));
}

function hasProductIntent(text) {
  const normalized = normalizeText(text);
  return PRODUCT_TRIGGER_WORDS.some((word) => normalized === normalizeText(word));
}

function hasAvailabilityIntent(text) {
  const normalized = normalizeText(text);
  return AVAILABILITY_TRIGGER_WORDS.some((word) => normalized.includes(normalizeText(word)));
}

function parseMainMenuChoice(text) {
  const normalized = normalizeText(text);
  if (normalized === '1') return 'reservation';
  if (normalized === '2') return 'availability';
  if (normalized === '3') return 'query';
  if (normalized === '4') return 'products';
  return null;
}

function wantsCancel(text) {
  const normalized = normalizeText(text);
  return CANCEL_WORDS.some((word) => normalized === word || normalized.includes(word));
}

function wantsBack(text) {
  const normalized = normalizeText(text);
  return BACK_WORDS.includes(normalized);
}

function parseDate(text) {
  const normalized = normalizeText(text);
  const today = todayIsoInBusinessTimeZone();

  if (normalized.includes('hoy')) return today;
  if (normalized.includes('manana')) return addDaysToIso(today, 1);

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return validIsoDate(iso[1], iso[2], iso[3]);
  }

  const local = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!local) return null;

  const year = local[3]
    ? Number(local[3].length === 2 ? `20${local[3]}` : local[3])
    : Number(today.slice(0, 4));
  return validIsoDate(year, local[2], local[1]);
}

function dateInputExamples() {
  const currentDate = formatIsoDateForUser(todayIsoInBusinessTimeZone());
  return `${currentDate}, ${currentDate.slice(0, 5)}, "hoy" o "mañana"`;
}

function dateRequestMessage(prefix, backInstruction = '') {
  return [
    `${prefix} Puede ser ${dateInputExamples()}.`,
    backInstruction
  ].filter(Boolean).join(' ');
}

function displayDate(value) {
  return formatIsoDateForUser(value) || String(value || '');
}

function parseDuration(text) {
  const match = String(text || '').match(/\b([1-4])\b/);
  return match ? Number(match[1]) : null;
}

function parseEmail(text) {
  const match = String(text || '').match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0].toLowerCase() : null;
}

function parseChoice(text, items, labelKey = 'nombre') {
  const normalized = normalizeText(text);
  const numeric = normalized.match(/\b(\d+)\b/);

  if (numeric) {
    const number = Number(numeric[1]);
    // Una respuesta numerica siempre representa la posicion mostrada al usuario,
    // nunca el ID interno que pueda tener el elemento.
    return items[number - 1] || null;
  }

  if (normalized.length < 2) return null;
  return items.find((item) => normalizeText(item[labelKey]).includes(normalized));
}

function formatCanchas(canchas) {
  return canchas
    .map((cancha, index) => {
      const precio = Number(cancha.precio || 0);
      const unidad = cancha.precio_unidad || 'hora';
      const duracion = cancha.duracion_fija ? ` (${cancha.duracion_fija} hs)` : '';
      return `${index + 1}. ${cancha.nombre}${duracion} - $${precio} / ${unidad}`;
    })
    .concat('0. Volver')
    .join('\n');
}

function formatSlots(slots) {
  return slots
    .map((slot, index) => `${index + 1}. ${slot.label || `${slot.inicio} a ${slot.fin}`}`)
    .concat('0. Volver')
    .join('\n');
}

function formatSlotsForAvailability(slots) {
  return slots
    .map((slot) => `- ${slot.label || `${slot.inicio} a ${slot.fin}`}`)
    .join('\n');
}

function userMenuMessage(_businessSettings = {}, intro = '') {
  const menu = [
    '¿Que queres hacer?',
    '1. Buscar un turno',
    '2. Ver disponibilidad',
    '3. Ver mis reservas',
    '4. Ver productos',
    '',
    'Responde con el numero o escribime lo que necesitas.'
  ].join('\n');

  return intro ? `${intro}\n\n${menu}` : menu;
}

function mainMenuMessage(businessSettings = {}) {
  return userMenuMessage(businessSettings, 'Volvimos al menu principal.');
}

function goBack(state, businessSettings = {}) {
  const data = state.data || {};

  if (state.step === 'ask_phone' && data.intent === 'reservation_after_availability') {
    return {
      state: buildState('ask_slot', data),
      replies: [`Volvamos a elegir el horario. Las opciones son:\n${formatSlots(data.slots || [])}`]
    };
  }

  if (['ask_phone', 'ask_register_name', 'ask_cancha'].includes(state.step)) {
    return { state: null, replies: [mainMenuMessage(businessSettings)] };
  }

  if (state.step === 'ask_register_email') {
    return {
      state: buildState('ask_register_name', data),
      replies: ['Volvamos al nombre. Pasame tu nombre y apellido. Para volver al menu, escribi "volver".']
    };
  }

  if (state.step === 'ask_duracion' || (state.step === 'ask_fecha' && data.cancha?.duracion_fija)) {
    return {
      state: buildState('ask_cancha', data),
      replies: [`Volvamos a elegir la cancha. Las opciones son:\n${formatCanchas(data.canchas || [])}`]
    };
  }

  if (state.step === 'ask_fecha') {
    return {
      state: buildState('ask_duracion', data),
      replies: ['Volvamos a la duracion. Las opciones son 1, 2, 3 o 4 horas. Tambien podes escribir "volver".']
    };
  }

  if (state.step === 'ask_slot') {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('Volvamos a la fecha.', 'Tambien podes escribir "volver".')]
    };
  }

  if (state.step === 'ask_availability_reserve') {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('Volvamos a la fecha.', 'Tambien podes escribir "volver".')]
    };
  }

  if (state.step === 'ask_terms') {
    return {
      state: buildState('ask_slot', data),
      replies: [`Volvamos a elegir el horario. Las opciones son:\n${formatSlots(data.slots || [])}`]
    };
  }

  if (state.step === 'ask_name') {
    return {
      state: buildState('ask_terms', data),
      replies: [`${compactTerms(data.terminos || [])}\n\nResponde SI ACEPTO para continuar o VOLVER para cambiar el horario.`]
    };
  }

  if (state.step === 'ask_email') {
    return {
      state: buildState('ask_name', data),
      replies: ['Volvamos al nombre. ¿A nombre de quien queda la reserva? Tambien podes escribir "volver".']
    };
  }

  if (state.step === 'ask_confirm') {
    return {
      state: buildState('ask_email', data),
      replies: ['Volvamos al email. Enviame el email correcto. Tambien podes escribir "volver".']
    };
  }

  return { state: null, replies: [mainMenuMessage(businessSettings)] };
}

function compactTerms(terminos) {
  if (!terminos.length) return 'Para continuar necesito que aceptes los terminos de la reserva.';
  return [
    'Terminos y condiciones de la reserva:',
    ...terminos.map((item) => `- ${item}`)
  ].filter(Boolean).join('\n');
}

function formatTurnos(turnos) {
  return turnos
    .map((turno, index) => {
      const estado = turno.estado ? ` - ${turno.estado}` : '';
      const senia = Number(turno.senia ?? turno.sena ?? 0);
      const totalRaw = turno.total ?? turno.precio_total ?? turno.importe_total;
      let total = totalRaw !== undefined && totalRaw !== null && totalRaw !== ''
        ? Number(totalRaw)
        : null;
      const saldoRaw = turno.saldo ?? turno.saldo_pendiente;
      const saldo = saldoRaw !== undefined && saldoRaw !== null && saldoRaw !== ''
        ? Number(saldoRaw)
        : Number.isFinite(total) ? Math.max(0, total - senia) : null;

      if (!Number.isFinite(total) && Number.isFinite(senia) && Number.isFinite(saldo)) {
        total = senia + saldo;
      }

      const formatMoney = (value) => `$${Number(value).toLocaleString('es-AR')}`;
      const importes = [
        Number.isFinite(senia) ? `Seña: ${formatMoney(senia)}` : '',
        Number.isFinite(saldo) ? `Saldo: ${formatMoney(saldo)}` : '',
        Number.isFinite(total) ? `Total: ${formatMoney(total)}` : ''
      ].filter(Boolean).join(' - ');

      return [
        `${index + 1}. ${turno.cancha}${estado}`,
        `${turno.fecha_label || turno.fecha} - ${turno.hora_inicio} a ${turno.hora_fin}`,
        importes
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function buildState(step, data = {}) {
  return { step, data, updatedAt: new Date().toISOString() };
}

function isExpired(state) {
  if (!state?.updatedAt) return false;

  const updatedAt = new Date(state.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return false;

  return Date.now() - updatedAt > FLOW_TIMEOUT_MINUTES * 60 * 1000;
}

async function identifyClient(phone) {
  try {
    const result = await consultarCliente({ telefono: phone });
    if (!result.exists) {
      return { found: false, cliente: null, turnos: [] };
    }

    return {
      found: true,
      cliente: result.cliente || null,
      turnos: result.turnos || []
    };
  } catch (error) {
    if (error.status === 404) {
      return { found: false, cliente: null, turnos: [] };
    }
    throw error;
  }
}

async function identifyClientByEmail(email) {
  try {
    const result = await consultarCliente({ email });
    if (!result.exists) {
      return { found: false, cliente: null };
    }

    return { found: true, cliente: result.cliente || null };
  } catch (error) {
    if (error.status === 404) {
      return { found: false, cliente: null };
    }
    throw error;
  }
}

async function startFlow({ phone, pushName, registrationAvailable = true }) {
  const identity = phone ? await identifyClient(phone) : { found: false, cliente: null, turnos: [] };
  const cliente = identity.cliente || {};

  if (phone && !identity.found) {
    if (registrationAvailable) {
      return {
        ...startRegisterFlow({
          phone,
          pushName,
          after: 'reservation',
          intro: 'No encontre un registro con ese numero. Para continuar con la reserva necesito completar algunos datos.'
        }),
        targetFlow: 'registration'
      };
    }

    return {
      state: null,
      replies: ['No encontre tu telefono registrado. El registro automatico no esta habilitado para este negocio.']
    };
  }

  const canchas = await listarCanchas();

  const data = {
    phone,
    nombre: cliente.nombre || pushName || '',
    email: cliente.email || '',
    existingClient: identity.found,
    canchas
  };

  const greeting = identity.found && cliente.nombre
    ? `Hola ${cliente.nombre}. Te ayudo a reservar.`
    : 'Te ayudo a hacer la reserva.';

  return {
    state: buildState('ask_cancha', data),
    replies: [
      `${greeting}\n\nElegí la cancha respondiendo con el numero:\n${formatCanchas(canchas)}`
    ]
  };
}

async function startAvailabilityFlow() {
  const canchas = await listarCanchas();
  return {
    state: buildState('ask_cancha', { availabilityOnly: true, canchas }),
    replies: [`Para consultar disponibilidad, elegi la cancha respondiendo con el numero:\n${formatCanchas(canchas)}`]
  };
}

async function continueSelectedAvailability({
  data,
  phone,
  pushName,
  registrationAvailable = true
}) {
  const identity = await identifyClient(phone);

  if (!identity.found) {
    if (!registrationAvailable) {
      return {
        state: null,
        replies: ['Para reservar necesitas estar registrado, pero el registro automatico no esta habilitado para este negocio.']
      };
    }

    return {
      ...startRegisterFlow({
        phone,
        pushName,
        after: 'availability_reservation',
        reservationData: data,
        intro: 'El horario sigue disponible. No encontre un registro con ese numero, asi que necesito dos datos mas para terminar la reserva.'
      }),
      targetFlow: 'registration'
    };
  }

  const cliente = identity.cliente || {};
  const terminos = await listarTerminos({
    tipo: Number(data.cancha?.duracion_fija) === 3 ? 'cumple' : 'turno',
    cancha: data.cancha?.id
  });
  const nextData = {
    ...data,
    phone,
    nombre: cliente.nombre || pushName || '',
    email: cliente.email || '',
    existingClient: true,
    terminos
  };

  return {
    state: buildState('ask_terms', nextData),
    replies: [`${compactTerms(terminos)}\n\nPara aceptar y seguir, responde SI ACEPTO. Para cambiar el horario, responde VOLVER.`]
  };
}

function startRegisterFlow({
  phone,
  pushName,
  after = 'menu',
  reservationData = null,
  intro = 'Te ayudo a registrarte.'
}) {
  return {
    state: buildState('ask_register_name', {
      phone,
      pushName,
      after,
      reservationData
    }),
    replies: [`${intro}\n\nPrimero, pasame tu nombre y apellido. Para volver al menu, escribi "volver".`]
  };
}

async function finishRegisterFlow(data, businessSettings = {}) {
  const emailIdentity = await identifyClientByEmail(data.email);
  const created = await crearCliente({
    nombre: data.nombre,
    email: data.email,
    telefono: data.phone
  });
  const cliente = created.cliente || emailIdentity.cliente || {};
  const updatedByExistingEmail = emailIdentity.found && !created.created;

  if (data.after === 'availability_reservation') {
    const reservationData = data.reservationData || {};
    const terminos = await listarTerminos({
      tipo: Number(reservationData.cancha?.duracion_fija) === 3 ? 'cumple' : 'turno',
      cancha: reservationData.cancha?.id
    });
    return {
      targetFlow: 'reservation',
      state: buildState('ask_terms', {
        ...reservationData,
        phone: data.phone,
        nombre: cliente.nombre || data.nombre,
        email: cliente.email || data.email,
        existingClient: true,
        terminos
      }),
      replies: [[
        updatedByExistingEmail
          ? 'Listo, encontre ese email y asocie el telefono.'
          : created.created
            ? 'Listo, ya quedaste registrado.'
            : 'Listo, ya encontre tus datos.',
        compactTerms(terminos),
        'Para aceptar y seguir, responde SI ACEPTO. Para cambiar el horario, responde VOLVER.'
      ].join('\n\n')]
    };
  }

  if (data.after === 'reservation') {
    const canchas = await listarCanchas();
    return {
      targetFlow: 'reservation',
      state: buildState('ask_cancha', {
        phone: data.phone,
        nombre: cliente.nombre || data.nombre,
        email: cliente.email || data.email,
        existingClient: true,
        canchas
      }),
      replies: [
        [
          updatedByExistingEmail
            ? 'Listo, encontre ese email y actualice/asocie el telefono para continuar.'
            : created.created
              ? 'Listo, ya te registre para poder reservar.'
              : 'Listo, ya encontre tus datos para continuar.',
          `ElegÃ­ la cancha respondiendo con el numero:\n${formatCanchas(canchas)}`
        ].join('\n\n')
      ]
    };
  }

  return {
    state: null,
    replies: [
      [updatedByExistingEmail
        ? 'Listo, encontre ese email y actualice/asocie tu telefono.'
        : created.created
          ? 'Listo, ya quedaste registrado.'
          : 'Listo, tus datos ya estaban registrados.',
      userMenuMessage(businessSettings)].join('\n\n')
    ]
  };
}

async function startQueryFlow({ phone }) {
  try {
    const identity = await identifyClient(phone);
    if (!identity.found) {
      return {
        state: null,
        replies: ['No encontre un cliente registrado con ese telefono.']
      };
    }

    const cliente = identity.cliente || {};
    const consultas = [
      consultarTurnos({ telefono: phone, futuros: 0, limite: 100 })
    ];

    if (cliente.email) {
      consultas.push(consultarTurnos({ email: cliente.email, futuros: 0, limite: 100 }));
    }

    const resultados = await Promise.allSettled(consultas);
    const exitosos = resultados
      .filter((resultado) => resultado.status === 'fulfilled' || resultado.reason?.status === 404)
      .map((resultado) => resultado.status === 'fulfilled' ? resultado.value : { turnos: [] });

    if (!exitosos.length) {
      const error = resultados.find((resultado) => resultado.status === 'rejected')?.reason;
      throw error || new Error('No se pudieron consultar las reservas.');
    }

    const turnosUnicos = new Map();
    for (const result of exitosos) {
      for (const turno of result.turnos || []) {
        const key = turno.ticket_id || [
          turno.cancha,
          turno.fecha,
          turno.hora_inicio,
          turno.hora_fin
        ].join('|');
        turnosUnicos.set(String(key), turno);
      }
    }
    const dateTimeOf = (turno) => {
      const fecha = parseDate(turno.fecha) || String(turno.fecha || '');
      return `${fecha}T${turno.hora_inicio || '00:00'}`;
    };
    const turnos = [...turnosUnicos.values()]
      .sort((a, b) => dateTimeOf(b).localeCompare(dateTimeOf(a)))
      .slice(0, 5);

    if (!turnos.length) {
      return {
        state: null,
        replies: [
          cliente.nombre
            ? `${cliente.nombre}, no encontre reservas asociadas a tu telefono o email.`
            : 'No encontre reservas asociadas a tu telefono o email.'
        ]
      };
    }

    return {
      state: null,
      replies: [
        [
          cliente.nombre ? `${cliente.nombre}, estas son tus ultimas reservas:` : 'Estas son tus ultimas reservas:',
          formatTurnos(turnos)
        ].join('\n')
      ]
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        state: null,
        replies: ['No encontre un cliente registrado con ese telefono.']
      };
    }

    throw error;
  }
}

async function askDisponibilidad(data) {
  const slots = await consultarDisponibilidad({
    fecha: data.fecha,
    cancha: data.cancha.id,
    duracion: data.duracion
  });

  if (!slots.length) {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('No veo horarios disponibles para esa fecha. Pasame otra fecha.')]
    };
  }

  if (data.availabilityOnly) {
    return {
      state: buildState('ask_availability_reserve', { ...data, slots }),
      replies: [[
        `Estos horarios estan disponibles para el ${displayDate(data.fecha)}:`,
        formatSlotsForAvailability(slots),
        '¿Queres reservar uno de estos horarios?',
        '1. Si, reservar',
        '2. No, volver al menu'
      ].join('\n')]
    };
  }

  return {
    state: buildState('ask_slot', { ...data, slots }),
    replies: [`Estos horarios estan disponibles. Responde con el numero:\n${formatSlots(slots)}`]
  };
}

async function continueFlow({
  state,
  text,
  canonicalJid,
  pushName,
  businessName = 'el negocio',
  businessSettings = {},
  registrationAvailable = true
}) {
  if (!reservasApiConfigured()) {
    return {
      state: null,
      replies: ['Todavia falta configurar la URL o API key de reservas para poder tomar turnos.']
    };
  }

  if (wantsCancel(text)) {
    return {
      state: null,
      replies: [[
        'Listo, cancele el flujo actual.',
        userMenuMessage(businessSettings)
      ].join('\n\n')]
    };
  }

  if (state && isExpired(state)) {
    if (!hasReservationIntent(text) && !hasAvailabilityIntent(text) && !hasQueryIntent(text) && !hasRegisterIntent(text)) {
      return {
        state: null,
        replies: [
          [
            `La conversacion anterior quedo pausada mas de ${FLOW_TIMEOUT_MINUTES} minutos y la reinicie.`,
            userMenuMessage(businessSettings)
          ].join('\n\n')
        ]
      };
    }

    if (hasAvailabilityIntent(text)) {
      const restartedAvailability = await startAvailabilityFlow();
      return {
        state: restartedAvailability.state,
        replies: [
          `La conversacion anterior habia vencido despues de ${FLOW_TIMEOUT_MINUTES} minutos sin actividad.`,
          ...restartedAvailability.replies
        ]
      };
    }

    if (hasQueryIntent(text)) {
      const phone = phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', { pushName, intent: 'query' }),
          replies: [phoneRequestMessage('consultar tus reservas', businessName)]
        };
      }

      const restartedQuery = await startQueryFlow({ phone });
      return {
        state: restartedQuery.state,
        replies: [
          `La conversacion anterior habia vencido despues de ${FLOW_TIMEOUT_MINUTES} minutos sin actividad.`,
          ...restartedQuery.replies
        ]
      };
    }

    if (hasRegisterIntent(text)) {
      const phone = phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', { pushName, intent: 'register' }),
          replies: [phoneRequestMessage('registrarte', businessName)]
        };
      }

      return startRegisterFlow({ phone, pushName });
    }

    const restarted = await startFlow({ phone: phoneFromJid(canonicalJid), pushName, registrationAvailable });
    return {
      state: restarted.state,
      replies: [
        `La reserva anterior habia vencido despues de ${FLOW_TIMEOUT_MINUTES} minutos sin actividad. Empecemos de nuevo.`,
        ...restarted.replies
      ]
    };
  }

  if (!state) {
    const menuChoice = parseMainMenuChoice(text);
    const availabilityIntent = menuChoice === 'availability' || hasAvailabilityIntent(text);
    const reservationIntent = !availabilityIntent && (menuChoice === 'reservation' || hasReservationIntent(text));
    const queryIntent = menuChoice === 'query' || hasQueryIntent(text);
    const registerIntent = hasRegisterIntent(text);
    const productIntent = menuChoice === 'products' || hasProductIntent(text);

    if (productIntent) {
      const catalogUrl = String(businessSettings.catalogUrl || '').trim();
      return {
        state: null,
        replies: [catalogUrl
          ? `Podes consultar nuestro catalogo de productos aca:\n${catalogUrl}`
          : 'El catalogo de productos no esta disponible en este momento.']
      };
    }

    if (availabilityIntent) {
      return startAvailabilityFlow();
    }

    if (!reservationIntent && !queryIntent && !registerIntent) {
      const welcome = buildWelcomeMessage(businessSettings, businessName, pushName || '');
      return {
        state: null,
        replies: [[welcome, userMenuMessage(businessSettings)].join('\n\n')]
      };
    }

    const phone = phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', {
          pushName,
          intent: queryIntent ? 'query' : registerIntent || !reservationIntent ? 'register' : 'reservation'
        }),
        replies: [
          queryIntent
            ? phoneRequestMessage('consultar tus reservas', businessName)
            : registerIntent || !reservationIntent
              ? phoneRequestMessage('registrarte', businessName)
            : phoneRequestMessage('empezar la reserva', businessName)
        ]
      };
    }

    if (queryIntent) {
      return startQueryFlow({ phone });
    }

    if (registerIntent) {
      const identity = await identifyClient(phone);
      if (identity.found) {
        const cliente = identity.cliente || {};
        return {
          state: null,
          replies: [[
            `Ya estas registrado${cliente.nombre ? ` como ${cliente.nombre}` : ''}.`,
            userMenuMessage(businessSettings)
          ].join('\n\n')]
        };
      }

      return startRegisterFlow({ phone, pushName });
    }

    if (reservationIntent) {
      return startFlow({ phone, pushName, registrationAvailable });
    }
  }

  const data = state.data || {};

  if (wantsBack(text)) {
    return goBack(state, businessSettings);
  }

  if (hasQueryIntent(text)) {
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName, intent: 'query' }),
        replies: [phoneRequestMessage('consultar tus reservas', businessName)]
      };
    }

    return startQueryFlow({ phone });
  }

  if (hasRegisterIntent(text)) {
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName, intent: 'register' }),
        replies: [phoneRequestMessage('registrarte', businessName)]
      };
    }

    return startRegisterFlow({ phone, pushName });
  }

  if (state.step === 'ask_availability_reserve') {
    const answer = normalizeText(text);
    if (['1', 'si', 'reservar', 'si reservar'].includes(answer)) {
      return {
        state: buildState('ask_slot', data),
        replies: [`Perfecto. Elegi el horario que queres reservar:\n${formatSlots(data.slots || [])}`]
      };
    }

    if (['2', 'no'].includes(answer)) {
      return {
        state: null,
        replies: [mainMenuMessage(businessSettings)]
      };
    }

    return {
      state,
      replies: ['Responde 1 para reservar uno de los horarios o 2 para volver al menu.']
    };
  }

  if (state.step === 'ask_phone') {
    if (!looksLikeArgentinePhone(text)) {
      return {
        state,
        replies: ['No pude identificar el numero. Podes escribirlo como 388 410-4530, 0388 15 410-4530 o +54 9 388 410-4530.']
      };
    }

    if (data.intent === 'query') {
      return startQueryFlow({ phone: normalizeArgentinePhone(text) });
    }

    if (data.intent === 'register') {
      const phone = normalizeArgentinePhone(text);
      const identity = await identifyClient(phone);
      if (identity.found) {
        const cliente = identity.cliente || {};
        const nombre = cliente.nombre || data.pushName || pushName || '';
        const welcome = buildWelcomeMessage(businessSettings, businessName, nombre);
        return {
          state: null,
          replies: [[welcome, userMenuMessage(businessSettings)].join('\n\n')]
        };
      }

      return startRegisterFlow({ phone, pushName: data.pushName || pushName });
    }

    if (data.intent === 'reservation_after_availability') {
      return continueSelectedAvailability({
        data: { ...data, phone: normalizeArgentinePhone(text) },
        phone: normalizeArgentinePhone(text),
        pushName: data.pushName || pushName,
        registrationAvailable
      });
    }

    return startFlow({
      phone: normalizeArgentinePhone(text),
      pushName: data.pushName || pushName,
      registrationAvailable
    });
  }

  if (state.step === 'ask_register_name') {
    const nombre = String(text || '').trim();
    if (nombre.length < 5 || !nombre.includes(' ')) {
      return { state, replies: ['Pasame nombre y apellido, por favor.'] };
    }

    const firstName = nombre.split(/\s+/)[0];
    const emailMessage = ['reservation', 'availability_reservation'].includes(data.after)
      ? `Gracias, ${firstName}. Para terminar, pasame tu email. Lo usamos para identificar la reserva y generar el pago de la seña.`
      : `Gracias, ${firstName}. Ahora pasame tu email para completar el registro.`;

    return {
      state: buildState('ask_register_email', { ...data, nombre }),
      replies: [`${emailMessage} Para cambiar el nombre, escribi "volver".`]
    };
  }

  if (state.step === 'ask_register_email') {
    const email = parseEmail(text);
    if (!email) {
      return { state, replies: ['Ese email no parece valido. Mandame uno tipo nombre@email.com.'] };
    }

    return finishRegisterFlow({ ...data, email }, businessSettings);
  }

  if (state.step === 'ask_cancha') {
    const cancha = parseChoice(text, data.canchas || []);
    if (!cancha) {
      return {
        state,
        replies: [`Esa no es una de las opciones. Las opciones son:\n${formatCanchas(data.canchas || [])}`]
      };
    }

    const nextData = { ...data, cancha };
    if (cancha.duracion_fija) {
      return {
        state: buildState('ask_fecha', { ...nextData, duracion: Number(cancha.duracion_fija) }),
        replies: [dateRequestMessage('Perfecto. Pasame la fecha de la reserva.', 'Para cambiar la cancha, escribi "volver".')]
      };
    }

    return {
      state: buildState('ask_duracion', nextData),
      replies: ['Cuantas horas queres reservar? Responde 1, 2, 3 o 4. Para cambiar la cancha, responde 0 o "volver".']
    };
  }

  if (state.step === 'ask_duracion') {
    const duracion = parseDuration(text);
    if (!duracion) {
      return { state, replies: ['Esa no es una de las opciones. Responde 1, 2, 3 o 4 horas. Para volver, responde 0 o "volver".'] };
    }

    return {
      state: buildState('ask_fecha', { ...data, duracion }),
      replies: [dateRequestMessage('Pasame la fecha de la reserva.', 'Para cambiar la duracion, escribi "volver".')]
    };
  }

  if (state.step === 'ask_fecha') {
    const fecha = parseDate(text);
    if (!fecha) {
      return {
        state,
        replies: [dateRequestMessage('Esa fecha no es valida.', 'Para volver a la opcion anterior, escribi "volver".')]
      };
    }

    return askDisponibilidad({ ...data, fecha });
  }

  if (state.step === 'ask_slot') {
    const slot = parseChoice(text, data.slots || [], 'label');
    if (!slot) {
      return { state, replies: [`Esa no es una de las opciones. Los horarios disponibles son:\n${formatSlots(data.slots || [])}`] };
    }

    if (data.availabilityOnly) {
      const selectedData = { ...data, slot };
      const phone = data.phone || phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', {
            ...selectedData,
            pushName,
            intent: 'reservation_after_availability'
          }),
          replies: [phoneRequestMessage('completar la reserva', businessName)]
        };
      }

      return continueSelectedAvailability({
        data: selectedData,
        phone,
        pushName,
        registrationAvailable
      });
    }

    const terminos = await listarTerminos({
      tipo: Number(data.cancha?.duracion_fija) === 3 ? 'cumple' : 'turno',
      cancha: data.cancha?.id
    });

    return {
      state: buildState('ask_terms', { ...data, slot, terminos }),
      replies: [`${compactTerms(terminos)}\n\nPara aceptar y seguir, responde SI ACEPTO. Para cambiar el horario, responde VOLVER.`]
    };
  }

  if (state.step === 'ask_terms') {
    const accepted = ['si', 'sí', 'si acepto', 'sí acepto', 'acepto'].includes(normalizeText(text));
    if (!accepted) {
      return { state, replies: ['Esa no es una opcion valida. Responde "SI ACEPTO" para continuar o "VOLVER" para cambiar el horario.'] };
    }

    if (!data.nombre) {
      return {
        state: buildState('ask_name', { ...data, aceptaTerminos: true }),
        replies: ['A nombre de quien queda la reserva? Para volver a los terminos, escribi "volver".']
      };
    }

    if (!parseEmail(data.email)) {
      return {
        state: buildState('ask_email', { ...data, aceptaTerminos: true }),
        replies: ['Pasame un email para generar el pago de la seña. Para volver, escribi "volver".']
      };
    }

    return {
      state: buildState('ask_confirm', { ...data, aceptaTerminos: true }),
      replies: [summaryMessage(data)]
    };
  }

  if (state.step === 'ask_name') {
    const nombre = String(text || '').trim();
    if (nombre.length < 2) {
      return { state, replies: ['Pasame nombre y apellido, por favor.'] };
    }

    return {
      state: buildState('ask_email', { ...data, nombre }),
      replies: ['Genial. Ahora pasame un email para generar el pago de la seña. Para cambiar el nombre, escribi "volver".']
    };
  }

  if (state.step === 'ask_email') {
    const email = parseEmail(text);
    if (!email) {
      return { state, replies: ['Ese email no parece valido. Mandame uno tipo nombre@email.com.'] };
    }

    const nextData = { ...data, email };
    return {
      state: buildState('ask_confirm', nextData),
      replies: [summaryMessage(nextData)]
    };
  }

  if (state.step === 'ask_confirm') {
    const accepted = ['si', 'sí', 'confirmo', 'reservar'].includes(normalizeText(text));
    if (!accepted) {
      return {
        state,
        replies: ['Esa no es una opcion valida. Responde SI para confirmar, VOLVER para corregir los datos o CANCELAR para salir.']
      };
    }

    const reserva = await crearReserva({
      cliente: {
        nombre: data.nombre,
        email: data.email,
        telefono: data.phone || phoneFromJid(canonicalJid)
      },
      fecha: data.slot.fecha,
      hora_inicio: data.slot.inicio,
      cancha: data.cancha.id,
      duracion: data.duracion,
      acepta_terminos: true
    });

    return {
      state: null,
      replies: [
        [
          'Reserva creada. Queda pendiente hasta pagar la seña.',
          `Cancha: ${reserva.reserva?.cancha || data.cancha.nombre}`,
          `Fecha: ${displayDate(reserva.reserva?.fecha || data.fecha)}`,
          `Horario: ${reserva.reserva?.hora_inicio || data.slot.inicio} a ${reserva.reserva?.hora_fin || data.slot.fin}`,
          reserva.mercadopago?.init_point ? `Link de pago: ${reserva.mercadopago.init_point}` : ''
        ].filter(Boolean).join('\n')
      ]
    };
  }

  return {
    state: null,
    replies: ['Se reinicio el flujo. Para reservar, escribime "reservar".']
  };
}

function summaryMessage(data) {
  return [
    'Confirmame la reserva respondiendo SI:',
    `Cancha: ${data.cancha?.nombre}`,
    `Fecha: ${displayDate(data.fecha)}`,
    `Horario: ${data.slot?.label || `${data.slot?.inicio} a ${data.slot?.fin}`}`,
    `Duracion: ${data.duracion} hs`,
    `Nombre: ${data.nombre}`,
    `Email: ${data.email}`
  ].join('\n');
}

export async function handleReservationFlow(input) {
  if (!input.state && hasRegisterIntent(input.text)) {
    return { state: null, replies: [] };
  }

  try {
    return await withReservasApi(input.reservasApi, () => continueFlow(input));
  } catch (error) {
    return {
      state: input.state || null,
      replies: [
        `No pude avanzar con la reserva: ${error.message || 'error desconocido'}. Proba de nuevo en unos minutos o escribi cancelar para reiniciar.`
      ]
    };
  }
}

function isRegistrationState(state) {
  return ['ask_register_name', 'ask_register_email'].includes(state?.step) ||
    (state?.step === 'ask_phone' && state?.data?.intent === 'register');
}

export async function handleRegistrationFlow(input) {
  if (!isRegistrationState(input.state) && !hasRegisterIntent(input.text)) {
    return { handled: false, state: input.state || null, replies: [] };
  }

  try {
    const result = await withReservasApi(input.reservasApi, () => continueFlow(input));
    return { ...result, handled: true };
  } catch (error) {
    return {
      handled: true,
      state: input.state || null,
      replies: [`No pude avanzar con el registro: ${error.message || 'error desconocido'}. Proba de nuevo en unos minutos.`]
    };
  }
}
