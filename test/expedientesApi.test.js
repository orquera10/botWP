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

test("prepara una salida identificando al usuario por telefono", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ destinos: [] }));
  };
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot", apiKey: "secret" });
    await api.prepararSalida({ codigo: "769", numero: 220, anio: 2026, telefono: "5493884104530" });
    assert.equal(
      requestedUrl,
      "https://example.com/api/bot/expedientes/769/220/2026/salida?telefono=5493884104530"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registra una salida con POST y la API key", async () => {
  const previousFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot", apiKey: "secret" });
    await api.registrarSalida({
      codigo: "769",
      numero: 220,
      anio: 2026,
      telefono: "5493884104530",
      destino: "12",
      motivo: "Pase",
    });
    assert.equal(request.url, "https://example.com/api/bot/expedientes/769/220/2026/salida");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["X-API-Key"], "secret");
    assert.deepEqual(JSON.parse(request.options.body), {
      telefono: "5493884104530",
      destino: "12",
      motivo: "Pase",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prepara una entrada identificando al usuario por telefono", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ sector: { sector: "Archivo" } }));
  };
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot", apiKey: "secret" });
    await api.prepararEntrada({ codigo: "769", numero: 220, anio: 2026, telefono: "5493884104530" });
    assert.equal(
      requestedUrl,
      "https://example.com/api/bot/expedientes/769/220/2026/entrada?telefono=5493884104530"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registra una entrada con POST y la API key", async () => {
  const previousFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  try {
    const api = createExpedientesApi({ baseUrl: "https://example.com/api/bot", apiKey: "secret" });
    await api.registrarEntrada({
      codigo: "769",
      numero: 220,
      anio: 2026,
      telefono: "5493884104530",
      motivo: "Recibido",
    });
    assert.equal(request.url, "https://example.com/api/bot/expedientes/769/220/2026/entrada");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["X-API-Key"], "secret");
    assert.deepEqual(JSON.parse(request.options.body), {
      telefono: "5493884104530",
      motivo: "Recibido",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
