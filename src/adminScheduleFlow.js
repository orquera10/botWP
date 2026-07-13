const ADMIN_TRIGGERS = ['agenda', 'ver turnos', 'todos los turnos', 'turnos del dia', 'turnos del día'];

function normalizeText(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(text) {
  const normalized = normalizeText(text);
  const today = new Date();
  if (normalized === 'hoy') return toIsoDate(today);
  if (normalized === 'manana') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return toIsoDate(tomorrow);
  }

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const local = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!local) return null;
  const year = local[3] ? Number(local[3].length === 2 ? `20${local[3]}` : local[3]) : today.getFullYear();
  const date = new Date(year, Number(local[2]) - 1, Number(local[1]));
  return Number.isNaN(date.getTime()) ? null : toIsoDate(date);
}

function isAdminIntent(text) {
  const normalized = normalizeText(text);
  return ADMIN_TRIGGERS.some((trigger) => normalized.includes(normalizeText(trigger)));
}

function formatAgenda(turnos) {
  return turnos.map((turno, index) => [
    `${index + 1}. ${turno.cancha || turno.recurso || 'Turno'}`,
    `${turno.hora_inicio || turno.hora || ''}${turno.hora_fin ? ` a ${turno.hora_fin}` : ''}`,
    turno.cliente?.nombre || turno.cliente_nombre || turno.nombre || '',
    turno.estado ? `Estado: ${turno.estado}` : ''
  ].filter(Boolean).join(' · ')).join('\n');
}

export async function handleAdminScheduleFlow({ state, text, reservasApi, businessName }) {
  const active = state?.step === 'ask_admin_date';
  if (!active && !isAdminIntent(text)) return { handled: false, state: null, replies: [] };

  if (!active) {
    return {
      handled: true,
      state: { step: 'ask_admin_date', updatedAt: new Date().toISOString() },
      replies: [`Agenda administrativa de ${businessName}. ¿Que fecha queres consultar? Responde hoy, mañana o DD/MM.`]
    };
  }

  const fecha = parseDate(text);
  if (!fecha) {
    return { handled: true, state, replies: ['No pude leer la fecha. Responde hoy, mañana, DD/MM o AAAA-MM-DD.'] };
  }

  try {
    const turnos = await reservasApi.consultarAgenda({ fecha });
    return {
      handled: true,
      state: null,
      replies: [turnos.length ? `Turnos del ${fecha}:\n${formatAgenda(turnos)}` : `No hay turnos registrados para el ${fecha}.`]
    };
  } catch (error) {
    return {
      handled: true,
      state: null,
      replies: [
        `No pude consultar la agenda de ${businessName}. La API debe implementar la accion administrativa configurada para listar todos los turnos por fecha.`
      ],
      error
    };
  }
}
