import {
  consultarCliente,
  consultarDisponibilidad,
  consultarTurnos,
  crearCliente,
  crearReserva,
  listarCanchas,
  listarTerminos,
  reservasApiConfigured
} from './wpReservasApi.js';

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
const CANCEL_WORDS = ['cancelar', 'salir', 'menu', 'reiniciar'];
const DEFAULT_FLOW_TIMEOUT_MINUTES = 120;
const FLOW_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.RESERVATION_FLOW_TIMEOUT_MINUTES || DEFAULT_FLOW_TIMEOUT_MINUTES)
);

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneFromJid(jid) {
  if (!jid?.endsWith('@s.whatsapp.net')) return '';
  return onlyDigits(jid.split('@')[0]);
}

function looksLikePhone(text) {
  const digits = onlyDigits(text);
  return digits.length >= 10 && digits.length <= 15;
}

function normalizeText(text) {
  return String(text || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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

function wantsCancel(text) {
  const normalized = normalizeText(text);
  return CANCEL_WORDS.some((word) => normalized === word || normalized.includes(word));
}

function parseDate(text) {
  const normalized = normalizeText(text);
  const now = new Date();

  if (normalized.includes('hoy')) return toIsoDate(now);
  if (normalized.includes('manana')) {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    return toIsoDate(date);
  }

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }

  const local = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!local) return null;

  const year = local[3]
    ? Number(local[3].length === 2 ? `20${local[3]}` : local[3])
    : now.getFullYear();
  const month = Number(local[2]);
  const day = Number(local[1]);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return toIsoDate(date);
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    const byPosition = items[number - 1];
    if (byPosition) return byPosition;

    const byId = items.find((item) => Number(item.id) === number);
    if (byId) return byId;
  }

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
    .join('\n');
}

function formatSlots(slots) {
  return slots
    .slice(0, 10)
    .map((slot, index) => `${index + 1}. ${slot.label || `${slot.inicio} a ${slot.fin}`}`)
    .join('\n');
}

function compactTerms(terminos) {
  if (!terminos.length) return 'Para continuar necesito que aceptes los terminos de la reserva.';
  return [
    'Terminos principales:',
    ...terminos.slice(0, 8).map((item) => `- ${item}`),
    terminos.length > 8 ? `- Y ${terminos.length - 8} condicion(es) mas.` : ''
  ].filter(Boolean).join('\n');
}

function formatTurnos(turnos) {
  return turnos
    .map((turno, index) => {
      const estado = turno.estado ? ` - ${turno.estado}` : '';
      const senia = Number(turno.senia ?? turno.sena ?? 0);
      const totalRaw = turno.total ?? turno.precio_total ?? turno.importe_total;
      const total = totalRaw !== undefined && totalRaw !== null && totalRaw !== ''
        ? Number(totalRaw)
        : null;
      const saldoRaw = turno.saldo ?? turno.saldo_pendiente;
      const saldo = saldoRaw !== undefined && saldoRaw !== null && saldoRaw !== ''
        ? Number(saldoRaw)
        : Number.isFinite(total) ? Math.max(0, total - senia) : null;
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

async function startFlow({ phone, pushName }) {
  const canchas = await listarCanchas();
  const identity = phone ? await identifyClient(phone) : { found: false, cliente: null, turnos: [] };
  const cliente = identity.cliente || {};

  if (phone && !identity.found) {
    return startRegisterFlow({
      phone,
      pushName,
      after: 'reservation',
      intro: 'No encontre tu telefono registrado. Para poder reservar, primero necesito darte de alta.'
    });
  }

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

function startRegisterFlow({ phone, pushName, after = 'menu', intro = 'Te ayudo a registrarte.' }) {
  return {
    state: buildState('ask_register_name', {
      phone,
      pushName,
      after
    }),
    replies: [`${intro}\nPasame tu nombre completo.`]
  };
}

async function finishRegisterFlow(data) {
  const emailIdentity = await identifyClientByEmail(data.email);
  const created = await crearCliente({
    nombre: data.nombre,
    email: data.email,
    telefono: data.phone
  });
  const cliente = created.cliente || emailIdentity.cliente || {};
  const updatedByExistingEmail = emailIdentity.found && !created.created;

  if (data.after === 'reservation') {
    const canchas = await listarCanchas();
    return {
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
      updatedByExistingEmail
        ? 'Listo, encontre ese email y actualice/asocie tu telefono.'
        : created.created
          ? 'Listo, ya quedaste registrado.'
          : 'Listo, tus datos ya estaban registrados.'
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
      replies: ['No veo horarios disponibles para esa fecha. Pasame otra fecha, por ejemplo 2026-07-05 o 05/07.']
    };
  }

  return {
    state: buildState('ask_slot', { ...data, slots }),
    replies: [`Estos horarios estan disponibles. Responde con el numero:\n${formatSlots(slots)}`]
  };
}

async function continueFlow({ state, text, canonicalJid, pushName }) {
  if (!reservasApiConfigured()) {
    return {
      state: null,
      replies: ['Todavia falta configurar la URL o API key de reservas para poder tomar turnos.']
    };
  }

  if (wantsCancel(text)) {
    return {
      state: null,
      replies: ['Listo, cancele el flujo actual. Para reservar, escribime "reservar". Para consultar tus reservas, escribime "mis reservas". Para registrarte, escribime "registrarme".']
    };
  }

  if (state && isExpired(state)) {
    if (!hasReservationIntent(text) && !hasQueryIntent(text) && !hasRegisterIntent(text)) {
      return {
        state: null,
        replies: [
          `La conversacion anterior quedo pausada mas de ${FLOW_TIMEOUT_MINUTES} minutos y la reinicie. Para reservar, escribime "reservar". Para consultar tus reservas, escribime "mis reservas". Para registrarte, escribime "registrarme".`
        ]
      };
    }

    if (hasQueryIntent(text)) {
      const phone = phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', { pushName, intent: 'query' }),
          replies: ['Para consultar tus reservas necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567']
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
          replies: ['Para registrarte necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567']
        };
      }

      return startRegisterFlow({ phone, pushName });
    }

    const restarted = await startFlow({ phone: phoneFromJid(canonicalJid), pushName });
    return {
      state: restarted.state,
      replies: [
        `La reserva anterior habia vencido despues de ${FLOW_TIMEOUT_MINUTES} minutos sin actividad. Empecemos de nuevo.`,
        ...restarted.replies
      ]
    };
  }

  if (!state) {
    const reservationIntent = hasReservationIntent(text);
    const queryIntent = hasQueryIntent(text);
    const registerIntent = hasRegisterIntent(text);

    const phone = phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', {
          pushName,
          intent: queryIntent ? 'query' : registerIntent || !reservationIntent ? 'register' : 'reservation'
        }),
        replies: [
          queryIntent
            ? 'Para consultar tus reservas necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567'
            : registerIntent || !reservationIntent
              ? 'Para registrarte necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567'
            : 'Para empezar la reserva necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567'
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
          replies: [`Ya estas registrado${cliente.nombre ? ` como ${cliente.nombre}` : ''}. Para reservar escribime "reservar".`]
        };
      }

      return startRegisterFlow({ phone, pushName });
    }

    if (reservationIntent) {
      return startFlow({ phone, pushName });
    }

    // Aunque sea un saludo u otro mensaje general, comprobamos si el remitente
    // necesita registrarse. Los clientes ya registrados no reciben una respuesta
    // automática hasta que expresen una intención de reserva o consulta.
    const identity = await identifyClient(phone);
    if (!identity.found) {
      return startRegisterFlow({
        phone,
        pushName,
        intro: [
          `Bienvenido${pushName ? `, ${pushName}` : ''}.`,
          'No encontre tu telefono registrado. Para continuar, necesito comprobar tus datos.'
        ].join('\n')
      });
    }

    const cliente = identity.cliente || {};
    const nombre = cliente.nombre || pushName || '';
    return {
      state: null,
      replies: [
        [
          `Bienvenido${nombre ? `, ${nombre}` : ''}. ¿En que puedo ayudarte?`,
          '',
          'Escribi una de estas opciones:',
          '- "reservar" para hacer una reserva',
          '- "mis reservas" para consultar tus turnos',
          '- "registrarme" para comprobar tus datos'
        ].join('\n')
      ]
    };
  }

  const data = state.data || {};

  if (hasQueryIntent(text)) {
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName, intent: 'query' }),
        replies: ['Para consultar tus reservas necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567']
      };
    }

    return startQueryFlow({ phone });
  }

  if (hasRegisterIntent(text)) {
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName, intent: 'register' }),
        replies: ['Para registrarte necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567']
      };
    }

    return startRegisterFlow({ phone, pushName });
  }

  if (state.step === 'ask_phone') {
    if (!looksLikePhone(text)) {
      return {
        state,
        replies: ['Pasame el numero con codigo de pais, solo numeros o con +. Ejemplo: 5493881234567']
      };
    }

    if (data.intent === 'query') {
      return startQueryFlow({ phone: onlyDigits(text) });
    }

    if (data.intent === 'register') {
      return startRegisterFlow({ phone: onlyDigits(text), pushName: data.pushName || pushName });
    }

    return startFlow({ phone: onlyDigits(text), pushName: data.pushName || pushName });
  }

  if (state.step === 'ask_register_name') {
    const nombre = String(text || '').trim();
    if (nombre.length < 5 || !nombre.includes(' ')) {
      return { state, replies: ['Pasame nombre y apellido, por favor.'] };
    }

    return {
      state: buildState('ask_register_email', { ...data, nombre }),
      replies: ['Genial. Ahora pasame tu email. Si ya existe en la base, lo usamos para asociar/actualizar tu telefono.']
    };
  }

  if (state.step === 'ask_register_email') {
    const email = parseEmail(text);
    if (!email) {
      return { state, replies: ['Ese email no parece valido. Mandame uno tipo nombre@email.com.'] };
    }

    return finishRegisterFlow({ ...data, email });
  }

  if (state.step === 'ask_cancha') {
    const cancha = parseChoice(text, data.canchas || []);
    if (!cancha) {
      return {
        state,
        replies: [`No pude identificar la cancha. Responde con uno de estos numeros:\n${formatCanchas(data.canchas || [])}`]
      };
    }

    const nextData = { ...data, cancha };
    if (cancha.duracion_fija) {
      return {
        state: buildState('ask_fecha', { ...nextData, duracion: Number(cancha.duracion_fija) }),
        replies: ['Perfecto. Pasame la fecha de la reserva. Puede ser 2026-07-05, 05/07 o "mañana".']
      };
    }

    return {
      state: buildState('ask_duracion', nextData),
      replies: ['Cuantas horas queres reservar? Responde 1, 2, 3 o 4.']
    };
  }

  if (state.step === 'ask_duracion') {
    const duracion = parseDuration(text);
    if (!duracion) {
      return { state, replies: ['La duracion tiene que ser 1, 2, 3 o 4 horas.'] };
    }

    return {
      state: buildState('ask_fecha', { ...data, duracion }),
      replies: ['Pasame la fecha de la reserva. Puede ser 2026-07-05, 05/07 o "mañana".']
    };
  }

  if (state.step === 'ask_fecha') {
    const fecha = parseDate(text);
    if (!fecha) {
      return { state, replies: ['No pude leer la fecha. Mandamela como 2026-07-05, 05/07 o "mañana".'] };
    }

    return askDisponibilidad({ ...data, fecha });
  }

  if (state.step === 'ask_slot') {
    const slot = parseChoice(text, data.slots || [], 'label');
    if (!slot) {
      return { state, replies: [`Elegí un horario respondiendo con el numero:\n${formatSlots(data.slots || [])}`] };
    }

    const terminos = await listarTerminos({
      tipo: Number(data.cancha?.duracion_fija) === 3 ? 'cumple' : 'turno',
      cancha: data.cancha?.id
    });

    return {
      state: buildState('ask_terms', { ...data, slot, terminos }),
      replies: [`${compactTerms(terminos)}\n\nPara aceptar y seguir, responde SI ACEPTO.`]
    };
  }

  if (state.step === 'ask_terms') {
    const accepted = ['si', 'sí', 'si acepto', 'sí acepto', 'acepto'].includes(normalizeText(text));
    if (!accepted) {
      return { state, replies: ['Necesito que respondas "SI ACEPTO" para poder generar la reserva.'] };
    }

    if (!data.nombre) {
      return {
        state: buildState('ask_name', { ...data, aceptaTerminos: true }),
        replies: ['A nombre de quien queda la reserva?']
      };
    }

    if (!parseEmail(data.email)) {
      return {
        state: buildState('ask_email', { ...data, aceptaTerminos: true }),
        replies: ['Pasame un email para generar el pago de la seña.']
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
      replies: ['Genial. Ahora pasame un email para generar el pago de la seña.']
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
        replies: ['Si esta todo bien responde SI. Para empezar de nuevo responde cancelar y despues "reservar".']
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
          `Fecha: ${reserva.reserva?.fecha || data.fecha}`,
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
    `Fecha: ${data.fecha}`,
    `Horario: ${data.slot?.label || `${data.slot?.inicio} a ${data.slot?.fin}`}`,
    `Duracion: ${data.duracion} hs`,
    `Nombre: ${data.nombre}`,
    `Email: ${data.email}`
  ].join('\n');
}

export async function handleReservationFlow(input) {
  try {
    return await continueFlow(input);
  } catch (error) {
    return {
      state: input.state || null,
      replies: [
        `No pude avanzar con la reserva: ${error.message || 'error desconocido'}. Proba de nuevo en unos minutos o escribi cancelar para reiniciar.`
      ]
    };
  }
}
