import dns from 'node:dns';
import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_BASE_URL = 'https://mediumslateblue-pony-524766.hostingersite.com/wp_reservas_api.php';

const defaultConfig = {
  baseUrl: process.env.WP_RESERVAS_API_URL || DEFAULT_BASE_URL,
  apiKey: process.env.WP_RESERVAS_API_KEY || process.env.API_KEY || ''
};
const apiContext = new AsyncLocalStorage();

dns.setDefaultResultOrder?.('ipv4first');

function buildUrl(baseUrl, action, params = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('action', action);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function request(config, action, { method = 'GET', params = {}, body = null } = {}) {
  const { baseUrl, apiKey } = config;
  if (!apiKey) {
    throw new Error('Falta configurar API_KEY o WP_RESERVAS_API_KEY.');
  }

  const url = buildUrl(baseUrl, action, params);
  let response;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey
        },
        body: body ? JSON.stringify(body) : null
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

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

export function createReservasApi(config = {}) {
  const resolvedConfig = {
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || ''
  };

  return {
    configured: () => Boolean(resolvedConfig.baseUrl && resolvedConfig.apiKey),
    async listarCanchas() {
      const data = await request(resolvedConfig, 'canchas');
      return data.canchas || [];
    },
    async listarTerminos({ tipo = 'turno', cancha } = {}) {
      const data = await request(resolvedConfig, 'terminos', { params: { tipo, cancha } });
      return data.terminos || [];
    },
    async consultarDisponibilidad({ fecha, cancha, duracion }) {
      const data = await request(resolvedConfig, 'disponibilidad', {
        params: { fecha, cancha, duracion }
      });
      return data.slots || [];
    },
    consultarTurnos({ telefono, email, futuros = 1, limite = 5 }) {
      return request(resolvedConfig, 'turnos', {
        params: { telefono, email, futuros, limite }
      });
    },
    consultarCliente({ telefono, email }) {
      return request(resolvedConfig, 'cliente', { params: { telefono, email } });
    },
    crearCliente({ nombre, email, telefono }) {
      return request(resolvedConfig, 'crear_cliente', {
        method: 'POST',
        body: { nombre, email, telefono }
      });
    },
    crearReserva(payload) {
      return request(resolvedConfig, 'reservar', { method: 'POST', body: payload });
    }
  };
}

const defaultApi = createReservasApi(defaultConfig);
const activeApi = () => apiContext.getStore() || defaultApi;

export function withReservasApi(api, callback) {
  return apiContext.run(api || defaultApi, callback);
}

export const reservasApiConfigured = () => activeApi().configured();
export const listarCanchas = (...args) => activeApi().listarCanchas(...args);
export const listarTerminos = (...args) => activeApi().listarTerminos(...args);
export const consultarDisponibilidad = (...args) => activeApi().consultarDisponibilidad(...args);
export const consultarTurnos = (...args) => activeApi().consultarTurnos(...args);
export const consultarCliente = (...args) => activeApi().consultarCliente(...args);
export const crearCliente = (...args) => activeApi().crearCliente(...args);
export const crearReserva = (...args) => activeApi().crearReserva(...args);
