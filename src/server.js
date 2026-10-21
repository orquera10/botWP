import 'dotenv/config';

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import Pino from 'pino';
import baileys, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import {
  clearBotFlowState,
  initDatabase,
  isDatabaseEnabled,
  deleteDbClient,
  getBotFlowState,
  getBusinessProfile,
  getBusinessUserRole,
  getCanonicalConversationJid,
  hasRecentLidVerificationRequest,
  linkConversationAlias,
  listConversations,
  listBusinessProfiles,
  listAiFallbackStatus,
  listDbClients,
  listMessages,
  listUnlinkedLidConversations,
  saveIncomingMessage,
  saveBusinessProfile,
  saveBotFlowState,
  saveOutgoingMessage,
  shouldAskForLidVerification,
  updateMessageDeliveryStatus,
  upsertClient
} from './db.js';
import {
  buildBirthdayInvitationNameState,
  handleRegistrationFlow,
  handleReservationFlow
} from './reservationFlow.js';
import { normalizeArgentinePhone } from './phoneUtils.js';
import { handleAdminScheduleFlow } from './adminScheduleFlow.js';
import { createReservasApi } from './wpReservasApi.js';
import { aiEnabled, handleAiConversation, serializeAiConversation } from './aiConversation.js';
import { prepareAiRetry, activateLegacyFallback, hasPendingCheckout, applyResponseModeRevision } from './aiFallback.js';
import { senderPhoneJid, senderLidJid } from './whatsappIdentity.js';
import { handlePendingBirthdayInvitation } from './pendingBirthdayInvitation.js';
import { getAudioMessage, transcribeVoiceMessage } from './voiceMessages.js';
import { createMessageBatcher } from './messageBatcher.js';

const aiStates = new Map();
const aiMessageBatcher = createMessageBatcher({ debounceMs: 1500, maxWaitMs: 3500 });
const aiCleanupTimer = setInterval(() => {
  for (const [key, state] of aiStates) {
    if (Date.now() - state.updatedAt > 3_600_000) aiStates.delete(key);
  }
}, 600_000);
aiCleanupTimer.unref();

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
const API_KEY = process.env.API_KEY || '';
const DEFAULT_BUSINESS_ID = 'la-toxica';

function normalizeAdminAgendaAction(value) {
  const action = String(value || '').trim();
  return !action || action === 'agenda' ? 'turnos' : action;
}

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

function apiAuth(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const headerKey = req.header('x-api-key');
  if (headerKey && headerKey === API_KEY) {
    return next();
  }

  return res.status(401).json({ error: 'API key requerida' });
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

  return Boolean(extractText(message) || getAudioMessage(message));
}

function buildLidVerificationMessage(session) {
  return [
    `Hola 👋 Soy el asistente virtual de ${session.businessName || session.clientName}.`,
    'Para identificar tu cuenta necesito asociar un numero de contacto.',
    'Escribilo como lo usas normalmente, por ejemplo: 388 410-4530. Tambien podes enviarlo con +54 9.'
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
    businessId: session.businessId,
    businessName: session.businessName,
    flowType: session.flowType,
    flows: session.businessFlows,
    dir: session.dir,
    status: session.status,
    connected: session.status === 'open',
    hasQr: Boolean(session.lastQr),
    user: session.sock?.user || null,
    lastError: session.lastError
  };
}

function defaultBusinessProfile() {
  return {
    id: DEFAULT_BUSINESS_ID,
    name: 'La Toxica',
    flowType: 'reservas',
    flows: ['registro', 'reservas'],
    apiUrl: process.env.WP_RESERVAS_API_URL || '',
    apiKey: process.env.WP_RESERVAS_API_KEY || process.env.API_KEY || '',
    adminApiUrl: process.env.ADMIN_API_URL || '',
    adminApiKey: process.env.ADMIN_API_KEY || '',
    settings: {
      catalogUrl: process.env.CATALOG_URL || ''
    }
  };
}

function applyBusinessProfile(session, business = defaultBusinessProfile()) {
  session.businessId = business.id || DEFAULT_BUSINESS_ID;
  session.businessName = business.name || session.businessId;
  session.flowType = business.flowType || 'none';
  session.businessFlows = Array.isArray(business.flows)
    ? business.flows
    : session.flowType === 'reservas' ? ['registro', 'reservas'] : [];
  session.businessApiUrl = business.apiUrl || '';
  session.businessApiKey = business.apiKey || '';
  session.businessAdminApiUrl = business.adminApiUrl || '';
  session.businessAdminApiKey = business.adminApiKey || '';
  session.businessSettings = business.settings || {};
  return session;
}

async function resolveBusinessProfile(businessId = DEFAULT_BUSINESS_ID) {
  if (isDatabaseEnabled()) {
    return getBusinessProfile(businessId);
  }

  if (businessId === 'sin-automatizacion') {
    return { id: businessId, name: 'Sin automatizacion', flowType: 'none', flows: [], settings: {} };
  }

  return businessId === DEFAULT_BUSINESS_ID ? defaultBusinessProfile() : null;
}

function getOrCreateSession(clientName, businessProfile = null) {
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
    applyBusinessProfile(sessions.get(id), businessProfile || defaultBusinessProfile());
  } else if (businessProfile) {
    applyBusinessProfile(sessions.get(id), businessProfile);
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

async function sendTypingIndicator(session, to) {
  if (!session?.sock || session.status !== 'open' || !to) return;
  try {
    await session.sock.sendPresenceUpdate('composing', to);
  } catch {
    // Ignorar fallos de presencia para no bloquear los mensajes
  }
}

async function clearTypingIndicator(session, to) {
  if (!session?.sock || session.status !== 'open' || !to) return;
  try {
    await session.sock.sendPresenceUpdate('paused', to);
  } catch {}
}

async function sendBotText(session, to, text) {
  if (!session.sock || session.status !== 'open' || !text) return null;

  const result = await session.sock.sendMessage(to, { text, contextInfo: {} });
  await saveOutgoingMessage(session, { to, text, result });
  emitAdminEvent('message:new', {
    clientId: session.id,
    direction: 'outgoing',
    message: {
      clientId: session.id,
      clientName: session.clientName,
      id: result?.key?.id,
      from: session.sock?.user?.id || null,
      to,
      text
    }
  });

  return result;
}

async function sendBotImage(session, to, media) {
  if (!session.sock || session.status !== 'open') return null;

  const image = media.buffer || await fs.readFile(media.path);
  const caption = String(media.caption || '').trim();
  const result = await session.sock.sendMessage(to, {
    image,
    caption,
    mimetype: 'image/png',
    fileName: media.fileName || 'imagen.png'
  });
  await saveOutgoingMessage(session, {
    to,
    text: caption,
    result,
    messageType: 'image'
  });
  emitAdminEvent('message:new', {
    clientId: session.id,
    direction: 'outgoing',
    message: {
      clientId: session.id,
      clientName: session.clientName,
      id: result?.key?.id,
      from: session.sock?.user?.id || null,
      to,
      text: caption,
      messageType: 'image'
    }
  });

  return result;
}

async function sendFlowOutput(session, to, flowResult) {
  for (const reply of flowResult.replies || []) {
    await sendBotText(session, to, reply);
  }
  for (const media of flowResult.media || []) {
    await sendBotImage(session, to, media);
  }
  for (const reply of flowResult.afterMediaReplies || []) {
    await sendBotText(session, to, reply);
  }
  await clearTypingIndicator(session, to);
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

function normalizeCanonicalPhoneJid(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.endsWith('@lid')) return null;

  const hasJid = raw.includes('@');
  if (hasJid && !raw.endsWith('@s.whatsapp.net')) return null;

  const phonePart = hasJid ? raw.split('@')[0].split(':')[0] : raw;
  const digits = phonePart.replace(/\D/g, '');
  const phone = hasJid ? digits : normalizeArgentinePhone(phonePart);
  if (!phone || phone.length < 9 || phone.length > 15) return null;

  return `${phone}@s.whatsapp.net`;
}

function extractPhoneJidFromVerificationReply(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('@lid')) return null;
  return normalizeCanonicalPhoneJid(raw);
}

async function linkClientAlias(session, aliasJid, canonicalJid) {
  const alias = normalizeAliasJid(aliasJid);
  const canonical = normalizeCanonicalPhoneJid(canonicalJid);

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

    const socket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: session.id === DEFAULT_SESSION_ID,
      logger: Pino({ level: 'silent' }),
      browser: [`Proyecto WP Bot ${session.id}`, 'Chrome', '1.0.0']
    });
    session.sock = socket;

    socket.ev.on('creds.update', (creds) => {
      if (session.sock === socket) {
        return saveCreds(creds);
      }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (session.sock !== socket) return;
        session.lastQr = qr;
        session.lastQrDataUrl = await QRCode.toDataURL(qr);
        session.status = 'qr';
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.info({ clientId: session.id, clientName: session.clientName }, 'QR generado');
      }

      if (connection === 'open') {
        if (session.sock !== socket) return;
        session.status = 'open';
        session.lastQr = null;
        session.lastQrDataUrl = null;
        session.lastError = null;
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.info({ clientId: session.id, clientName: session.clientName }, 'WhatsApp conectado');
      }

      if (connection === 'close') {
        // Un socket anterior puede cerrarse después de un reset. No debe borrar ni
        // reconectar por encima del socket nuevo que ya ocupa la sesión.
        if (session.sock !== socket) return;

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const connectionReplaced = statusCode === DisconnectReason.connectionReplaced;
        const requiresRelink = [
          DisconnectReason.badSession,
          DisconnectReason.multideviceMismatch,
          DisconnectReason.forbidden
        ].includes(statusCode);

        session.sock = null;
        session.status = loggedOut
          ? 'logged_out'
          : connectionReplaced
            ? 'connection_replaced'
            : requiresRelink
              ? 'relink_required'
              : 'closed';
        session.lastError = connectionReplaced
          ? {
              ...serializeError(lastDisconnect?.error),
              statusCode,
              message:
                'La sesion fue reemplazada por otra conexion. Detene cualquier otra instancia del bot y usa "Resetear" para vincular este dispositivo nuevamente.'
            }
          : serializeError(lastDisconnect?.error);
        await upsertClient(session);
        emitAdminEvent('client:update', { client: sessionSummary(session) });
        logger.warn({ clientId: session.id, clientName: session.clientName, statusCode }, 'Conexion de WhatsApp cerrada');

        if (!loggedOut && !connectionReplaced && !requiresRelink) {
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

    async function handlePhoneNumberShare({ lid, jid }) {
      const aliasJid = normalizeAliasJid(lid);
      const canonicalJid = normalizeCanonicalPhoneJid(jid);
      if (!aliasJid?.endsWith('@lid') || !canonicalJid) {
        throw new Error('WhatsApp no envio una relacion LID/telefono valida.');
      }

      const previousCanonicalJid = await getCanonicalConversationJid(session.id, aliasJid);
      const [registrationState, reservationState] = await Promise.all([
        getBotFlowState(session.id, previousCanonicalJid, 'registration'),
        getBotFlowState(session.id, previousCanonicalJid, 'reservation')
      ]);

      await linkClientAlias(session, aliasJid, canonicalJid);

      if (aiEnabled(session.businessSettings) && session.businessFlows.includes('reservas')) {
        await sendBotText(session, aliasJid, '¡Gracias! Ya tengo tu número. Contame qué cancha y horario te interesan, o qué necesitás consultar.');
        return;
      }

      const reservasApi = createReservasApi({
        baseUrl: session.businessApiUrl,
        apiKey: session.businessApiKey,
        chatJid: canonicalJid,
        sessionId: session.id,
        adminAgendaAction: normalizeAdminAgendaAction(session.businessSettings.adminAgendaAction)
      });
      const phone = canonicalJid.split('@')[0];
      let originFlow = 'reservation';
      let flowResult;

      if (registrationState) {
        originFlow = 'registration';
        flowResult = await handleRegistrationFlow({
          state: registrationState,
          text: phone,
          canonicalJid,
          pushName: '',
          reservasApi,
          businessName: session.businessName,
          businessSettings: session.businessSettings
        });
      } else {
        flowResult = await handleReservationFlow({
          state: reservationState,
          text: reservationState?.step === 'ask_phone' ? phone : 'hola',
          canonicalJid,
          pushName: '',
          reservasApi,
          businessName: session.businessName,
          businessSettings: session.businessSettings,
          registrationAvailable: session.businessFlows.includes('registro')
        });
      }

      for (const conversationJid of new Set([previousCanonicalJid, canonicalJid])) {
        await Promise.all([
          clearBotFlowState(session.id, conversationJid, 'registration'),
          clearBotFlowState(session.id, conversationJid, 'reservation')
        ]);
      }

      if (flowResult.state) {
        const nextFlow = flowResult.targetFlow === 'reservation'
          ? 'reservation'
          : flowResult.targetFlow === 'registration' || flowResult.state.step?.startsWith('ask_register_')
            ? 'registration'
            : originFlow;
        await saveBotFlowState(session.id, canonicalJid, nextFlow, flowResult.state);
      }

      await sendFlowOutput(session, aliasJid, flowResult);

      emitAdminEvent('conversation:update', { clientId: session.id });
      logger.info(
        { clientId: session.id, clientName: session.clientName, lid: aliasJid, canonicalJid },
        'LID relacionado mediante el boton nativo de WhatsApp'
      );
    }

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
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
          text: extractText(message.message) || (getAudioMessage(message.message) ? '[Nota de voz]' : ''),
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
          let canonicalConversationJid = await getCanonicalConversationJid(session.id, payload.from);
          canonicalConversationJid = senderLidJid({ key: { remoteJid: canonicalConversationJid } }) || canonicalConversationJid;

          const automaticPhoneJid = senderPhoneJid(message);
          if (automaticPhoneJid) {
            if (payload.from !== automaticPhoneJid) await linkClientAlias(session, payload.from, automaticPhoneJid);
            canonicalConversationJid = automaticPhoneJid;
          }

          if (payload.from?.endsWith('@lid') && !aiEnabled(session.businessSettings)) {
            const canonicalJid = extractPhoneJidFromVerificationReply(payload.text);
            if (canonicalJid) {
              const [registrationState, reservationState] = await Promise.all([
                getBotFlowState(session.id, canonicalConversationJid, 'registration'),
                getBotFlowState(session.id, canonicalConversationJid, 'reservation')
              ]);
              const shouldLink = registrationState?.step === 'ask_phone' ||
                reservationState?.step === 'ask_phone' ||
                await hasRecentLidVerificationRequest(session.id, payload.from);

              if (shouldLink) {
                await linkClientAlias(session, payload.from, canonicalJid);
                if (canonicalConversationJid !== canonicalJid) {
                  for (const [flowName, flowState] of [
                    ['registration', registrationState],
                    ['reservation', reservationState]
                  ]) {
                    if (!flowState) continue;
                    await clearBotFlowState(session.id, canonicalConversationJid, flowName);
                    await saveBotFlowState(session.id, canonicalJid, flowName, flowState);
                  }
                }
                canonicalConversationJid = canonicalJid;
                emitAdminEvent('conversation:update', { clientId: session.id });
                logger.info(
                  { clientId: session.id, clientName: session.clientName, lid: payload.from, canonicalJid },
                  'LID relacionado automaticamente por respuesta de verificacion'
                );
              }
            }
          }

          const reservasApi = createReservasApi({
            baseUrl: session.businessApiUrl,
            apiKey: session.businessApiKey,
            chatJid: senderLidJid(message) || canonicalConversationJid,
            senderPhone: automaticPhoneJid?.split('@')[0] || '',
            sessionId: session.id,
            adminAgendaAction: normalizeAdminAgendaAction(session.businessSettings.adminAgendaAction)
          });
          const adminApi = createReservasApi({
            baseUrl: session.businessAdminApiUrl,
            apiKey: session.businessAdminApiKey,
            authHeader: 'X-Admin-API-Key',
            adminAgendaAction: normalizeAdminAgendaAction(session.businessSettings.adminAgendaAction)
          });
          let handledByAdminFlow = false;

          if (getAudioMessage(message.message) && (!session.businessFlows.includes('reservas') || !aiEnabled(session.businessSettings))) {
            await sendBotText(session, payload.from, 'Por ahora necesito que me escribas tu consulta para poder ayudarte.');
            continue;
          }

          if (session.businessFlows.includes('admin_agenda')) {
            const senderPhone = canonicalConversationJid?.endsWith('@s.whatsapp.net')
              ? canonicalConversationJid.split('@')[0].replace(/\D/g, '')
              : '';
            const senderRole = await getBusinessUserRole(session.businessId, senderPhone);
            if (senderRole === 'admin') {
              const adminState = await getBotFlowState(session.id, canonicalConversationJid, 'admin_agenda');
              const adminResult = await handleAdminScheduleFlow({
                state: adminState,
                text: payload.text,
                reservasApi: adminApi,
                businessName: session.businessName
              });
              handledByAdminFlow = adminResult.handled;

              if (adminResult.state) {
                await saveBotFlowState(session.id, canonicalConversationJid, 'admin_agenda', adminResult.state);
              } else if (adminState) {
                await clearBotFlowState(session.id, canonicalConversationJid, 'admin_agenda');
              }
              for (const reply of adminResult.replies || []) {
                await sendBotText(session, payload.from, reply);
              }
              if (adminResult.error) {
                logger.warn(
                  { clientId: session.id, businessId: session.businessId, error: adminResult.error },
                  'La API del negocio no pudo completar la consulta administrativa'
                );
              }
            }
          }

          async function runLegacyFlows() {
          let handledByRegistrationFlow = false;
          if (session.businessFlows.includes('registro')) {
            const registrationState = await getBotFlowState(session.id, canonicalConversationJid, 'registration');
            const registrationResult = await handleRegistrationFlow({
              state: registrationState,
              text: payload.text,
              canonicalJid: canonicalConversationJid,
              pushName: payload.pushName,
              reservasApi,
              businessName: session.businessName,
              businessSettings: session.businessSettings
            });
            handledByRegistrationFlow = registrationResult.handled;

            if (registrationResult.targetFlow === 'reservation') {
              if (registrationState) {
                await clearBotFlowState(session.id, canonicalConversationJid, 'registration');
              }
              if (registrationResult.state) {
                await saveBotFlowState(session.id, canonicalConversationJid, 'reservation', registrationResult.state);
              }
            } else if (registrationResult.state) {
              await saveBotFlowState(session.id, canonicalConversationJid, 'registration', registrationResult.state);
            } else if (registrationState) {
              await clearBotFlowState(session.id, canonicalConversationJid, 'registration');
            }
            for (const reply of registrationResult.replies || []) {
              await sendBotText(session, payload.from, reply);
            }
            if (handledByRegistrationFlow) return registrationResult;
          }

          if (!handledByRegistrationFlow && session.businessFlows.includes('reservas')) {
            let reservationState = await getBotFlowState(session.id, canonicalConversationJid, 'reservation');
            const flowResult = await handleReservationFlow({
              state: reservationState,
              text: payload.text,
              canonicalJid: canonicalConversationJid,
              pushName: payload.pushName,
              reservasApi,
              businessName: session.businessName,
              businessSettings: session.businessSettings,
              registrationAvailable: session.businessFlows.includes('registro')
            });

            if (flowResult.targetFlow === 'registration') {
              if (reservationState) {
                await clearBotFlowState(session.id, canonicalConversationJid, 'reservation');
              }
              if (flowResult.state) {
                await saveBotFlowState(session.id, canonicalConversationJid, 'registration', flowResult.state);
              }
            } else if (flowResult.state) {
              await saveBotFlowState(session.id, canonicalConversationJid, 'reservation', flowResult.state);
            } else if (reservationState) {
              await clearBotFlowState(session.id, canonicalConversationJid, 'reservation');
            }

            await sendFlowOutput(session, payload.from, flowResult);

            if (
              (!flowResult.replies || flowResult.replies.length === 0) &&
              payload.from?.endsWith('@lid') &&
              await shouldAskForLidVerification(session.id, payload.from)
            ) {
              await sendBotText(session, payload.from, buildLidVerificationMessage(session));
            }
            return flowResult;
          }
          }

          let handledByAi = false;
          if (!handledByAdminFlow && session.businessFlows.includes('reservas') && aiEnabled(session.businessSettings)) {
            handledByAi = true;
            const key = `${session.id}:${session.businessId}:${canonicalConversationJid}`;
            await sendTypingIndicator(session, payload.from);

            const executeAiTurn = async (inputText) => {
              await serializeAiConversation(key, async () => {
                await sendTypingIndicator(session, payload.from);
                const currentText = inputText || payload.text;
                const savedState = aiStates.get(key) || await getBotFlowState(session.id, canonicalConversationJid, 'ai_conversation');
                const state = prepareAiRetry(applyResponseModeRevision(savedState, session.businessSettings.aiModeRevision));
                const invitationState = await getBotFlowState(session.id, canonicalConversationJid, 'reservation');
                const invitationOutput = await handlePendingBirthdayInvitation({
                  state: invitationState, text: currentText, canonicalJid: canonicalConversationJid,
                  reservasApi, businessName: session.businessName, businessSettings: session.businessSettings
                });
                if (invitationOutput) {
                  if (invitationOutput.state) {
                    await saveBotFlowState(session.id, canonicalConversationJid, 'reservation', invitationOutput.state);
                  } else {
                    await clearBotFlowState(session.id, canonicalConversationJid, 'reservation');
                  }
                  const resumedState = {
                    ...state, pending: undefined, offTopic: 0, updatedAt: Date.now(),
                    history: [
                      ...(state?.history || []),
                      { role: 'user', parts: [{ text: currentText }] },
                      { role: 'model', parts: [{ text: (invitationOutput.replies || []).join('\n') }] }
                    ].slice(-12)
                  };
                  aiStates.set(key, resumedState);
                  await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', resumedState);
                  await sendFlowOutput(session, payload.from, invitationOutput);
                  return;
                }
                let waitNoticeSent = false;
                const sendWaitNotice = async (msg = 'Dame un momento, por favor...') => {
                  if (waitNoticeSent) return;
                  waitNoticeSent = true;
                  try {
                    await sendTypingIndicator(session, payload.from);
                    await sendBotText(session, payload.from, msg);
                    await sendTypingIndicator(session, payload.from);
                  } catch (e) {
                    logger.warn({ clientId: session.id, err: e }, 'No se pudo enviar aviso de espera');
                  }
                };

                const waitTimer = setTimeout(() => {
                  sendWaitNotice();
                }, 9000);

                let output;
                try {
                  output = await handleAiConversation({
                    state, text: currentText, canonicalJid: canonicalConversationJid,
                    reservasApi, businessName: session.businessName, businessSettings: session.businessSettings,
                    registrationAvailable: session.businessFlows.includes('registro'),
                    onDiagnostic: diagnostic => logger.warn({ clientId: session.id, businessId: session.businessId, ...diagnostic }, 'Consulta IA no completada'),
                    onProgress: sendWaitNotice,
                    onBeforeWrite: async consumedState => {
                      aiStates.set(key, consumedState);
                      await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', consumedState);
                    }
                  });

                  let bgRetries = 0;
                  while (output?.fallback && output.fallbackReason !== 'quota' && bgRetries < 2) {
                    bgRetries++;
                    await sendWaitNotice();
                    logger.warn({ clientId: session.id, attempt: bgRetries }, 'Reintentando turno IA en segundo plano');
                    await new Promise(r => setTimeout(r, 1500 * bgRetries));
                    output = await handleAiConversation({
                      state: output.state || state, text: currentText, canonicalJid: canonicalConversationJid,
                      reservasApi, businessName: session.businessName, businessSettings: session.businessSettings,
                      registrationAvailable: session.businessFlows.includes('registro'),
                      onDiagnostic: diagnostic => logger.warn({ clientId: session.id, businessId: session.businessId, ...diagnostic }, 'Reintento consulta IA'),
                      onProgress: sendWaitNotice,
                      onBeforeWrite: async consumedState => {
                        aiStates.set(key, consumedState);
                        await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', consumedState);
                      }
                    });
                  }
                } finally {
                  clearTimeout(waitTimer);
                }

                if (output.fallback) {
                  const fallbackState = { ...(output.state || state), pending: undefined };
                  delete fallbackState.fallbackMode;
                  delete fallbackState.fallbackReason;
                  fallbackState.updatedAt = Date.now();
                  aiStates.set(key, fallbackState);
                  await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', fallbackState);
                  logger.warn({ clientId: session.id, reason: output.fallbackReason }, 'Fallo en consulta IA mantenido en modo conversacional');

                  if (hasPendingCheckout(output.state)) {
                    const payment = await handleAiConversation({ state: output.state, text: 'estado pago', canonicalJid: canonicalConversationJid, reservasApi, businessSettings: session.businessSettings });
                    aiStates.set(key, payment.state);
                    await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', payment.state);
                    await sendFlowOutput(session, payload.from, payment);
                  } else {
                    const fallbackMsg = output.fallbackReason === 'quota'
                      ? 'Llegamos al límite de consultas por esta hora. Podés escribirnos en unos minutos o contactar al negocio.'
                      : (output.replies?.[0] || 'Dame unos minutitos, por favor, que se demoró la consulta con el sistema. Ya te confirmo.');
                    await sendBotText(session, payload.from, fallbackMsg);
                  }
                  return;
                }

                aiStates.set(key, output.state);
                await saveBotFlowState(session.id, canonicalConversationJid, 'ai_conversation', output.state);
                await sendFlowOutput(session, payload.from, output);
              });
            };

            if (getAudioMessage(message.message)) {
              try {
                payload.text = await transcribeVoiceMessage({ message, key, download: msg => downloadMediaMessage(msg, 'buffer', { options: { timeout: 15_000, maxContentLength: 5 * 1024 * 1024 } }, { logger, reuploadRequest: socket.updateMediaMessage }) });
              } catch (error) {
                logger.warn({ clientId: session.id, category: error.message === 'Audio too long' ? 'audio_limit' : 'audio_unavailable' }, 'No se pudo procesar la nota de voz');
                const reply = error.message === 'Audio too long' ? 'Mandame un audio de hasta un minuto, por favor, o escribime tu consulta.'
                  : error.message === 'Audio quota reached' ? 'Llegamos al límite de audios por esta hora. Podés escribirme y seguimos por acá.'
                    : 'No pude entender el audio ahora. ¿Me lo escribís o probás con una nota más corta?';
                await sendBotText(session, payload.from, reply);
                await clearTypingIndicator(session, payload.from);
                return;
              }
              await executeAiTurn(payload.text);
            } else {
              await aiMessageBatcher.enqueue(
                key,
                payload.text,
                executeAiTurn,
                () => sendTypingIndicator(session, payload.from)
              );
            }
          }

          if (!handledByAdminFlow && !handledByAi) await runLegacyFlows();
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

    socket.ev.on('messages.update', async (updates) => {
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

    socket.ev.on('contacts.upsert', handleContacts);
    socket.ev.on('contacts.update', handleContacts);
    socket.ev.on('chats.phoneNumberShare', (share) => {
      handlePhoneNumberShare(share).catch((error) => {
        logger.warn(
          { clientId: session.id, clientName: session.clientName, share, error: serializeError(error) },
          'No se pudo procesar el numero compartido desde WhatsApp'
        );
      });
    });

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

  let businessProfile = null;
  if (id && !sessions.has(id) && isDatabaseEnabled()) {
    const clients = await listDbClients();
    const client = clients.find((item) => item.id === id);
    if (client) {
      businessProfile = {
        id: client.businessId,
        name: client.businessName,
        flowType: client.flowType,
        flows: client.flows,
        apiUrl: client.apiUrl,
        apiKey: client.apiKey,
        adminApiUrl: client.adminApiUrl,
        adminApiKey: client.adminApiKey,
        settings: client.settings
      };
    }
  }

  const session = getOrCreateSession(requestedName, businessProfile);
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
  const businessId = req.body.businessId || DEFAULT_BUSINESS_ID;
  const businessProfile = await resolveBusinessProfile(businessId);

  if (!businessProfile) {
    return res.status(400).json({ error: 'El negocio seleccionado no existe o esta deshabilitado.' });
  }

  const session = getOrCreateSession(clientName, businessProfile);

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

async function unlinkCustomerHandler(req, res) {
  const session = req.whatsappSession;
  const phone = normalizeArgentinePhone(req.body.phone);
  const lid = /^\d{9,20}@lid$/.test(String(req.body.phone || '').trim()) ? String(req.body.phone).trim() : null;
  if ((!phone && !lid) || req.body.confirm !== true) return res.status(400).json({ error: 'Indicá el número o LID y confirmá la desvinculación.' });
  if (!session.businessFlows?.includes('reservas')) return res.status(400).json({ error: 'Esta sesión no tiene reservas habilitadas.' });
  const jid = await getCanonicalConversationJid(session.id, lid || `${phone}@s.whatsapp.net`);
  try {
    const api = createReservasApi({ baseUrl: session.businessApiUrl, apiKey: session.businessApiKey, chatJid: jid, sessionId: session.id });
    await serializeAiConversation(`${session.id}:${session.businessId}:${jid}`, async () => {
      await api.desvincularCliente(phone);
      // Keep WhatsApp identity aliases and message history; clear only cached flow data.
      for (const linked of sessions.values()) {
        if (linked.businessId !== session.businessId) continue;
        aiStates.delete(`${linked.id}:${linked.businessId}:${jid}`);
        for (const flow of ['ai_conversation', 'reservation', 'registration']) {
          await clearBotFlowState(linked.id, jid, flow);
        }
      }
    });
    return res.json({ ok: true });
  } catch (error) {
    const status = [400, 409].includes(error.status) ? error.status : 502;
    return res.status(status).json({ error: status === 502 ? 'No se pudo completar la desvinculación. Verificá que la API de La Tóxica esté actualizada y volvé a intentar.' : error.message });
  }
}

async function sendMessageHandler(req, res) {
  const requested = req.body.botSession;
  const session = requested ? sessions.get(requested) : req.whatsappSession;
  if (!session) return res.status(404).json({ error: 'Sesión de WhatsApp no disponible.' });

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

async function birthdayInvitationHandler(req, res) {
  const session = req.body.botSession ? sessions.get(req.body.botSession) : req.whatsappSession;
  if (!session) return res.status(404).json({ error: 'Sesión de WhatsApp no disponible.' });
  if (!session.sock || session.status !== 'open') {
    return res.status(409).json({ error: 'WhatsApp no está conectado' });
  }
  if (!isDatabaseEnabled()) {
    return res.status(503).json({ error: 'PostgreSQL es necesario para conservar el flujo de la invitación' });
  }

  const jid = normalizeJid(req.body.to);
  const date = String(req.body.date || '').trim();
  const startTime = String(req.body.startTime || '').trim();
  const endTime = String(req.body.endTime || '').trim();
  const phone = String(req.body.phone || req.body.to || '').trim();
  if (!jid || !date || !startTime || !endTime || !phone) {
    return res.status(400).json({
      error: 'Faltan datos. Enviá "to", "phone", "date", "startTime" y "endTime".'
    });
  }
  if ([req.body.to, req.body.phone, req.body.date, req.body.startTime, req.body.endTime].some(Array.isArray)) {
    return res.status(400).json({ error: 'Los datos de la invitación deben ser valores simples.' });
  }

  const canonicalJid = await getCanonicalConversationJid(session.id, jid);
  const state = buildBirthdayInvitationNameState({ date, startTime, endTime, phone });
  const prompt = '¿Cuál es el primer nombre del cumpleañero o cumpleañera? Escribí solamente el nombre, sin apellido.';

  await saveBotFlowState(session.id, canonicalJid, 'reservation', state);
  try {
    await sendBotText(session, jid, prompt);
  } catch (error) {
    await clearBotFlowState(session.id, canonicalJid, 'reservation');
    logger.error(
      { clientId: session.id, clientName: session.clientName, jid, error: serializeError(error) },
      'No se pudo solicitar el nombre para la invitación de cumpleaños'
    );
    return res.status(500).json({ error: 'No se pudo solicitar el nombre para la invitación' });
  }

  return res.json({ ok: true, clientId: session.id, to: jid });
}

app.get('/admin', adminAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

app.get('/api/admin/config', adminAuth, (_req, res) => {
  res.json({ apiKey: API_KEY || '' });
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

app.use('/admin', adminAuth, express.static(ADMIN_DIR, { setHeaders: res => res.set('Cache-Control', 'no-store') }));

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
      birthdayInvitation: 'POST /clients/:clientName/birthday-invitation',
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
    const clients = await listDbClients();
    return res.json(clients.map(({ apiKey, apiUrl, adminApiKey, adminApiUrl, settings, ...client }) => client));
  }

  return res.json([...sessions.values()].map(sessionSummary));
});

app.get('/businesses', adminAuth, async (_req, res) => {
  if (isDatabaseEnabled()) {
    const [businesses, statuses] = await Promise.all([listBusinessProfiles(), listAiFallbackStatus()]);
    return res.json(businesses.map(business => ({ ...business, aiActive: aiEnabled(business.settings), aiAvailable: Boolean(process.env.GEMINI_API_KEY), aiFallback: statuses.find(status => status.businessId === business.id) || { chats: 0, reasons: [] } })));
  }

  return res.json([
    {
      id: DEFAULT_BUSINESS_ID,
      name: 'La Toxica',
      flowType: 'reservas',
      flows: ['registro', 'reservas'],
      settings: defaultBusinessProfile().settings,
      aiActive: aiEnabled(defaultBusinessProfile().settings),
      aiAvailable: Boolean(process.env.GEMINI_API_KEY),
      enabled: true
    },
    { id: 'sin-automatizacion', name: 'Sin automatizacion', flowType: 'none', flows: [], enabled: true }
  ]);
});

app.post('/businesses', adminAuth, async (req, res) => {
  if (!isDatabaseEnabled()) {
    return res.status(409).json({ error: 'Se necesita PostgreSQL para guardar negocios.' });
  }

  const name = String(req.body.name || '').trim();
  const id = normalizeClientName(req.body.id || name);
  const flows = [...new Set(Array.isArray(req.body.flows) ? req.body.flows.map(String) : [])];
  const allowedFlows = ['reservas', 'registro', 'admin_agenda'];
  const flowType = flows.includes('reservas') ? 'reservas' : 'none';
  const apiUrl = String(req.body.apiUrl || '').trim();
  const apiKey = String(req.body.apiKey || '').trim();
  const adminApiUrl = String(req.body.adminApiUrl || '').trim();
  const adminApiKey = String(req.body.adminApiKey || '').trim();
  const adminPhones = [...new Set((Array.isArray(req.body.adminPhones) ? req.body.adminPhones : [])
    .map((phone) => String(phone).replace(/\D/g, ''))
    .filter((phone) => phone.length >= 10 && phone.length <= 15))];
  const settings = {
    welcomeMessage: String(req.body.settings?.welcomeMessage || '').trim(),
    unregisteredMessage: String(req.body.settings?.unregisteredMessage || '').trim(),
    catalogUrl: String(req.body.settings?.catalogUrl || '').trim(),
    adminAgendaAction: normalizeAdminAgendaAction(req.body.settings?.adminAgendaAction)
  };

  if (!id || !name) {
    return res.status(400).json({ error: 'El negocio necesita un nombre valido.' });
  }
  if (flows.some((flow) => !allowedFlows.includes(flow))) {
    return res.status(400).json({ error: 'Uno de los modulos seleccionados no es valido.' });
  }
  const existingBusiness = await getBusinessProfile(id);
  if (req.body.settings?.aiEnabled !== undefined && typeof req.body.settings.aiEnabled !== 'boolean') {
    return res.status(400).json({ error: 'El modo de respuestas debe ser IA o automático.' });
  }
  if (typeof req.body.settings?.aiEnabled === 'boolean') {
    settings.aiEnabled = req.body.settings.aiEnabled;
    settings.aiModeRevision = settings.aiEnabled ? randomUUID() : existingBusiness?.settings?.aiModeRevision;
  } else if (typeof existingBusiness?.settings?.aiEnabled === 'boolean') {
    settings.aiEnabled = existingBusiness.settings.aiEnabled;
    settings.aiModeRevision = existingBusiness.settings.aiModeRevision;
  }
  if (settings.aiEnabled === true && !process.env.GEMINI_API_KEY) {
    return res.status(400).json({ error: 'Falta configurar la clave de Gemini en el servidor para habilitar respuestas con IA.' });
  }
  if (settings.aiEnabled === true && !flows.includes('reservas')) {
    return res.status(400).json({ error: 'Activá el módulo Reservas para usar las respuestas con IA.' });
  }
  if (flows.some((flow) => ['reservas', 'registro'].includes(flow))
    && (!(apiUrl || existingBusiness?.apiUrl) || (!apiKey && !existingBusiness?.apiKey))) {
    return res.status(400).json({ error: 'Reservas y registro necesitan su URL y API key.' });
  }
  if (flows.includes('admin_agenda')
    && (!(adminApiUrl || existingBusiness?.adminApiUrl) || (!adminApiKey && !existingBusiness?.adminApiKey))) {
    return res.status(400).json({ error: 'La agenda administrativa necesita su URL y API key.' });
  }

  const business = await saveBusinessProfile({
    id,
    name,
    flowType,
    flows,
    apiUrl,
    apiKey,
    adminApiUrl,
    adminApiKey,
    settings,
    adminPhones
  });
  const privateBusiness = await getBusinessProfile(id);
  for (const session of sessions.values()) {
    if (session.businessId === id) applyBusinessProfile(session, privateBusiness);
  }
  emitAdminEvent('business:update', { business });
  return res.status(201).json({ ok: true, business });
});

app.post('/clients', createClientHandler);

app.use('/clients/:clientName', ensureSessionForRequest);

app.post('/clients/:clientName/start', startSessionHandler);

app.post('/clients/:clientName/reset', resetSessionHandler);

app.post('/clients/:clientName/aliases', linkAliasHandler);
app.post('/clients/:clientName/unlink-customer', adminAuth, apiAuth, unlinkCustomerHandler);

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

app.post('/clients/:clientName/send', apiAuth, sendMessageHandler);

app.post('/clients/:clientName/birthday-invitation', apiAuth, birthdayInvitationHandler);

app.post('/clients/:clientName/logout', apiAuth, async (req, res) => {
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

app.post('/sessions/:sessionId/send', apiAuth, sendMessageHandler);

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

app.post('/send', apiAuth, (req, res) => {
  const requested = req.body.botSession;
  if (requested && !sessions.has(requested)) return res.status(404).json({ error: 'Sesión de WhatsApp no disponible.' });
  req.whatsappSession = requested ? sessions.get(requested) : getOrCreateSession(DEFAULT_SESSION_ID);
  return sendMessageHandler(req, res);
});

app.post('/logout', apiAuth, async (req, res) => {
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
  if (isDatabaseEnabled()) {
    const clients = await listDbClients();
    const knownClientIds = new Set(clients.map((client) => client.id));
    const manualRecoveryStatuses = new Set(['logged_out', 'connection_replaced', 'relink_required']);
    for (const client of clients.filter((item) => !manualRecoveryStatuses.has(item.status))) {
      const clientName = client.clientName || client.id;
      getOrCreateSession(clientName, {
        id: client.businessId,
        name: client.businessName,
        flowType: client.flowType,
        flows: client.flows,
        apiUrl: client.apiUrl,
        apiKey: client.apiKey,
        adminApiUrl: client.adminApiUrl,
        adminApiKey: client.adminApiKey,
        settings: client.settings
      });
      connectSession(clientName).catch((error) => {
        logger.warn({ clientName, error }, 'No se pudo auto-iniciar cliente');
      });
    }

    const entries = await fs.readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory() && !knownClientIds.has(item.name))) {
      connectSession(entry.name).catch((error) => {
        logger.warn({ clientName: entry.name, error }, 'No se pudo migrar la sesion local');
      });
    }
    return;
  }

  const entries = await fs.readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory())) {
    connectSession(entry.name).catch((error) => {
      logger.warn({ clientName: entry.name, error }, 'No se pudo auto-iniciar cliente');
    });
  }
}

startServer().catch((error) => {
  logger.error({ error }, 'No se pudo iniciar el servidor');
  process.exit(1);
});
