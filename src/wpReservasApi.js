const DEFAULT_BASE_URL = 'https://mediumslateblue-pony-524766.hostingersite.com/wp_reservas_api.php';

const baseUrl = process.env.WP_RESERVAS_API_URL || DEFAULT_BASE_URL;
const apiKey = process.env.WP_RESERVAS_API_KEY || process.env.API_KEY || '';

function buildUrl(action, params = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('action', action);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function request(action, { method = 'GET', params = {}, body = null } = {}) {
  if (!apiKey) {
    throw new Error('Falta configurar API_KEY o WP_RESERVAS_API_KEY.');
  }

  const response = await fetch(buildUrl(action, params), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: body ? JSON.stringify(body) : null
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Respuesta invalida de reservas (${response.status}): ${text.slice(0, 160)}`);
  }

  if (!response.ok || data.success === false) {
    const error = new Error(data.message || `Error de reservas (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function reservasApiConfigured() {
  return Boolean(baseUrl && apiKey);
}

export async function listarCanchas() {
  const data = await request('canchas');
  return data.canchas || [];
}

export async function listarTerminos({ tipo = 'turno', cancha } = {}) {
  const data = await request('terminos', { params: { tipo, cancha } });
  return data.terminos || [];
}

export async function consultarDisponibilidad({ fecha, cancha, duracion }) {
  const data = await request('disponibilidad', {
    params: { fecha, cancha, duracion }
  });

  return data.slots || [];
}

export async function consultarTurnos({ telefono, email, futuros = 1, limite = 5 }) {
  return request('turnos', {
    params: { telefono, email, futuros, limite }
  });
}

export async function crearReserva(payload) {
  return request('reservar', {
    method: 'POST',
    body: payload
  });
}
