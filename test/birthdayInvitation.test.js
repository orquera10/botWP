import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  BIRTHDAY_INVITATION_TEMPLATE,
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

  const regions = [
    { left: 220, top: 490, width: 610, height: 110 },
    { left: 220, top: 780, width: 350, height: 60 },
    { left: 220, top: 945, width: 350, height: 60 },
    { left: 220, top: 1110, width: 350, height: 60 }
  ];

  for (const region of regions) {
    const [basePixels, generatedPixels] = await Promise.all([
      sharp(BIRTHDAY_INVITATION_TEMPLATE).extract(region).raw().toBuffer(),
      sharp(buffer).extract(region).raw().toBuffer()
    ]);
    let changedChannels = 0;
    for (let index = 0; index < basePixels.length; index += 1) {
      if (basePixels[index] !== generatedPixels[index]) changedChannels += 1;
    }
    assert.ok(changedChannels > 500, 'El campo personalizado no se dibujo sobre la plantilla');
  }
});
