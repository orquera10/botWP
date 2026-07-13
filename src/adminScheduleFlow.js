const TURNOS_TRIGGERS = ['agenda', 'turnos', 'ver turnos', 'todos los turnos', 'turnos del dia', 'turnos del día'];
const DAILY_TRIGGERS = ['informe diario', 'informe del dia', 'informe del día', 'reporte diario', 'resumen diario', 'caja', 'caja del dia', 'caja del día', 'balance diario'];
const MONTHLY_TRIGGERS = ['informe mensual', 'reporte mensual', 'resumen mensual', 'caja mensual', 'balance mensual'];
const MENU_TRIGGERS = ['hola', 'menu', 'menú'];

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

function validDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return toIsoDate(date);
}

function parseDate(text) {
  const normalized = normalizeText(text);
  const today = new Date();
  if (/\bhoy\b/.test(normalized)) return toIsoDate(today);
  if (/\bayer\b/.test(normalized)) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return toIsoDate(yesterday);
  }
  if (/\bmanana\b/.test(normalized)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return toIsoDate(tomorrow);
  }

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const local = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!local) return null;
  const year = local[3] ? Number(local[3].length === 2 ? `20${local[3]}` : local[3]) : today.getFullYear();
  return validDate(year, Number(local[2]), Number(local[1]));
}

function parseMonth(text) {
  const normalized = normalizeText(text);
  const today = new Date();
  if (/\b(este mes|mes actual)\b/.test(normalized)) {
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})\b/);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  }

  const local = normalized.match(/\b(\d{1,2})[/-](\d{4})\b/);
  if (local && Number(local[1]) >= 1 && Number(local[1]) <= 12) {
    return `${local[2]}-${local[1].padStart(2, '0')}`;
  }

  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthIndex = months.findIndex((month) => new RegExp(`\\b${month}\\b`).test(normalized));
  if (monthIndex === -1) return null;
  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  return `${yearMatch?.[1] || today.getFullYear()}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function hasTrigger(text, triggers) {
  const normalized = normalizeText(text);
  return triggers.some((trigger) => normalized.includes(normalizeText(trigger)));
}

function detectIntent(text) {
  const normalized = normalizeText(text);
  if (normalized === '1') return 'turnos';
  if (normalized === '2') return 'daily';
  if (normalized === '3') return 'monthly';
  if (hasTrigger(text, MONTHLY_TRIGGERS)) return 'monthly';
  if (hasTrigger(text, DAILY_TRIGGERS)) return 'daily';
  if (hasTrigger(text, TURNOS_TRIGGERS)) return 'turnos';
  return null;
}

function isMenuIntent(text) {
  const normalized = normalizeText(text);
  return MENU_TRIGGERS.some((trigger) => normalized === normalizeText(trigger));
}

function adminMenu(businessName) {
  return [
    `Menú administrativo de ${businessName}:`,
    'Respondé con 1, 2 o 3.',
    '',
    '1. Ver turnos',
    '   Escribí: agenda hoy',
    '',
    '2. Informe diario',
    '   Escribí: informe diario hoy',
    '',
    '3. Informe mensual',
    '   Escribí: informe mensual este mes',
    '',
    'También podés escribir menú para volver a estas opciones.'
  ].join('\n');
}

function money(value) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function formatAgenda(turnos) {
  const visible = turnos.slice(0, 25);
  const lines = visible.map((turno, index) => {
    const cancha = turno.cancha?.nombre || turno.cancha || turno.recurso || 'Turno';
    const cliente = turno.cliente?.nombre || turno.cliente_nombre || turno.nombre || 'Sin cliente';
    const horario = `${turno.hora_inicio || turno.hora || ''}${turno.hora_fin ? ` a ${turno.hora_fin}` : ''}`;
    const saldo = Number(turno.saldo_pendiente) > 0 ? `Saldo: ${money(turno.saldo_pendiente)}` : '';
    return [
      `${index + 1}. ${cancha}`,
      horario,
      cliente,
      turno.estado ? `Estado: ${turno.estado}` : '',
      saldo
    ].filter(Boolean).join(' · ');
  });

  if (turnos.length > visible.length) lines.push(`…y ${turnos.length - visible.length} turnos más.`);
  return lines.join('\n');
}

function formatDailyReport(data) {
  const resumen = data.resumen || {};
  return [
    `Informe diario del ${data.fecha}:`,
    `Ingresos cobrados: ${money(resumen.ingresos_cobrados)}`,
    `Egresos: ${money(resumen.egresos)}`,
    `Resultado neto: ${money(resumen.resultado_neto)}`,
    '',
    `Ventas finalizadas: ${data.ventas?.cantidad || 0}`,
    `Señas recibidas: ${data.senias?.cantidad || 0} (${money(data.senias?.totales?.total)})`,
    `Gastos: ${data.gastos?.cantidad || 0} (${money(data.gastos?.totales?.total)})`,
    `Efectivo al finalizar: ${money(data.ventas?.totales?.efectivo)}`,
    `Transferencias al finalizar: ${money(data.ventas?.totales?.transferencia)}`
  ].join('\n');
}

function formatMonthlyReport(data) {
  const resumen = data.resumen || {};
  const courts = (data.ventas?.por_cancha || []).map((item) =>
    `• ${item.cancha}: ${item.cantidad || 0} ventas · ${money(item.facturado)}`
  );
  return [
    `Informe mensual ${data.mes}:`,
    `Ingresos cobrados: ${money(resumen.ingresos_cobrados)}`,
    `Egresos: ${money(resumen.egresos)}`,
    `Resultado neto: ${money(resumen.resultado_neto)}`,
    '',
    `Ventas: ${data.ventas?.totales?.cantidad || 0} · Facturado: ${money(data.ventas?.totales?.facturado)}`,
    `Señas: ${data.senias?.totales?.cantidad || 0} · ${money(data.senias?.totales?.total)}`,
    `Gastos generales: ${data.gastos?.cantidad || 0} · ${money(data.gastos?.total)}`,
    `Servicios: ${data.gastos_servicios?.cantidad || 0} · ${money(data.gastos_servicios?.total)}`,
    `Pagos a empleados: ${data.pagos_empleados?.cantidad || 0} · ${money(data.pagos_empleados?.total)}`,
    ...(courts.length ? ['', 'Por cancha:', ...courts] : [])
  ].join('\n');
}

function promptFor(type, businessName) {
  if (type === 'monthly') {
    return `Informe mensual de ${businessName}. ¿Qué mes querés consultar? Respondé este mes, AAAA-MM, MM/AAAA o el nombre del mes.`;
  }
  const label = type === 'daily' ? 'Informe diario' : 'Agenda administrativa';
  return `${label} de ${businessName}. ¿Qué fecha querés consultar? Respondé hoy, ayer, mañana, DD/MM o AAAA-MM-DD.`;
}

async function runQuery(type, period, reservasApi, businessName) {
  try {
    if (type === 'daily') {
      const data = await reservasApi.consultarInformeDiario({ fecha: period });
      return { handled: true, state: null, replies: [formatDailyReport(data)] };
    }
    if (type === 'monthly') {
      const data = await reservasApi.consultarInformeMensual({ mes: period });
      return { handled: true, state: null, replies: [formatMonthlyReport(data)] };
    }

    const turnos = await reservasApi.consultarAgenda({ fecha: period });
    return {
      handled: true,
      state: null,
      replies: [turnos.length ? `Turnos del ${period}:\n${formatAgenda(turnos)}` : `No hay turnos registrados para el ${period}.`]
    };
  } catch (error) {
    const label = type === 'monthly' ? 'el informe mensual' : type === 'daily' ? 'el informe diario' : 'la agenda';
    return {
      handled: true,
      state: null,
      replies: [`No pude consultar ${label} de ${businessName}. Intentá nuevamente en unos minutos.`],
      error
    };
  }
}

export async function handleAdminScheduleFlow({ state, text, reservasApi, businessName }) {
  if (isMenuIntent(text)) {
    return { handled: true, state: null, replies: [adminMenu(businessName)] };
  }

  const legacyActive = state?.step === 'ask_admin_date';
  const active = legacyActive || state?.step === 'ask_admin_period';
  const type = legacyActive ? 'turnos' : state?.reportType || detectIntent(text);
  if (!active && !type) return { handled: false, state: null, replies: [] };

  if (active && /\b(cancelar|salir)\b/.test(normalizeText(text))) {
    return { handled: true, state: null, replies: ['Consulta administrativa cancelada.'] };
  }

  const period = type === 'monthly' ? parseMonth(text) : parseDate(text);
  if (period) return runQuery(type, period, reservasApi, businessName);

  if (!active) {
    return {
      handled: true,
      state: { step: 'ask_admin_period', reportType: type, updatedAt: new Date().toISOString() },
      replies: [promptFor(type, businessName)]
    };
  }

  return {
    handled: true,
    state,
    replies: [type === 'monthly'
      ? 'No pude leer el mes. Respondé este mes, AAAA-MM, MM/AAAA o, por ejemplo, julio 2026.'
      : 'No pude leer la fecha. Respondé hoy, ayer, mañana, DD/MM o AAAA-MM-DD.']
  };
}
