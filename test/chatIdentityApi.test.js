import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReservasApi } from '../src/wpReservasApi.js';

test('business API pins the sender chat, protocol phone and session on GET and POST', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: new URL(req.url, 'http://localhost'), body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, exists: false, status: 'registered', cliente: { id: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = createReservasApi({ baseUrl: `http://127.0.0.1:${server.address().port}/api.php`, apiKey: 'test-only', chatJid: '123456789012345@lid', sessionId: 'toxica', senderPhone: '' });
  await api.consultarCliente({ nombre: 'Otra Persona', telefono: '5493889999999' });
  await api.registrarChat({ nombre: 'Maria Perez', bot_jid: '999999999999999@lid', bot_session: 'otro', bot_phone: '5493889999999' });
  assert.equal(api.supportsChatIdentity, true);
  for (const request of requests) {
    assert.equal(request.url.searchParams.get('bot_jid'), '123456789012345@lid');
    assert.equal(request.url.searchParams.get('bot_session'), 'toxica');
  }
  assert.equal(requests[1].body.bot_jid, '123456789012345@lid');
  assert.equal(requests[1].body.bot_session, 'toxica');
  assert.equal(requests[1].body.bot_phone, '');
});

test('notificarCancelacion posts to notificar_cancelacion action with payload', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: new URL(req.url, 'http://localhost'), body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Alerta enviada', destinatarios: ['5493886002759'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = createReservasApi({ baseUrl: `http://127.0.0.1:${server.address().port}/api.php`, apiKey: 'test-only' });
  const result = await api.notificarCancelacion({ motivo: 'no voy a asistir', telefono: '5493881234567' });
  assert.equal(result.success, true);
  assert.equal(requests[0].url.searchParams.get('action'), 'notificar_cancelacion');
  assert.equal(requests[0].body.motivo, 'no voy a asistir');
  assert.equal(requests[0].body.telefono, '5493881234567');
});
