import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGeminiLiveTransport, isLiveModel } from '../src/geminiLive.js';
import { handleAiConversation } from '../src/aiConversation.js';

class FakeSocket extends EventEmitter {
  static CLOSED = 3;
  static instance;
  readyState = 1;
  sent = [];
  constructor() { super(); FakeSocket.instance = this; queueMicrotask(() => this.emit('open')); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  close() { this.readyState = 3; this.emit('close', 1000); }
}
const options = { body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Recepcionista' }] }, tools: [], contents: [{ role: 'user', parts: [{ text: 'Hola' }] }] }) };

test('Live sends setup and history, waits for complete transcript and closes', async () => {
  const live = createGeminiLiveTransport({ model: 'gemini-3.1-flash-live-preview', apiKey: 'test', Socket: FakeSocket });
  const pending = live.request('', options);
  await Promise.resolve();
  const socket = FakeSocket.instance;
  assert.equal(socket.sent[0].setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(socket.sent[0].setup.generationConfig.responseModalities, ['AUDIO']);
  socket.frame({ setupComplete: {} });
  assert.equal(socket.sent[1].clientContent.turns[0].parts[0].text, 'Hola');
  socket.frame({ serverContent: { outputTranscription: { text: 'Hola, ' } } });
  socket.frame({ serverContent: { outputTranscription: { text: '¿cómo estás?' }, generationComplete: true } });
  socket.frame({ serverContent: { turnComplete: true } });
  const result = await (await pending).json();
  assert.equal(result.candidates[0].content.parts[0].text, 'Hola, ¿cómo estás?');
  live.close();
  assert.equal(socket.readyState, 3);
});

test('Live tool responses retain the call id and use the same socket', async () => {
  const live = createGeminiLiveTransport({ model: 'gemini-3.1-flash-live-preview', apiKey: 'test', Socket: FakeSocket });
  const first = live.request('', options);
  await Promise.resolve();
  const socket = FakeSocket.instance;
  socket.frame({ setupComplete: {} });
  socket.frame({ toolCall: { functionCalls: [{ id: 'call-1', name: 'canchas', args: {} }] } });
  assert.equal((await (await first).json()).candidates[0].content.parts[0].functionCall.id, 'call-1');
  const second = live.request('', { body: JSON.stringify({ contents: [{ role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'canchas', response: { result: [] } } }] }] }) });
  assert.equal(socket.sent.at(-1).toolResponse.functionResponses[0].id, 'call-1');
  socket.frame({ serverContent: { outputTranscription: { text: 'No hay canchas.' }, turnComplete: true } });
  assert.equal((await (await second).json()).candidates[0].content.parts[0].text, 'No hay canchas.');
  live.close();
});

test('connection failure rejects safely without exposing the API key', async () => {
  const live = createGeminiLiveTransport({ model: 'live', apiKey: 'secret-key', Socket: FakeSocket });
  const pending = live.request('', options);
  FakeSocket.instance.emit('error', new Error('secret-key'));
  await assert.rejects(pending, { message: 'Gemini Live connection error' });
  assert.equal(FakeSocket.instance.readyState, 3);
});

test('Live timeout closes the socket', async () => {
  const live = createGeminiLiveTransport({ model: 'live', apiKey: 'test', Socket: FakeSocket, timeoutMs: 10 });
  await assert.rejects(live.request('', options), /timeout/);
  assert.equal(FakeSocket.instance.readyState, 3);
});

test('Live routing does not match regular Flash models', () => {
  assert.equal(isLiveModel('gemini-3.1-flash-live-preview'), true);
  assert.equal(isLiveModel('gemini-2.5-flash'), false);
});

test('conversation routes Live tools and retains confirmation and cleanup', async () => {
  const previous = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
  let closed = false;
  let round = 0;
  try {
    const output = await handleAiConversation({
      text: 'Qué canchas hay', canonicalJid: 'test@lid',
      reservasApi: { listarCanchas: async () => [{ id: 5, nombre: 'Fútbol 5' }] },
      fetchImpl: () => assert.fail('Live must not use REST'),
      liveTransportFactory: () => ({
        close: () => { closed = true; },
        request: async (_url, options) => {
          const body = JSON.parse(options.body);
          if (round++ === 0) return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'abc', name: 'canchas', args: {} } }] } }] }) };
          assert.equal(body.contents.at(-1).parts[0].functionResponse.id, 'abc');
          return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Tenemos fútbol 5.' }] } }] }) };
        }
      })
    });
    assert.deepEqual(output.replies, ['Tenemos fútbol 5.']);
    assert.equal(closed, true);
    assert.equal(output.state.pending, undefined);
    assert.equal(output.state.history.length, 2);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previous;
  }
});
