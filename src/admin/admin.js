const state = {
  clients: [],
  selectedClientId: null,
  selectedConversationJid: null,
  serverInfo: null,
  search: '',
  refreshTimer: null
};

const els = {
  systemStatus: document.querySelector('#system-status'),
  dbBadge: document.querySelector('#db-badge'),
  totalClients: document.querySelector('#total-clients'),
  connectedClients: document.querySelector('#connected-clients'),
  qrClients: document.querySelector('#qr-clients'),
  errorClients: document.querySelector('#error-clients'),
  refreshButton: document.querySelector('#refresh-button'),
  createClientForm: document.querySelector('#create-client-form'),
  clientNameInput: document.querySelector('#client-name-input'),
  clientSearchInput: document.querySelector('#client-search-input'),
  clientsList: document.querySelector('#clients-list'),
  emptyState: document.querySelector('#empty-state'),
  clientDetail: document.querySelector('#client-detail'),
  selectedClientTitle: document.querySelector('#selected-client-title'),
  selectedClientMeta: document.querySelector('#selected-client-meta'),
  selectedClientStatus: document.querySelector('#selected-client-status'),
  lastErrorBox: document.querySelector('#last-error-box'),
  startClientButton: document.querySelector('#start-client-button'),
  qrClientButton: document.querySelector('#qr-client-button'),
  resetClientButton: document.querySelector('#reset-client-button'),
  logoutClientButton: document.querySelector('#logout-client-button'),
  deleteClientButton: document.querySelector('#delete-client-button'),
  qrBox: document.querySelector('#qr-box'),
  qrFrame: document.querySelector('#qr-frame'),
  sendMessageForm: document.querySelector('#send-message-form'),
  messageToInput: document.querySelector('#message-to-input'),
  messageTextInput: document.querySelector('#message-text-input'),
  linkAliasForm: document.querySelector('#link-alias-form'),
  aliasLidInput: document.querySelector('#alias-lid-input'),
  aliasPhoneInput: document.querySelector('#alias-phone-input'),
  loadConversationsButton: document.querySelector('#load-conversations-button'),
  conversationsList: document.querySelector('#conversations-list'),
  conversationContext: document.querySelector('#conversation-context'),
  lidQuestionsPanel: document.querySelector('#lid-questions-panel'),
  loadLidsButton: document.querySelector('#load-lids-button'),
  lidQuestionsList: document.querySelector('#lid-questions-list'),
  loadMessagesButton: document.querySelector('#load-messages-button'),
  messagesList: document.querySelector('#messages-list'),
  messagesContext: document.querySelector('#messages-context'),
  toast: document.querySelector('#toast')
};

function selectedClient() {
  return state.clients.find((client) => client.id === state.selectedClientId) || null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === 'string' ? body : body.error || 'Error de API';
    throw new Error(message);
  }

  return body;
}

function statusLabel(client) {
  if (client?.connected) return 'open';
  return client?.status || 'idle';
}

function statusClass(status) {
  return `status-pill status-${String(status || 'idle')}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function filteredClients() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.clients;

  return state.clients.filter((client) => {
    const haystack = `${client.id} ${client.clientName || ''} ${client.status || ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderSummary() {
  const total = state.clients.length;
  const connected = state.clients.filter((client) => client.connected || client.status === 'open').length;
  const qr = state.clients.filter((client) => client.status === 'qr').length;
  const errors = state.clients.filter((client) => ['error', 'logged_out', 'closed'].includes(client.status)).length;

  els.totalClients.textContent = total;
  els.connectedClients.textContent = connected;
  els.qrClients.textContent = qr;
  els.errorClients.textContent = errors;
}

function renderClients() {
  const clients = filteredClients();
  els.clientsList.innerHTML = '';

  if (!clients.length) {
    els.clientsList.innerHTML = '<div class="muted-line">No hay clientes para mostrar.</div>';
    return;
  }

  for (const client of clients) {
    const status = statusLabel(client);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `client-item ${client.id === state.selectedClientId ? 'active' : ''}`;
    item.innerHTML = `
      <div class="client-row">
        <div>
          <div class="client-title">${escapeHtml(client.clientName || client.id)}</div>
          <div class="client-meta">${escapeHtml(client.id)}</div>
        </div>
        <span class="${statusClass(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="client-meta">${escapeHtml(client.userName || client.userJid || client.dir || '')}</div>
    `;
    item.addEventListener('click', () => selectClient(client.id));
    els.clientsList.appendChild(item);
  }
}

function renderSelectedClient() {
  const client = selectedClient();

  if (!client) {
    els.emptyState.classList.remove('hidden');
    els.clientDetail.classList.add('hidden');
    return;
  }

  const status = statusLabel(client);
  els.emptyState.classList.add('hidden');
  els.clientDetail.classList.remove('hidden');
  els.selectedClientTitle.textContent = client.clientName || client.id;
  els.selectedClientMeta.textContent = `${client.id} · ${client.userName || client.userJid || client.dir || 'sin usuario vinculado'}`;
  els.selectedClientStatus.className = statusClass(status);
  els.selectedClientStatus.textContent = status;

  const errorMessage = client.lastError?.message || client.lastError?.name || '';
  els.lastErrorBox.textContent = errorMessage ? `Ultimo error: ${errorMessage}` : '';
  els.lastErrorBox.classList.toggle('hidden', !errorMessage);

  const isOpen = status === 'open';
  els.sendMessageForm.querySelector('button').disabled = !isOpen;
}

function renderAll() {
  renderSummary();
  renderClients();
  renderSelectedClient();
}

async function loadServerInfo() {
  state.serverInfo = await api('/');
  const dbEnabled = Boolean(state.serverInfo.database?.enabled);

  els.systemStatus.textContent = `${dbEnabled ? 'PostgreSQL conectado' : 'PostgreSQL sin configurar'} · ${state.serverInfo.sessionRoot}`;
  els.dbBadge.textContent = dbEnabled ? 'DB conectada' : 'DB off';
  els.dbBadge.className = `badge ${dbEnabled ? 'badge-ok' : 'badge-off'}`;
}

async function loadClients() {
  state.clients = await api('/clients');

  if (state.selectedClientId && !state.clients.some((client) => client.id === state.selectedClientId)) {
    state.selectedClientId = null;
  }

  renderAll();
}

async function refreshAll() {
  await loadServerInfo();
  await loadClients();
}

function scheduleSelectedRefresh(clientId) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    await loadClients();

    if (state.selectedClientId && (!clientId || state.selectedClientId === clientId)) {
      await Promise.allSettled([loadConversations(), loadMessages(), loadUnlinkedLids()]);
    }
  }, 250);
}

function connectRealtimeEvents() {
  if (!window.EventSource) return;

  const source = new EventSource('/admin/events');

  source.addEventListener('ready', () => {
    showToast('Panel en tiempo real conectado.');
  });

  source.addEventListener('client:update', (event) => {
    const data = JSON.parse(event.data);
    scheduleSelectedRefresh(data.client?.id);
  });

  source.addEventListener('client:delete', () => {
    scheduleSelectedRefresh();
  });

  source.addEventListener('message:new', (event) => {
    const data = JSON.parse(event.data);
    scheduleSelectedRefresh(data.clientId);
  });

  source.addEventListener('message:update', (event) => {
    const data = JSON.parse(event.data);
    scheduleSelectedRefresh(data.clientId);
  });

  source.addEventListener('conversation:update', (event) => {
    const data = JSON.parse(event.data);
    scheduleSelectedRefresh(data.clientId);
  });

  source.onerror = () => {
    els.systemStatus.textContent = `${els.systemStatus.textContent.replace(' · tiempo real activo', '')} · reconectando tiempo real`;
  };
}

function selectClient(clientId) {
  state.selectedClientId = clientId;
  state.selectedConversationJid = null;
  els.qrBox.classList.add('hidden');
  els.conversationsList.innerHTML = '';
  els.messagesList.innerHTML = '';
  els.messagesContext.textContent = 'Ultimos mensajes del cliente';
  renderAll();
  loadConversations().catch((error) => showToast(error.message));
  loadMessages().catch((error) => showToast(error.message));
  loadUnlinkedLids().catch((error) => showToast(error.message));
}

async function createClient(event) {
  event.preventDefault();

  const clientName = els.clientNameInput.value.trim();
  if (!clientName) return;

  const result = await api('/clients', {
    method: 'POST',
    body: JSON.stringify({ clientName })
  });

  els.clientNameInput.value = '';
  state.selectedClientId = result.client.id;
  state.selectedConversationJid = null;
  showToast('Cliente creado. Abri el QR para vincular WhatsApp.');
  await loadClients();
  openQr();
}

async function runClientAction(action, successMessage) {
  const client = selectedClient();
  if (!client) return;

  await api(`/clients/${encodeURIComponent(client.id)}/${action}`, { method: 'POST' });
  showToast(successMessage);
  await loadClients();
}

async function deleteSelectedClient() {
  const client = selectedClient();
  if (!client) return;

  const confirmed = window.confirm(`Eliminar el cliente "${client.clientName || client.id}"? Se borran su sesion local y sus datos en PostgreSQL.`);
  if (!confirmed) return;

  await api(`/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE' });
  state.selectedClientId = null;
  state.selectedConversationJid = null;
  els.qrBox.classList.add('hidden');
  els.conversationsList.innerHTML = '';
  els.messagesList.innerHTML = '';
  showToast('Cliente eliminado.');
  await loadClients();
}

function openQr() {
  const client = selectedClient();
  if (!client) return;

  els.qrFrame.src = `/clients/${encodeURIComponent(client.id)}/qr`;
  els.qrBox.classList.remove('hidden');
}

async function sendMessage(event) {
  event.preventDefault();

  const client = selectedClient();
  if (!client) return;

  await api(`/clients/${encodeURIComponent(client.id)}/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: els.messageToInput.value.trim(),
      message: els.messageTextInput.value.trim()
    })
  });

  els.messageTextInput.value = '';
  showToast('Mensaje enviado.');
  await loadMessages();
}

async function linkAlias(event) {
  event.preventDefault();

  const client = selectedClient();
  if (!client) return;

  await api(`/clients/${encodeURIComponent(client.id)}/aliases`, {
    method: 'POST',
    body: JSON.stringify({
      lid: els.aliasLidInput.value.trim(),
      phone: els.aliasPhoneInput.value.trim()
    })
  });

  els.aliasLidInput.value = '';
  els.aliasPhoneInput.value = '';
  state.selectedConversationJid = null;
  showToast('Conversacion unificada.');
  await loadConversations();
  await loadMessages();
}

async function linkSpecificLid(lid, phone) {
  const client = selectedClient();
  if (!client) return;

  await api(`/clients/${encodeURIComponent(client.id)}/aliases`, {
    method: 'POST',
    body: JSON.stringify({ lid, phone })
  });

  showToast('LID relacionado con el numero.');
  state.selectedConversationJid = null;
  await Promise.all([loadUnlinkedLids(), loadConversations(), loadMessages()]);
}

async function loadUnlinkedLids() {
  const client = selectedClient();
  if (!client) return;

  const lids = await api(`/clients/${encodeURIComponent(client.id)}/unlinked-lids`);

  els.lidQuestionsPanel.classList.toggle('hidden', lids.length === 0);
  els.lidQuestionsList.innerHTML = '';

  if (!lids.length) return;

  for (const item of lids) {
    const row = document.createElement('div');
    row.className = 'lid-question-item';
    row.innerHTML = `
      <div>
        <div class="conversation-title">A que numero pertenece ${escapeHtml(item.pushName || item.jid)}?</div>
        <div class="conversation-meta">${escapeHtml(item.jid)}</div>
        <div class="conversation-meta">Ultimo mensaje: ${escapeHtml(item.lastMessageText || '')}</div>
      </div>
      <form class="lid-question-form">
        <input name="phone" placeholder="Ej: 5493885104530" required>
        <button type="submit">Relacionar</button>
      </form>
    `;

    row.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const phone = new FormData(event.currentTarget).get('phone');
      linkSpecificLid(item.jid, String(phone || '').trim()).catch((error) => showToast(error.message));
    });

    els.lidQuestionsList.appendChild(row);
  }
}

async function loadConversations() {
  const client = selectedClient();
  if (!client) return;

  els.conversationsList.innerHTML = '<div class="muted-line">Cargando conversaciones...</div>';
  const conversations = await api(`/clients/${encodeURIComponent(client.id)}/conversations`);
  els.conversationsList.innerHTML = '';
  els.conversationContext.textContent = conversations.length
    ? `${conversations.length} conversaciones guardadas`
    : 'Sin conversaciones guardadas';

  if (!conversations.length) {
    els.conversationsList.innerHTML = '<div class="muted-line">Todavia no hay conversaciones para este cliente.</div>';
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'client-item';
    item.innerHTML = `
      <div class="conversation-title">${escapeHtml(conversation.pushName || conversation.jid)}</div>
      <div class="conversation-meta">${escapeHtml(conversation.jid)}</div>
      <div class="conversation-meta">${escapeHtml(conversation.lastMessageText || '')}</div>
      <div class="conversation-meta">${escapeHtml(formatDate(conversation.updatedAt))}</div>
    `;
    item.addEventListener('click', () => {
      state.selectedConversationJid = conversation.jid;
      els.messageToInput.value = conversation.jid.replace('@s.whatsapp.net', '');
      if (conversation.jid.endsWith('@lid')) {
        els.aliasLidInput.value = conversation.jid;
        els.aliasPhoneInput.focus();
      }
      els.messagesContext.textContent = `Mensajes de ${conversation.pushName || conversation.jid}`;
      loadMessages().catch((error) => showToast(error.message));
    });
    els.conversationsList.appendChild(item);
  }
}

async function loadMessages() {
  const client = selectedClient();
  if (!client) return;

  const url = state.selectedConversationJid
    ? `/clients/${encodeURIComponent(client.id)}/conversations/${encodeURIComponent(state.selectedConversationJid)}/messages`
    : `/clients/${encodeURIComponent(client.id)}/messages`;

  els.messagesList.innerHTML = '<div class="muted-line">Cargando mensajes...</div>';
  const messages = await api(url);
  els.messagesList.innerHTML = '';

  if (!messages.length) {
    els.messagesList.innerHTML = '<div class="muted-line">Todavia no hay mensajes guardados.</div>';
    return;
  }

  for (const message of messages) {
    const item = document.createElement('div');
    item.className = `message-item ${message.direction || ''}`;
    const status = message.deliveryStatus ? ` · estado ${message.deliveryStatus}` : '';
    item.innerHTML = `
      <div class="message-title">${escapeHtml(message.direction || 'message')} · ${escapeHtml(message.from || message.to || '')}</div>
      <div class="message-meta">${escapeHtml(formatDate(message.createdAt || message.messageTimestamp))}${escapeHtml(status)}</div>
      <div>${escapeHtml(message.text || '')}</div>
    `;
    els.messagesList.appendChild(item);
  }
}

els.refreshButton.addEventListener('click', () => refreshAll().catch((error) => showToast(error.message)));
els.createClientForm.addEventListener('submit', (event) => createClient(event).catch((error) => showToast(error.message)));
els.clientSearchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderClients();
});
els.startClientButton.addEventListener('click', () => runClientAction('start', 'Cliente iniciado.').catch((error) => showToast(error.message)));
els.qrClientButton.addEventListener('click', openQr);
els.resetClientButton.addEventListener('click', () => runClientAction('reset', 'Sesion reseteada.').catch((error) => showToast(error.message)));
els.logoutClientButton.addEventListener('click', () => runClientAction('logout', 'Sesion cerrada.').catch((error) => showToast(error.message)));
els.deleteClientButton.addEventListener('click', () => deleteSelectedClient().catch((error) => showToast(error.message)));
els.sendMessageForm.addEventListener('submit', (event) => sendMessage(event).catch((error) => showToast(error.message)));
els.linkAliasForm.addEventListener('submit', (event) => linkAlias(event).catch((error) => showToast(error.message)));
els.loadConversationsButton.addEventListener('click', () => loadConversations().catch((error) => showToast(error.message)));
els.loadLidsButton.addEventListener('click', () => loadUnlinkedLids().catch((error) => showToast(error.message)));
els.loadMessagesButton.addEventListener('click', () => loadMessages().catch((error) => showToast(error.message)));

refreshAll().catch((error) => showToast(error.message));
connectRealtimeEvents();
setInterval(() => loadClients().catch(() => {}), 30000);
