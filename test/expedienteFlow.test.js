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
});

test("guía código, número y año y consulta la API", async () => {
  const api = { consultar: async (key) => ({ ...sample, key }) };
  const start = await handleExpedienteFlow({ text: "hola", expedientesApi: api });
  assert.equal(start.state.step, "ask_codigo");
  const code = await handleExpedienteFlow({ currentState: start.state, text: "769", expedientesApi: api });
  const number = await handleExpedienteFlow({ currentState: code.state, text: "1234", expedientesApi: api });
  const result = await handleExpedienteFlow({ currentState: number.state, text: "2026", expedientesApi: api });
  assert.equal(result.state.step, "menu");
  assert.match(result.replies[0], /Expediente 769-1234\/2026/);
  assert.match(result.replies[0], /Mesa → Archivo/);
});

test("informa cuando el expediente no existe", async () => {
  const error = Object.assign(new Error("No encontrado"), { status: 404 });
  const result = await handleExpedienteFlow({ text: "769-1-2026", expedientesApi: { consultar: async () => { throw error; } } });
  assert.equal(result.state.step, "ask_codigo");
  assert.match(result.replies[0], /No encontré/);
});

test("confirma cuando el telefono de WhatsApp queda asociado y autorizado", async () => {
  const result = await handleExpedienteFlow({
    text: "388 410-4530",
    expedientesApi: {},
    justLinkedPhone: true,
    authorizedUser: { nombre: "Juan" }
  });

  assert.equal(result.handled, true);
  assert.equal(result.state, null);
  assert.match(result.replies[0], /Listo, Juan/);
  assert.match(result.replies[0], /numero quedo asociado y autorizado/i);
  assert.match(result.replies[0], /expediente/i);
});
