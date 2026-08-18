function apiRoot(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/expedientes$/i, "");
}

function expedienteEndpoint(baseUrl, codigo, numero, anio) {
  return `${apiRoot(baseUrl)}/expedientes/${encodeURIComponent(codigo)}/${numero}/${anio}?limite=5`;
}

function usuarioEndpoint(baseUrl, telefono) {
  return `${apiRoot(baseUrl)}/usuarios/telefono/${encodeURIComponent(telefono)}`;
}

async function request(url, apiKey) {
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Respuesta invalida de expedientes (${response.status}).`);
  }
  return { response, data };
}

export function createExpedientesApi({ baseUrl = "", apiKey = "" } = {}) {
  return {
    configured: () => Boolean(baseUrl && apiKey),
    async autorizarTelefono(telefono) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }
      const { response, data } = await request(usuarioEndpoint(baseUrl, telefono), apiKey);
      if (response.status === 404) return { autorizado: false };
      if (!response.ok) {
        const error = new Error(data.error || `Error de usuarios (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
    async consultar({ codigo, numero, anio }) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }

      const { response, data } = await request(
        expedienteEndpoint(baseUrl, codigo, numero, anio),
        apiKey
      );

      if (!response.ok) {
        const error = new Error(data.error || `Error de expedientes (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
  };
}
