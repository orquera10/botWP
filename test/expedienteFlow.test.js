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
  assert.doesNotMatch(result.replies[0], /\*2\*/);
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
