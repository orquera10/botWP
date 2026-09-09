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
import {
  BIRTHDAY_CONTACT_URL,
  BIRTHDAY_INVITATION_TEMPLATE,
  BIRTHDAY_RULES_IMAGE,
  createBirthdayInvitation,
  invitationFirstName
} from './birthdayInvitation.js';

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
const SPECIFIC_QUESTIONS_MESSAGE = `Este número está destinado exclusivamente a reservas. Para dudas o consultas específicas, comunicate con la cancha por WhatsApp:\n${BIRTHDAY_CONTACT_URL}`;

function phoneFromJid(jid) {
  if (!jid?.endsWith('@s.whatsapp.net')) return '';
  return String(jid.split('@')[0] || '').replace(/\D/g, '');
}

function phoneRequestMessage(purpose = 'continuar') {
  if (purpose === 'verificar el registro para continuar la reserva') {
    return [
      'Para continuar con la reserva necesito verificar si ya estas registrado.',
      'Pasame tu numero de telefono. Podes escribirlo como 388 410-4530 o enviarlo con +54 9.'
    ].join('\n');
  }

  if (['empezar la reserva', 'completar la reserva'].includes(purpose)) {
    const reservationProgress = purpose === 'completar la reserva'
      ? 'Para terminar de preparar la reserva necesito algunos datos.'
      : 'Para continuar con la reserva necesito algunos datos.';
    return [
      reservationProgress,
      'Primero, pasame tu numero de telefono. Podes escribirlo como 388 410-4530 o enviarlo con +54 9.',
      'WhatsApp no me lo proporciono automaticamente. Si ya estas registrado, no voy a pedirte nuevamente los datos que tenemos.'
    ].join('\n');
  }

  return [
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

function normalizePersonName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-AR')
    .split(' ')
    .map((part) => part ? `${part[0].toLocaleUpperCase('es-AR')}${part.slice(1)}` : '')
    .join(' ');
}

function normalizeClientRecord(cliente) {
  if (!cliente) return null;
  return {
    ...cliente,
    nombre: normalizePersonName(cliente.nombre)
  };
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

function hasGreeting(text) {
  const normalized = normalizeText(text);
  return /^(hola|buen dia|buenas|buenas tardes|buenas noches)\b/.test(normalized);
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

function formatAlternativeSlots(slots) {
  return slots
    .map((slot, index) => `${index + 1}. ${slot.cancha.nombre} - ${slot.label || `${slot.inicio} a ${slot.fin}`}`)
    .concat('0. Volver')
    .join('\n');
}

function parseRequestedTime(text) {
  const match = String(text || '').match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
  if (!match) return '';
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2] || '00'}`;
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.POSITIVE_INFINITY;
}

function isCompatibleAlternativeCourt(selectedCourt, alternativeCourt) {
  const selectedFixedDuration = Number(selectedCourt?.duracion_fija || 0);
  const alternativeFixedDuration = Number(alternativeCourt?.duracion_fija || 0);

  if (selectedFixedDuration > 0) {
    return alternativeFixedDuration === selectedFixedDuration;
  }

  return alternativeFixedDuration === 0;
}

async function findAlternativeSlots(data, requestedStartTime = '') {
  const canchas = Array.isArray(data.canchas) && data.canchas.length
    ? data.canchas
    : await listarCanchas();
  const alternatives = canchas.filter((cancha) =>
    String(cancha.id) !== String(data.cancha?.id)
    && isCompatibleAlternativeCourt(data.cancha, cancha)
  );

  const results = await Promise.allSettled(alternatives.map(async (cancha) => {
    const slots = await consultarDisponibilidad({
      fecha: data.fecha,
      cancha: cancha.id,
      duracion: data.duracion
    });
    return slots
      .filter((slot) => !requestedStartTime || slot.inicio === requestedStartTime)
      .map((slot) => ({ ...slot, cancha }));
  }));

  return results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .sort((left, right) => String(left.inicio).localeCompare(String(right.inicio))
      || String(left.cancha.nombre).localeCompare(String(right.cancha.nombre)));
}

function isAvailabilityConflict(error) {
  const message = normalizeText(error?.message || '');
  return error?.status === 409
    || /dispon|ocupad|ya fue reservad|horario.*reservad|turno.*tomad/.test(message);
}

function userMenuMessage(_businessSettings = {}, intro = '') {
  const menu = [
    '¿Que queres hacer?',
    '1. Buscar un turno',
    '2. Ver disponibilidad',
    '3. Ver mis reservas',
    '4. Ver productos',
    '',
    'Responde con el numero o escribime lo que necesitas.',
    'En cualquier momento podes escribir "cancelar" o "menu" para volver al menu principal.'
  ].join('\n');

  return intro ? `${intro}\n\n${menu}` : menu;
}

function mainMenuMessage(businessSettings = {}) {
  return userMenuMessage(businessSettings, 'Volvimos al menu principal.');
}

function faqAnswer(text) {
  const normalized = normalizeText(text);

  if (/\b(pelotero|peloteros|cama elastica|camas elasticas|inflable|inflables)\b/.test(normalized)) {
    return 'No está permitido ingresar peloteros, camas elásticas, inflables ni otros aparatos o juegos.';
  }

  if (/\b(parrilla|parrillas|asado)\b/.test(normalized)) {
    return 'Sí, está permitido usar la parrilla, pero se requiere un consumo mínimo.';
  }

  if (/\b(pechera|pecheras|chaleco|chalecos)\b/.test(normalized)) {
    return 'Sí, contamos con pecheras para los equipos.';
  }

  if (/\b(bebida|bebidas|gaseosa|gaseosas|cerveza|cervezas)\b/.test(normalized)) {
    return 'No está permitido ingresar bebidas. Se pueden consumir las que están disponibles para la venta en el salón.';
  }

  if (/\b(cocina|cocinar)\b/.test(normalized)) {
    return 'No está permitido ingresar a la cocina; su uso es exclusivo del personal.';
  }

  if (/\b(pinata|pinatas|papel picado)\b/.test(normalized)) {
    return 'No está permitido tirar papel picado ni usar piñatas dentro del espacio de la cancha.';
  }

  if (/\b(vajilla|manteleria|manteles|platos|cubiertos)\b/.test(normalized)) {
    return 'La vajilla y la mantelería tienen un costo adicional.';
  }

  if (/\b(salon superior|salon de arriba|ambos salones|dos salones)\b/.test(normalized)) {
    return 'El salón superior y el uso de ambos salones tienen un costo adicional.';
  }

  if (/\b(capacidad|cuantas personas|cantidad de personas|mas de 30|30 personas)\b/.test(normalized)) {
    return 'La reserva de cumpleaños incluye hasta 30 personas entre adultos y niños. Las personas adicionales tienen costo.';
  }

  if (/\b(reembolso|reembolsable|devolucion|devolver la senia|cancelar el cumple)\b/.test(normalized)) {
    return 'La seña es totalmente reembolsable únicamente hasta 72 horas antes del evento.';
  }

  if (/\b(wifi|estacionamiento|vestuario|vestuarios|ducha|duchas|mascota|mascotas|decoracion|decorar|torta|comida|mesas|sillas|musica|parlante|parlantes|aire acondicionado|calefaccion)\b/.test(normalized)) {
    return SPECIFIC_QUESTIONS_MESSAGE;
  }

  return '';
}

function isExpectedFlowAnswer(state, text) {
  const data = state?.data || {};
  const normalized = normalizeText(text);

  switch (state?.step) {
    case undefined:
    case 'main_menu':
      return Boolean(
        parseMainMenuChoice(text)
        || hasAvailabilityIntent(text)
        || hasQueryIntent(text)
        || hasRegisterIntent(text)
        || hasProductIntent(text)
        || /\b(quiero reservar|hacer una reserva|reservar un turno|buscar un turno)\b/.test(normalized)
        || hasGreeting(text)
      );
    case 'ask_phone':
    case 'ask_register_match_phone':
      return looksLikeArgentinePhone(text) || normalized === 'usar email';
    case 'ask_register_email':
    case 'ask_register_match_email':
    case 'ask_email':
      return Boolean(parseEmail(text));
    case 'ask_cancha':
      return Boolean(parseChoice(text, data.canchas || []));
    case 'ask_duracion':
      return Boolean(parseDuration(text));
    case 'ask_fecha':
      return Boolean(parseDate(text));
    case 'ask_start_time':
      return Boolean(parseRequestedTime(text));
    case 'ask_slot':
      return Boolean(parseChoice(text, data.slots || [], 'label'));
    case 'ask_alternative_slot':
      return Boolean(parseChoice(text, data.alternativeSlots || [], 'label'));
    case 'ask_availability_reserve':
      return ['1', '2', 'si', 'no', 'reservar', 'si reservar'].includes(normalized);
    case 'ask_terms':
      return ['si', 'si acepto', 'acepto'].includes(normalized);
    case 'ask_confirm':
      return ['si', 'confirmo', 'reservar'].includes(normalized);
    case 'ask_register_name':
    case 'ask_name':
    case 'birthday_invitation_name':
      return !/[?¿]/.test(String(text || '')) && normalized.length >= 2;
    case 'birthday_invitation_offer':
      return ['si', 'quiero', 'dale', 'acepto', 'no', 'no gracias'].includes(normalized);
    default:
      return false;
  }
}

function isOtherInquiry(state, text) {
  const normalized = normalizeText(text);
  const questionLike = /[?¿]/.test(String(text || ''))
    || /^(que|como|cuando|donde|cuanto|por que|tienen|hay|dan|hacen|venden|alquilan|permiten|cuentan|puedo|se puede|quisiera saber)\b/.test(normalized);

  return questionLike
    && !wantsCancel(text)
    && !wantsBack(text)
    && !isExpectedFlowAnswer(state, text);
}

function currentFlowReminder(state, businessSettings = {}) {
  const data = state?.data || {};
  switch (state?.step) {
    case 'main_menu':
      return userMenuMessage(businessSettings);
    case 'ask_phone':
      return phoneRequestMessage('continuar');
    case 'ask_register_email':
      return 'Para continuar, pasame tu correo electrónico.';
    case 'ask_register_name':
      return 'Para continuar, pasame tu nombre y apellido.';
    case 'ask_register_match_phone':
      return 'Para continuar, escribí el teléfono que figura en el registro o "usar email".';
    case 'ask_register_match_email':
      return 'Para continuar, escribí el correo electrónico que figura en el registro.';
    case 'ask_cancha':
      return `Elegí la cancha respondiendo con el número:\n${formatCanchas(data.canchas || [])}`;
    case 'ask_duracion':
      return '¿Cuántas horas querés reservar? Respondé 1, 2, 3 o 4.';
    case 'ask_fecha':
      return dateRequestMessage('¿Qué fecha querés reservar?');
    case 'ask_start_time':
      return '¿A qué hora querés comenzar? Por ejemplo: 18:00.';
    case 'ask_slot':
      return `Elegí el horario respondiendo con el número:\n${formatSlots(data.slots || [])}`;
    case 'ask_alternative_slot':
      return `Elegí un turno respondiendo con el número:\n${formatAlternativeSlots(data.alternativeSlots || [])}`;
    case 'ask_availability_reserve':
      return 'Respondé 1 para reservar uno de los horarios o 2 para volver al menú.';
    case 'ask_terms':
      return termsAcceptancePrompt();
    case 'ask_name':
      return '¿A nombre de quién queda la reserva?';
    case 'ask_email':
      return 'Pasame el correo electrónico para generar el pago de la seña.';
    case 'ask_confirm':
      return summaryMessage(data);
    case 'birthday_invitation_offer':
      return 'Respondé SÍ si querés una invitación personalizada o NO para continuar sin personalizarla.';
    case 'birthday_invitation_name':
      return '¿Cuál es el primer nombre del cumpleañero o cumpleañera? Escribí solamente el nombre, sin apellido.';
    default:
      return 'Cuando quieras, respondé la pregunta anterior para continuar.';
  }
}

function answerFaqWithoutInterruptingFlow({ answer, state, pushName, businessSettings }) {
  const completeAnswer = answer.includes('exclusivamente a reservas')
    ? answer
    : `${answer}\n\n${SPECIFIC_QUESTIONS_MESSAGE}`;

  if (!state || state.step === 'main_menu') {
    return {
      state: buildState('main_menu', { ...(state?.data || {}), pushName }),
      replies: [[completeAnswer, userMenuMessage(businessSettings)].join('\n\n')]
    };
  }

  return {
    state: buildState(state.step, state.data || {}),
    replies: [[completeAnswer, 'Continuemos donde estábamos:', currentFlowReminder(state, businessSettings)].join('\n\n')]
  };
}

function goBack(state, businessSettings = {}) {
  const data = state.data || {};

  if (state.step === 'ask_phone' && data.intent === 'reservation_after_availability') {
    return {
      state: buildState('ask_slot', data),
      replies: [`Volvamos a elegir el horario. Las opciones son:\n${formatSlots(data.slots || [])}`]
    };
  }

  if (state.step === 'ask_phone' && data.intent === 'availability_registration_check') {
    return {
      state: buildState('ask_availability_reserve', data),
      replies: ['Volvamos a la disponibilidad. Responde 1 para reservar uno de los horarios o 2 para volver al menu.']
    };
  }

  if (['ask_phone', 'ask_register_email', 'ask_register_match_phone', 'ask_cancha'].includes(state.step)) {
    return {
      state: buildState('main_menu', { pushName: data.pushName || '' }),
      replies: [mainMenuMessage(businessSettings)]
    };
  }

  if (state.step === 'ask_register_name') {
    return {
      state: buildState('ask_register_email', data),
      replies: ['Volvamos al email. Pasame el correo que queres usar para buscar o crear tu registro. Para volver al menu, escribi "volver".']
    };
  }

  if (state.step === 'ask_register_match_email') {
    return {
      state: buildState('ask_register_match_phone', data),
      replies: ['Volvamos a la verificacion. Escribi el telefono que figura en el registro o "usar email" para buscar de otra manera.']
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

  if (state.step === 'ask_start_time') {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('Volvamos a elegir la fecha.', 'Tambien podes escribir "volver".')]
    };
  }

  if (state.step === 'ask_slot') {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('Volvamos a la fecha.', 'Tambien podes escribir "volver".')]
    };
  }

  if (state.step === 'ask_alternative_slot') {
    if (data.availabilitySearch) {
      return {
        state: buildState('ask_start_time', data),
        replies: ['¿A qué hora querés comenzar? Por ejemplo: 18:00. Para cambiar la fecha, escribí "volver".']
      };
    }
    if (data.slots?.length) {
      return {
        state: buildState('ask_slot', data),
        replies: [`Volvamos a los horarios de ${data.cancha?.nombre}:\n${formatSlots(data.slots)}`]
      };
    }
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('Volvamos a elegir la fecha.', 'Tambien podes escribir "volver".')]
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
      replies: [compactTerms(data.terminos || []), termsAcceptancePrompt()]
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

  return {
    state: buildState('main_menu', { pushName: data.pushName || '' }),
    replies: [mainMenuMessage(businessSettings)]
  };
}

function compactTerms(terminos) {
  if (!terminos.length) return 'Para continuar necesito que aceptes los terminos de la reserva.';
  return [
    'Terminos y condiciones de la reserva:',
    ...terminos.map((item) => `- ${item}`)
  ].filter(Boolean).join('\n');
}

function termsAcceptancePrompt() {
  return 'Para aceptar y seguir, responde SI ACEPTO. Para cambiar el horario, responde VOLVER.';
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

export function buildBirthdayInvitationNameState(data) {
  return buildState('birthday_invitation_name', data);
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
      cliente: normalizeClientRecord(result.cliente),
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

    return { found: true, cliente: normalizeClientRecord(result.cliente) };
  } catch (error) {
    if (error.status === 404) {
      return { found: false, cliente: null };
    }
    throw error;
  }
}

async function identifyClientByName(nombre) {
  const normalizedName = normalizePersonName(nombre);
  if (!normalizedName) return { found: false, cliente: null };

  try {
    const result = await consultarCliente({ nombre: normalizedName });
    if (!result.exists) return { found: false, cliente: null };
    return { found: true, cliente: normalizeClientRecord(result.cliente) };
  } catch (error) {
    // Algunas versiones anteriores de la API no admiten busqueda por nombre.
    if ([400, 404].includes(error.status)) return { found: false, cliente: null };
    throw error;
  }
}

async function greetingNameFor(canonicalJid, pushName) {
  const phone = phoneFromJid(canonicalJid);
  if (!phone) return pushName || '';

  try {
    const identity = await identifyClient(phone);
    return identity.found && identity.cliente?.nombre
      ? identity.cliente.nombre
      : pushName || '';
  } catch {
    return pushName || '';
  }
}

async function startFlow({ phone, pushName }) {
  const canchas = await listarCanchas();

  const data = {
    phone,
    pushName,
    deferRegistration: true,
    canchas
  };

  return {
    state: buildState('ask_cancha', data),
    replies: [
      `Te ayudo a hacer la reserva.\n\nElegí la cancha respondiendo con el numero:\n${formatCanchas(canchas)}`
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

async function prepareAvailabilityReservation({
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
        replies: ['Para continuar con la reserva tenes que registrarte, pero el registro automatico no esta habilitado para este negocio.']
      };
    }

    return {
      ...(await startRegisterFlow({
        phone,
        pushName,
        after: 'availability_choose_slot',
        reservationData: data,
        intro: 'Para continuar con la reserva tenes que registrarte. Ya tengo tu numero; ahora necesito tu nombre y tu email.'
      })),
      targetFlow: 'registration'
    };
  }

  const cliente = identity.cliente || {};
  return {
    state: buildState('ask_slot', {
      ...data,
      availabilityOnly: false,
      phone,
      nombre: cliente.nombre || pushName || '',
      email: cliente.email || '',
      existingClient: true
    }),
    replies: [`Perfecto. Ya encontre tus datos. Elegi el horario que queres reservar:\n${formatSlots(data.slots || [])}`]
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
      ...(await startRegisterFlow({
        phone,
        pushName,
        after: 'availability_reservation',
        reservationData: data,
        intro: 'El horario sigue disponible. Para terminar la reserva te tengo que registrar.'
      })),
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
    replies: [compactTerms(terminos), termsAcceptancePrompt()]
  };
}

async function startRegisterFlow({
  phone,
  pushName,
  after = 'menu',
  reservationData = null,
  intro = 'Te ayudo a registrarte.'
}) {
  const nameIdentity = pushName
    ? await identifyClientByName(pushName)
    : { found: false, cliente: null };
  const candidate = nameIdentity.cliente;

  if (nameIdentity.found && candidate?.telefono && candidate?.email) {
    return {
      state: buildState('ask_register_match_phone', {
        phone,
        pushName,
        after,
        reservationData,
        candidate
      }),
      replies: [[
        intro,
        `Encontre un posible registro a nombre de ${candidate.nombre}.`,
        'Para confirmar que es tuyo sin mostrar datos privados, escribi el numero de telefono que figura en ese registro. Si no es tu registro, escribi "usar email".'
      ].join('\n\n')]
    };
  }

  return {
    state: buildState('ask_register_email', {
      phone,
      pushName,
      after,
      reservationData
    }),
    replies: [`${intro}\n\nPrimero, pasame tu correo electronico. Voy a buscar si ya tenes un registro con ese email. Para volver al menu, escribi "volver".`]
  };
}

async function finishRegisterFlow(data, businessSettings = {}, knownEmailIdentity = null) {
  const emailIdentity = knownEmailIdentity || await identifyClientByEmail(data.email);
  const created = await crearCliente({
    nombre: normalizePersonName(data.nombre),
    email: data.email,
    telefono: data.phone
  });
  const cliente = normalizeClientRecord(created.cliente || emailIdentity.cliente) || {};
  const updatedByExistingEmail = emailIdentity.found && !created.created;

  if (data.after === 'query') {
    const queryResult = await startQueryFlow({
      phone: data.phone,
      pushName: cliente.nombre || data.nombre || data.pushName || '',
      registrationAvailable: false
    });
    const linkedMessage = updatedByExistingEmail
      ? 'Listo, encontre ese email y asocie el telefono.'
      : created.created
        ? 'Listo, ya quedaste registrado y vincule tus datos.'
        : 'Listo, ya encontre y vincule tus datos.';

    return {
      state: queryResult.state || null,
      replies: [[linkedMessage, ...(queryResult.replies || [])].join('\n\n')]
    };
  }

  if (data.after === 'availability_choose_slot') {
    const reservationData = data.reservationData || {};
    return {
      targetFlow: 'reservation',
      state: buildState('ask_slot', {
        ...reservationData,
        availabilityOnly: false,
        phone: data.phone,
        nombre: cliente.nombre || data.nombre,
        email: cliente.email || data.email,
        existingClient: true
      }),
      replies: [[
        updatedByExistingEmail
          ? 'Listo, encontre ese email y asocie el telefono.'
          : created.created
            ? 'Listo, ya quedaste registrado.'
            : 'Listo, ya encontre tus datos.',
        `Ahora elegi el horario que queres reservar:\n${formatSlots(reservationData.slots || [])}`
      ].join('\n\n')]
    };
  }

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
      replies: [
        updatedByExistingEmail
          ? 'Listo, encontre ese email y asocie el telefono.'
          : created.created
            ? 'Listo, ya quedaste registrado.'
            : 'Listo, ya encontre tus datos.',
        compactTerms(terminos),
        termsAcceptancePrompt()
      ]
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
    state: buildState('main_menu', { pushName: data.pushName || '' }),
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

async function startQueryFlow({
  phone,
  pushName = '',
  registrationAvailable = true
}) {
  try {
    const identity = await identifyClient(phone);
    if (!identity.found) {
      if (registrationAvailable) {
        return {
          ...(await startRegisterFlow({
            phone,
            pushName,
            after: 'query',
            intro: 'No encontre un cliente asociado a ese numero. Para consultar tus reservas primero necesito vincularlo con la base de datos.'
          })),
          targetFlow: 'registration'
        };
      }

      return {
        state: null,
        replies: ['No encontre un cliente registrado con ese telefono o email.']
      };
    }

    const cliente = identity.cliente || {};
    const consultas = [
      consultarTurnos({ telefono: phone, futuros: 0, limite: 100 }),
      consultarTurnos({ telefono: phone, futuros: 1, limite: 100 })
    ];

    if (cliente.email) {
      consultas.push(
        consultarTurnos({ email: cliente.email, futuros: 0, limite: 100 }),
        consultarTurnos({ email: cliente.email, futuros: 1, limite: 100 })
      );
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
  const currentSlots = await consultarDisponibilidad({
    fecha: data.fecha,
    cancha: data.cancha.id,
    duracion: data.duracion
  });
  const alternativeSlots = await findAlternativeSlots(data);
  const allSlots = [
    ...currentSlots.map((slot) => ({ ...slot, cancha: data.cancha })),
    ...alternativeSlots
  ];
  const exactSlots = allSlots.filter((slot) => slot.inicio === data.requestedStartTime);

  if (!allSlots.length) {
    return {
      state: buildState('ask_fecha', data),
      replies: [dateRequestMessage('No veo horarios disponibles para esa fecha. Pasame otra fecha.')]
    };
  }

  const requestedMinutes = timeToMinutes(data.requestedStartTime);
  const options = (exactSlots.length ? exactSlots : allSlots)
    .sort((left, right) => {
      const leftDistance = Math.abs(timeToMinutes(left.inicio) - requestedMinutes);
      const rightDistance = Math.abs(timeToMinutes(right.inicio) - requestedMinutes);
      return leftDistance - rightDistance
        || String(left.inicio).localeCompare(String(right.inicio))
        || String(left.cancha.nombre).localeCompare(String(right.cancha.nombre));
    })
    .slice(0, 8);

  return {
    state: buildState('ask_alternative_slot', {
      ...data,
      availabilitySearch: true,
      slots: [],
      alternativeSlots: options
    }),
    replies: [[
      exactSlots.length
        ? `Encontré estos turnos para comenzar a las ${data.requestedStartTime}:`
        : `No hay turnos que comiencen a las ${data.requestedStartTime}. Estos son los horarios más cercanos:`,
      formatAlternativeSlots(options),
      'Respondé con el número del turno que querés reservar.'
    ].join('\n')]
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
      state: buildState('main_menu', { pushName }),
      replies: [[
        'Listo, cancele el flujo actual.',
        userMenuMessage(businessSettings)
      ].join('\n\n')]
    };
  }

  if (state && isExpired(state)) {
    if (!hasReservationIntent(text) && !hasAvailabilityIntent(text) && !hasQueryIntent(text) && !hasRegisterIntent(text)) {
      return {
        state: buildState('main_menu', { pushName }),
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
          replies: [phoneRequestMessage('consultar tus reservas')]
        };
      }

      const restartedQuery = await startQueryFlow({ phone, pushName, registrationAvailable });
      return {
        targetFlow: restartedQuery.targetFlow,
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
          replies: [phoneRequestMessage('registrarte')]
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

  const faq = faqAnswer(text);
  if (faq) {
    return answerFaqWithoutInterruptingFlow({
      answer: faq,
      state,
      pushName,
      businessSettings
    });
  }

  if (isOtherInquiry(state, text)) {
    return answerFaqWithoutInterruptingFlow({
      answer: SPECIFIC_QUESTIONS_MESSAGE,
      state,
      pushName,
      businessSettings
    });
  }

  if (!state) {
    const greetingName = await greetingNameFor(canonicalJid, pushName);
    const welcome = buildWelcomeMessage(businessSettings, businessName, greetingName);
    return {
      state: buildState('main_menu', { pushName, greetingName }),
      replies: [[welcome, userMenuMessage(businessSettings)].join('\n\n')]
    };
  }

  if (state.step === 'birthday_invitation_offer') {
    const answer = normalizeText(text);
    const accepted = ['si', 'quiero', 'dale', 'acepto'].includes(answer);
    const declined = ['no', 'no gracias'].includes(answer);

    if (accepted) {
      return {
        state: buildState('birthday_invitation_name', state.data),
        replies: ['¿Cuál es el primer nombre del cumpleañero o cumpleañera? Escribí solamente el nombre, sin apellido.']
      };
    }

    if (declined) {
      return {
        state: null,
        replies: ['No hay problema. Te envío la invitación base para que puedas completarla y el reglamento de cumpleaños.'],
        media: [
          { path: BIRTHDAY_INVITATION_TEMPLATE, fileName: 'invitacion_cumple_base.png', caption: 'Invitación base' },
          { path: BIRTHDAY_RULES_IMAGE, fileName: 'reglamento_cancha.png', caption: 'Reglamento para cumpleaños' }
        ],
        afterMediaReplies: [`Para dudas específicas, podés comunicarte con nosotros acá:\n${BIRTHDAY_CONTACT_URL}`]
      };
    }

    return {
      state: buildState('birthday_invitation_offer', state.data),
      replies: ['Respondé SÍ si querés una invitación personalizada o NO si preferís continuar sin personalizarla.']
    };
  }

  if (state.step === 'birthday_invitation_name') {
    const birthdayName = invitationFirstName(text);
    if (!birthdayName) {
      return {
        state: buildState('birthday_invitation_name', state.data),
        replies: ['Para que la tarjeta quede bien, escribí únicamente el primer nombre del cumpleañero o cumpleañera, sin apellido.']
      };
    }

    const invitation = await createBirthdayInvitation({
      name: birthdayName,
      date: String(state.data?.date || '').replaceAll('-', '/'),
      startTime: state.data?.startTime,
      endTime: state.data?.endTime,
      phone: state.data?.phone || phoneFromJid(canonicalJid)
    });

    return {
      state: null,
      replies: [`¡Listo! Preparé la invitación personalizada para ${birthdayName}.`],
      media: [
        { buffer: invitation, fileName: 'invitacion_personalizada.png', caption: 'Invitación personalizada' },
        { path: BIRTHDAY_RULES_IMAGE, fileName: 'reglamento_cancha.png', caption: 'Reglamento para cumpleaños' }
      ],
      afterMediaReplies: [`Para dudas específicas, podés comunicarte con nosotros acá:\n${BIRTHDAY_CONTACT_URL}`]
    };
  }

  if (state.step === 'main_menu') {
    const menuChoice = parseMainMenuChoice(text);
    const availabilityIntent = menuChoice === 'availability' || hasAvailabilityIntent(text);
    const reservationIntent = !availabilityIntent && (menuChoice === 'reservation' || hasReservationIntent(text));
    const queryIntent = menuChoice === 'query' || hasQueryIntent(text);
    const registerIntent = hasRegisterIntent(text);
    const productIntent = menuChoice === 'products' || hasProductIntent(text);

    if (productIntent) {
      const catalogUrl = String(businessSettings.catalogUrl || '').trim();
      return {
        state: buildState('main_menu', { pushName }),
        replies: [[catalogUrl
          ? `Podes consultar nuestro catalogo de productos aca:\n${catalogUrl}`
          : 'El catalogo de productos no esta disponible en este momento.',
        userMenuMessage(businessSettings)].join('\n\n')]
      };
    }

    if (availabilityIntent) {
      return startAvailabilityFlow();
    }

    if (reservationIntent) {
      return startFlow({ phone: phoneFromJid(canonicalJid), pushName });
    }

    if (!reservationIntent && !queryIntent && !registerIntent) {
      if (hasGreeting(text)) {
        const greetingName = await greetingNameFor(canonicalJid, pushName);
        const welcome = buildWelcomeMessage(businessSettings, businessName, greetingName);
        return {
          state: buildState('main_menu', { pushName, greetingName }),
          replies: [[welcome, userMenuMessage(businessSettings)].join('\n\n')]
        };
      }

      return {
        state: buildState('main_menu', { pushName }),
        replies: [[
          SPECIFIC_QUESTIONS_MESSAGE,
          userMenuMessage(businessSettings)
        ].join('\n\n')]
      };
    }

    const phone = phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', {
          pushName,
          intent: queryIntent ? 'query' : 'register'
        }),
        replies: [
          queryIntent
            ? phoneRequestMessage('consultar tus reservas')
            : phoneRequestMessage('registrarte')
        ]
      };
    }

    if (queryIntent) {
      return startQueryFlow({ phone, pushName, registrationAvailable });
    }

    if (registerIntent) {
      const identity = await identifyClient(phone);
      if (identity.found) {
        const cliente = identity.cliente || {};
        return {
          state: buildState('main_menu', { pushName }),
          replies: [[
            `Ya estas registrado${cliente.nombre ? ` como ${cliente.nombre}` : ''}.`,
            userMenuMessage(businessSettings)
          ].join('\n\n')]
        };
      }

      return startRegisterFlow({ phone, pushName });
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
        replies: [phoneRequestMessage('consultar tus reservas')]
      };
    }

    return startQueryFlow({ phone, pushName, registrationAvailable });
  }

  if (hasRegisterIntent(text)) {
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (!phone) {
      return {
        state: buildState('ask_phone', { pushName, intent: 'register' }),
        replies: [phoneRequestMessage('registrarte')]
      };
    }

    return startRegisterFlow({ phone, pushName });
  }

  if (state.step === 'ask_availability_reserve') {
    const answer = normalizeText(text);
    if (['1', 'si', 'reservar', 'si reservar'].includes(answer)) {
      const phone = data.phone || phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', {
            ...data,
            pushName,
            intent: 'availability_registration_check'
          }),
          replies: [phoneRequestMessage('verificar el registro para continuar la reserva')]
        };
      }

      return prepareAvailabilityReservation({
        data,
        phone,
        pushName,
        registrationAvailable
      });
    }

    if (['2', 'no'].includes(answer)) {
      return {
        state: buildState('main_menu', { pushName }),
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
      return startQueryFlow({
        phone: normalizeArgentinePhone(text),
        pushName: data.pushName || pushName,
        registrationAvailable
      });
    }

    if (data.intent === 'register') {
      const phone = normalizeArgentinePhone(text);
      const identity = await identifyClient(phone);
      if (identity.found) {
        const cliente = identity.cliente || {};
        const nombre = cliente.nombre || data.pushName || pushName || '';
        const welcome = buildWelcomeMessage(businessSettings, businessName, nombre);
        return {
          state: buildState('main_menu', { pushName: data.pushName || pushName }),
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

    if (data.intent === 'availability_registration_check') {
      return prepareAvailabilityReservation({
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

  if (state.step === 'ask_register_match_phone') {
    if (normalizeText(text) === 'usar email') {
      return {
        state: buildState('ask_register_email', data),
        replies: ['De acuerdo. Pasame tu correo electronico y voy a buscarlo en la base de datos.']
      };
    }

    const suppliedPhone = normalizeArgentinePhone(text);
    const storedPhone = normalizeArgentinePhone(data.candidate?.telefono);
    if (!suppliedPhone || suppliedPhone !== storedPhone) {
      return {
        state,
        replies: ['Ese telefono no coincide con el registro encontrado. Intentalo nuevamente o escribi "usar email" para buscar por correo.']
      };
    }

    return {
      state: buildState('ask_register_match_email', data),
      replies: ['El telefono coincide. Ahora escribi el correo electronico que figura en ese registro.']
    };
  }

  if (state.step === 'ask_register_match_email') {
    const suppliedEmail = parseEmail(text);
    const storedEmail = String(data.candidate?.email || '').trim().toLowerCase();
    if (!suppliedEmail || suppliedEmail !== storedEmail) {
      return {
        state,
        replies: ['Ese email no coincide con el registro encontrado. Intentalo nuevamente o escribi VOLVER para revisar el telefono.']
      };
    }

    return finishRegisterFlow(
      {
        ...data,
        nombre: data.candidate.nombre,
        email: storedEmail
      },
      businessSettings,
      { found: true, cliente: data.candidate }
    );
  }

  if (state.step === 'ask_register_name') {
    const nombre = normalizePersonName(text);
    if (nombre.length < 5 || !nombre.includes(' ')) {
      return { state, replies: ['Pasame nombre y apellido, por favor.'] };
    }

    const knownEmailIdentity = data.emailIdentityFound
      ? { found: true, cliente: data.emailCliente || null }
      : { found: false, cliente: null };
    return finishRegisterFlow(
      { ...data, nombre },
      businessSettings,
      knownEmailIdentity
    );
  }

  if (state.step === 'ask_register_email') {
    const email = parseEmail(text);
    if (!email) {
      return { state, replies: ['Ese email no parece valido. Mandame uno tipo nombre@email.com.'] };
    }

    const emailIdentity = await identifyClientByEmail(email);
    const existingName = String(emailIdentity.cliente?.nombre || '').trim();

    if (emailIdentity.found && existingName) {
      return finishRegisterFlow(
        { ...data, email, nombre: existingName },
        businessSettings,
        emailIdentity
      );
    }

    return {
      state: buildState('ask_register_name', {
        ...data,
        email,
        emailIdentityFound: emailIdentity.found,
        emailCliente: emailIdentity.cliente || null
      }),
      replies: [emailIdentity.found
        ? 'Encontre el email, pero falta completar el nombre. Pasame tu nombre y apellido.'
        : 'No encontre ningun cliente con ese email. Para registrarte, pasame tu nombre y apellido.']
    };
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

    return {
      state: buildState('ask_start_time', { ...data, fecha }),
      replies: ['¿A qué hora querés comenzar? Por ejemplo: 18:00. Para cambiar la fecha, escribí "volver".']
    };
  }

  if (state.step === 'ask_start_time') {
    const requestedStartTime = parseRequestedTime(text);
    if (!requestedStartTime) {
      return {
        state,
        replies: ['No pude reconocer esa hora. Escribila, por ejemplo, como 18:00. Para cambiar la fecha, escribí "volver".']
      };
    }

    return askDisponibilidad({ ...data, requestedStartTime });
  }

  if (state.step === 'ask_slot') {
    const slot = parseChoice(text, data.slots || [], 'label');
    if (!slot) {
      const requestedStartTime = parseRequestedTime(text);
      if (requestedStartTime) {
        const alternativeSlots = await findAlternativeSlots(data, requestedStartTime);
        if (alternativeSlots.length) {
          return {
            state: buildState('ask_alternative_slot', { ...data, alternativeSlots }),
            replies: [[
              `Ese horario no está disponible en ${data.cancha.nombre}.`,
              `Para las ${requestedStartTime} encontré estas opciones en otras canchas:`,
              formatAlternativeSlots(alternativeSlots)
            ].join('\n')]
          };
        }
      }
      return { state, replies: [`Esa no es una de las opciones. Los horarios disponibles son:\n${formatSlots(data.slots || [])}`] };
    }

    if (data.availabilityOnly || data.deferRegistration) {
      const selectedData = { ...data, slot };
      const phone = data.phone || phoneFromJid(canonicalJid);
      if (!phone) {
        return {
          state: buildState('ask_phone', {
            ...selectedData,
            pushName,
            intent: 'reservation_after_availability'
          }),
          replies: [phoneRequestMessage('completar la reserva')]
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
      replies: [compactTerms(terminos), termsAcceptancePrompt()]
    };
  }

  if (state.step === 'ask_alternative_slot') {
    const alternative = parseChoice(text, data.alternativeSlots || [], 'label');
    if (!alternative) {
      return {
        state,
        replies: [`Esa no es una de las opciones. Los turnos alternativos son:\n${formatAlternativeSlots(data.alternativeSlots || [])}`]
      };
    }

    const selectedData = {
      ...data,
      cancha: alternative.cancha,
      slot: alternative,
      slots: [alternative],
      alternativeSlots: undefined
    };
    const phone = data.phone || phoneFromJid(canonicalJid);
    if (data.availabilityOnly || data.deferRegistration) {
      if (!phone) {
        return {
          state: buildState('ask_phone', {
            ...selectedData,
            pushName,
            intent: 'reservation_after_availability'
          }),
          replies: [phoneRequestMessage('completar la reserva')]
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
      tipo: Number(alternative.cancha?.duracion_fija) === 3 ? 'cumple' : 'turno',
      cancha: alternative.cancha?.id
    });
    return {
      state: buildState('ask_terms', { ...selectedData, terminos }),
      replies: [compactTerms(terminos), termsAcceptancePrompt()]
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
    const nombre = normalizePersonName(text);
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

    let reserva;
    try {
      reserva = await crearReserva({
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
    } catch (error) {
      if (isAvailabilityConflict(error)) {
        const alternativeSlots = await findAlternativeSlots(data, data.slot.inicio);
        if (alternativeSlots.length) {
          return {
            state: buildState('ask_alternative_slot', { ...data, alternativeSlots }),
            replies: [[
              `El horario de las ${data.slot.inicio} acaba de ocuparse en ${data.cancha.nombre}.`,
              'Está disponible en estas otras canchas:',
              formatAlternativeSlots(alternativeSlots)
            ].join('\n')]
          };
        }
      }
      throw error;
    }

    return {
      state: null,
      replies: [
        [
          reserva.mercadopago?.init_point
            ? 'Para confirmar tu reserva, accede al siguiente link y paga la seña:'
            : 'Tu reserva quedó pendiente de confirmación.',
          reserva.mercadopago?.init_point || '',
          'La reserva se confirmará únicamente cuando se acredite el pago.',
          reserva.mercadopago?.init_point
            ? 'Importante: el link de Mercado Pago permanecerá activo durante 10 minutos. Si no realizas el pago dentro de ese plazo, el turno se cancelará automáticamente y tendrás que solicitarlo nuevamente.'
            : ''
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
  return [
    'ask_register_name',
    'ask_register_email',
    'ask_register_match_phone',
    'ask_register_match_email'
  ].includes(state?.step) ||
    (state?.step === 'ask_phone' && state?.data?.intent === 'register');
}

export async function handleRegistrationFlow(input) {
  // El primer contacto siempre lo presenta el flujo principal. El modulo de
  // registro toma el control recien cuando ya existe un estado de registro.
  if (!input.state || (!isRegistrationState(input.state) && !hasRegisterIntent(input.text))) {
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
