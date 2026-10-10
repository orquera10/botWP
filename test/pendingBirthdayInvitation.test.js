import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePendingBirthdayInvitation } from '../src/pendingBirthdayInvitation.js';
import { buildBirthdayInvitationNameState } from '../src/reservationFlow.js';

test('payment-triggered invitation consumes Mariana and returns PNG with stored birthday details', async () => {
  const state = buildBirthdayInvitationNameState({ date: '21-10-2026', startTime: '17:00', endTime: '20:00', phone: '5493881234567' });
  const output = await handlePendingBirthdayInvitation({
    state, text: 'Mariana', canonicalJid: '5493881234567@s.whatsapp.net',
    reservasApi: { configured: () => true }, businessName: 'La Tóxica'
  });
  assert.equal(output.state, null);
  assert.match(output.replies[0], /Mariana/);
  assert.equal(output.media[0].fileName, 'invitacion_personalizada.png');
  assert.equal(output.media[0].buffer.subarray(1, 4).toString(), 'PNG');
  assert.equal(output.media[1].fileName, 'reglamento_cancha.png');
});

test('ordinary reservations and messages remain available to AI routing', async () => {
  assert.equal(await handlePendingBirthdayInvitation({ state: null, text: 'Mariana' }), null);
  assert.equal(await handlePendingBirthdayInvitation({ state: { step: 'ask_confirm' }, text: 'Mariana' }), null);
});
