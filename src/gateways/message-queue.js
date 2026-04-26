/**
 * message-queue.js — Per-channel message queueing primitive
 *
 * Shared by chat-style gateways (Discord, Slack) that batch incoming
 * messages within a debounce window, merge them into one agent turn,
 * and pick the highest-priority trigger across the batch. Telegram
 * processes messages one-at-a-time and doesn't use this.
 *
 * The gateway provides a `processOnce(channelId, ch)` callback that
 * does the platform-specific work (typing indicator, stall feedback,
 * agent.processMessage call, send reply, feed log). This module owns
 * everything else: channel state map, queue cap, debounce timer, lull
 * timer, drain ordering, trigger merge + priority resolution.
 */

const TRIGGER_PRIORITY = ['mention', 'reply', 'dm', 'name', 'task_complete', 'continuation', 'lull', 'proactive'];

class MessageQueue {
  /**
   * @param {object} opts
   * @param {object} opts.config        — full agent config (reads maxQueuePerChannel, messageDebounceMs)
   * @param {object} opts.log           — logger
   * @param {function} opts.processOnce — async (channelId, ch) => void; the gateway's per-batch worker
   * @param {string} [opts.lullPrompt]  — content placed on the synthetic lull item
   * @param {number} [opts.lullDelayMs] — observe-path lull window (default 15s)
   */
  constructor({ config, log, processOnce, lullPrompt = '[conversation paused — lull check]', lullDelayMs = 15_000 }) {
    this.log = log;
    this._maxQueueSize = config.maxQueuePerChannel || 3;
    this._debounceMs = config.messageDebounceMs || 800;
    this._lullDelayMs = lullDelayMs;
    this._lullPrompt = lullPrompt;
    this._processOnce = processOnce;
    this._channels = new Map();
  }

  /**
   * Lazy-init channel state. Gateways extend the record with their own
   * platform-specific fields by simply assigning to it later (e.g.
   * ch.lastBotMessageId = ...). The base record only carries fields
   * that the queue itself manages.
   */
  getChannel(channelId) {
    if (!this._channels.has(channelId)) {
      this._channels.set(channelId, {
        queue: [],
        processing: false,
        debounceTimer: null,
        lullTimer: null,
      });
    }
    return this._channels.get(channelId);
  }

  /**
   * Iterate over (channelId, ch) pairs — for callers that need to
   * walk active channels (e.g. shutdown cleanup, status report).
   */
  entries() {
    return this._channels.entries();
  }

  /**
   * A new triggered message arrived. Cancel any pending lull, drop the
   * oldest item if the queue is at cap, then restart the debounce
   * timer. Caller passes the item record with its own platform-specific
   * fields included.
   */
  enqueueTriggered(channelId, item, { channelLabel } = {}) {
    const ch = this.getChannel(channelId);
    if (ch.lullTimer) { clearTimeout(ch.lullTimer); ch.lullTimer = null; }
    if (ch.queue.length >= this._maxQueueSize) {
      this.log.warn(`Queue full for ${channelLabel || channelId}, dropping oldest`);
      ch.queue.shift();
    }
    ch.queue.push(item);
    if (ch.debounceTimer) clearTimeout(ch.debounceTimer);
    ch.debounceTimer = setTimeout(() => this.processQueue(channelId), this._debounceMs);
  }

  /**
   * Observe-path: schedule a callback to fire after the lull window
   * unless a real trigger arrives first (which clears the timer via
   * enqueueTriggered).
   */
  scheduleLull(channelId, fn, delayMs = this._lullDelayMs) {
    const ch = this.getChannel(channelId);
    if (ch.lullTimer) clearTimeout(ch.lullTimer);
    ch.lullTimer = setTimeout(fn, delayMs);
  }

  /**
   * Push a synthetic lull-marker item onto the queue and start
   * processing. Returns false if processing is already in flight (the
   * lull is dropped — the in-flight turn covers the lull window).
   * Caller supplies the platform-specific fields; content + trigger
   * are filled in here.
   */
  enqueueLull(channelId, item) {
    const ch = this.getChannel(channelId);
    if (ch.processing) return false;
    ch.queue.push({ ...item, content: this._lullPrompt, trigger: 'lull' });
    this.processQueue(channelId);
    return true;
  }

  /**
   * Orchestrator: gate on the per-channel `processing` flag, run the
   * gateway's processOnce for the whole batch, then schedule a
   * follow-up drain if more items accumulated mid-run. Lull-led
   * follow-ups get a longer pause to avoid back-to-back chiming.
   */
  async processQueue(channelId) {
    const ch = this.getChannel(channelId);
    if (ch.processing || ch.queue.length === 0) return;
    ch.processing = true;
    try {
      await this._processOnce(channelId, ch);
    } catch (e) {
      this.log.error(`[message-queue] processOnce failed for ${channelId}: ${e.message}`);
    } finally {
      ch.processing = false;
      if (ch.queue.length > 0) {
        const drainDelay = ch.queue[0].trigger === 'lull' ? 2000 : 200;
        setTimeout(() => this.processQueue(channelId), drainDelay);
      }
    }
  }

  /**
   * Consume the queued items as a single batch and resolve the trigger
   * for the merged turn. Returns { items, merged, last, trigger,
   * isPassive }. Called by the gateway's processOnce as its first step.
   */
  drain(ch) {
    const items = ch.queue.splice(0);
    const merged = items.map(i => i.content).join('\n');
    const last = items[items.length - 1];
    const allTriggers = items.map(i => i.trigger).filter(Boolean);
    const trigger = TRIGGER_PRIORITY.find(p => allTriggers.includes(p)) || allTriggers[0] || 'unknown';
    const isPassive = trigger === 'lull' || trigger === 'task_complete' || trigger === 'proactive';
    return { items, merged, last, trigger, isPassive };
  }
}

module.exports = { MessageQueue, TRIGGER_PRIORITY };
