const CANCEL_WORDS = new Set(["cancelar", "salir", "fin"]);
const MENU_WORDS = new Set(["menu", "menú", "hola", "inicio", "expediente", "expte"]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function state(step, data = {}) {
  return { step, data, updatedAt: new Date().toISOString() };
}

function parsePositiveInteger(value) {
  if (!/^\d+$/.test(String(value || "").trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseExpedienteKey(value) {
  const match = String(value || "").trim().match(/^([a-zA-Z0-9]+)\s*[-/]\s*(\d+)\s*[-/]\s*(\d{1,4})$/);
  if (!match) return null;
  return { codigo: match[1], numero: Number(match[2]), anio: Number(match[3]) };
}

function formatDate(value) {
  if (!value) return "Sin fecha";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("es-AR", { timeZone: "UTC" }).format(date);
}

function clean(value, fallback = "No informado", max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatExpedienteResult(result) {
  const expediente = result.expediente;
  const movimientos = Array.isArray(result.movimientos) ? result.movimientos.slice(0, 3) : [];
  const lines = [
    `📄 *Expediente ${expediente.codigo}-${expediente.numero}/${expediente.anio}*`,
    `Tipo: ${clean(expediente.tipo)}`,
    `Asunto: ${clean(expediente.asunto)}`,
    `Iniciador: ${clean(expediente.iniciador)}`,
    `Beneficiario: ${clean(expediente.beneficiario)}`,
    `Fecha de inicio: ${formatDate(expediente.fechainicio)}`,
    `Fojas: ${clean(expediente.fojas)}`,
    `Caja: ${clean(expediente.caja)}`,
  ];

  if (!movimientos.length) {
    lines.push("", "No tiene movimientos habilitados.");
  } else {
    lines.push("", `📍 *Últimos movimientos (${movimientos.length})*`);
    movimientos.forEach((movimiento, index) => {
      lines.push(
        `${index + 1}. ${formatDate(movimiento.fechamov)} · ${clean(movimiento.origen)} → ${clean(movimiento.destino)}`,
        `   Motivo: ${clean(movimiento.motivo, "No informado", 180)}`
      );
    });
  }
  return lines.join("\n");
}

async function consult(key, expedientesApi) {
  try {
    const result = await expedientesApi.consultar(key);
    return {
      handled: true,
      state: state("menu"),
      replies: [
        formatExpedienteResult(result),
        'Responde *1* para consultar otro expediente o *2* para finalizar.',
      ],
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        handled: true,
        state: state("ask_codigo"),
        replies: ["No encontré ese expediente. Revisá los datos e ingresá nuevamente el código."],
      };
    }
    return {
      handled: true,
      state: null,
      replies: ["No pude consultar expedientes en este momento. Intentá nuevamente más tarde."],
      error,
    };
  }
}

export async function handleExpedienteFlow({ currentState = null, text, expedientesApi }) {
  const input = String(text || "").trim();
  const normalized = normalize(input);
  const directKey = parseExpedienteKey(input);

  if (CANCEL_WORDS.has(normalized)) {
    return { handled: true, state: null, replies: ["Consulta finalizada."] };
  }
  if (directKey) return consult(directKey, expedientesApi);

  if (!currentState) {
    if (!MENU_WORDS.has(normalized) && !/consult(ar|a).*expediente/.test(normalized)) {
      return { handled: false, state: null, replies: [] };
    }
    return {
      handled: true,
      state: state("ask_codigo"),
      replies: [
        "📂 *Consulta de expedientes*\nIngresá el código del expediente. Por ejemplo: *769*.\n\nTambién podés enviar los datos juntos como *769-1234-2026*.",
      ],
    };
  }

  if (MENU_WORDS.has(normalized)) {
    return { handled: true, state: state("ask_codigo"), replies: ["Ingresá el código del expediente."] };
  }
  if (currentState.step === "menu") {
    if (normalized === "1") {
      return { handled: true, state: state("ask_codigo"), replies: ["Ingresá el código del expediente."] };
    }
    if (normalized === "2") {
      return { handled: true, state: null, replies: ["Consulta finalizada."] };
    }
    return { handled: true, state: currentState, replies: ["Respondé *1* para otra consulta o *2* para finalizar."] };
  }
  if (currentState.step === "ask_codigo") {
    if (!/^[a-zA-Z0-9]+$/.test(input)) {
      return { handled: true, state: currentState, replies: ["El código no es válido. Ingresá solo letras o números."] };
    }
    return { handled: true, state: state("ask_numero", { codigo: input }), replies: ["Ahora ingresá el número del expediente."] };
  }
  if (currentState.step === "ask_numero") {
    const numero = parsePositiveInteger(input);
    if (!numero) return { handled: true, state: currentState, replies: ["El número no es válido. Ingresá un número mayor que cero."] };
    return { handled: true, state: state("ask_anio", { ...currentState.data, numero }), replies: ["Por último, ingresá el año del expediente."] };
  }
  if (currentState.step === "ask_anio") {
    if (!/^\d{1,4}$/.test(input)) {
      return { handled: true, state: currentState, replies: ["El año no es válido. Por ejemplo: *2026*."] };
    }
    return consult({ ...currentState.data, anio: Number(input) }, expedientesApi);
  }

  return { handled: true, state: state("ask_codigo"), replies: ["Ingresá el código del expediente."] };
}
