const CANCEL_WORDS = new Set(["cancelar", "salir", "fin"]);
const MENU_WORDS = new Set(["menu", "menú", "hola", "inicio", "expediente", "expedientes", "expte"]);
const MAIN_MENU_MESSAGE = "📋 *Menú principal*\n\n*1* - Consulta de expediente\n*2* - Dar salida a un expediente\n*3* - Dar entrada a un expediente\n\nRespondé con el número de opción.";

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function state(step, data = {}) {
  return { step, data, updatedAt: new Date().toISOString() };
}

function mainMenu(replies = []) {
  return {
    handled: true,
    state: state("menu"),
    replies: [...replies, MAIN_MENU_MESSAGE]
  };
}

function parsePositiveInteger(value) {
  if (!/^\d+$/.test(String(value || "").trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseExpedienteKey(value) {
  const input = String(value || "")
    .trim()
    .replace(/^(?:expedientes?|expte)\s*[:#-]?\s+/i, "");
  const separator = "(?:\\s*[-/]\\s*|\\s+)";
  const match = input.match(new RegExp(`^([a-zA-Z0-9]+)${separator}(\\d+)${separator}(\\d{1,4})$`));
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
        MAIN_MENU_MESSAGE,
      ],
    };
  } catch (error) {
    if (error.status === 404) {
      return mainMenu(["No encontré ese expediente. Revisá los datos e intentá nuevamente."]);
    }
    return {
      ...mainMenu(["No pude consultar expedientes en este momento. Intentá nuevamente más tarde."]),
      error,
    };
  }
}

function salidaKeyPrompt() {
  return "📤 *Dar salida a un expediente*\nIngresá código, número y año juntos.\nPor ejemplo: *769 220 2026*.";
}

function formatDestinos(destinos) {
  return destinos
    .map((sector, index) => `${index + 1}. ${clean(sector.sector)}`)
    .join("\n");
}

async function prepareSalida(key, expedientesApi, authorizedPhone) {
  try {
    const result = await expedientesApi.prepararSalida({ ...key, telefono: authorizedPhone });
    const destinos = Array.isArray(result.destinos) ? result.destinos : [];
    if (!destinos.length) {
      return mainMenu(["No hay sectores de destino habilitados para registrar la salida."]);
    }
    return {
      handled: true,
      state: state("ask_salida_destino", {
        key,
        expediente: result.expediente,
        origen: result.origen,
        destinos: destinos.map(({ codigosector, sector }) => ({ codigosector, sector })),
      }),
      replies: [
        `📄 *Expediente ${key.codigo}-${key.numero}/${key.anio}*\n` +
          `Asunto: ${clean(result.expediente?.asunto)}\n` +
          `Origen: ${clean(result.origen?.sector)}\n\n` +
          `Elegí el sector de destino:\n${formatDestinos(destinos)}`
      ]
    };
  } catch (error) {
    return {
      ...mainMenu([error.message || "No se pudo preparar la salida del expediente."]),
      error,
    };
  }
}

async function registerSalida(data, expedientesApi, authorizedPhone) {
  try {
    const result = await expedientesApi.registrarSalida({
      ...data.key,
      telefono: authorizedPhone,
      destino: data.destino.codigosector,
      motivo: data.motivo,
    });
    return mainMenu([
      `✅ *Salida registrada correctamente*\n` +
      `Expediente: ${data.key.codigo}-${data.key.numero}/${data.key.anio}\n` +
      `Origen: ${clean(result.origen?.sector || data.origen?.sector)}\n` +
      `Destino: ${clean(result.destino?.sector || data.destino?.sector)}\n` +
      `Movimiento: ${clean(result.movimiento?.movimiento)}`
    ]);
  } catch (error) {
    return {
      ...mainMenu([error.message || "No se pudo registrar la salida del expediente."]),
      error,
    };
  }
}

function entradaKeyPrompt() {
  return "📥 *Dar entrada a un expediente*\nIngresá código, número y año juntos.\nPor ejemplo: *769 220 2026*.";
}

async function prepareEntrada(key, expedientesApi, authorizedPhone) {
  try {
    const result = await expedientesApi.prepararEntrada({ ...key, telefono: authorizedPhone });
    return {
      handled: true,
      state: state("ask_entrada_motivo", {
        key,
        expediente: result.expediente,
        movimientoActual: result.movimientoActual,
        sector: result.sector,
      }),
      replies: [
        `📄 *Expediente ${key.codigo}-${key.numero}/${key.anio}*\n` +
        `Asunto: ${clean(result.expediente?.asunto)}\n` +
        `Procedencia: ${clean(result.movimientoActual?.origen)}\n` +
        `Entrada en: ${clean(result.sector?.sector)}\n\n` +
        "Escribí el motivo de la entrada o respondé *0* para continuar sin motivo."
      ]
    };
  } catch (error) {
    return {
      ...mainMenu([error.message || "No se pudo preparar la entrada del expediente."]),
      error,
    };
  }
}

async function registerEntrada(data, expedientesApi, authorizedPhone) {
  try {
    const result = await expedientesApi.registrarEntrada({
      ...data.key,
      telefono: authorizedPhone,
      motivo: data.motivo,
    });
    return mainMenu([
      `✅ *Entrada registrada correctamente*\n` +
      `Expediente: ${data.key.codigo}-${data.key.numero}/${data.key.anio}\n` +
      `Sector: ${clean(result.sector?.sector || data.sector?.sector)}\n` +
      `Movimiento: ${clean(result.movimiento?.movimiento)}`
    ]);
  } catch (error) {
    return {
      ...mainMenu([error.message || "No se pudo registrar la entrada del expediente."]),
      error,
    };
  }
}

export async function handleExpedienteFlow({
  currentState = null,
  text,
  expedientesApi,
  justLinkedPhone = false,
  authorizedUser = null,
  authorizedPhone = ""
}) {
  const input = String(text || "").trim();
  const normalized = normalize(input);
  const directKey = parseExpedienteKey(input);

  if (justLinkedPhone) {
    const name = String(authorizedUser?.nombre || "").trim();
    return mainMenu([
      `${name ? `Listo, ${name}.` : "Listo."} Tu numero quedo asociado y autorizado.`
    ]);
  }

  if (CANCEL_WORDS.has(normalized)) {
    return mainMenu(["Operación cancelada."]);
  }

  if (!currentState) {
    if (directKey) return consult(directKey, expedientesApi);
    return mainMenu();
  }

  if (MENU_WORDS.has(normalized)) {
    return mainMenu();
  }

  if (currentState.step === "ask_salida_clave") {
    if (!directKey) {
      return { handled: true, state: currentState, replies: [salidaKeyPrompt()] };
    }
    return prepareSalida(directKey, expedientesApi, authorizedPhone);
  }
  if (currentState.step === "ask_salida_destino") {
    const selection = parsePositiveInteger(input);
    const destino = selection ? currentState.data.destinos?.[selection - 1] : null;
    if (!destino) {
      return {
        handled: true,
        state: currentState,
        replies: [`Elegí una opción válida:\n${formatDestinos(currentState.data.destinos || [])}`]
      };
    }
    return {
      handled: true,
      state: state("ask_salida_motivo", { ...currentState.data, destino }),
      replies: [
        `Destino seleccionado: *${clean(destino.sector)}*.\n` +
        "Escribí el motivo de la salida o respondé *0* para continuar sin motivo."
      ]
    };
  }
  if (currentState.step === "ask_salida_motivo") {
    if (!input) {
      return { handled: true, state: currentState, replies: ["Ingresá un motivo o respondé *0*."] };
    }
    const motivo = input === "0" ? "" : input;
    const data = { ...currentState.data, motivo };
    return {
      handled: true,
      state: state("confirm_salida", data),
      replies: [
        `⚠️ *Confirmar salida*\n` +
        `Expediente: ${data.key.codigo}-${data.key.numero}/${data.key.anio}\n` +
        `Origen: ${clean(data.origen?.sector)}\n` +
        `Destino: ${clean(data.destino?.sector)}\n` +
        `Motivo: ${clean(motivo, "Sin motivo")}\n\n` +
        "Respondé *CONFIRMAR* para registrar la salida o *CANCELAR* para volver al menú."
      ]
    };
  }
  if (currentState.step === "confirm_salida") {
    if (normalized === "confirmar") {
      return registerSalida(currentState.data, expedientesApi, authorizedPhone);
    }
    return mainMenu(["Salida cancelada."]);
  }

  if (currentState.step === "ask_entrada_clave") {
    if (!directKey) {
      return { handled: true, state: currentState, replies: [entradaKeyPrompt()] };
    }
    return prepareEntrada(directKey, expedientesApi, authorizedPhone);
  }
  if (currentState.step === "ask_entrada_motivo") {
    if (!input) {
      return { handled: true, state: currentState, replies: ["Ingresá un motivo o respondé *0*."] };
    }
    const motivo = input === "0" ? "" : input;
    const data = { ...currentState.data, motivo };
    return {
      handled: true,
      state: state("confirm_entrada", data),
      replies: [
        `⚠️ *Confirmar entrada*\n` +
        `Expediente: ${data.key.codigo}-${data.key.numero}/${data.key.anio}\n` +
        `Sector: ${clean(data.sector?.sector)}\n` +
        `Motivo: ${clean(motivo, "Sin motivo")}\n\n` +
        "Respondé *CONFIRMAR* para registrar la entrada o *CANCELAR* para volver al menú."
      ]
    };
  }
  if (currentState.step === "confirm_entrada") {
    if (normalized === "confirmar") {
      return registerEntrada(currentState.data, expedientesApi, authorizedPhone);
    }
    return mainMenu(["Entrada cancelada."]);
  }

  if (directKey) return consult(directKey, expedientesApi);

  if (currentState.step === "menu") {
    if (normalized === "1") {
      return {
        handled: true,
        state: state("ask_codigo"),
        replies: [
          "📂 *Consulta de expediente*\nIngresá el código. Por ejemplo: *769*.\n\nTambién podés enviar los datos juntos como *769 220 2026*."
        ]
      };
    }
    if (normalized === "2") {
      return {
        handled: true,
        state: state("ask_salida_clave"),
        replies: [salidaKeyPrompt()]
      };
    }
    if (normalized === "3") {
      return {
        handled: true,
        state: state("ask_entrada_clave"),
        replies: [entradaKeyPrompt()]
      };
    }
    return mainMenu();
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

  return mainMenu();
}
