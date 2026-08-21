import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  createBirthdayInvitation,
  formatInvitationPhone
} from '../src/birthdayInvitation.js';

test('formatea el telefono argentino para la tarjeta', () => {
  assert.equal(formatInvitationPhone('5493886002759'), '3886 002759');
  assert.equal(formatInvitationPhone('3886-002759'), '3886 002759');
});

test('genera una tarjeta PNG con las dimensiones de la plantilla', async () => {
  const buffer = await createBirthdayInvitation({
    name: 'Martina',
    date: '21/08/2026',
    startTime: '18:00',
    endTime: '21:00',
    phone: '5493886002759'
  });
  const metadata = await sharp(buffer).metadata();

  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1054);
  assert.equal(metadata.height, 1492);
});
