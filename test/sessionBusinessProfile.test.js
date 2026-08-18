import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionBusinessProfileFromClient } from '../src/sessionBusinessProfile.js';

test('restaura la configuracion de expedientes al iniciar un cliente guardado', () => {
  const profile = sessionBusinessProfileFromClient({
    businessId: 'expedientes',
    businessName: 'Expedientes',
    flowType: 'none',
    flows: ['expedientes'],
    expedientesApiUrl: 'https://example.com/api/bot',
    expedientesApiKey: 'secret',
    settings: {}
  });

  assert.equal(profile.expedientesApiUrl, 'https://example.com/api/bot');
  assert.equal(profile.expedientesApiKey, 'secret');
  assert.deepEqual(profile.flows, ['expedientes']);
});
