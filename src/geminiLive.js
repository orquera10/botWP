import WebSocket from 'ws';

export const isLiveModel = model => /(?:^|-)live(?:-|$)/.test(model);

// One session per incoming WhatsApp message. Tool rounds share the same session;
// conversation history is restored from the existing server-side state.
export function createGeminiLiveTransport({ model, apiKey, Socket = WebSocket, timeoutMs = 45_000 }) {
  let socket;
  let waiting;
  let timer;
  let closed = false;
  let transcript = '';
  let text = '';
  let usage;
  let toolPending = false;

  function complete(error, content) {
    if (!waiting) return;
    clearTimeout(timer);
    const { resolve, reject } = waiting;
    waiting = undefined;
    if (error) reject(error);
    else resolve({ ok: true, json: async () => ({ candidates: [{ content }], usageMetadata: usage }) });
  }
  function close() {
    closed = true;
    clearTimeout(timer);
    complete(new Error('Gemini Live session closed'));
    if (socket && socket.readyState !== Socket.CLOSED) socket.close();
  }
  function fail(message) {
    complete(new Error(message));
    close();
  }
  const send = value => socket.send(JSON.stringify(value));

  async function request(_url, options) {
    if (closed || waiting) throw new Error('Gemini Live session unavailable');
    const body = JSON.parse(options.body);
    transcript = '';
    text = '';
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      timer = setTimeout(() => fail('Gemini Live timeout'), timeoutMs);
      if (socket) {
        const parts = body.contents.at(-1)?.parts || [];
        const functionResponses = parts.filter(p => p.functionResponse).map(p => p.functionResponse);
        if (!functionResponses.length) { fail('Gemini Live missing tool responses'); return; }
        toolPending = false;
        send({ toolResponse: { functionResponses } });
        return;
      }
      const url = new URL('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
      url.searchParams.set('key', apiKey);
      socket = new Socket(url.toString());
      socket.on('open', () => send({ setup: {
        model: `models/${model.replace(/^models\//, '')}`,
        systemInstruction: body.systemInstruction,
        tools: body.tools,
        generationConfig: { responseModalities: ['AUDIO'], temperature: 0.3, maxOutputTokens: 1200 },
        outputAudioTranscription: {}
      } }));
      // Serialize events so a delayed tool result cannot race with subsequent frames.
      socket.on('message', raw => {
        if (closed) return;
        try {
          const data = JSON.parse(raw.toString());
          if (data.error) { fail(`Gemini Live ${data.error.status || 'error'}`); return; }
          if (data.setupComplete) send({ clientContent: { turns: body.contents, turnComplete: true } });
          if (data.usageMetadata) usage = data.usageMetadata;
          if (data.toolCall?.functionCalls?.length) {
            toolPending = true;
            complete(null, { role: 'model', parts: data.toolCall.functionCalls.map(functionCall => ({ functionCall })) });
          }
          if (data.toolCallCancellation) { fail('Gemini Live tool call cancelled'); return; }
          const server = data.serverContent;
          if (server?.outputTranscription?.text) transcript += server.outputTranscription.text;
          for (const part of server?.modelTurn?.parts || []) {
            if (part.text && !part.thought) text += part.text;
          }
          // Audio chunks are intentionally discarded; WhatsApp receives the transcript.
          if (server?.turnComplete && !toolPending) {
            const answer = transcript.trim() || text.trim();
            if (!answer) { fail('Gemini Live empty transcript'); return; }
            complete(null, { role: 'model', parts: [{ text: answer }] });
          }
        } catch { fail('Gemini Live invalid response'); }
      });
      socket.on('error', () => fail('Gemini Live connection error'));
      socket.on('close', code => {
        if (!closed) fail(`Gemini Live connection closed (${code})`);
      });
    });
  }
  return { request, close };
}
