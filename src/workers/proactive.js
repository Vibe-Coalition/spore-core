/**
 * proactive.js — Proactive Outreach Engine
 *
 * Decides whether to share insights from maintenance cycles
 * in active chat channels. Uses LLM assessment with strict
 * rules to avoid spam.
 *
 * Extracted from maintainer.js to separate proactive posting
 * from core maintenance logic.
 */

class ProactiveEngine {
  constructor(maintainer) {
    this.maintainer = maintainer;
    this.config = maintainer.config;
    this.log = maintainer.log;
    this.db = maintainer.db;

    this._lastAt = 0;
    this._todayCount = 0;
    this._todayDate = new Date().toISOString().substring(0, 10);
  }

  async maybeAction(cycleSummary, channelHints) {
    if (!cycleSummary) return null;

    const proactive = this.config.proactive;
    if (!proactive?.enabled) return null;

    const total = (cycleSummary.gapsDetected || 0) + (cycleSummary.gapsFilled || 0)
      + (cycleSummary.reflections || 0) + (cycleSummary.staleMarked || 0)
      + (cycleSummary.edgesCreated || 0);
    if (total === 0) return null;

    const today = new Date().toISOString().substring(0, 10);
    if (today !== this._todayDate) {
      this._todayDate = today;
      this._todayCount = 0;
    }

    if (this._todayCount >= (proactive.maxPerDay || 5)) {
      this.log.debug('[proactive] Daily cap reached');
      return null;
    }

    const cooldownMs = (proactive.cooldownMinutes || 60) * 60 * 1000;
    if (Date.now() - this._lastAt < cooldownMs) {
      this.log.debug('[proactive] Cooldown not elapsed');
      return null;
    }

    if (!channelHints || channelHints.length === 0) {
      this.log.debug('[proactive] No active channels to post in');
      return null;
    }

    const allowedChannels = proactive.channels?.length > 0
      ? channelHints.filter(ch => proactive.channels.includes(ch.id))
      : channelHints;
    if (allowedChannels.length === 0) return null;

    const selfContext = this._getSelfContext();
    const channelList = allowedChannels
      .map(ch => `- ${ch.id} (#${ch.name}${ch.recentTopic ? `: recent topic — ${ch.recentTopic}` : ''})`)
      .join('\n');

    const summaryText = [];
    if (cycleSummary.gapsFilled) summaryText.push(`Filled ${cycleSummary.gapsFilled} knowledge gap(s)`);
    if (cycleSummary.reflections) summaryText.push(`Wrote ${cycleSummary.reflections} reflection(s)`);
    if (cycleSummary.staleMarked) summaryText.push(`Found ${cycleSummary.staleMarked} stale item(s)`);
    if (cycleSummary.edgesCreated) summaryText.push(`Connected ${cycleSummary.edgesCreated} node(s)`);
    if (cycleSummary.gapsDetected) summaryText.push(`Discovered ${cycleSummary.gapsDetected} new question(s)`);

    const recentFilledGaps = this._getRecentFilledGaps(3);
    const recentReflections = this._getRecentReflections(2);

    let detailText = '';
    if (recentFilledGaps.length > 0) {
      detailText += '\nRecently learned:\n' + recentFilledGaps.map(g =>
        `- About "${g.label}": ${g.answer.substring(0, 150)}`
      ).join('\n');
    }
    if (recentReflections.length > 0) {
      detailText += '\nRecent reflections:\n' + recentReflections.map(r =>
        `- On "${r.label}": ${r.content.substring(0, 150)}`
      ).join('\n');
    }

    const minutesSinceLast = this._lastAt
      ? Math.round((Date.now() - this._lastAt) / 60000)
      : null;

    try {
      const response = await this.maintainer._callLLM(
        `You are deciding whether to proactively share something in a chat channel.
You just completed a maintenance cycle on your knowledge graph. Below is what happened.
Given your personality and the available channels, decide if anything is worth sharing.

RULES:
- If you learned something interesting, made a surprising connection, or have a thought worth sharing, suggest posting.
- Never share maintenance details, graph statistics, or meta-information about your own processes.
- Your personality should inform how and whether you share.
- If you genuinely have nothing interesting, choose NO_ACTION.

Return ONLY JSON: {"action":"none"} or {"action":"post","channelId":"...","context":"1-sentence summary of what to share","topic":"the relevant topic"}`,
        `Your personality:\n${selfContext}\n\nCycle results: ${summaryText.join('. ')}${detailText}\n\nAvailable channels:\n${channelList}${minutesSinceLast ? `\n\nYou last posted proactively ${minutesSinceLast} minutes ago.` : '\n\nYou have never posted proactively before.'}`
      );

      const result = this.maintainer._parseJSON(response);
      if (!result || result.action === 'none' || result.action !== 'post') {
        this.log.debug('[proactive] LLM decided: no action');
        return null;
      }

      if (!result.channelId || !result.context) {
        this.log.debug('[proactive] LLM returned incomplete action');
        return null;
      }

      const validChannel = allowedChannels.find(ch => ch.id === result.channelId);
      if (!validChannel) {
        this.log.debug(`[proactive] LLM suggested invalid channel ${result.channelId}`);
        return null;
      }

      this._lastAt = Date.now();
      this._todayCount++;
      this.log.info(`[proactive] Action approved: post in #${validChannel.name} — ${result.context.substring(0, 80)}`);

      return {
        action: 'post',
        channelId: result.channelId,
        channelName: validChannel.name,
        context: result.context,
        topic: result.topic || '',
      };
    } catch (e) {
      this.log.error('[proactive] Assessment error:', e.message);
      return null;
    }
  }

  _getSelfContext() {
    if (!this.db) return 'No personality data available.';
    try {
      const agentId = this.config.agentId || 'anima';
      const node = this.db.prepare('SELECT id, label, description FROM nodes WHERE id = ?').get(agentId);
      if (!node) return 'No self-node found.';

      const aspects = this.db.prepare(
        "SELECT id, name FROM aspects WHERE node_id = ? AND name IN ('personality', 'identity', 'voice', 'agent_directives') ORDER BY weight DESC"
      ).all(agentId);

      const lines = [node.description || node.label];
      for (const asp of aspects) {
        const attrs = this.db.prepare(
          'SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 4'
        ).all(asp.id);
        if (attrs.length) lines.push(`[${asp.name}] ${attrs.map(a => a.content).join(' | ')}`);
      }
      return lines.join('\n');
    } catch {
      return 'Could not load personality.';
    }
  }

  _getRecentFilledGaps(count) {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT g.content AS question, g.answer, n.label
        FROM gaps g JOIN nodes n ON g.node_id = n.id
        WHERE g.status = 'answered' AND g.answered_at > datetime('now', '-4 hours')
        ORDER BY g.answered_at DESC LIMIT ?
      `).all(count);
    } catch { return []; }
  }

  _getRecentReflections(count) {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT r.content, n.label
        FROM reflections r JOIN nodes n ON r.node_id = n.id
        WHERE r.updated > datetime('now', '-4 hours')
        ORDER BY r.updated DESC LIMIT ?
      `).all(count);
    } catch { return []; }
  }
}

module.exports = { ProactiveEngine };
