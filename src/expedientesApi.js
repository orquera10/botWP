function apiRoot(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/expedientes$/i, "");
}

function expedienteEndpoint(baseUrl, codigo, numero, anio) {
  return `${apiRoot(baseUrl)}/expedientes/${encodeURIComponent(codigo)}/${numero}/${anio}?limite=5`;
}

function usuarioEndpoint(baseUrl, telefono) {
  return `${apiRoot(baseUrl)}/usuarios/telefono/${encodeURIComponent(telefono)}`;
}

function salidaEndpoint(baseUrl, codigo, numero, anio) {
  return `${apiRoot(baseUrl)}/expedientes/${encodeURIComponent(codigo)}/${numero}/${anio}/salida`;
}

function entradaEndpoint(baseUrl, codigo, numero, anio) {
  return `${apiRoot(baseUrl)}/expedientes/${encodeURIComponent(codigo)}/${numero}/${anio}/entrada`;
}

async function request(url, apiKey, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "X-API-Key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
    async prepararSalida({ codigo, numero, anio, telefono }) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }
      const url = new URL(salidaEndpoint(baseUrl, codigo, numero, anio));
      url.searchParams.set("telefono", telefono);
      const { response, data } = await request(url.toString(), apiKey);
      if (!response.ok) {
        const error = new Error(data.error || `Error preparando salida (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
    async registrarSalida({ codigo, numero, anio, telefono, destino, motivo = "" }) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }
      const { response, data } = await request(
        salidaEndpoint(baseUrl, codigo, numero, anio),
        apiKey,
        {
          method: "POST",
          body: { telefono, destino, motivo },
        }
      );
      if (!response.ok) {
        const error = new Error(data.error || `Error registrando salida (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
    async prepararEntrada({ codigo, numero, anio, telefono }) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }
      const url = new URL(entradaEndpoint(baseUrl, codigo, numero, anio));
      url.searchParams.set("telefono", telefono);
      const { response, data } = await request(url.toString(), apiKey);
      if (!response.ok) {
        const error = new Error(data.error || `Error preparando entrada (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
    async registrarEntrada({ codigo, numero, anio, telefono, motivo = "" }) {
      if (!baseUrl || !apiKey) {
        throw new Error("Falta configurar la URL o la API key de expedientes.");
      }
      const { response, data } = await request(
        entradaEndpoint(baseUrl, codigo, numero, anio),
        apiKey,
        {
          method: "POST",
          body: { telefono, motivo },
        }
      );
      if (!response.ok) {
        const error = new Error(data.error || `Error registrando entrada (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    },
  };
}
