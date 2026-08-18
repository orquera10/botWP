import test from "node:test";
import assert from "node:assert/strict";
import { createExpedientesApi } from "../src/expedientesApi.js";

test("autoriza el telefono contra la API de usuarios", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ autorizado: true, usuario: { nombre: "Juan" } }));
  };
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot", apiKey: "secret" });
    const result = await api.autorizarTelefono("5493884104530");
    assert.equal(result.autorizado, true);
    assert.equal(requestedUrl, "https://example.com/api/bot/usuarios/telefono/5493884104530");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("un usuario inexistente no queda autorizado", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ autorizado: false }), { status: 404 });
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot/expedientes", apiKey: "secret" });
    assert.deepEqual(await api.autorizarTelefono("5493884104530"), { autorizado: false });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
