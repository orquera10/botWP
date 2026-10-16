import test from 'node:test';
import assert from 'node:assert/strict';
import { readAdminResponse } from '../src/admin/apiResponse.js';

test('HTML errors and HTML successes never become code dumps or success messages', async () => {
  for (const status of [200, 404, 500, 502]) {
    const response = new Response('<html><body>internal stack trace</body></html>', { status, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(readAdminResponse(response), error => !/html|stack trace|<body>/.test(error.message));
  }
});
test('JSON success and actionable errors are preserved without exposing invalid JSON or markup', async () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await readAdminResponse(json({ ok: true })), { ok: true });
  await assert.rejects(readAdminResponse(json({ error: 'Hay un pago pendiente.' }, 409)), /Hay un pago pendiente/);
  await assert.rejects(readAdminResponse(json({ error: '<html>stack</html>' }, 500)), /El servidor no pudo/);
  await assert.rejects(readAdminResponse(new Response('invalid', { headers: { 'Content-Type': 'application/json' } })), /El servidor no pudo/);
});
