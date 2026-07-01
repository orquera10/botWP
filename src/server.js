import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import Pino from 'pino';
import baileys, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import {
  initDatabase,
  isDatabaseEnabled,
  deleteDbClient,
  linkConversationAlias,
  listConversations,
  listDbClients,
  listMessages,
  listUnlinkedLidConversations,
  saveIncomingMessage,
  saveOutgoingMessage,
  shouldAskForLidVerification,
  updateMessageDeliveryStatus,
  upsertClient
} from './db.js';

const PORT = Number(process.env.PORT || 3000);
const LEGACY_SESSION_DIR = process.env.SESSION_DIR || 'sessions/whatsapp';
const SESSION_ROOT = process.env.SESSION_ROOT || path.join(path.dirname(LEGACY_SESSION_DIR), 'clients');
const DEFAULT_SESSION_ID =
  process.env.DEFAULT_SESSION_ID || path.basename(LEGACY_SESSION_DIR) || 'whatsapp';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_DIR = path.join(process.cwd(), 'src', 'admin');
const MESSAGE_SEND_DELAY_MS = Number(process.env.MESSAGE_SEND_DELAY_MS || 2000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' });
const { makeWASocket } = baileys;
const sessions = new Map();
const sessionRootPath = path.resolve(SESSION_ROOT);
const eventClients = new Set();

function emitAdminEvent(event, payload = {}) {
  const data = JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload
  });

  for (const res of eventClients) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

function adminAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const [user, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="WP Bot Admin"');
  return res.status(401).send('Autenticacion requerida');
}

function normalizeJid(to) {
  if (!to) return null;
  if (to.includes('@')) return to;

  const digits = String(to).replace(/\D/g, '');
  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}

function normalizeClientName(clientName) {
  const cleaned = String(clientName || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || null;
}

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ''
  );
}

function isUserVisibleMessage(message) {
  if (!message) return false;
  if (message.protocolMessage) return false;
  if (message.senderKeyDistributionMessage) return false;
  if (message.messageContextInfo && Object.keys(message).length === 1) return false;

  return Boolean(extractText(message));
}

function buildLidVerificationMessage(session) {
  return [
    `Hola, soy el asistente de ${session.clientName}.`,
    'Para verificar tu contacto y poder responderte correctamente, me pasas tu numero de WhatsApp con codigo de pais?',
    'Ejemplo: 5493881234567'
  ].join('\n');
}

function serializeError(error) {
  if (!error) return null;

  return {
    name: error?.name,
    message: error?.message,
    stack: error?.stack
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    clientName: session.clientName,
    dir: session.dir,
    status: session.status,
    connected: session.status === 'open',
    hasQr: Boolean(session.lastQr),
    user: session.sock?.user || null,
    lastError: session.lastError
  };
}

function getOrCreateSession(clientName) {
  const id = normalizeClientName(clientName);
  if (!id) return null;

  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      clientName: String(clientName || id).trim(),
      dir: path.join(SESSION_ROOT, id),
      sock: null,
      status: 'idle',
      lastQr: null,
      lastQrDataUrl: null,
      lastError: null,
      recentMessages: [],
      reconnectTimer: null,
      starting: null
    });
  }

  const session = sessions.get(id);
  upsertClient(session).catch((error) => {
    logger.warn({ clientId: session.id, error }, 'No se pudo guardar el cliente');
  });

  return session;
}

async function removeSessionFiles(session) {
  const sessionPath = path.resolve(session.dir);

  if (sessionPath !== sessionRootPath && !sessionPath.startsWith(`${sessionRootPath}${path.sep}`)) {
    throw new Error('Ruta de sesion invalida.');
  }

  await fs.rm(sessionPath, { recursive: true, force: true });
}

function rememberMessage(session, payload) {
  session.recentMessages.unshift(payload);
  session.recentMessages.splice(100);
}

async function postWebhook(session, payload) {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: session.id,
        clientName: session.clientName,
        ...payload
      })
    });
  } catch (error) {
    logger.warn({ clientId: session.id, error }, 'No se pudo enviar el webhook');
  }
}

function normalizeAliasJid(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw;

  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}

async function linkClientAlias(session, aliasJid, canonicalJid) {
  const alias = normalizeAliasJid(aliasJid);
  const canonical = normalizeAliasJid(canonicalJid);

  if (!alias || !canonical) {
    throw new Error('aliasJid y canonicalJid son requeridos.');
  }

  return linkConversationAlias(session.id, alias, canonical);
}

async function connectSession(clientName) {
  const session = getOrCreateSession(clientName);
  if (!session) {
    throw new Error('Nombre de cliente invalido.');
  }

  if (session.starting) return session.starting;
  if (session.sock && ['open', 'qr', 'connecting'].includes(session.status)) return session;

  session.status = 'connecting';
  session.lastError = null;
  await upsertClient(session);
  emitAdminEvent('client:update', { client: sessionSummary(session) });

  session.starting = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(session.dir);
    const { version } = await fetchLatestBaileysVersion();

    session.sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: session.id === DEFAULT_SESSION_ID,
      logger: Pino({ level: 'silent' }),
      browser: [`Proyecto WP Bot ${session.id}`, 'Chrome', '1.0.0']
    });

    session.sock.ev.on('creds.update', saveCreds);

    session.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.lastQr = qr;
        session.lastQrDataUrl = await QRCode.toDataURL(qr);
        session.status = 'qr';
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.info({ clientId: session.id, clientName: session.clientName }, 'QR generado');
      }

      if (connection === 'open') {
        session.status = 'open';
        session.lastQr = null;
        session.lastQrDataUrl = null;
        session.lastError = null;
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.info({ clientId: session.id, clientName: session.clientName }, 'WhatsApp conectado');
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        session.sock = null;
        session.status = loggedOut ? 'logged_out' : 'closed';
        session.lastError = serializeError(lastDisconnect?.error);
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.warn({ clientId: session.id, clientName: session.clientName, statusCode }, 'Conexion de WhatsApp cerrada');

        if (!loggedOut) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(() => {
            session.starting = null;
            connectSession(session.id).catch((error) => {
              session.status = 'error';
              session.lastError = serializeError(error);
              logger.error({ clientId: session.id, clientName: session.clientName, error }, 'No se pudo reconectar Baileys');
            });
          }, 3000);
        }
      }
    });

    session.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const message of messages) {
        if (!message.message) continue;
        if (message.key.remoteJid === 'status@broadcast') continue;
        if (!isUserVisibleMessage(message.message)) continue;

        const payload = {
          clientId: session.id,
          clientName: session.clientName,
          id: message.key.id,
          type,
          from: message.key.remoteJid,
          pushName: message.pushName,
          text: extractText(message.message),
          timestamp: message.messageTimestamp,
          raw: message
        };

        rememberMessage(session, payload);
        if (message.key.fromMe) {
          await saveOutgoingMessage(session, {
            to: message.key.remoteJid,
            text: payload.text,
            messageId: message.key.id,
            raw: message,
            timestamp: message.messageTimestamp,
            messageType: type
          });
          emitAdminEvent('message:new', {
            clientId: session.id,
            direction: 'outgoing',
            message: payload
          });
        } else {
          await saveIncomingMessage(session, payload);
          if (payload.from?.endsWith('@lid') && await shouldAskForLidVerification(session.id, payload.from)) {
            const verificationText = buildLidVerificationMessage(session);
            const result = await session.sock.sendMessage(payload.from, { text: verificationText });
            await saveOutgoingMessage(session, {
              to: payload.from,
              text: verificationText,
              result
            });
            emitAdminEvent('message:new', {
              clientId: session.id,
              direction: 'outgoing',
              message: {
                clientId: session.id,
                clientName: session.clientName,
                id: result?.key?.id,
                from: session.sock?.user?.id || null,
                to: payload.from,
                text: verificationText
              }
            });
          }
          emitAdminEvent('message:new', {
            clientId: session.id,
            direction: 'incoming',
            message: payload
          });
        }
        logger.info(
          {
            clientId: session.id,
            clientName: session.clientName,
            from: payload.from,
            fromMe: Boolean(message.key.fromMe),
            text: payload.text
          },
          message.key.fromMe ? 'Mensaje saliente registrado' : 'Mensaje recibido'
        );
        await postWebhook(session, payload);
      }
    });

    session.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (!update.key?.id || typeof update.update?.status === 'undefined') continue;

        await updateMessageDeliveryStatus(session.id, update.key.id, update.update.status);
        emitAdminEvent('message:update', {
          clientId: session.id,
          messageId: update.key.id,
          status: update.update.status
        });
      }
    });

    async function handleContacts(contacts) {
      for (const contact of contacts) {
        if (contact?.id && contact?.lid) {
          await linkClientAlias(session, contact.lid, contact.id).catch((error) => {
            logger.warn(
              { clientId: session.id, contactId: contact.id, lid: contact.lid, error },
              'No se pudo asociar LID de contacto'
            );
          });
        }
      }
    }

    session.sock.ev.on('contacts.upsert', handleContacts);
    session.sock.ev.on('contacts.update', handleContacts);

    return session;
  })()
    .catch(async (error) => {
      session.status = 'error';
      session.lastError = serializeError(error);
      await upsertClient(session);
      emitAdminEvent('client:update', { client: sessionSummary(session) });
      console.error(`No se pudo iniciar Baileys para ${session.id}:`, error);
      logger.error({ clientId: session.id, clientName: session.clientName, error }, 'No se pudo iniciar Baileys');
      throw error;
    })
    .finally(() => {
      session.starting = null;
    });

  return session.starting;
}

function qrHtml(session) {
  if (!session.lastQr) {
    return `
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>QR WhatsApp ${session.id}</title>
          <style>
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #f6f7f9; color: #111827; }
            main { text-align: center; padding: 24px; }
            p { color: #4b5563; }
          </style>
        </head>
        <body>
          <main>
            <h1>No hay QR disponible</h1>
            <p>Cliente: ${session.clientName}</p>
            <p>Estado actual: ${session.status}</p>
            <p>Si ya vinculaste WhatsApp, revisa <a href="/clients/${session.id}/status">/clients/${session.id}/status</a>.</p>
          </main>
        </body>
      </html>
    `;
  }

  return `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="20">
        <title>QR WhatsApp ${session.id}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #f6f7f9; color: #111827; }
          main { text-align: center; padding: 24px; }
          img { width: min(82vw, 360px); height: auto; border: 12px solid white; box-shadow: 0 12px 40px rgba(17, 24, 39, .16); }
          p { color: #4b5563; }
        </style>
      </head>
      <body>
        <main>
          <h1>Escanea este QR con WhatsApp</h1>
          <img src="${session.lastQrDataUrl}" alt="QR para vincular WhatsApp">
          <p>Cliente: ${session.clientName}</p>
          <p>WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo</p>
        </main>
      </body>
    </html>
  `;
}

async function ensureSessionForRequest(req, res, next) {
  const requestedName = req.params.clientName || req.params.sessionId;
  const id = normalizeClientName(requestedName);

  if (req.method === 'DELETE') {
    let session = id ? sessions.get(id) : null;

    if (!session && id && isDatabaseEnabled()) {
      const clients = await listDbClients();
      const client = clients.find((item) => item.id === id);

      if (client) {
        session = {
          id: client.id,
          clientName: client.clientName || client.id,
          dir: client.dir || path.join(SESSION_ROOT, client.id),
          sock: null,
          status: client.status || 'idle',
          lastQr: null,
          lastQrDataUrl: null,
          lastError: client.lastError || null,
          recentMessages: [],
          reconnectTimer: null,
          starting: null
        };
        sessions.set(session.id, session);
      }
    }

    if (!session && id) {
      const dir = path.join(SESSION_ROOT, id);
      const existsOnDisk = await fs
        .access(dir)
        .then(() => true)
        .catch(() => false);

      if (existsOnDisk) {
        session = {
          id,
          clientName: String(requestedName || id).trim(),
          dir,
          sock: null,
          status: 'idle',
          lastQr: null,
          lastQrDataUrl: null,
          lastError: null,
          recentMessages: [],
          reconnectTimer: null,
          starting: null
        };
        sessions.set(session.id, session);
      }
    }

    if (!session) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    req.whatsappSession = session;
    return next();
  }

  const session = getOrCreateSession(requestedName);
  if (!session) {
    return res.status(400).json({
      error: 'Nombre de cliente invalido.'
    });
  }

  req.whatsappSession = session;
  return next();
}

async function createClientHandler(req, res) {
  const clientName = req.body.clientName || req.body.name;
  const session = getOrCreateSession(clientName);

  if (!session) {
    return res.status(400).json({
      error: 'Envia un nombre de cliente valido en "clientName".'
    });
  }

  try {
    await connectSession(session.clientName);
    emitAdminEvent('client:update', { client: sessionSummary(session) });
    return res.status(201).json({
      ok: true,
      client: sessionSummary(session),
      links: {
        status: `/clients/${session.id}/status`,
        qr: `/clients/${session.id}/qr`,
        send: `/clients/${session.id}/send`,
        messages: `/clients/${session.id}/messages`,
        logout: `/clients/${session.id}/logout`
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'No se pudo iniciar la sesion del cliente',
      details: serializeError(error)
    });
  }
}

async function resetSessionHandler(req, res) {
  const session = req.whatsappSession;

  clearTimeout(session.reconnectTimer);

  if (session.sock) {
    try {
      await session.sock.logout();
    } catch {
      // La sesion puede estar rota o ya cerrada; igual limpiamos archivos locales.
    }
  }

  await removeSessionFiles(session);

  session.sock = null;
  session.status = 'idle';
  session.lastQr = null;
  session.lastQrDataUrl = null;
  session.lastError = null;
  session.starting = null;
  session.reconnectTimer = null;
  await upsertClient(session);
  emitAdminEvent('client:update', { client: sessionSummary(session) });

  await connectSession(session.clientName);
  emitAdminEvent('client:update', { client: sessionSummary(session) });

  return res.json({
    ok: true,
    client: sessionSummary(session),
    links: {
      status: `/clients/${session.id}/status`,
      qr: `/clients/${session.id}/qr`
    }
  });
}

async function deleteClientHandler(req, res) {
  const session = req.whatsappSession;

  clearTimeout(session.reconnectTimer);

  if (session.sock) {
    try {
      await session.sock.logout();
    } catch {
      // Si WhatsApp ya cerro o la sesion esta rota, igual eliminamos datos locales.
    }
  }

  await removeSessionFiles(session);
  await deleteDbClient(session.id);
  sessions.delete(session.id);
  emitAdminEvent('client:delete', {
    clientId: session.id,
    clientName: session.clientName
  });

  return res.json({
    ok: true,
    deleted: {
      clientId: session.id,
      clientName: session.clientName
    }
  });
}

async function logoutSession(session) {
  if (!session.sock) {
    throw new Error('Socket no iniciado');
  }

  await session.sock.logout();
  session.status = 'logged_out';
  session.sock = null;
  session.lastQr = null;
  session.lastQrDataUrl = null;
  await upsertClient(session);
  emitAdminEvent('client:update', { client: sessionSummary(session) });
}

async function linkAliasHandler(req, res) {
  const session = req.whatsappSession;
  const rawAlias = req.body.aliasJid || req.body.lid;
  const canonicalJid = req.body.canonicalJid || req.body.phone || req.body.number;
  const aliasJid =
    req.body.lid && !String(req.body.lid).includes('@') ? `${String(req.body.lid).replace(/\D/g, '')}@lid` : rawAlias;

  try {
    const result = await linkClientAlias(session, aliasJid, canonicalJid);
    emitAdminEvent('conversation:update', { clientId: session.id });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({
      error: error.message
    });
  }
}

async function startSessionHandler(req, res) {
  try {
    const session = await connectSession(req.whatsappSession.id);
    return res.json(sessionSummary(session));
  } catch (error) {
    return res.status(500).json({
      error: 'No se pudo iniciar la sesion',
      details: serializeError(error)
    });
  }
}

async function sendMessageHandler(req, res) {
  const session = req.whatsappSession;

  if (!session.sock || session.status !== 'open') {
    return res.status(409).json({
      error: 'WhatsApp no esta conectado',
      session: sessionSummary(session)
    });
  }

  const jid = normalizeJid(req.body.to);
  const text = String(req.body.message || '').trim();

  if (!jid || !text) {
    return res.status(400).json({
      error: 'Faltan datos. Envia JSON con "to" y "message".'
    });
  }

  if (Array.isArray(req.body.to) || Array.isArray(req.body.message)) {
    return res.status(400).json({
      error: 'Solo se permite un destinatario y un mensaje por request.'
    });
  }

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  await sleep(MESSAGE_SEND_DELAY_MS);

  async function attemptSend(targetJid) {
    try {
      await session.sock.presenceSubscribe(targetJid);
    } catch {
      try {
        await session.sock.sendPresenceUpdate('available', targetJid);
      } catch {
        // Ignorar errores de presencia y continuar con el envio.
      }
    }

    const result = await session.sock.sendMessage(targetJid, { text, contextInfo: {} });
    await saveOutgoingMessage(session, { to: targetJid, text, result });
    emitAdminEvent('message:new', {
      clientId: session.id,
      direction: 'outgoing',
      message: {
        clientId: session.id,
        clientName: session.clientName,
        id: result?.key?.id,
        from: session.sock?.user?.id || null,
        to: targetJid,
        text
      }
    });
    return result;
  }

  try {
    let result = await attemptSend(jid);
    return res.json({
      ok: true,
      clientId: session.id,
      clientName: session.clientName,
      to: jid,
      result
    });
  } catch (error) {
    const serialized = serializeError(error);
    logger.warn(
      { clientId: session.id, clientName: session.clientName, jid, error: serialized },
      'Fallo el envio con el JID principal, probando formato @lid'
    );

    if (!jid.endsWith('@lid')) {
      await sleep(MESSAGE_SEND_DELAY_MS);
      const lidJid = `${jid.split('@')[0]}@lid`;
      try {
        const result = await attemptSend(lidJid);
        return res.json({
          ok: true,
          clientId: session.id,
          clientName: session.clientName,
          to: lidJid,
          originalJid: jid,
          result
        });
      } catch (lidError) {
        logger.error(
          { clientId: session.id, clientName: session.clientName, jid, error: serializeError(lidError) },
          'No se pudo enviar el mensaje ni con el formato @lid'
        );
        return res.status(500).json({
          error: 'No se pudo enviar el mensaje',
          details: serialized,
          lidFallbackError: serializeError(lidError)
        });
      }
    }

    logger.error({ clientId: session.id, clientName: session.clientName, jid, error: serialized }, 'No se pudo enviar el mensaje');
    return res.status(500).json({
      error: 'No se pudo enviar el mensaje',
      details: serialized
    });
  }
}

app.get('/admin', adminAuth, (_req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

app.get('/admin/events', adminAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders?.();
  res.write('event: ready\n');
  res.write(`data: ${JSON.stringify({ event: 'ready', at: new Date().toISOString() })}\n\n`);

  eventClients.add(res);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

app.use('/admin', adminAuth, express.static(ADMIN_DIR));

app.get('/', (_req, res) => {
  res.json({
    name: 'proyecto-wp-bot',
    sessionRoot: SESSION_ROOT,
    database: {
      enabled: isDatabaseEnabled()
    },
    endpoints: {
      clients: 'GET /clients',
      createClient: 'POST /clients',
      startClient: 'POST /clients/:clientName/start',
      status: 'GET /clients/:clientName/status',
      qr: 'GET /clients/:clientName/qr',
      messages: 'GET /clients/:clientName/messages',
      conversations: 'GET /clients/:clientName/conversations',
      unlinkedLids: 'GET /clients/:clientName/unlinked-lids',
      conversationMessages: 'GET /clients/:clientName/conversations/:jid/messages',
      send: 'POST /clients/:clientName/send',
      logout: 'POST /clients/:clientName/logout',
      reset: 'POST /clients/:clientName/reset',
      linkAlias: 'POST /clients/:clientName/aliases',
      delete: 'DELETE /clients/:clientName'
    },
    legacyEndpoints: {
      sessions: 'GET /sessions',
      status: 'GET /status',
      qr: 'GET /qr',
      messages: 'GET /messages',
      send: 'POST /send'
    }
  });
});

app.get('/clients', async (_req, res) => {
  if (isDatabaseEnabled()) {
    return res.json(await listDbClients());
  }

  return res.json([...sessions.values()].map(sessionSummary));
});

app.post('/clients', createClientHandler);

app.use('/clients/:clientName', ensureSessionForRequest);

app.post('/clients/:clientName/start', startSessionHandler);

app.post('/clients/:clientName/reset', resetSessionHandler);

app.post('/clients/:clientName/aliases', linkAliasHandler);

app.delete('/clients/:clientName', deleteClientHandler);

app.get('/clients/:clientName/status', (req, res) => {
  res.json(sessionSummary(req.whatsappSession));
});

app.get('/clients/:clientName/qr', async (req, res) => {
  if (req.whatsappSession.status === 'idle') {
    await connectSession(req.whatsappSession.clientName).catch(() => {});
  }

  res.send(qrHtml(req.whatsappSession));
});

app.get('/clients/:clientName/qr.json', async (req, res) => {
  if (req.whatsappSession.status === 'idle') {
    await connectSession(req.whatsappSession.clientName).catch(() => {});
  }

  if (!req.whatsappSession.lastQr) {
    return res.status(404).json({
      error: 'No hay QR disponible',
      client: sessionSummary(req.whatsappSession)
    });
  }

  return res.json({
    qr: req.whatsappSession.lastQr,
    dataUrl: req.whatsappSession.lastQrDataUrl
  });
});

app.get('/clients/:clientName/messages', async (req, res) => {
  if (isDatabaseEnabled()) {
    return res.json(await listMessages(req.whatsappSession.id, null, req.query.limit));
  }

  return res.json(req.whatsappSession.recentMessages);
});

app.get('/clients/:clientName/conversations', async (req, res) => {
  if (!isDatabaseEnabled()) {
    return res.status(503).json({ error: 'PostgreSQL no esta configurado' });
  }

  return res.json(await listConversations(req.whatsappSession.id));
});

app.get('/clients/:clientName/unlinked-lids', async (req, res) => {
  if (!isDatabaseEnabled()) {
    return res.status(503).json({ error: 'PostgreSQL no esta configurado' });
  }

  return res.json(await listUnlinkedLidConversations(req.whatsappSession.id));
});

app.get('/clients/:clientName/conversations/:jid/messages', async (req, res) => {
  if (!isDatabaseEnabled()) {
    return res.status(503).json({ error: 'PostgreSQL no esta configurado' });
  }

  return res.json(await listMessages(req.whatsappSession.id, req.params.jid, req.query.limit));
});

app.post('/clients/:clientName/send', sendMessageHandler);

app.post('/clients/:clientName/logout', async (req, res) => {
  const session = req.whatsappSession;
  if (!session.sock) return res.status(409).json({ error: 'Socket no iniciado' });

  await logoutSession(session);
  res.json({ ok: true, clientId: session.id, clientName: session.clientName });
});

app.get('/sessions', (_req, res) => {
  res.json([...sessions.values()].map(sessionSummary));
});

app.use('/sessions/:sessionId', ensureSessionForRequest);

app.post('/sessions/:sessionId/start', startSessionHandler);

app.post('/sessions/:sessionId/reset', resetSessionHandler);

app.post('/sessions/:sessionId/aliases', linkAliasHandler);

app.delete('/sessions/:sessionId', deleteClientHandler);

app.get('/sessions/:sessionId/status', (req, res) => {
  res.json(sessionSummary(req.whatsappSession));
});

app.get('/sessions/:sessionId/qr', async (req, res) => {
  if (req.whatsappSession.status === 'idle') {
    await connectSession(req.whatsappSession.id).catch(() => {});
  }

  res.send(qrHtml(req.whatsappSession));
});

app.get('/sessions/:sessionId/qr.json', async (req, res) => {
  if (req.whatsappSession.status === 'idle') {
    await connectSession(req.whatsappSession.id).catch(() => {});
  }

  if (!req.whatsappSession.lastQr) {
    return res.status(404).json({
      error: 'No hay QR disponible',
      session: sessionSummary(req.whatsappSession)
    });
  }

  return res.json({
    qr: req.whatsappSession.lastQr,
    dataUrl: req.whatsappSession.lastQrDataUrl
  });
});

app.get('/sessions/:sessionId/messages', (req, res) => {
  res.json(req.whatsappSession.recentMessages);
});

app.post('/sessions/:sessionId/send', sendMessageHandler);

app.post('/sessions/:sessionId/logout', async (req, res) => {
  const session = req.whatsappSession;
  if (!session.sock) return res.status(409).json({ error: 'Socket no iniciado' });

  await logoutSession(session);
  res.json({ ok: true, clientId: session.id, clientName: session.clientName });
});

app.get('/status', (req, res) => {
  req.params.sessionId = DEFAULT_SESSION_ID;
  req.whatsappSession = getOrCreateSession(DEFAULT_SESSION_ID);
  res.json(sessionSummary(req.whatsappSession));
});

app.get('/qr', async (req, res) => {
  const session = getOrCreateSession(DEFAULT_SESSION_ID);
  if (session.status === 'idle') {
    await connectSession(session.id).catch(() => {});
  }

  res.send(qrHtml(session));
});

app.get('/qr.json', async (_req, res) => {
  const session = getOrCreateSession(DEFAULT_SESSION_ID);
  if (session.status === 'idle') {
    await connectSession(session.id).catch(() => {});
  }

  if (!session.lastQr) {
    return res.status(404).json({
      error: 'No hay QR disponible',
      session: sessionSummary(session)
    });
  }

  return res.json({
    qr: session.lastQr,
    dataUrl: session.lastQrDataUrl
  });
});

app.get('/messages', (_req, res) => {
  res.json(getOrCreateSession(DEFAULT_SESSION_ID).recentMessages);
});

app.post('/send', (req, res) => {
  req.whatsappSession = getOrCreateSession(DEFAULT_SESSION_ID);
  return sendMessageHandler(req, res);
});

app.post('/logout', async (req, res) => {
  req.whatsappSession = getOrCreateSession(DEFAULT_SESSION_ID);
  const session = req.whatsappSession;
  if (!session.sock) return res.status(409).json({ error: 'Socket no iniciado' });

  await logoutSession(session);
  res.json({ ok: true, clientId: session.id, clientName: session.clientName });
});

async function startServer() {
  await initDatabase();

  app.listen(PORT, () => {
    logger.info(`Servidor listo en http://localhost:${PORT}`);
    if (isDatabaseEnabled()) {
      logger.info('PostgreSQL conectado y tablas verificadas');
    }
    autoStartClients().catch((error) => {
      logger.error({ error }, 'No se pudieron iniciar clientes automaticamente');
    });
  });
}

async function autoStartClients() {
  let clientNames = [];

  if (isDatabaseEnabled()) {
    const clients = await listDbClients();
    clientNames = clients
      .filter((client) => client.status !== 'logged_out')
      .map((client) => client.clientName || client.id);
  } else {
    const entries = await fs.readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => []);
    clientNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  for (const clientName of clientNames) {
    connectSession(clientName).catch((error) => {
      logger.warn({ clientName, error }, 'No se pudo auto-iniciar cliente');
    });
  }
}

startServer().catch((error) => {
  logger.error({ error }, 'No se pudo iniciar el servidor');
  process.exit(1);
});
