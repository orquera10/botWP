import {
  consultarDisponibilidad,
  consultarTurnos,
  crearReserva,
  listarCanchas,
  listarTerminos,
  reservasApiConfigured
} from './wpReservasApi.js';

const TRIGGER_WORDS = ['reserv', 'turno', 'cancha', 'jugar', 'futbol', 'fútbol', 'cumple'];
const CANCEL_WORDS = ['cancelar', 'salir', 'menu', 'reiniciar'];

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

function buildState(step, data = {}) {
  return { step, data, updatedAt: new Date().toISOString() };
}

async function identifyClient(phone) {
  try {
    const result = await consultarTurnos({ telefono: phone, futuros: 1, limite: 3 });
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

async function startFlow({ phone, pushName }) {
  const canchas = await listarCanchas();
  const identity = phone ? await identifyClient(phone) : { found: false, cliente: null, turnos: [] };
  const cliente = identity.cliente || {};
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
      replies: ['Listo, cancele el flujo de reserva. Cuando quieras reservar, escribime "reservar".']
    };
  }

  if (!state) {
    if (!hasReservationIntent(text)) return { state: null, replies: [] };

    const phone = phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName }),
        replies: ['Para empezar la reserva necesito identificar tu telefono de WhatsApp con codigo de pais. Ejemplo: 5493881234567']
      };
    }

    return startFlow({ phone, pushName });
  }

  const data = state.data || {};

  if (state.step === 'ask_phone') {
    if (!looksLikePhone(text)) {
      return {
        state,
        replies: ['Pasame el numero con codigo de pais, solo numeros o con +. Ejemplo: 5493881234567']
      };
    }

    return startFlow({ phone: onlyDigits(text), pushName: data.pushName || pushName });
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
