import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || '';
const databaseEnabled = Boolean(DATABASE_URL);

const pool = databaseEnabled
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    })
  : null;

export function isDatabaseEnabled() {
  return databaseEnabled;
}

export async function initDatabase() {
  if (!pool) return;

  await pool.query(`
    create table if not exists clients (
      id text primary key,
      client_name text not null,
      session_dir text not null,
      status text not null default 'idle',
      user_jid text,
      user_name text,
      last_error jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists conversations (
      id bigserial primary key,
      client_id text not null references clients(id) on delete cascade,
      jid text not null,
      push_name text,
      last_message_text text,
      last_message_at timestamptz,
      unread_count integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (client_id, jid)
    );

    create table if not exists messages (
      id bigserial primary key,
      client_id text not null references clients(id) on delete cascade,
      conversation_id bigint references conversations(id) on delete set null,
      whatsapp_message_id text,
      direction text not null check (direction in ('incoming', 'outgoing')),
      message_type text,
      from_jid text,
      to_jid text,
      push_name text,
      text text,
      raw jsonb,
      delivery_status text,
      message_timestamp timestamptz,
      created_at timestamptz not null default now(),
      unique (client_id, whatsapp_message_id, direction)
    );

    alter table messages add column if not exists delivery_status text;

    create index if not exists idx_conversations_client_updated
      on conversations (client_id, updated_at desc);

    create index if not exists idx_messages_client_created
      on messages (client_id, created_at desc);

    create index if not exists idx_messages_conversation_created
      on messages (conversation_id, created_at desc);

    create table if not exists conversation_aliases (
      client_id text not null references clients(id) on delete cascade,
      alias_jid text not null,
      canonical_jid text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (client_id, alias_jid)
    );

    create table if not exists lid_verification_requests (
      client_id text not null references clients(id) on delete cascade,
      lid_jid text not null,
      last_requested_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      primary key (client_id, lid_jid)
    );
  `);
}

export async function upsertClient(session) {
  if (!pool) return;

  await pool.query(
    `
      insert into clients (id, client_name, session_dir, status, user_jid, user_name, last_error, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (id) do update set
        client_name = excluded.client_name,
        session_dir = excluded.session_dir,
        status = excluded.status,
        user_jid = excluded.user_jid,
        user_name = excluded.user_name,
        last_error = excluded.last_error,
        updated_at = now()
    `,
    [
      session.id,
      session.clientName,
      session.dir,
      session.status,
      session.sock?.user?.id || null,
      session.sock?.user?.name || null,
      session.lastError ? JSON.stringify(session.lastError) : null
    ]
  );
}

export async function listDbClients() {
  if (!pool) return [];

  const result = await pool.query(`
    select id, client_name as "clientName", session_dir as dir, status, user_jid as "userJid",
      user_name as "userName", last_error as "lastError", created_at as "createdAt", updated_at as "updatedAt"
    from clients
    order by updated_at desc
  `);

  return result.rows;
}

export async function deleteDbClient(clientId) {
  if (!pool) return;

  await pool.query('delete from clients where id = $1', [clientId]);
}

function toMessageDate(value) {
  if (!value) return null;

  const seconds = Number(typeof value === 'object' && 'low' in value ? value.low : value);
  if (!Number.isFinite(seconds)) return null;

  return new Date(seconds * 1000);
}

async function resolveConversationJid(clientId, jid) {
  const result = await pool.query(
    'select canonical_jid from conversation_aliases where client_id = $1 and alias_jid = $2',
    [clientId, jid]
  );

  return result.rows[0]?.canonical_jid || jid;
}

export async function isConversationAliasLinked(clientId, aliasJid) {
  if (!pool || !clientId || !aliasJid) return false;

  const result = await pool.query(
    `
      select 1
      from conversation_aliases
      where client_id = $1
        and alias_jid = $2
        and canonical_jid <> alias_jid
      limit 1
    `,
    [clientId, aliasJid]
  );

  return result.rowCount > 0;
}

export async function shouldAskForLidVerification(clientId, lidJid) {
  if (!pool || !clientId || !lidJid?.endsWith('@lid')) return false;
  if (await isConversationAliasLinked(clientId, lidJid)) return false;

  const result = await pool.query(
    `
      insert into lid_verification_requests (client_id, lid_jid, last_requested_at)
      values ($1, $2, now())
      on conflict (client_id, lid_jid) do update set
        last_requested_at = case
          when lid_verification_requests.last_requested_at < now() - interval '24 hours'
          then now()
          else lid_verification_requests.last_requested_at
        end
      returning last_requested_at > now() - interval '5 seconds' as "shouldAsk"
    `,
    [clientId, lidJid]
  );

  return Boolean(result.rows[0]?.shouldAsk);
}

export async function hasRecentLidVerificationRequest(clientId, lidJid) {
  if (!pool || !clientId || !lidJid?.endsWith('@lid')) return false;

  const result = await pool.query(
    `
      select 1
      from lid_verification_requests
      where client_id = $1
        and lid_jid = $2
        and last_requested_at > now() - interval '7 days'
      limit 1
    `,
    [clientId, lidJid]
  );

  return result.rowCount > 0;
}

async function inferCanonicalForUnknownLid(clientId, lidJid) {
  if (!lidJid?.endsWith('@lid')) return null;

  const existing = await resolveConversationJid(clientId, lidJid);
  if (existing !== lidJid) return existing;

  const result = await pool.query(
    `
      select c.jid
      from conversations c
      where c.client_id = $1
        and c.jid like '%@s.whatsapp.net'
        and c.updated_at > now() - interval '2 hours'
        and not exists (
          select 1
          from messages incoming
          where incoming.conversation_id = c.id
            and incoming.direction = 'incoming'
        )
        and exists (
          select 1
          from messages outgoing
          where outgoing.conversation_id = c.id
            and outgoing.direction = 'outgoing'
        )
      order by c.updated_at desc
      limit 2
    `,
    [clientId]
  );

  return result.rowCount === 1 ? result.rows[0].jid : null;
}

export async function linkConversationAlias(clientId, aliasJid, canonicalJid) {
  if (!pool || !clientId || !aliasJid || !canonicalJid) return null;

  const client = await pool.connect();

  try {
    await client.query('begin');

    await client.query(
      `
        insert into conversation_aliases (client_id, alias_jid, canonical_jid, updated_at)
        values ($1, $2, $3, now()), ($1, $3, $3, now())
        on conflict (client_id, alias_jid) do update set
          canonical_jid = excluded.canonical_jid,
          updated_at = now()
      `,
      [clientId, aliasJid, canonicalJid]
    );

    const target = await client.query(
      'select id from conversations where client_id = $1 and jid = $2',
      [clientId, canonicalJid]
    );
    const source = await client.query(
      'select id, push_name from conversations where client_id = $1 and jid = $2',
      [clientId, aliasJid]
    );

    if (source.rowCount && !target.rowCount) {
      await client.query(
        'update conversations set jid = $3, updated_at = now() where client_id = $1 and jid = $2',
        [clientId, aliasJid, canonicalJid]
      );
    }

    if (source.rowCount && target.rowCount && source.rows[0].id !== target.rows[0].id) {
      await client.query(
        'update messages set conversation_id = $1 where conversation_id = $2',
        [target.rows[0].id, source.rows[0].id]
      );

      const latest = await client.query(
        `
          select text, message_timestamp, created_at
          from messages
          where conversation_id = $1
          order by created_at desc
          limit 1
        `,
        [target.rows[0].id]
      );

      await client.query(
        `
          update conversations set
            push_name = coalesce(push_name, $2),
            last_message_text = coalesce($3, last_message_text),
            last_message_at = coalesce($4, $5, last_message_at),
            updated_at = now()
          where id = $1
        `,
        [
          target.rows[0].id,
          source.rows[0].push_name || null,
          latest.rows[0]?.text || null,
          latest.rows[0]?.message_timestamp || null,
          latest.rows[0]?.created_at || null
        ]
      );
      await client.query('delete from conversations where id = $1', [source.rows[0].id]);
    }

    await client.query('commit');
    return { clientId, aliasJid, canonicalJid };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function upsertConversation({ clientId, jid, pushName, text, messageDate, incoming }) {
  const canonicalJid = await resolveConversationJid(clientId, jid);
  const result = await pool.query(
    `
      insert into conversations (
        client_id, jid, push_name, last_message_text, last_message_at, unread_count, updated_at
      )
      values ($1, $2, $3, $4, coalesce($5, now()), $6, now())
      on conflict (client_id, jid) do update set
        push_name = coalesce(excluded.push_name, conversations.push_name),
        last_message_text = excluded.last_message_text,
        last_message_at = excluded.last_message_at,
        unread_count = conversations.unread_count + excluded.unread_count,
        updated_at = now()
      returning id
    `,
    [clientId, canonicalJid, pushName || null, text || null, messageDate, incoming ? 1 : 0]
  );

  return result.rows[0].id;
}

export async function saveIncomingMessage(session, payload) {
  if (!pool) return;

  const inferredCanonical = await inferCanonicalForUnknownLid(session.id, payload.from);
  if (inferredCanonical) {
    await linkConversationAlias(session.id, payload.from, inferredCanonical);
  }

  const messageDate = toMessageDate(payload.timestamp);
  const conversationId = await upsertConversation({
    clientId: session.id,
    jid: payload.from,
    pushName: payload.pushName,
    text: payload.text,
    messageDate,
    incoming: true
  });

  await pool.query(
    `
      insert into messages (
        client_id, conversation_id, whatsapp_message_id, direction, message_type,
        from_jid, to_jid, push_name, text, raw, message_timestamp
      )
      values ($1, $2, $3, 'incoming', $4, $5, $6, $7, $8, $9, $10)
      on conflict (client_id, whatsapp_message_id, direction) do nothing
    `,
    [
      session.id,
      conversationId,
      payload.id || null,
      payload.type || null,
      payload.from || null,
      session.sock?.user?.id || null,
      payload.pushName || null,
      payload.text || null,
      JSON.stringify(payload.raw || {}),
      messageDate
    ]
  );
}

export async function saveOutgoingMessage(session, { to, text, result, messageId, raw, timestamp, messageType }) {
  if (!pool) return;

  const whatsappMessageId = messageId || result?.key?.id || null;
  const messageDate = timestamp ? toMessageDate(timestamp) || new Date() : new Date();
  const conversationId = await upsertConversation({
    clientId: session.id,
    jid: to,
    pushName: null,
    text,
    messageDate,
    incoming: false
  });

  await pool.query(
    `
      insert into messages (
        client_id, conversation_id, whatsapp_message_id, direction, message_type,
        from_jid, to_jid, text, raw, delivery_status, message_timestamp
      )
      values ($1, $2, $3, 'outgoing', $4, $5, $6, $7, $8, $9, $10)
      on conflict (client_id, whatsapp_message_id, direction) do nothing
    `,
    [
      session.id,
      conversationId,
      whatsappMessageId,
      messageType || 'text',
      session.sock?.user?.id || null,
      to,
      text,
      JSON.stringify(raw || result || {}),
      String(raw?.status || result?.status || 'unknown'),
      messageDate
    ]
  );
}

export async function updateMessageDeliveryStatus(clientId, whatsappMessageId, status) {
  if (!pool || !clientId || !whatsappMessageId) return;

  await pool.query(
    `
      update messages
      set delivery_status = $3
      where client_id = $1 and whatsapp_message_id = $2
    `,
    [clientId, whatsappMessageId, String(status)]
  );
}

export async function listConversations(clientId) {
  if (!pool) return [];

  const result = await pool.query(
    `
      select id, client_id as "clientId", jid, push_name as "pushName",
        last_message_text as "lastMessageText", last_message_at as "lastMessageAt",
        unread_count as "unreadCount", created_at as "createdAt", updated_at as "updatedAt"
      from conversations
      where client_id = $1
      order by updated_at desc
    `,
    [clientId]
  );

  return result.rows;
}

export async function listUnlinkedLidConversations(clientId) {
  if (!pool) return [];

  const result = await pool.query(
    `
      select c.id, c.client_id as "clientId", c.jid, c.push_name as "pushName",
        c.last_message_text as "lastMessageText", c.last_message_at as "lastMessageAt",
        c.updated_at as "updatedAt"
      from conversations c
      left join conversation_aliases a
        on a.client_id = c.client_id
       and a.alias_jid = c.jid
       and a.canonical_jid <> c.jid
      where c.client_id = $1
        and c.jid like '%@lid'
        and a.alias_jid is null
      order by c.updated_at desc
    `,
    [clientId]
  );

  return result.rows;
}

export async function listMessages(clientId, jid, limit = 100) {
  if (!pool) return [];

  const result = await pool.query(
    `
      select m.id, m.client_id as "clientId", m.whatsapp_message_id as "whatsappMessageId",
        m.direction, m.message_type as "messageType", m.from_jid as "from",
        m.to_jid as "to", m.push_name as "pushName", m.text, m.message_timestamp as "messageTimestamp",
        m.delivery_status as "deliveryStatus", m.created_at as "createdAt"
      from messages m
      left join conversations c on c.id = m.conversation_id
      where m.client_id = $1 and ($2::text is null or c.jid = $2)
      order by m.created_at desc
      limit $3
    `,
    [clientId, jid || null, Math.min(Number(limit) || 100, 500)]
  );

  return result.rows;
}
