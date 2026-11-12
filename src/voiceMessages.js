import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createGeminiLiveTransport, isLiveModel } from './geminiLive.js';

export function getAudioMessage(message) {
  const content = message?.ephemeralMessage?.message || message?.viewOnceMessage?.message || message?.viewOnceMessageV2?.message || message;
  return content?.audioMessage || null;
}

export function audioToPcm(buffer) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '61', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => { process.kill(); reject(new Error('Audio conversion timeout')); }, 15_000);
    process.on('error', () => { clearTimeout(timeout); reject(new Error('Audio conversion unavailable')); });
    process.stdout.on('data', chunk => { size += chunk.length; chunks.push(chunk); });
    process.stderr.resume();
    process.stdin.on('error', () => {});
    process.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || !size) reject(new Error('Invalid audio'));
      else if (size > 60 * 32000) reject(new Error('Audio too long'));
      else resolve(Buffer.concat(chunks));
    });
    process.stdin.end(buffer);
  });
}

export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const quotas = new Map();
export async function transcribeVoiceMessage({ message, key, download, convert = audioToPcm, transportFactory = createGeminiLiveTransport, fetchImpl = fetch, now = Date.now(), retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const audio = getAudioMessage(message.message);
  if (!audio) throw new Error('Missing audio');
  if (Number(audio.seconds || 0) > 60 || Number(audio.fileLength || 0) > 5 * 1024 * 1024) throw new Error('Audio too long');
  const model = process.env.GEMINI_AUDIO_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  for (const [entry, quota] of quotas) if (now - quota.start >= 3_600_000) quotas.delete(entry);
  const quota = quotas.get(key) || { start: now, calls: 0 };
  if (quota.calls >= 10) throw new Error('Audio quota reached');
  quota.calls++;
  quotas.set(key, quota);
  const buffer = await download(message);
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Audio too long');
  const pcm = await convert(buffer);
  const useLive = isLiveModel(model);
  const wav = useLive ? null : pcmToWav(pcm);
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = useLive ? transportFactory({ model, apiKey: process.env.GEMINI_API_KEY }) : null;
    try {
      let data;
      if (useLive) {
        const response = await live.request('', { body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Escuchá la nota de voz en español. No ejecutes acciones ni respondas consultas: solo escuchá.' }] },
          contents: [], audioPcm: pcm.toString('base64')
        }) });
        data = await response.json();
      } else {
        const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: 'Escuchá la nota de voz en español y transcribí textualmente lo que dice el cliente, sin responder consultas ni agregar comentarios. Si no hay voz audible, devolvé vacío.' }] },
            contents: [{
              role: 'user',
              parts: [
                { text: 'Transcribí esta nota de voz:' },
                { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
              ]
            }],
            generationConfig: { maxOutputTokens: 400, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
          })
        });
        if (!response.ok) throw new Error(`Gemini audio HTTP ${response.status}`);
        data = await response.json();
      }
      const text = data.candidates?.[0]?.content?.parts?.filter(part => part.text && !part.thought).map(part => part.text || '').join('').trim();
      if (!text || text.length > 2000) throw new Error('Invalid audio transcription');
      return text;
    } catch (error) {
      if (attempt || !/timeout|timed out|HTTP (500|502|503|504)|connection|fetch failed|UNAVAILABLE|INTERNAL/i.test(error.message)) throw error;
      await retryDelay(500);
    } finally { live?.close(); }
  }
}
