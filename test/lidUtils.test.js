import test from 'node:test';
import assert from 'node:assert/strict';

import { isUnlinkedLidConversation } from '../src/lidUtils.js';

test('solo interpreta numeros como verificacion mientras el LID no esta asociado', () => {
  const lid = '123456789@lid';

  assert.equal(isUnlinkedLidConversation(lid, lid), true);
  assert.equal(isUnlinkedLidConversation(lid, '5493884104530@s.whatsapp.net'), false);
  assert.equal(isUnlinkedLidConversation('5493884104530@s.whatsapp.net', '5493884104530@s.whatsapp.net'), false);
});
