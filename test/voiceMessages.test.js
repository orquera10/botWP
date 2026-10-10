import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { getAudioMessage, audioToPcm, transcribeVoiceMessage } from '../src/voiceMessages.js';

test('detects ordinary and wrapped voice notes', () => {
  const audioMessage = { seconds: 5, ptt: true };
  assert.equal(getAudioMessage({ audioMessage }), audioMessage);
  assert.equal(getAudioMessage({ ephemeralMessage: { message: { audioMessage } } }), audioMessage);
  assert.equal(getAudioMessage({ conversation: 'Hola' }), null);
});

test('ffmpeg converts a real WAV buffer to 16kHz mono PCM', async () => {
  const samples = Buffer.alloc(16000 * 2);
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.writeUInt32LE(36 + samples.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length, 40);
  assert.equal((await audioToPcm(Buffer.concat([wav, samples]))).length, samples.length);
  const ogg = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { input: Buffer.concat([wav, samples]), windowsHide: true, timeout: 10_000 });
  assert.equal(ogg.status, 0);
  assert.equal(ogg.stdout.subarray(0, 4).toString(), 'OggS');
  assert.equal((await audioToPcm(ogg.stdout)).length, samples.length);
});

test('a voice note is downloaded, converted and transcribed with the configured Live model', async () => {
  const previous = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
  let closed = false;
  try {
    const text = await transcribeVoiceMessage({ message: { message: { audioMessage: { seconds: 5 } } }, key: 'voice-test',
      download: async () => Buffer.from('ogg'), convert: async buffer => { assert.equal(buffer.toString(), 'ogg'); return Buffer.from('pcm'); },
      transportFactory: ({ model }) => {
        assert.equal(model, 'gemini-3.1-flash-live-preview');
        return { close: () => { closed = true; }, request: async (_url, options) => {
          assert.equal(JSON.parse(options.body).audioPcm, Buffer.from('pcm').toString('base64'));
          return { json: async () => ({ candidates: [{ content: { parts: [{ text: 'Somos 10 para el martes.' }] } }] }) };
        } };
      }
    });
    assert.equal(text, 'Somos 10 para el martes.');
    assert.equal(closed, true);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previous;
  }
});

test('oversized notes are rejected before download or Gemini', async () => {
  await assert.rejects(transcribeVoiceMessage({ message: { message: { audioMessage: { seconds: 61 } } }, download: () => assert.fail('No download') }), /Audio too long/);
});
