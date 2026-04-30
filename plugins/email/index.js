// Email plugin — SMTP send + IMAP read.
//
// Originally lived inline in src/tools/tools.js (_emailSendTool, _emailListTool,
// _emailReadTool, _emailSearchTool) plus settings UI in src/static/graph-viewer.html
// plus persistence endpoints in src/gateways/web.js. All migrated here.
//
// Provider defaults for Proton + Gmail are baked in. Operator brings their own
// SMTP token (Proton) or App Password (Gmail). All four tools fall through
// configuration validation and return user-readable errors when half-configured.

const PROVIDER_DEFAULTS = {
  proton: { smtpHost: 'smtp.protonmail.ch', smtpPort: 587, smtpSecure: false, imapHost: 'imap.protonmail.ch', imapPort: 993, imapSecure: true },
  google: { smtpHost: 'smtp.gmail.com',     smtpPort: 587, smtpSecure: false, imapHost: 'imap.gmail.com',     imapPort: 993, imapSecure: true },
};

// ── One-time legacy migration ──────────────────────────────────────
// SPORE used to keep email config at top-level (config.emailProvider, etc.).
// Settings now live under config.plugins.email. On first install, copy any
// legacy keys forward so existing operators don't have to re-enter creds.
const LEGACY_KEY_MAP = {
  emailProvider:     'provider',
  emailAddress:      'address',
  emailSmtpHost:     'smtpHost',
  emailSmtpPort:     'smtpPort',
  emailSmtpSecure:   'smtpSecure',
  emailSmtpUsername: 'smtpUsername',
  emailSmtpPassword: 'smtpPassword',
  emailImapHost:     'imapHost',
  emailImapPort:     'imapPort',
  emailImapSecure:   'imapSecure',
};

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return; // already migrated
  const host = api.getHostConfig();
  const patch = {};
  let any = false;
  for (const [legacy, modern] of Object.entries(LEGACY_KEY_MAP)) {
    const v = host[legacy];
    if (v !== undefined && v !== null && v !== '') {
      patch[modern] = v;
      any = true;
    }
  }
  if (any) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated ${Object.keys(patch).length} legacy email config key(s) into plugins.email`);
  }
}

// ── Config resolution (provider defaults + presence checks) ────────
function resolveConfig(cfg) {
  if (!cfg.provider || !cfg.smtpPassword) return { ok: false, error: 'Email not configured. Open Settings → Plugins → Email and fill in provider, address, and SMTP token / app password.' };
  if (!cfg.address) return { ok: false, error: 'Email address not set in plugin settings.' };
  const defaults = PROVIDER_DEFAULTS[cfg.provider] || {};
  return {
    ok: true,
    provider: cfg.provider,
    address: cfg.address,
    username: cfg.smtpUsername || cfg.address,
    password: cfg.smtpPassword,
    smtpHost: cfg.smtpHost || defaults.smtpHost,
    smtpPort: Number(cfg.smtpPort) || defaults.smtpPort || 587,
    smtpSecure: cfg.smtpSecure === true,
    imapHost: cfg.imapHost || defaults.imapHost,
    imapPort: Number(cfg.imapPort) || defaults.imapPort || 993,
    imapSecure: cfg.imapSecure !== false,
  };
}

// ── SMTP send ──────────────────────────────────────────────────────
async function sendEmail(api, input) {
  const { to, subject, body, isHtml, cc, bcc } = input;
  if (!to || !subject || !body) return { error: 'to, subject, and body are required' };
  const cfg = resolveConfig(api.getConfig());
  if (!cfg.ok) return { error: cfg.error };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { return { error: 'nodemailer not installed — run npm install nodemailer and restart' }; }
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpSecure,
      auth: { user: cfg.username, pass: cfg.password },
      connectionTimeout: 15000,
    });
    const info = await transporter.sendMail({
      from: cfg.address,
      to, subject,
      cc: cc || undefined,
      bcc: bcc || undefined,
      text: isHtml ? undefined : String(body),
      html: isHtml ? String(body) : undefined,
    });
    api.getLogger().info(`${cfg.address} → ${to} — ${info.messageId || 'sent'}`);
    return { ok: true, messageId: info.messageId || null, accepted: info.accepted || [], rejected: info.rejected || [] };
  } catch (e) {
    return { error: 'send failed: ' + (e.message || String(e)).slice(0, 300) };
  }
}

// ── IMAP plumbing ──────────────────────────────────────────────────
async function imapConnect(api) {
  const cfg = resolveConfig(api.getConfig());
  if (!cfg.ok) return { error: cfg.error };
  let ImapFlow;
  try { ImapFlow = require('imapflow').ImapFlow; } catch { return { error: 'imapflow not installed — run npm install imapflow and restart' }; }
  const client = new ImapFlow({
    host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapSecure,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    emitLogs: false,
  });
  try { await client.connect(); } catch (e) { return { error: 'imap connect failed: ' + (e.message || String(e)).slice(0, 300) }; }
  return { ok: true, client };
}

function summarize(parsed, envelope, uid) {
  const from = (envelope?.from || []).map(a => a.address || a.name).filter(Boolean).join(', ');
  const to = (envelope?.to || []).map(a => a.address || a.name).filter(Boolean).join(', ');
  const text = String(parsed?.text || parsed?.html || '').replace(/\s+/g, ' ').slice(0, 180);
  return { uid, from, to, subject: envelope?.subject || '', date: envelope?.date || null, preview: text };
}

async function listEmails(api, input) {
  const folder = String(input?.folder || 'INBOX');
  const limit = Math.max(1, Math.min(100, Number(input?.limit) || 20));
  const unreadOnly = !!input?.unreadOnly;
  const conn = await imapConnect(api);
  if (!conn.ok) return { error: conn.error };
  const client = conn.client;
  const results = [];
  try {
    await client.mailboxOpen(folder);
    const search = unreadOnly ? { seen: false } : { all: true };
    const uids = await client.search(search, { uid: true });
    const latest = uids.slice(-limit).reverse();
    for (const uid of latest) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) continue;
      let parsed = null;
      try { const { simpleParser } = require('mailparser'); parsed = await simpleParser(msg.source); } catch (e) { api.getLogger().warn('parse failed: ' + e.message); }
      results.push(summarize(parsed, msg.envelope, uid));
    }
  } catch (e) {
    await client.logout().catch(() => {});
    return { error: 'list failed: ' + (e.message || String(e)).slice(0, 300) };
  }
  await client.logout().catch(() => {});
  return { folder, count: results.length, messages: results };
}

async function readEmail(api, input) {
  const uid = Number(input?.uid);
  if (!Number.isFinite(uid)) return { error: 'uid required' };
  const folder = String(input?.folder || 'INBOX');
  const markSeen = input?.markSeen !== false;
  const conn = await imapConnect(api);
  if (!conn.ok) return { error: conn.error };
  const client = conn.client;
  try {
    await client.mailboxOpen(folder);
    const msg = await client.fetchOne(uid, { envelope: true, source: true, flags: true }, { uid: true });
    if (!msg) { await client.logout().catch(() => {}); return { error: `No message with uid ${uid} in ${folder}` }; }
    let parsed = {};
    try { const { simpleParser } = require('mailparser'); parsed = await simpleParser(msg.source); } catch (e) { api.getLogger().warn('parse failed: ' + e.message); }
    if (markSeen && msg.flags && !msg.flags.has?.('\\Seen')) {
      try { await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch (e) { api.getLogger().warn('mark-seen failed: ' + e.message); }
    }
    const out = {
      uid, folder,
      from: (msg.envelope?.from || []).map(a => a.address || a.name).filter(Boolean).join(', '),
      to: (msg.envelope?.to || []).map(a => a.address || a.name).filter(Boolean).join(', '),
      cc: (msg.envelope?.cc || []).map(a => a.address || a.name).filter(Boolean).join(', '),
      subject: msg.envelope?.subject || '',
      date: msg.envelope?.date || null,
      text: String(parsed.text || '').slice(0, 20000),
      html: parsed.html ? String(parsed.html).slice(0, 20000) : null,
      attachments: (parsed.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    };
    await client.logout().catch(() => {});
    return out;
  } catch (e) {
    await client.logout().catch(() => {});
    return { error: 'read failed: ' + (e.message || String(e)).slice(0, 300) };
  }
}

async function searchEmails(api, input) {
  const folder = String(input?.folder || 'INBOX');
  const limit = Math.max(1, Math.min(200, Number(input?.limit) || 30));
  const q = {};
  if (input?.from) q.from = String(input.from);
  if (input?.to) q.to = String(input.to);
  if (input?.subject) q.subject = String(input.subject);
  if (input?.body) q.body = String(input.body);
  if (input?.since) q.since = new Date(input.since);
  if (input?.before) q.before = new Date(input.before);
  if (input?.unreadOnly) q.seen = false;
  if (!Object.keys(q).length) return { error: 'at least one search filter required (from / to / subject / body / since / before / unreadOnly)' };
  const conn = await imapConnect(api);
  if (!conn.ok) return { error: conn.error };
  const client = conn.client;
  const results = [];
  try {
    await client.mailboxOpen(folder);
    const uids = await client.search(q, { uid: true });
    const latest = uids.slice(-limit).reverse();
    for (const uid of latest) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) continue;
      let parsed = null;
      try { const { simpleParser } = require('mailparser'); parsed = await simpleParser(msg.source); } catch (e) { api.getLogger().warn('parse failed: ' + e.message); }
      results.push(summarize(parsed, msg.envelope, uid));
    }
  } catch (e) {
    await client.logout().catch(() => {});
    return { error: 'search failed: ' + (e.message || String(e)).slice(0, 300) };
  }
  await client.logout().catch(() => {});
  return { folder, count: results.length, messages: results };
}

// ── Plugin registration ────────────────────────────────────────────
module.exports = function register(api) {
  // Reference nodes (ref-email + aspects/attrs/edge).
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  // One-time copy-forward of legacy top-level config keys.
  backfillLegacyConfig(api);

  // Settings pane — replaces the in-tree Email section under the Agent tab.
  api.registerSettingsPane({
    title: 'Email',
    description: 'Give the agent its own mailbox. Pick a provider; SMTP/IMAP defaults fill in. Bring your own SMTP token (Proton) or App Password (Gmail).',
    schema: [
      { key: 'provider', label: 'Provider', type: 'select',
        options: [
          { value: '', label: '(disabled)' },
          { value: 'proton', label: 'Proton Mail' },
          { value: 'google', label: 'Google (Gmail / Workspace)' },
        ],
      },
      { key: 'address',    label: 'Email address',     type: 'text' },
      { key: 'smtpHost',   label: 'SMTP host',         type: 'text' },
      { key: 'smtpPort',   label: 'SMTP port',         type: 'number', default: 587 },
      { key: 'smtpSecure', label: 'SMTP implicit TLS', type: 'toggle' },
      { key: 'smtpUsername', label: 'Username (blank = use email address)', type: 'text' },
      { key: 'smtpPassword', label: 'Password / SMTP token', type: 'password', secret: true,
        help: 'Proton: SMTP token from Proton settings. Gmail: App Password (requires 2-Step Verification).' },
      { key: 'imapHost',   label: 'IMAP host',         type: 'text' },
      { key: 'imapPort',   label: 'IMAP port',         type: 'number', default: 993 },
      { key: 'imapSecure', label: 'IMAP implicit TLS', type: 'toggle', default: true },
    ],
  });

  // Live status line in the agent prompt — tells the model whether email is
  // configured (and which mailbox) without round-tripping a tool call.
  api.registerPromptSection('full', 'Email', () => {
    const cfg = api.getConfig();
    if (cfg.provider && cfg.smtpPassword) {
      const addr = cfg.address || '(unset)';
      return `**Configured**: \`${addr}\` via ${cfg.provider}. Tools: email_send / email_list / email_read / email_search. See \`ref-email\` for usage rules (confirm external recipients first, never attach secrets).`;
    }
    if (cfg.provider || cfg.address) {
      return 'Half-configured. Tell the operator to finish Settings → Plugins → Email (missing password or provider).';
    }
    return null;
  });

  // ── Tools (bare names preserved via namespaced:false) ────────────
  api.registerTool('email_send', {
    namespaced: false,
    description: 'Send an email from the configured mailbox. Supports plain text or HTML. Use sparingly; confirm with the operator before sending anything high-stakes (external recipients, commitments, money).',
    inputSchema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient(s), comma-separated' },
        subject: { type: 'string', description: 'Subject line' },
        body:    { type: 'string', description: 'Message body (plain text unless isHtml=true)' },
        isHtml:  { type: 'boolean', description: 'Treat body as HTML (default false)' },
        cc:      { type: 'string', description: 'Cc recipient(s), comma-separated (optional)' },
        bcc:     { type: 'string', description: 'Bcc recipient(s), comma-separated (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: (input) => sendEmail(api, input),
  });

  api.registerTool('email_list', {
    namespaced: false,
    description: 'List recent messages in an email mailbox via IMAP. Default folder INBOX. Returns {uid, from, to, subject, date, preview} per message.',
    inputSchema: {
      type: 'object',
      properties: {
        folder:     { type: 'string', description: 'IMAP folder (default: INBOX)' },
        limit:      { type: 'number', description: 'Max messages to return (default 20, max 100)' },
        unreadOnly: { type: 'boolean', description: 'Only return unread messages (default false)' },
      },
      required: [],
    },
    execute: (input) => listEmails(api, input),
  });

  api.registerTool('email_read', {
    namespaced: false,
    description: 'Fetch the full body + headers of a single message by UID. Folder defaults to INBOX.',
    inputSchema: {
      type: 'object',
      properties: {
        uid:      { type: 'number', description: 'Message UID returned by email_list' },
        folder:   { type: 'string', description: 'IMAP folder (default: INBOX)' },
        markSeen: { type: 'boolean', description: 'Mark as read after fetching (default true)' },
      },
      required: ['uid'],
    },
    execute: (input) => readEmail(api, input),
  });

  api.registerTool('email_search', {
    namespaced: false,
    description: 'Search the mailbox via IMAP. Filters combine with AND. Returns summaries like email_list.',
    inputSchema: {
      type: 'object',
      properties: {
        folder:     { type: 'string', description: 'IMAP folder (default: INBOX)' },
        from:       { type: 'string', description: 'Match sender address/name (substring)' },
        to:         { type: 'string', description: 'Match recipient' },
        subject:    { type: 'string', description: 'Match subject (substring)' },
        body:       { type: 'string', description: 'Match message body (substring)' },
        since:      { type: 'string', description: 'Return messages since date (YYYY-MM-DD)' },
        before:     { type: 'string', description: 'Return messages before date (YYYY-MM-DD)' },
        unreadOnly: { type: 'boolean', description: 'Only unread (default false)' },
        limit:      { type: 'number', description: 'Max results (default 30, max 200)' },
      },
      required: [],
    },
    execute: (input) => searchEmails(api, input),
  });

  // Self-test endpoint: SMTP-send a self-mail, then IMAP-open the inbox.
  // Replaces the legacy POST /api/email/test endpoint.
  api.registerWebRoute('POST', '/test', async (req, res) => {
    const cfg = api.getConfig();
    if (!cfg.address) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'address not set' }));
      return;
    }
    const sendRes = await sendEmail(api, {
      to: cfg.address,
      subject: 'Spore Core email self-test',
      body: `Self-test at ${new Date().toISOString()} — if you see this, SMTP from ${cfg.address} is working.`,
    });
    if (sendRes.error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, stage: 'smtp', error: sendRes.error }));
      return;
    }
    const imapRes = await listEmails(api, { folder: 'INBOX', limit: 1 });
    if (imapRes.error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, stage: 'imap', error: imapRes.error, smtp: 'ok' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, smtp: 'ok', imap: 'ok', messageId: sendRes.messageId }));
  });

  api.getLogger().info('Plugin ready — 4 tools registered, settings pane mounted.');
};
