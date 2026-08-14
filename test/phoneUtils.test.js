import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeArgentinePhone,
  normalizeArgentinePhone
} from '../src/phoneUtils.js';

test('normaliza formatos argentinos habituales', () => {
  const expected = '5493884104530';

  assert.equal(normalizeArgentinePhone('3884104530'), expected);
  assert.equal(normalizeArgentinePhone('0388 410-4530'), expected);
  assert.equal(normalizeArgentinePhone('0388 15 410-4530'), expected);
  assert.equal(normalizeArgentinePhone('+54 9 388 410-4530'), expected);
  assert.equal(normalizeArgentinePhone('0054 9 388 4104530'), expected);
});

test('rechaza entradas que no forman un numero argentino completo', () => {
  assert.equal(normalizeArgentinePhone('1234'), '');
  assert.equal(looksLikeArgentinePhone('hola'), false);
  assert.equal(looksLikeArgentinePhone('388 410-4530'), true);
});
