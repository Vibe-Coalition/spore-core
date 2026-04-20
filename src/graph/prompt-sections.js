/**
 * prompt-sections.js — Prompt Section Builders
 *
 * All _build*Section methods that format graph data into prompt text.
 *
 */

const path = require('path');
const feed = require('./feed.js');

function _utcCalendarDaysSince(anchorUtcMidnight, now) {
  const a = Date.UTC(anchorUtcMidnight.getUTCFullYear(), anchorUtcMidnight.getUTCMonth(), anchorUtcMidnight.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((b - a) / 86400000);
}

function _parseIsoDateOnly(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Mixin: attaches prompt section methods to GraphContext.prototype ────────

function applyPromptSectionsMixin(GraphContext) {
  const proto = GraphContext.prototype;

  proto._buildEpisodesSection = function _buildEpisodesSection(messageContent, queryParams) {
    if (!messageContent) return null;
    const { QUERY_TYPE_PARAMS, _expandQueryTerms, SEARCH_STOPWORDS } = require('./retrieval');
    const qp = queryParams || QUERY_TYPE_PARAMS.specific;

    const episodes = this._searchEpisodes(messageContent, qp.episodeCount);

    const seenIds = new Set(episodes.map(e => e.id));
    try {
      const baseWords = messageContent.toLowerCase().replace(/[?!.,;:'"]/g, '').split(/\s+/)
        .filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w));
      const words = _expandQueryTerms(baseWords);
      if (words.length > 0) {
        const likeClauses = words.map(() => 'e.content LIKE ?').join(' OR ');
        const params = words.map(w => `%${w}%`);
        const extra = this.db.prepare(`
          SELECT e.id, e.content, e.observed_at, e.session_id
          FROM episodes e WHERE (${likeClauses})
          ORDER BY e.observed_at DESC LIMIT ?
        `).all(...params, Math.max(3, qp.episodeCount - episodes.length));
        for (const r of extra) {
          if (!seenIds.has(r.id)) {
            episodes.push({ id: r.id, content: r.content, observedAt: r.observed_at, sessionId: r.session_id });
            seenIds.add(r.id);
          }
        }
      }
    } catch { }

    if (episodes.length === 0) return null;

    // Check which episodes have facts that were later updated in the graph
    const superseded = this._findSupersededEpisodes
      ? this._findSupersededEpisodes(episodes.map(e => e.id))
      : new Map();

    const charLimit = qp.episodeCount > 6 ? 1000 : 600;
    const parts = ['## Raw Conversation Excerpts (from past sessions)'];
    for (const ep of episodes) {
      const dateTag = ep.observedAt ? ` [${ep.observedAt.substring(0, 10)}]` : '';
      const snippet = ep.content.length > charLimit ? ep.content.substring(0, charLimit) + '...' : ep.content;
      const overrides = superseded.get(ep.id);
      if (overrides && overrides.length > 0) {
        const corrections = overrides.map(o => `"${o.old}" → "${o.new}"`).join('; ');
        parts.push(`---${dateTag} ⚠️ PARTIALLY OUTDATED — graph later updated: ${corrections}\n${snippet}`);
      } else {
        parts.push(`---${dateTag}\n${snippet}`);
      }
    }
    return parts.join('\n');
  };

  proto._buildPersonaFraming = function _buildPersonaFraming() {
    const agentNode = this.getNode(this.config.agentId || 'spore');
    const directives = agentNode?.aspects?.find(a => a.name === 'agent_directives');

    if (directives && directives.attributes.length > 0) {
      const lines = directives.attributes
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .map(a => a.content);
      return lines.join('\n');
    }

    const name = agentNode?.label || this.config.displayName || 'this agent';
    return [
      `You are ${name} — a character with a distinct personality, not a generic assistant.`,
      'Fully embody the identity and voice described below. Do not fall back on default AI mannerisms.',
      'No "Great question!", no unsolicited caveats, no reflexive helpfulness. Just be yourself.',
      'In casual conversation, be natural — short messages are fine, imperfect grammar is fine, personality is more important than polish.',
      'Match the energy and register of whoever you are talking to unless your voice rules say otherwise.',
      'You may curse if the other person curses. You may use emojis if they do. Mirror their level of formality.',
    ].join('\n');
  };

  proto._buildIdentitySection = function _buildIdentitySection() {
    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (!agentNode) return '## Identity\nYou are an AI agent.';

    const identity = agentNode.aspects.find(a => a.name === 'identity');
    if (!identity) return `## Identity\n${agentNode.description}`;

    const lines = identity.attributes
      .sort((a, b) => (b.importance || 5) - (a.importance || 5))
      .map(a => `- ${a.content}`);

    return `## Identity\n${agentNode.description}\n\n${lines.join('\n')}`;
  };

  proto._buildVoiceSection = function _buildVoiceSection() {
    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (!agentNode) return null;

    const voice = agentNode.aspects.find(a => a.name === 'voice');
    if (!voice) return null;

    const lines = voice.attributes.map(a => `- ${a.content}`);
    return `## Voice\n${lines.join('\n')}`;
  };

  proto._buildRulesSection = function _buildRulesSection() {
    const parts = [];

    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (agentNode) {
      const rules = agentNode.aspects.find(a => a.name === 'hard_rules');
      if (rules) {
        const lines = rules.attributes
          .sort((a, b) => (b.importance || 5) - (a.importance || 5))
          .map((a, i) => `${i + 1}. ${a.content}`);
        parts.push(lines.join('\n'));
      }

      const privacy = agentNode.aspects.find(a => a.name === 'user_privacy');
      if (privacy) {
        const lines = privacy.attributes
          .sort((a, b) => (b.importance || 5) - (a.importance || 5))
          .map(a => `- ${a.content}`);
        parts.push(`### User Privacy & Confidentiality\n${lines.join('\n')}`);
      }

      const team = agentNode.aspects.find(a => a.name === 'team_context');
      if (team) {
        const lines = team.attributes
          .sort((a, b) => (b.importance || 5) - (a.importance || 5))
          .map(a => `- ${a.content}`);
        parts.push(`### Team Context (you serve multiple people)\n${lines.join('\n')}`);
      }

      const startup = agentNode.aspects.find(a => a.name === 'startup_rules');
      if (startup) {
        const lines = startup.attributes.map(a => `- ${a.content}`);
        parts.push(`### Startup\n${lines.join('\n')}`);
      }
    }

    const ruleNodes = this.getNodesByTypeSelf('rule');
    if (ruleNodes.length > 0) {
      const ruleLines = ruleNodes.map(r => `- **${r.label}**: ${r.description}`);
      parts.push(`### Rule Nodes\n${ruleLines.join('\n')}`);
    }

    return parts.length > 0 ? `## Rules\n${parts.join('\n\n')}` : null;
  };

  proto._buildReflectionsSection = function _buildReflectionsSection() {
    if (!this.db) return null;
    try {
      const rows = this.db.prepare(
        `SELECT r.content, n.label FROM reflections r
         LEFT JOIN nodes n ON n.id = r.node_id
         ORDER BY r.created DESC LIMIT 5`
      ).all();
      if (!rows || rows.length === 0) return null;
      const lines = rows.map(r => `- ${r.label ? `[${r.label}] ` : ''}${r.content}`);
      return `## Recent Reflections\n${lines.join('\n')}`;
    } catch { return null; }
  };

  proto._buildDerivedFactsSection = function _buildDerivedFactsSection(messageContent) {
    if (!this.db) return null;
    try {
      const hasTbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='derived_facts'").get();
      if (!hasTbl) return null;

      let facts = [];

      // If we have a query, find derived facts relevant to the search results
      if (messageContent) {
        const { SEARCH_STOPWORDS, _expandQueryTerms } = require('./retrieval');
        const words = messageContent.toLowerCase().replace(/[?!.,;:'"]/g, '').split(/\s+/)
          .filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w));
        const expanded = _expandQueryTerms(words);

        if (expanded.length > 0) {
          const likeClauses = expanded.map(() => 'df.content LIKE ?').join(' OR ');
          const params = expanded.map(w => `%${w}%`);
          facts = this.db.prepare(`
            SELECT df.content, df.reasoning_type, df.confidence, df.premises, df.source_node_ids
            FROM derived_facts df
            WHERE df.invalidated_at IS NULL AND (${likeClauses})
            ORDER BY df.created DESC LIMIT 8
          `).all(...params);
        }
      }

      // Also include recent high-confidence facts regardless of query match
      if (facts.length < 5) {
        const recent = this.db.prepare(`
          SELECT df.content, df.reasoning_type, df.confidence, df.premises, df.source_node_ids
          FROM derived_facts df
          WHERE df.invalidated_at IS NULL AND df.confidence IN ('high', 'medium')
          ORDER BY df.created DESC LIMIT ?
        `).all(8 - facts.length);
        const seen = new Set(facts.map(f => f.content));
        for (const r of recent) {
          if (!seen.has(r.content)) {
            facts.push(r);
            seen.add(r.content);
          }
        }
      }

      if (facts.length === 0) return null;

      const lines = facts.map(f => {
        const tag = f.reasoning_type ? `[${f.reasoning_type}]` : '[derived]';
        const conf = f.confidence === 'high' ? '' : ` (${f.confidence} confidence)`;
        return `- ${tag} ${f.content}${conf}`;
      });

      return `## Derived Conclusions\nInferences drawn from accumulated knowledge — not directly stated but logically derived:\n${lines.join('\n')}`;
    } catch { return null; }
  };

  proto._buildGapsSection = function _buildGapsSection() {
    if (!this.db) return null;
    try {
      const rows = this.db.prepare(
        `SELECT g.content, n.label FROM gaps g
         LEFT JOIN nodes n ON n.id = g.node_id
         WHERE g.status = 'open' ORDER BY g.created DESC LIMIT 5`
      ).all();
      if (!rows || rows.length === 0) return null;
      const lines = rows.map(g => `- ${g.label ? `[${g.label}] ` : ''}${g.content}`);
      return `## Open Questions\nThings you're curious about or want to explore when relevant:\n${lines.join('\n')}`;
    } catch { return null; }
  };

  proto._buildPluginSection = function _buildPluginSection() {
    if (!this._pluginManager) return null;
    const engines = this._pluginManager.getContextEngines();
    if (engines.length === 0) return null;

    const parts = [];
    for (const { name, engine } of engines) {
      try {
        const result = typeof engine.assemble === 'function' ? engine.assemble({
          total: GraphContext.SECTION_BUDGETS.plugin,
          used: 0,
          remaining: GraphContext.SECTION_BUDGETS.plugin,
        }) : null;
        if (result && typeof result === 'string') parts.push(result);
        else if (result?.text) parts.push(result.text);
      } catch {
      }
    }
    return parts.length > 0 ? `## Plugin Context\n${parts.join('\n\n')}` : null;
  };

  proto._buildChannelSection = function _buildChannelSection(channelId, channelName) {
    const parts = [];

    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (agentNode) {
      const channels = agentNode.aspects.find(a => a.name === 'channel_awareness');
      if (channels) {
        const lines = channels.attributes.map(a => `- ${a.content}`);
        parts.push(lines.join('\n'));
      }
    }

    if (channelId || channelName) {
      const channelNode = this._findChannelNode(channelId, channelName);
      if (channelNode) {
        parts.push(`### Current Channel: ${channelNode.label}`);
        if (channelNode.description) {
          parts.push(channelNode.description);
        }

        for (const asp of channelNode.aspects || []) {
          if (asp.name.includes('rule') || asp.name.includes('policy')) {
            const lines = asp.attributes.map(a => `- ${a.content}`);
            parts.push(`**${asp.name}**: ${lines.join(' ')}`);
          }
        }
      }
    }

    return parts.length > 0 ? `## Channel Awareness\n${parts.join('\n\n')}` : null;
  };

  proto._findChannelNode = function _findChannelNode(channelId, channelName) {
    if (!channelId && !channelName) return null;

    if (channelId) {
      const rows = this.db.prepare(`
        SELECT * FROM nodes WHERE type = 'channel' 
        AND (description LIKE ? OR id LIKE ? OR extra LIKE ?)
        LIMIT 1
      `).all(`%${channelId}%`, `%${channelId}%`, `%${channelId}%`);
      if (rows.length > 0) return this._hydrateNode(rows[0]);
    }

    if (channelName) {
      const node = this.getNodeByLabel(`#${channelName}`) || this.getNodeByLabel(channelName);
      if (node && node.type === 'channel') return node;
    }

    return null;
  };

  proto._buildPersonSection = function _buildPersonSection(userId, userName) {
    if (!userName) return null;

    let person = this.getNodeByLabel(userName);

    if (!person && userId) {
      const rows = this.db.prepare(`
        SELECT DISTINCT n.* FROM nodes n
        LEFT JOIN aliases a ON a.node_id = n.id
        WHERE n.type = 'person'
        AND (n.description LIKE ? OR a.alias LIKE ? OR n.extra LIKE ?)
        LIMIT 1
      `).all(`%${userId}%`, `%${userId}%`, `%${userId}%`);
      if (rows.length > 0) person = this._hydrateNode(rows[0]);
    }

    if (!person || person.type !== 'person') {
      // No person node matches the current speaker — emit a stub so the agent
      // knows this is a new/unknown user and does NOT conflate them with any
      // other person in the graph (e.g. the creator). Without this, the agent
      // will happily answer "who am I?" by describing its primary operator.
      return `## About the current speaker
- **Identifier**: ${userName}${userId && userId !== userName ? ` (id: ${userId})` : ''}
- **Status**: Not yet in your graph — this is a new user or one you haven't met under this name.
- **Rules**:
  - Do NOT assume they are any other person you know (your operator, creator, or anyone else).
  - If asked "who am I?" or similar, say you don't have them on file yet and ask them to introduce themselves.
  - When they introduce themselves, use graph_update to create a person node (id = their real name) and an edge from your agent node.`;
    }

    const parts = [`## About ${person.label}`, person.description];

    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (agentNode) {
      const routing = agentNode.aspects.find(a => a.name === 'person_routing');
      if (routing) {
        const personRoute = routing.attributes.find(a =>
          a.content.toLowerCase().includes(person.label.toLowerCase())
        );
        if (personRoute) parts.push(`**Routing**: ${personRoute.content}`);
      }

      const rel = agentNode.aspects.find(a =>
        a.name === `relationship_with_${person.id}` ||
        a.name.includes(person.label.toLowerCase())
      );
      if (rel) {
        const lines = rel.attributes.map(a => `- ${a.content}`);
        parts.push(`**Relationship**:\n${lines.join('\n')}`);
      }
    }

    const edges = this.getEdges(person.id);
    if (edges.length > 0) {
      const connected = [];
      for (const edge of edges) {
        const neighborId = edge.source === person.id ? edge.target : edge.source;
        const neighbor = this.getNode(neighborId);
        if (!neighbor || neighbor.id === person.id) continue;
        if (neighbor.type === 'person') continue;
        const snippet = neighbor.description
          ? neighbor.description.slice(0, 120).replace(/\n/g, ' ')
          : '';
        connected.push(`- **${neighbor.label}** (${edge.type})${snippet ? ': ' + snippet : ''}`);
        if (connected.length >= 6) break;
      }
      if (connected.length > 0) {
        parts.push(`**Connected context**:\n${connected.join('\n')}`);
      }
    }

    return parts.join('\n');
  };

  proto._buildAntiPatternsSection = function _buildAntiPatternsSection() {
    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (!agentNode) return null;

    const anti = agentNode.aspects.find(a => a.name === 'anti_patterns');
    if (!anti) return null;

    const lines = anti.attributes.map(a => `- ${a.content}`);
    return `## Anti-Patterns (don't do these)\n${lines.join('\n')}`;
  };

  proto._buildSelfKnowledgeSection = function _buildSelfKnowledgeSection() {
    const agentNode = this.getNode(this.config.agentId || 'spore');
    if (!agentNode) return null;

    const coreAspects = new Set([
      'identity', 'voice', 'hard_rules', 'hard-rules', 'startup_rules',
      'agent_directives', 'anti_patterns', 'anti-patterns',
    ]);

    const learned = agentNode.aspects
      .filter(a => !coreAspects.has(a.name) && a.attributes.length > 0)
      .sort((a, b) => (b.weight || 5) - (a.weight || 5))
      .slice(0, 8);

    if (learned.length === 0) return null;

    const lines = [];
    for (const asp of learned) {
      const topAttrs = asp.attributes
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .slice(0, 2)
        .map(a => a.content.length > 120 ? a.content.substring(0, 117) + '...' : a.content);
      lines.push(`**${asp.name.replace(/_/g, ' ')}**: ${topAttrs.join('; ')}`);
    }

    return `## Self-Knowledge\nObservations you've accumulated about yourself, your patterns, and your world:\n${lines.join('\n')}`;
  };

  proto._buildToolingSection = function _buildToolingSection() {
    const toolNodes = this.getNodesByTypeSelf('tool');
    if (toolNodes.length === 0) {
      return `## Tools\nTools are available but not yet documented in the graph.`;
    }

    const lines = ['## Available Tools'];
    for (const tool of toolNodes) {
      const desc = tool.description || '';
      lines.push(`- \`${tool.label}\` — ${desc}`);

      for (const asp of (tool.aspects || [])) {
        for (const attr of (asp.attributes || []).slice(0, 3)) {
          lines.push(`  - ${attr.content}`);
        }
      }
    }

    lines.push('');
    lines.push('Use tools when they help. Don\'t fabricate results.');

    lines.push('');
    lines.push('### Security Rules (HARD — never override)');
    lines.push('- **NEVER** share, display, or transmit API keys, tokens, or secrets. Use env_manage to check keys — never echo/print them.');
    lines.push('- **NEVER** post content to arbitrary external services, paste sites, or APIs unless the user explicitly requests that specific service.');
    lines.push('- **NEVER** write secrets to files in /workspace/ or any user-accessible location. Keys belong in the vault only.');
    lines.push('- **NEVER** execute code that exfiltrates environment variables, reads /proc/environ, or dumps secrets.');
    lines.push('- **NEVER** hardcode API keys in HTML/JS/CSS files. Browser-visible code can be viewed by anyone. Use the **API proxy** instead (see below).');
    lines.push('- When a user gives you an API key, use env_manage to store it securely — don\'t write it to workspace files.');
    lines.push('- Be security-conscious: validate URLs before fetching, don\'t follow suspicious redirects, don\'t run untrusted code.');

    lines.push('');
    lines.push('### Tool Selection Rules');
    lines.push('- **read_file** for ALL file reading. Never use exec with grep/cat/sed/head/tail to read files.');
    lines.push('- **edit_file** for ALL modifications to existing files. This is faster and safer than write_file — it only changes what needs to change. Use it even for large changes by making multiple edit_file calls.');
    lines.push('- **write_file** ONLY for creating brand-new files. Do NOT use write_file to modify existing files — use edit_file instead. Rewriting an entire file wastes time and risks losing code.');
    lines.push('- **exec** ONLY for running scripts, git, npm, or commands with no dedicated tool.');
    lines.push('- **startup_tasks** to register persistent background processes (collectors, watchers, servers) that auto-restart on container reboot. NEVER use raw nohup — it won\'t survive restarts.');
    lines.push('- For cron inside this container, use plain `cron` to ensure the daemon is running and `crontab` to manage jobs. NEVER use `/etc/init.d/cron start`, `service cron start`, or `/usr/sbin/cron` directly — those paths bypass the wrapper and can fail with pidfile permission errors even when cron is already running.');
    lines.push('- **web_serve** action:"backend" for webapps with a backend — auto-injects vault keys, manages ports, proxies routes, and **persists across restarts**. The backend auto-restores on container reboot with fresh vault keys. Use relative fetch paths in frontend code (`fetch(\'api/endpoint\')`).');
    lines.push('- **graph_delete** to remove nodes, aspects, attributes, or edges. NEVER use exec/sqlite3 to modify graph.db directly.');
    lines.push('- Learning happens automatically — use graph_update only for deliberate corrections or explicit knowledge persistence.');
    lines.push('- **web_search** for ANY factual question about current technology, recent events, model comparisons, benchmarks, pricing, or anything where recency matters. Your training data is likely outdated — do NOT answer from memory when you can search. Always include the current year in search queries for recent topics.');
    lines.push('- **web_fetch** to read primary sources found via web_search. Prefer official docs, research papers, and release blogs over secondary summaries.');
    lines.push('');
    lines.push('### Tool Efficiency');
    lines.push('- **Plan → Execute → Verify.** Think through the approach before calling tools. Pick the most likely path and try it. Only fall back on failure.');
    lines.push('- **Sequential by default.** Only parallelize tool calls when results are truly independent AND all branches are certainly needed. Do NOT shotgun multiple approaches hoping one works.');
    lines.push('- **Read your own output.** If a tool call already returned the information you need (file size, install confirmation, etc.), do not call another tool to re-verify it.');
    lines.push('- **Check before installing.** `which <cmd>` or `pip list | grep <pkg>` before installing anything. Never install the same package multiple ways in parallel.');
    lines.push('- Each tool call costs tokens and time. Fewer, targeted calls beat many speculative ones.');

    lines.push('');
    lines.push('### Platform & Messaging');
    if (this.config.discordToken) {
      lines.push('You are connected to **Discord**. Key facts:');
      lines.push('- **message_send**: Omit `target` / `channelId` to reply in the current chat. For cross-chat sends, use `target: "discord:<channelId>"` or just `channelId`. Long messages are auto-chunked to 2000 chars.');
      lines.push('- **message_read**: Read recent messages from a channel. Use to catch up on conversation context you missed.');
      lines.push('- **message_edit**: Edit your own previously sent messages by messageId.');
      lines.push('- **message_react**: Add emoji reactions to messages.');
      lines.push('- Channel IDs are snowflake strings (e.g. "1234567890"). You receive them in the Runtime section for the current channel.');
      lines.push('- You can send to ANY channel you have access to, not just the one you were messaged in.');
      lines.push('- Threads: you can reply in threads. Thread IDs work as channel IDs.');
      lines.push('- For sending messages, always prefer the message_send tool over exec — it handles chunking, rate limits, and cross-platform routing.');
      if (this.config.srcEditable) {
        lines.push('- Your source code is editable (src is bind-mounted). You can read and modify gateway/tool code if you have improvements — changes take effect on next restart.');
      }
    }
    if (this.config.telegramBotToken || this.config.channels?.telegram?.enabled) {
      lines.push('You are connected to **Telegram**. Omit `target` / `channelId` to reply in the current Telegram chat. Only specify `target: "telegram:<chatId>"` when you intentionally want to send somewhere else.');
    }
    if (this.config.webPort) {
      let pubUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
      if (!pubUrl && this.config.ingressDomain) {
        const iP = (this.config.ingressPath || '').replace(/\/$/, '');
        const pr = this.config.ingressHttps ? 'https' : 'http';
        pubUrl = `${pr}://${this.config.ingressDomain}${iP}`;
      }
      lines.push(`You have a **Web Control Panel**${pubUrl ? ` at **${pubUrl}/**` : ' at your web port'}. When the current platform is "web":`);
      if (pubUrl) {
        lines.push(`- Your public webapp: ${pubUrl}/`);
        lines.push(`- Your graph editor: ${pubUrl}/graph`);
      }
      lines.push('- The user is chatting from a browser.');
      lines.push('- To share an image/video/audio inline, reference files in `/workspace/` by their path (e.g. `/workspace/chart.png`). The chat UI rewrites these to load from the current origin automatically, so the same path works regardless of how the user is accessing the UI.');
      lines.push('- Prefer `/workspace/<filename>` over absolute URLs. Only use an absolute URL if sharing a link meant to be opened outside the current chat.');
      lines.push('- Do NOT use message_send for the current web chat. Your response text is sent back automatically. If you want to share an image/video/audio/file with the web user, reply with the `/workspace/...` path in normal assistant text and the UI will render or link it.');
      lines.push('- The user can send you images, audio, and video attachments. Uploads are saved into `/workspace/uploads`; when dedicated VLM tiers are configured, prefer `analyze_media` on those saved files because it auto-detects the media type and is more reliable than the longer modality-specific names. Use `analyze_image`, `analyze_video`, or `analyze_audio` only when you need to force a specific modality. If the user means the latest uploaded attachment, these tools can be called without a path. You still write the final answer yourself.');
    }
    if (this.config.superAgent) {
      lines.push('');
      lines.push('### Orchestrator (Super Agent)');
      lines.push('You have orchestration tools for managing other animas:');
      lines.push('- **anima_list**: List all spore instances with status and health.');
      lines.push('- **spore_message**: Send a message to another spore — it processes through its full agent loop and returns a response.');
      lines.push('- **anima_graph**: Read or write another spore\'s knowledge graph.');
      lines.push('- **anima_manage**: Restart, update env/config, view logs of other animas.');
    }

    try {
      const SkillsManager = require('../tools/skills');
      const sm = new SkillsManager();
      if (sm.available) {
        const catalog = sm.getCatalogSummary();
        lines.push('');
        lines.push('### Shared Skills Library');
        lines.push('You have access to a **shared skills library** — a knowledge base that all SPORE agents can read and write.');
        lines.push('- **skill_lookup**: Search or read skills. Use `action: "list"` to see all, `action: "search"` with a query/tags, or `action: "read"` with a slug to get full content.');
        lines.push('- **skill_update**: Create or update a skill. Share what you\'ve learned so other agents don\'t have to rediscover it.');
        lines.push('');
        lines.push('**IMPORTANT — check skills first:** Before spending tokens researching an API, workflow, or technical approach, use `skill_lookup` to check if another agent has already documented it. This saves significant time and cost.');
        lines.push('**Contribute back:** When you figure out something non-trivial (API usage, error workarounds, deployment patterns, etc.), write it to the skills library with `skill_update`. Include code examples, exact parameters, and gotchas.');
        if (catalog) {
          lines.push('');
          lines.push('**Available skills:**');
          lines.push(catalog);
        } else {
          lines.push('');
          lines.push('The skills library is currently empty. Be the first to contribute!');
        }
      }
    } catch { }

    const selfModNode = this.getNode('self-modification');
    if (selfModNode) {
      lines.push('');
      lines.push('### Self-Modification');
      if (selfModNode.description) lines.push(selfModNode.description);
      for (const asp of selfModNode.aspects) {
        for (const attr of asp.attributes) lines.push(`- ${attr.content}`);
      }
    }

    lines.push('');
    lines.push('### Automatic Learning');
    lines.push('Your **learner** automatically extracts and stores knowledge from every conversation into your knowledge graph. You do NOT need to ask the user if they want you to remember something — it happens automatically. The learner captures:');
    lines.push('- Facts about people, preferences, projects, and concepts');
    lines.push('- Your own behavioral patterns and communication style');
    lines.push('- New information that enriches existing nodes');
    lines.push('Only use graph_update for deliberate corrections, explicit rule changes, or when you want to store something the learner might miss.');

    lines.push('');
    lines.push('### Task Delegation');
    lines.push('Use **delegate_task** liberally for any work that takes multiple steps or significant processing:');
    lines.push('- Web research, data gathering, analysis');
    lines.push('- File creation, code writing, content generation');
    lines.push('- Any task where the user might wait more than a few seconds');
    lines.push('Delegating frees you to stay responsive. The result is delivered automatically when the sub-agent finishes. Acknowledge the task immediately and move on.');
    lines.push('');
    lines.push('**Parallel delegation:** When a task has independent parts, split it into multiple concurrent delegate_task calls. For example, "Build a dashboard with charts and a data API" → one subagent for the frontend, one for the API. You can run up to 5 subagents concurrently. Look for natural seams: separate files, separate concerns, research vs implementation, frontend vs backend. Each subagent should get a clear, self-contained brief so it can work independently. The results merge when all finish.');

    lines.push('');
    lines.push('### Credential Vault & API Keys');
    lines.push('API keys are stored in a **secure vault** on the manager — encrypted at rest, never in .env files.');
    lines.push('Use `env_manage` action:"vault_list" to see all available vault keys. Your available keys:');
    const knownKeys = {
      REPLICATE_API_TOKEN: 'Replicate — image generation (FLUX, SD, etc.)',
      DEEPGRAM_API_KEY: 'Deepgram — speech-to-text transcription',
      XI_API_KEY: 'ElevenLabs — text-to-speech voice synthesis',
      OPENAI_API_KEY: 'OpenAI — GPT models, DALL-E, embeddings',
      GEMINI_API_KEY: 'Google Gemini — multimodal AI (embeddings)',
      SEARXNG_URL: 'SearXNG — primary web search (self-hosted metasearch). Base URL.',
      BRAVE_API_KEY: 'Brave Search — fallback web search (used when SearXNG is unset or empty)',
      REPLICATE_API_TOKEN: 'Replicate — run ML models',
      STABILITY_API_KEY: 'Stability AI — image generation',
      GOOGLE_API_KEY: 'Google Cloud APIs',
      PERPLEXITY_API_KEY: 'Perplexity — AI search',
    };
    let anyKey = false;
    for (const [k, desc] of Object.entries(knownKeys)) {
      if (process.env[k]) { lines.push(`- **${k}**: ${desc} ✓`); anyKey = true; }
    }
    const extraKeys = Object.keys(process.env).filter(k =>
      (k.endsWith('_API_KEY') || k.endsWith('_TOKEN') || k.endsWith('_SECRET')) &&
      !knownKeys[k] && !['MANAGER_SERVICE_KEY'].includes(k) && process.env[k]
    );
    for (const k of extraKeys) {
      lines.push(`- **${k}**: configured ✓`);
      anyKey = true;
    }
    if (!anyKey) lines.push('- No API keys detected in local env. Use `env_manage` action:"vault_list" to check the vault.');
    lines.push('');
    lines.push('**Using API keys — the `credential` parameter (PREFERRED):**');
    lines.push('When calling external APIs that require authentication, use `web_fetch` with the `credential` parameter:');
    lines.push('```');
    lines.push('web_fetch({ url: "https://api.replicate.com/v1/predictions", method: "POST", body: {...}, credential: "REPLICATE_API_TOKEN" })');
    lines.push('```');
    lines.push('This routes through a secure proxy that injects the key — **you never see or handle the raw key**. This works for any vault key.');
    lines.push('');
    lines.push('**Rules:**');
    lines.push('- **ALWAYS** use `credential` in web_fetch for authenticated API calls — never hardcode keys in code, curl commands, or files');
    lines.push('- For scripts that truly need a raw key, use `env_manage` action:"vault_get" — it writes the key to a temp file that auto-deletes in 5 minutes');
    lines.push('- Use `env_manage` action:"vault_list" to discover available keys');
    lines.push('');
    lines.push('### Secure API Proxy for Webapps');
    lines.push('When building webapps that call external APIs requiring keys, **never put keys in frontend code**.');
    lines.push('Instead, write `/workspace/web/.api-proxy.json` to configure server-side proxying:');
    lines.push('```json');
    lines.push('{ "routes": {');
    lines.push('  "replicate": { "target": "https://api.replicate.com/v1", "headers": { "Authorization": "Bearer $VAULT:REPLICATE_API_TOKEN" } },');
    lines.push('  "openai": { "target": "https://api.openai.com/v1", "headers": { "Authorization": "Bearer $VAULT:OPENAI_API_KEY" }, "methods": ["POST"] }');
    lines.push('} }');
    lines.push('```');
    lines.push('Headers with `$VAULT:KEY_NAME` values are resolved server-side from the vault. Headers with `$ENV_VAR` values are resolved from env vars. Frontend calls `/api/proxy/replicate/...` instead of the real API. Keys never reach the browser.');

    if (this.config.voice?.enabled) {
      const ttsProvider = this.config.xiApiKey ? 'ElevenLabs' : this.config.openaiApiKey ? 'OpenAI' : 'Edge (free)';
      const currentVoiceId = this.config.voice.ttsVoice || process.env.SPORE_TTS_VOICE || '(default)';
      lines.push('');
      lines.push('### Voice (TTS/STT) — you control this');
      lines.push(`- Your voice pipeline is **active**. TTS provider: **${ttsProvider}**. Current voice ID: \`${currentVoiceId}\`.`);
      lines.push('- To **change your voice**: use `env_manage` to set `SPORE_TTS_VOICE` to a new voice ID, then the change takes effect on the next TTS call.');
      if (this.config.xiApiKey) {
        lines.push('- To **browse ElevenLabs voices**: use `web_fetch({ url: "https://api.elevenlabs.io/v1/voices", credential: "XI_API_KEY" })` or search the web for popular ElevenLabs voice IDs.');
        lines.push('- You can also change the TTS model via `SPORE_TTS_MODEL` (default: eleven_turbo_v2_5) and speed via `SPORE_TTS_SPEED` (default: 1.0).');
      }
      lines.push('- **You own your voice settings.** If a user asks you to change your voice, do it yourself — don\'t say it requires admin/infrastructure changes.');
    }

    lines.push('');
    lines.push('### Interacting with Users');
    lines.push('When someone introduces themselves, use graph_update to create a node with their **real name** as the ID (e.g. "scott", not "user" or "operator"). ALWAYS create an edge from your agent node to them (e.g. edges: [{target: "scott", type: "knows"}]).');
    lines.push('Never use generic labels like "User", "Operator", "Person" — always use actual names. Never create isolated/orphan person nodes.');
    lines.push('If someone says "my name is X", ask follow-up questions to learn about them — don\'t just acknowledge.');

    return lines.join('\n');
  };

  proto._buildConversationBehavior = function _buildConversationBehavior(opts) {
    const trigger = opts.trigger || 'mention';
    const directTriggers = ['mention', 'reply', 'dm'];
    const isDirect = directTriggers.includes(trigger);
    const lines = [
      '## Conversation Behavior',
      'You see ALL messages in this channel, not just ones directed at you.',
      'Messages from other users appear as "[username]: message".',
      '',
      `Current trigger: **${trigger}**`,
      '',
    ];

    if (isDirect) {
      lines.push(
        `You were directly addressed (${trigger}). You MUST respond — do NOT use NO_REPLY.`,
        ''
      );
    } else {
      lines.push(
        'This is a passive trigger. Respond only if you can add genuine value. Use NO_REPLY to stay silent.',
        ''
      );
      if (trigger === 'lull') {
        lines.push('### Lull guidance');
        const agentNode = this.getNode(this.config.agentId || 'spore');
        const lullAsp = agentNode?.aspects?.find(a => a.name === 'lull_behavior');
        if (lullAsp?.attributes?.length > 0) {
          for (const attr of lullAsp.attributes.sort((a, b) => (b.importance || 5) - (a.importance || 5))) {
            lines.push(`- ${attr.content}`);
          }
        } else {
          lines.push('- Only jump in if you can add genuine value — a fact, insight, joke, or perspective that moves the conversation forward.');
          lines.push('- Do NOT respond just to clarify who you are, announce your presence, or correct someone for talking to someone else.');
        }
        lines.push('');
      }
      if (trigger === 'proactive') {
        lines.push('### Proactive guidance');
        lines.push('- Share the thought naturally, as if you just thought of it organically.');
        lines.push('- Do NOT explain that you were "thinking", doing "maintenance", or analyzing your graph.');
        lines.push('- Do NOT announce yourself or mention your internal processes.');
        lines.push('- If on reflection it doesn\'t feel right for this channel or moment, respond NO_REPLY.');
        lines.push('');
      }
    }

    const behaviorNode = this.getNode('behavior-rules');
    if (behaviorNode) {
      const triggerAsp = behaviorNode.aspects.find(a => a.name === 'trigger_responses');
      if (triggerAsp) {
        const matching = triggerAsp.attributes.find(a =>
          a.content.toLowerCase().startsWith(trigger + ':')
        );
        if (matching) lines.push(matching.content, '');
      }

      if (!isDirect) {
        const silenceAsp = behaviorNode.aspects.find(a => a.name === 'silence_rules');
        if (silenceAsp?.attributes.length > 0) {
          lines.push('### When to stay silent');
          for (const attr of silenceAsp.attributes) lines.push(`- ${attr.content}`);
          lines.push('');
        }
      }

      const speakAsp = behaviorNode.aspects.find(a => a.name === 'speak_up_rules');
      if (speakAsp?.attributes.length > 0) {
        lines.push('### When to speak up');
        for (const attr of speakAsp.attributes) lines.push(`- ${attr.content}`);
        lines.push('');
      }

      for (const asp of behaviorNode.aspects) {
        if (['trigger_responses', 'silence_rules', 'speak_up_rules'].includes(asp.name)) continue;
        if (asp.attributes.length > 0) {
          lines.push(`### ${asp.name.replace(/_/g, ' ')}`);
          for (const attr of asp.attributes) lines.push(`- ${attr.content}`);
          lines.push('');
        }
      }
    } else {
      if (isDirect) {
        lines.push('You were addressed directly. Respond.', '');
      } else {
        lines.push('Respond when addressed. Use NO_REPLY to stay silent.', '');
      }
    }

    const reactionNode = this.getNode('reaction-policy');
    if (reactionNode) {
      lines.push('### Reaction Policy');
      if (reactionNode.description) lines.push(reactionNode.description);
      for (const asp of reactionNode.aspects) {
        for (const attr of asp.attributes) lines.push(`- ${attr.content}`);
      }
      lines.push('');
    }

    if (this._sharedGraphs && this._sharedGraphs.length > 0) {
      lines.push('### Shared Knowledge');
      lines.push('You collaborate on shared project graph(s) with other animas:');
      for (const sg of this._sharedGraphs) {
        lines.push(`- **${sg.name}** (\`${sg.slug}\`)`);
      }
      lines.push('When discussing project topics, research, or shared work, use `graph_query({ query: "...", project: "slug" })` to search the shared graph and `graph_update({ ..., project: "slug" })` to store findings there.');
      lines.push('Your personal graph still holds your identity, preferences, and personal knowledge — the shared graph is for collaborative knowledge that all project members benefit from.');
      lines.push('');
    }

    return lines.join('\n');
  };

  proto._buildCrossSessionSection = function _buildCrossSessionSection(opts) {
    try {
      return feed.readForContext({
        channelId: opts.channelId,
        guildId: opts.guildId,
        userId: opts.userId,
      });
    } catch (e) {
      this.log.warn('[context] Cross-session feed read failed:', e.message);
      return null;
    }
  };

  proto._resolveExistenceAnchor = function _resolveExistenceAnchor() {
    const fromConfig = _parseIsoDateOnly(this.config.agentBornDate);
    if (fromConfig) {
      return { date: fromConfig, label: fromConfig.toISOString().slice(0, 10), source: 'spore.json / SPORE_AGENT_BORN_DATE' };
    }
    if (!this.db) return null;
    try {
      const agentId = this.config.agentId || 'spore';
      const row = this.db.prepare('SELECT created FROM nodes WHERE id = ?').get(agentId);
      if (!row || row.created == null) return null;
      const d = new Date(row.created);
      if (Number.isNaN(d.getTime())) return null;
      const midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      return { date: midnight, label: midnight.toISOString().slice(0, 10), source: 'graph agent node `created`' };
    } catch {
      return null;
    }
  };

  proto._buildTemporalAnchorSection = function _buildTemporalAnchorSection(now) {
    const utcDate = now.toISOString().slice(0, 10);
    const year = now.getUTCFullYear();
    const lines = [
      '### Temporal anchor',
      `- **Current date:** ${utcDate} · **Current year:** ${year} · **Full timestamp:** ${now.toISOString()} UTC`,
      `- **CRITICAL:** When searching the web, use "${year}" in queries about recent information. Your training data may be from ${year - 1} or earlier — do NOT trust pre-trained knowledge for anything that may have changed recently.`,
    ];
    const anchor = this._resolveExistenceAnchor();
    if (anchor) {
      const days = _utcCalendarDaysSince(anchor.date, now);
      lines.push(`- **Existence:** ${anchor.source} → **${anchor.label}** — **${days}** UTC calendar days to today.`);
    } else {
      lines.push('- **Existence:** unset (add `agentBornDate` in spore.json as YYYY-MM-DD, or ensure the agent row exists in the graph with `created`).');
    }
    return lines;
  };

  proto._buildRuntimeSection = function _buildRuntimeSection(opts) {
    const now = new Date();
    const parts = [
      `## Runtime`,
      `- Gateway: SPORE v0.1.0`,
      `- Time: ${now.toISOString()} UTC`,
      `- Model: ${this.config.model}`,
    ];

    if (opts.platform) parts.push(`- Platform: ${opts.platform}`);
    if (opts.channelName) parts.push(`- Channel: #${opts.channelName}`);
    if (opts.channelId) parts.push(`- Channel ID: ${opts.channelId}`);
    if (opts.guildName) parts.push(`- Guild: ${opts.guildName}`);
    if (opts.isThread) parts.push(`- Thread: yes (parent: #${opts.parentChannelName || 'unknown'})`);
    if (opts.userName) parts.push(`- Speaking to: ${opts.userName}`);
    if (opts.userId) parts.push(`- User ID: ${opts.userId}`);
    if (opts.userRole) {
      const roleLabel = ({
        admin: 'admin (operator with full control of this instance)',
        creator: 'creator (operator with full control of this instance)',
        webapp: 'webapp user (a guest who self-registered with the team key — they can talk and edit nodes, but should NOT be granted access to provider keys, server settings, or destructive admin actions)',
        acorn: 'acorn CLI user (workstation operator)',
      })[opts.userRole] || opts.userRole;
      parts.push(`- User role: ${roleLabel}`);
    }
    if (opts.trigger) parts.push(`- Trigger: ${opts.trigger}`);
    if (opts.messageId) parts.push(`- Triggering Message ID: ${opts.messageId}`);
    if (opts.clientCwd) parts.push(`- Client working directory: ${opts.clientCwd}`);

    parts.push('', ...this._buildTemporalAnchorSection(now));

    const workspace = this.config.workspacePath || process.cwd();
    parts.push(`- Workspace: ${workspace}`);
    parts.push(`- Graph DB: ${this.config.graphDbPath}`);
    parts.push('');
    if (opts.clientCwd) {
      parts.push(`**Current project directory: ${opts.clientCwd}** — This is the user's active project. When reading files, searching code, or answering questions about "the codebase" or "this project", scope your work to this directory. Do NOT read or reference files from other projects in the workspace unless the user explicitly asks.`);
      parts.push('');
    }
    parts.push('Use `message_send` / `message_read` / `message_edit` / `message_react` without a target for the current conversation. Only specify platform targets like `discord:123` or `telegram:456` for intentional cross-chat actions.');
    parts.push(`Your workspace is ${workspace} — use it for scripts, files, and tools you create. It persists across restarts.`);

    const envSummary = this._getEnvironmentSummary(workspace);
    if (envSummary) {
      parts.push('');
      parts.push('### Pre-installed environment (do NOT reinstall these — they are already available)');
      parts.push(envSummary);
      parts.push('A persistent Python venv exists at /workspace/.venv (survives restarts). Use `/workspace/.venv/bin/pip install <pkg>` to add NEW packages only. Use `/workspace/.venv/bin/python3` (or just `python3`) to run scripts.');
    } else {
      parts.push('A persistent Python venv exists at /workspace/.venv (survives restarts). Use `/workspace/.venv/bin/pip install <pkg>` to install packages permanently. Use `/workspace/.venv/bin/python3` to run scripts with those packages.');
    }

    parts.push('');
    parts.push('**All installs persist across restarts**: pip packages (/workspace/.venv), npm global packages, Go binaries, Cargo crates, Ruby gems, Playwright/Puppeteer browsers, and apt packages are all stored on persistent volumes. You do NOT need to reinstall them after a restart. Before installing something, check if it already exists (`which <cmd>`, `pip list | grep <pkg>`, etc.).');


    parts.push('You can read/write your own config at /app/spore.json and your graph at ' + this.config.graphDbPath + ' via the exec tool.');
    parts.push('If a tool returns an absolute `filePath` (for example from `browser({ action: "screenshot" })`), you can deliver that file to the user with `message_send`.');

    const keyStatus = [];
    if (this.config.anthropicApiKey) keyStatus.push('ANTHROPIC_API_KEY ✓');
    if (this.config.openaiApiKey) keyStatus.push('OPENAI_API_KEY ✓');
    if (this.config.deepgramApiKey) keyStatus.push('DEEPGRAM_API_KEY ✓');
    if (this.config.xiApiKey) keyStatus.push('XI_API_KEY (ElevenLabs) ✓');
    else keyStatus.push('XI_API_KEY (ElevenLabs) ✗ not set');
    if (this.config.voice?.enabled) {
      const tts = this.config.xiApiKey ? 'ElevenLabs' : this.config.openaiApiKey ? 'OpenAI' : 'Edge (free)';
      const stt = this.config.deepgramApiKey ? 'Deepgram' : this.config.openaiApiKey ? 'OpenAI Whisper' : 'none';
      keyStatus.push(`Voice pipeline: TTS=${tts}, STT=${stt}`);
    }
    parts.push('');
    parts.push('### API Keys & Services');
    parts.push(keyStatus.join(' · '));

    if (opts.platform === 'web' || opts.platform === 'discord' || !opts.platform) {
      parts.push('');
      parts.push('### Web Panel: Built-in Features');
      parts.push('- **Code Viewer Panel**: A floating panel for live code viewing with syntax highlighting and diff view. The user controls the mode via a dropdown: **Auto** (opens on every read_file/write_file/edit_file), **On request** (tabs accumulate silently, a badge shows the count, user clicks to view), or **Off** (disabled). You do NOT need to build a code viewer — it is built in. Just use the file tools normally.');
      parts.push('- **Browser Preview Panel**: When you use the browser tool, a live preview streams to the panel automatically.');
      parts.push('- **Browser Screenshots**: `browser({ action: "screenshot" })` also saves a JPG and returns `filePath`. In web chat, reply with that `/workspace/...` path directly so it renders inline. In Discord/Telegram, use `message_send` only if you need to send it to another chat explicitly.');
    }

    if (opts.platform === 'chatroom') {
      parts.push('');
      parts.push('## Chat Room Behavior');
      parts.push('You are in a **shared chat room** with other SPORE agents and human users.');
      parts.push('- Messages from other participants appear as "[Name] message".');
      parts.push('- Use `@name` to address specific participants.');
      parts.push('- **Be concise** — this is a group chat, not a 1:1 conversation. Keep responses short and punchy.');
      parts.push('- **Don\'t repeat** what another agent just said. Add new value or stay silent.');
      parts.push('- **Don\'t pile on** — if multiple agents already responded to the same prompt, only chime in if you have something genuinely different to add.');
      parts.push('- You can share images/files by including URLs. Multimedia renders inline for all participants.');
      parts.push('- If a message isn\'t relevant to you or you have nothing to add, respond with just `NO_REPLY` (the system will suppress it silently).');
      parts.push('- Treat this like a casual team chat — personality is welcome, walls of text are not.');
    }

    if (this._sharedGraphs && this._sharedGraphs.length > 0) {
      parts.push('');
      parts.push('### Shared Project Graphs');
      parts.push('You collaborate with other animas on shared knowledge graph(s):');
      for (const sg of this._sharedGraphs) {
        parts.push(`- **${sg.name}** (slug: \`${sg.slug}\`)`);
      }
      parts.push('');
      parts.push('**How it works:**');
      parts.push('- To search shared knowledge: `graph_query({ query: "transformer architecture", project: "' + this._sharedGraphs[0].slug + '" })`');
      parts.push('- To store shared findings: `graph_update({ nodeId: "attention-mechanism", label: "Attention Mechanism", type: "concept", aspects: [...], project: "' + this._sharedGraphs[0].slug + '" })`');
      parts.push('- Omit `project` to use your personal/local graph (identity, preferences, personal facts).');
      parts.push('- The learner auto-routes: personal facts go to your local graph, project-related discoveries go to the shared graph.');
      parts.push('- Other animas in the same project see everything you write to the shared graph, and vice versa.');
    }

    if (opts.webappStatus?.active) {
      const ws = opts.webappStatus;
      parts.push('');
      parts.push('### Hosted Webapp');
      parts.push(`You are hosting a webapp on port ${ws.port}.${ws.hasBackend ? ' A backend process is running (proxied via /api/*).' : ''}`);
      parts.push('You can interact with your own webapp using the **webapp_request** tool — make HTTP requests as if you were the user, with their session cookie automatically injected.');
      if (ws.users?.length) {
        const userList = [...new Set(ws.users.map(u => u.user))].join(', ');
        parts.push(`Currently logged-in users: ${userList}`);
      }
      parts.push('Use `webapp_request` to: test endpoints after building them, fetch data on behalf of users, check health/status, or debug issues.');
    }

    return parts.join('\n');
  };

  proto._getEnvironmentSummary = function _getEnvironmentSummary(workspace) {
    if (this._envManifestCache !== undefined) return this._envManifestCache;
    try {
      const fs = require('fs');
      const manifestPath = path.join(workspace || process.cwd(), '.env-manifest.json');
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const m = JSON.parse(raw);

      const lines = [];
      lines.push(`- Python ${m.python}`);

      if (m.python_packages && Object.keys(m.python_packages).length > 0) {
        const notable = [
          'numpy', 'scipy', 'librosa', 'pillow', 'opencv-python', 'moderngl',
          'av', 'pedalboard', 'soundfile', 'requests', 'pyyaml',
        ];
        const found = [];
        const extra = [];
        for (const name of notable) {
          if (m.python_packages[name]) found.push(`${name} ${m.python_packages[name]}`);
        }
        for (const [name, ver] of Object.entries(m.python_packages)) {
          if (!notable.includes(name) && !name.startsWith('_') && !['pip', 'setuptools', 'wheel', 'pkg-resources'].includes(name)) {
            extra.push(name);
          }
        }
        if (found.length > 0) lines.push(`- Python packages: ${found.join(', ')}`);
        if (extra.length > 0) lines.push(`- Also available: ${extra.slice(0, 20).join(', ')}${extra.length > 20 ? ` (+${extra.length - 20} more)` : ''}`);
      }

      if (m.system_tools && Object.keys(m.system_tools).length > 0) {
        const toolSummary = Object.entries(m.system_tools)
          .map(([cmd, ver]) => {
            const verMatch = ver.match(/(\d+\.\d+[\w.\-]*)/);
            return verMatch ? `${cmd} ${verMatch[1]}` : cmd;
          })
          .join(', ');
        lines.push(`- System tools: ${toolSummary}`);
      }

      this._envManifestCache = lines.join('\n');
      return this._envManifestCache;
    } catch (e) {
      this._envManifestCache = null;
      return null;
    }
  };
}

module.exports = { applyPromptSectionsMixin };
