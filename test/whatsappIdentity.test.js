import test from 'node:test';
import assert from 'node:assert/strict';
import { senderPhoneJid, senderLidJid } from '../src/whatsappIdentity.js';

test('keeps the protocol LID even when WhatsApp supplies a phone as the primary address', () => {
  assert.equal(senderLidJid({ key: { remoteJid: '5493881234567@s.whatsapp.net', remoteJidAlt: '123456789012345:2@lid' } }), '123456789012345@lid');
  assert.equal(senderLidJid({ key: { remoteJid: '123@g.us', remoteJidAlt: '123456789012345@lid' } }), null);
  assert.equal(senderLidJid({ key: { remoteJid: '5493881234567@s.whatsapp.net' } }), null);
});

test('uses sender phone or WhatsApp alternate identity and strips device suffix', () => {
  assert.equal(senderPhoneJid({ key: { remoteJid: '5493881234567:4@s.whatsapp.net' } }), '5493881234567@s.whatsapp.net');
  assert.equal(senderPhoneJid({ key: { remoteJid: '123456789012345@lid', remoteJidAlt: '5493881234567@s.whatsapp.net' } }), '5493881234567@s.whatsapp.net');
});

test('never infers phone from LID, profile name, text or group participant', () => {
  assert.equal(senderPhoneJid({ key: { remoteJid: '123456789012345@lid' }, pushName: '5493881234567', message: { conversation: '5493881234567' } }), null);
  assert.equal(senderPhoneJid({ key: { remoteJid: '123@g.us', senderPn: '5493881234567@s.whatsapp.net' } }), null);
});
