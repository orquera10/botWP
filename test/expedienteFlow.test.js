import test from "node:test";
import assert from "node:assert/strict";
import { handleExpedienteFlow, parseExpedienteKey } from "../src/expedienteFlow.js";

const sample = {
  expediente: { codigo: "769", numero: "1234", anio: 2026, tipo: "Otro", asunto: "Prueba", iniciador: "Mesa", beneficiario: null, fechainicio: "2026-08-18", fojas: 2, caja: "1" },
  movimientos: [{ fechamov: "2026-08-18", origen: "Mesa", destino: "Archivo", motivo: "Ingreso" }],
};

test("acepta una clave completa", () => {
  assert.deepEqual(parseExpedienteKey("769-1234-2026"), { codigo: "769", numero: 1234, anio: 2026 });
  assert.deepEqual(parseExpedienteKey("769/1234/2026"), { codigo: "769", numero: 1234, anio: 2026 });
  assert.deepEqual(parseExpedienteKey("769 220 2026"), { codigo: "769", numero: 220, anio: 2026 });
  assert.deepEqual(parseExpedienteKey("expediente 769 220 2026"), { codigo: "769", numero: 220, anio: 2026 });
  assert.deepEqual(parseExpedienteKey("expedientes: 769 220 2026"), { codigo: "769", numero: 220, anio: 2026 });
});

test("hola muestra el menu de expedientes", async () => {
  const result = await handleExpedienteFlow({ text: "hola", expedientesApi: {} });

  assert.equal(result.handled, true);
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Menú principal/);
  assert.match(result.replies[0], /1.*Consulta de expediente/);
  assert.match(result.replies[0], /2.*Dar salida/);
  assert.match(result.replies[0], /3.*Dar entrada/);
});

test("la opcion 1 inicia la consulta guiada", async () => {
  const menu = await handleExpedienteFlow({ text: "hola", expedientesApi: {} });
  const result = await handleExpedienteFlow({ currentState: menu.state, text: "1", expedientesApi: {} });

  assert.equal(result.state.step, "ask_codigo");
  assert.match(result.replies[0], /Ingresá el código/);
  assert.match(result.replies[0], /769 220 2026/);
});

test("una pregunta ajena vuelve al menu principal", async () => {
  const result = await handleExpedienteFlow({ text: "como esta el clima", expedientesApi: {} });

  assert.equal(result.handled, true);
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Menú principal/);
});

test("una opcion desconocida vuelve a mostrar el menu principal", async () => {
  const menu = await handleExpedienteFlow({ text: "hola", expedientesApi: {} });
  const result = await handleExpedienteFlow({ currentState: menu.state, text: "quiero otra cosa", expedientesApi: {} });

  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /1.*Consulta de expediente/);
});

test("consulta directamente con los tres datos separados por espacios", async () => {
  let receivedKey = null;
  const result = await handleExpedienteFlow({
    text: "769 220 2026",
    expedientesApi: {
      consultar: async (key) => {
        receivedKey = key;
        return sample;
      }
    }
  });

  assert.deepEqual(receivedKey, { codigo: "769", numero: 220, anio: 2026 });
  assert.equal(result.handled, true);
  assert.equal(result.state.step, "menu");
});

test("guía código, número y año y consulta la API", async () => {
  const api = { consultar: async (key) => ({ ...sample, key }) };
  const start = await handleExpedienteFlow({ text: "hola", expedientesApi: api });
  const selected = await handleExpedienteFlow({ currentState: start.state, text: "1", expedientesApi: api });
  assert.equal(selected.state.step, "ask_codigo");
  const code = await handleExpedienteFlow({ currentState: selected.state, text: "769", expedientesApi: api });
  const number = await handleExpedienteFlow({ currentState: code.state, text: "1234", expedientesApi: api });
  const result = await handleExpedienteFlow({ currentState: number.state, text: "2026", expedientesApi: api });
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Expediente 769-1234\/2026/);
  assert.match(result.replies[0], /Mesa → Archivo/);
});

test("da salida a un expediente solo despues de confirmar", async () => {
  let registered = null;
  const api = {
    prepararSalida: async (data) => ({
      expediente: { codigo: data.codigo, numero: data.numero, anio: data.anio, asunto: "Compra de equipos" },
      origen: { codigosector: "10", sector: "Mesa de entradas" },
      destinos: [
        { codigosector: "20", sector: "Contaduria" },
        { codigosector: "30", sector: "Archivo" },
      ],
    }),
    registrarSalida: async (data) => {
      registered = data;
      return {
        origen: { sector: "Mesa de entradas" },
        destino: { sector: "Archivo" },
        movimiento: { movimiento: 8 },
      };
    },
  };
  const base = { expedientesApi: api, authorizedPhone: "5493884104530" };

  const menu = await handleExpedienteFlow({ ...base, text: "hola" });
  const start = await handleExpedienteFlow({ ...base, currentState: menu.state, text: "2" });
  assert.equal(start.state.step, "ask_salida_clave");

  const prepared = await handleExpedienteFlow({ ...base, currentState: start.state, text: "769 220 2026" });
  assert.equal(prepared.state.step, "ask_salida_destino");
  assert.match(prepared.replies[0], /2\. 30 - Archivo/);

  const destination = await handleExpedienteFlow({ ...base, currentState: prepared.state, text: "2" });
  assert.equal(destination.state.step, "ask_salida_motivo");

  const reason = await handleExpedienteFlow({ ...base, currentState: destination.state, text: "Pase para archivo" });
  assert.equal(reason.state.step, "confirm_salida");
  assert.equal(registered, null);

  const result = await handleExpedienteFlow({ ...base, currentState: reason.state, text: "CONFIRMAR" });
  assert.deepEqual(registered, {
    codigo: "769",
    numero: 220,
    anio: 2026,
    telefono: "5493884104530",
    destino: "30",
    motivo: "Pase para archivo",
  });
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Salida registrada correctamente/);
  assert.match(result.replies[0], /Destino: Archivo/);
});

test("da entrada a un expediente en el sector del usuario solo despues de confirmar", async () => {
  let registered = null;
  const api = {
    prepararEntrada: async (data) => ({
      expediente: { codigo: data.codigo, numero: data.numero, anio: data.anio, asunto: "Compra de equipos" },
      movimientoActual: { estado: "S", origen: "Contaduria", destino: "Archivo" },
      sector: { codigosector: "30", sector: "Archivo" },
    }),
    registrarEntrada: async (data) => {
      registered = data;
      return {
        sector: { sector: "Archivo" },
        movimiento: { movimiento: 9 },
      };
    },
  };
  const base = { expedientesApi: api, authorizedPhone: "5493884104530" };

  const menu = await handleExpedienteFlow({ ...base, text: "hola" });
  const start = await handleExpedienteFlow({ ...base, currentState: menu.state, text: "3" });
  assert.equal(start.state.step, "ask_entrada_clave");

  const prepared = await handleExpedienteFlow({ ...base, currentState: start.state, text: "769 220 2026" });
  assert.equal(prepared.state.step, "ask_entrada_motivo");
  assert.match(prepared.replies[0], /Entrada en: Archivo/);

  const reason = await handleExpedienteFlow({ ...base, currentState: prepared.state, text: "Recibido" });
  assert.equal(reason.state.step, "confirm_entrada");
  assert.equal(registered, null);

  const result = await handleExpedienteFlow({ ...base, currentState: reason.state, text: "CONFIRMAR" });
  assert.deepEqual(registered, {
    codigo: "769",
    numero: 220,
    anio: 2026,
    telefono: "5493884104530",
    motivo: "Recibido",
  });
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Entrada registrada correctamente/);
  assert.match(result.replies[0], /Sector: Archivo/);
});

test("informa cuando el expediente no existe", async () => {
  const error = Object.assign(new Error("No encontrado"), { status: 404 });
  const result = await handleExpedienteFlow({ text: "769-1-2026", expedientesApi: { consultar: async () => { throw error; } } });
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /No encontré/);
  assert.match(result.replies[1], /Menú principal/);
});

test("confirma cuando el telefono de WhatsApp queda asociado y autorizado", async () => {
  const result = await handleExpedienteFlow({
    text: "388 410-4530",
    expedientesApi: {},
    justLinkedPhone: true,
    authorizedUser: { nombre: "Juan" }
  });

  assert.equal(result.handled, true);
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Listo, Juan/);
  assert.match(result.replies[0], /numero quedo asociado y autorizado/i);
  assert.match(result.replies[1], /1.*Consulta de expediente/);
});
