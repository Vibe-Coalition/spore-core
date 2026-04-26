-- email plugin install SQL.
--
-- 1) Backfill: legacy installs created ref-email + its aspects/attributes/edges
--    with extracted_with='seed' via the in-tree migrate-ref-email.sql. Retag
--    everything tied to the ref-email node so future uninstall finds it.
-- 2) Idempotent insert (WHERE NOT EXISTS) of the node + aspects + attributes
--    + edge with extracted_with='{{plugin_id}}'. The {{plugin_id}} token is
--    substituted by the plugin manager.

-- ── Backfill legacy seed-tagged rows ──────────────────────────────
UPDATE nodes
   SET extracted_with = '{{plugin_id}}'
 WHERE id = 'ref-email'
   AND extracted_with = 'seed';

UPDATE aspects
   SET extracted_with = '{{plugin_id}}'
 WHERE node_id = 'ref-email'
   AND extracted_with = 'seed';

UPDATE attributes
   SET extracted_with = '{{plugin_id}}'
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-email')
   AND extracted_with = 'seed';

UPDATE edges
   SET extracted_with = '{{plugin_id}}'
 WHERE target = 'ref-email'
   AND extracted_with = 'seed';

-- ── Node ──────────────────────────────────────────────────────────
INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-email', 'Email (send + read)', 'reference',
  'The agent has its own mailbox when the operator wires up an email provider in Settings → Plugins → Email. Exposes four tools for sending and reading mail via SMTP + IMAP. Proton + Gmail are supported with provider-default hosts.',
  9, '{{plugin_id}}');

-- ── Overview aspect ───────────────────────────────────────────────
INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-email', 'overview', 10, '{{plugin_id}}'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='overview');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview'),
         'When configured, the agent gets email_send / email_list / email_read / email_search tools. If the operator has not set up email in Settings, those tools simply don''t exist in your toolbelt — do not fabricate an email address.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview') AND content LIKE 'When configured, the agent gets%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview'),
         'The mailbox is owned by the operator — you are authoring on their behalf. Treat every external recipient as high-stakes: when in doubt, confirm contents with the operator before calling email_send.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview') AND content LIKE 'The mailbox is owned by the operator%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview'),
         'Proton uses their SMTP submission service (smtp.protonmail.ch:587 + imap.protonmail.ch:993) with an SMTP token generated in Proton settings (requires a paid Proton Mail plan). The operator manages the credentials in the Plugins settings pane.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview') AND content LIKE 'Proton uses their SMTP submission service%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview'),
         'Google (Gmail / Workspace) uses smtp.gmail.com:587 + imap.gmail.com:993. Requires 2-Step Verification on the account + an App Password (not the regular password), and IMAP must be enabled in Gmail Settings → Forwarding and POP/IMAP. Works with both free Gmail and paid Workspace.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='overview') AND content LIKE 'Google (Gmail / Workspace)%');

-- ── Send aspect ───────────────────────────────────────────────────
INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-email', 'send', 9, '{{plugin_id}}'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='send');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='send'),
         'email_send { to, subject, body, isHtml?, cc?, bcc? } — From is always the configured mailbox. to/cc/bcc are comma-separated. body is plain text unless isHtml=true.',
         9, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='send')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='send') AND content LIKE 'email_send { to, subject%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='send'),
         'Before sending to external recipients: confirm the recipient list + subject + core message with the operator in chat, unless they explicitly authorised sending on their behalf for this task.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='send')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='send') AND content LIKE 'Before sending to external recipients%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='send'),
         'Never attach secrets (API keys, tokens, passwords) to outgoing mail. Never auto-reply to unknown senders — let the operator decide.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='send')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='send') AND content LIKE 'Never attach secrets%');

-- ── Read aspect ───────────────────────────────────────────────────
INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-email', 'read', 9, '{{plugin_id}}'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='read');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='read'),
         'email_list { folder?, limit?, unreadOnly? } — newest-first summaries (uid, from, to, subject, date, preview). Default folder is INBOX. Use to scan the mailbox quickly.',
         9, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='read')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='read') AND content LIKE 'email_list {%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='read'),
         'email_read { uid, folder?, markSeen? } — full headers + text/html body + attachment metadata for a single message. Only call for UIDs that email_list / email_search returned.',
         9, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='read')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='read') AND content LIKE 'email_read {%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='read'),
         'email_search { folder?, from?, to?, subject?, body?, since?, before?, unreadOnly?, limit? } — filters AND together. since/before are YYYY-MM-DD. Use this before falling back to fetching every recent message.',
         9, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='read')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='read') AND content LIKE 'email_search {%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='read'),
         'Attachments: email_read returns filename/contentType/size but not the bytes themselves. If the operator needs an attachment read, tell them to drag the file into chat instead.',
         7, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='read')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='read') AND content LIKE 'Attachments: email_read%');

-- ── Troubleshooting aspect ────────────────────────────────────────
INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-email', 'troubleshooting', 7, '{{plugin_id}}'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting'),
         'Auth errors usually mean the operator pasted their Proton LOGIN password instead of an SMTP token. Tell them to generate an SMTP token at Proton → Settings → IMAP/SMTP.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting') AND content LIKE 'Auth errors usually mean%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting'),
         '"Connection refused" on Proton SMTP/IMAP direct hosts → they require Proton Mail Plus or higher. Free accounts need the Bridge app running on the operator''s machine, reachable over tailscale.',
         7, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting') AND content LIKE '"Connection refused"%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting'),
         'Gmail 535 auth errors → the operator likely used their Google login password. Tell them to generate an App Password: myaccount.google.com → Security → 2-Step Verification → App passwords. 2-Step Verification must already be on.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting') AND content LIKE 'Gmail 535 auth errors%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting'),
         'Gmail IMAP returns zero messages → the operator hasn''t enabled IMAP yet. Gmail Settings → Forwarding and POP/IMAP → IMAP Access → Enable.',
         7, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting') AND content LIKE 'Gmail IMAP returns zero messages%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting'),
         'Gmail folders are labels under `[Gmail]/` — e.g. `[Gmail]/Sent Mail`, `[Gmail]/All Mail`, `[Gmail]/Trash`. Default INBOX works normally; if the operator asks about Sent or All mail, pass the bracketed folder name.',
         7, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-email' AND name='troubleshooting')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-email' AND name='troubleshooting') AND content LIKE 'Gmail folders are labels%');

-- ── Edge: agent self → ref-email ──────────────────────────────────
INSERT INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-email', 'documents', 0.8, '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='spore')
    AND EXISTS (SELECT 1 FROM nodes WHERE id='ref-email')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-email' AND type='documents');
