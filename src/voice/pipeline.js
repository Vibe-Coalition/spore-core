/**
 * voice/pipeline.js — Voice pipeline orchestrator
 *
 * Coordinates: audio in → STT → queued agent turn → TTS → audio out
 * Used by both Discord voice channels and Telegram voice notes.
 */

const { createSTT } = require('./stt');
const { createTTS } = require('./tts');
const settings = require('../settings');

class VoicePipeline {
  constructor(config, logger, pluginManager = null) {
    this.config = config;
    this.log = logger;
    this.pluginManager = pluginManager;
    this._buildSttTts();

    // Reactive: when any voice setting or any plugin's config changes
    // (e.g. STT/TTS plugin api keys), rebuild stt/tts. Replaces the
    // legacy `this._voicePipeline = null` cache-bust hack in web.js
    // and keeps Discord / Telegram pipelines fresh without restart.
    this._unsubVoice = settings.subscribe('voice.*', () => this._rebuild('voice setting changed'));
    this._unsubPlugins = settings.subscribe('plugins.**', () => this._rebuild('plugin config changed'));
  }

  _buildSttTts() {
    this.stt = createSTT(this.config, this.pluginManager);
    this.tts = createTTS(this.config, this.pluginManager);
    this.enabled = !!(this.stt && this.tts);

    if (this.enabled) {
      const ttsName = this.tts?.constructor?.name?.replace('TTS', '') || 'unknown';
      this.log.info(`[voice] Pipeline ready — STT: ${this.config.voice?.sttProvider || 'auto'}, TTS: ${ttsName}`);
    } else if (!this.stt) {
      this.log.info(`[voice] Pipeline disabled — no STT provider available (install an STT plugin in Settings → Plugins).`);
    }
  }

  _rebuild(reason) {
    try {
      this._buildSttTts();
      this.log.debug(`[voice] pipeline rebuilt (${reason})`);
    } catch (e) {
      this.log.warn(`[voice] pipeline rebuild failed: ${e?.message}`);
    }
  }

  destroy() {
    try { this._unsubVoice?.(); } catch { /* noop */ }
    try { this._unsubPlugins?.(); } catch { /* noop */ }
    this._unsubVoice = null;
    this._unsubPlugins = null;
  }

  _submitAgentTurn(agentLoop, opts, meta = {}) {
    const queue = agentLoop?._jobQueue;
    if (queue?.submitAgentTurn) return queue.submitAgentTurn(opts, meta);
    return agentLoop?.processMessage(opts);
  }

  /**
   * Full voice pipeline: audio buffer → transcription → agent → TTS audio.
   *
   * @param {Buffer} audioBuffer - Raw audio data (PCM, OGG, etc.)
   * @param {string} mimeType - Audio MIME type
   * @param {object} agentLoop - The AgentLoop instance
   * @param {object} messageOpts - Options for an agent turn (channelId, userId, etc.)
   * @returns {Promise<{transcription: string, responseText: string, audioBuffer: Buffer|null, error: string|null}>}
   */
  async process(audioBuffer, mimeType, agentLoop, messageOpts) {
    if (!this.enabled) {
      return { transcription: null, responseText: null, audioBuffer: null, error: 'Voice pipeline not configured' };
    }

    // Step 1: STT
    let transcription;
    try {
      const result = await this.stt.transcribe(audioBuffer, mimeType);
      transcription = result.text;
      if (!transcription || !transcription.trim()) {
        return { transcription: '', responseText: null, audioBuffer: null, error: null };
      }
      this.log.info(`[voice] STT: "${transcription.slice(0, 100)}${transcription.length > 100 ? '...' : ''}"`);
    } catch (e) {
      const msg = e?.message || String(e);
      this.log.error(`[voice] STT failed: ${msg}`);
      return { transcription: null, responseText: null, audioBuffer: null, error: `STT failed: ${msg}` };
    }

    // Step 2: Agent — process transcription exactly like a text message
    let responseText;
    try {
      const result = await this._submitAgentTurn(agentLoop, {
        ...messageOpts,
        content: messageOpts.isDm ? transcription : `[${messageOpts.userName}]: ${transcription}`,
        messageContent: transcription,
        modality: 'voice',
      }, {
        lane: 'channel',
        priority: 88,
        route: 'voice.message',
        sessionKey: messageOpts.channelId || messageOpts.channelName || messageOpts.userId || null,
        allowInterjection: true,
      });

      if (result?.skipped) {
        return { transcription, responseText: null, audioBuffer: null, error: 'Agent busy' };
      }

      responseText = result?.text;
      if (!responseText || responseText.trim() === 'NO_REPLY') {
        return { transcription, responseText: null, audioBuffer: null, error: null };
      }

      this._lastResult = result;
      this.log.info(`[voice] Agent response: "${responseText.slice(0, 100)}${responseText.length > 100 ? '...' : ''}" (${result.iterations} iters)`);
    } catch (e) {
      const msg = e?.message || String(e);
      this.log.error(`[voice] Agent failed: ${msg}`);
      return { transcription, responseText: null, audioBuffer: null, error: `Agent failed: ${msg}` };
    }

    // Step 3: TTS — convert response to audio
    let responseAudio;
    try {
      const ttsText = this._cleanForTTS(responseText);
      if (!ttsText) {
        return { transcription, responseText, audioBuffer: null, error: null };
      }
      responseAudio = await this.tts.synthesize(ttsText);
      this.log.info(`[voice] TTS: ${responseAudio.length} bytes`);
    } catch (e) {
      const msg = e?.message || String(e);
      this.log.error(`[voice] TTS failed: ${msg}`);
      return { transcription, responseText, audioBuffer: null, error: `TTS failed: ${msg}` };
    }

    const agentResult = this._lastResult || {};
    return { transcription, responseText, audioBuffer: responseAudio, error: null, usage: agentResult.usage, toolUsage: agentResult.toolUsage, iterations: agentResult.iterations };
  }

  /**
   * Process from already-transcribed text — runs agent + TTS, skipping STT.
   */
  async processFromText(transcription, agentLoop, messageOpts) {
    let responseText;
    try {
      const result = await this._submitAgentTurn(agentLoop, {
        ...messageOpts,
        content: messageOpts.isDm ? transcription : `[${messageOpts.userName}]: ${transcription}`,
        messageContent: transcription,
        modality: 'voice',
      }, {
        lane: 'channel',
        priority: 88,
        route: 'voice.text',
        sessionKey: messageOpts.channelId || messageOpts.channelName || messageOpts.userId || null,
        allowInterjection: true,
      });
      if (result?.skipped) return { transcription, responseText: null, audioBuffer: null, error: 'Agent busy' };
      responseText = result?.text;
      if (!responseText || responseText.trim() === 'NO_REPLY') return { transcription, responseText: null, audioBuffer: null, error: null };
      this._lastResult = result;
    } catch (e) {
      const msg = e?.message || String(e);
      this.log.error(`[voice] Agent failed: ${msg}`);
      return { transcription, responseText: null, audioBuffer: null, error: `Agent failed: ${msg}` };
    }
    let responseAudio;
    try {
      const ttsText = this._cleanForTTS(responseText);
      if (!ttsText) return { transcription, responseText, audioBuffer: null, error: null };
      responseAudio = await this.tts.synthesize(ttsText);
    } catch (e) {
      const msg = e?.message || String(e);
      this.log.error(`[voice] TTS failed: ${msg}`);
      return { transcription, responseText, audioBuffer: null, error: `TTS failed: ${msg}` };
    }
    const agentResult = this._lastResult || {};
    return { transcription, responseText, audioBuffer: responseAudio, error: null, usage: agentResult.usage, toolUsage: agentResult.toolUsage, iterations: agentResult.iterations };
  }

  /**
   * Transcribe-only — used when we just need the text (e.g., voice note → text reply fallback).
   */
  async transcribeOnly(audioBuffer, mimeType) {
    if (!this.stt) return { text: null, error: 'No STT configured' };
    try {
      const result = await this.stt.transcribe(audioBuffer, mimeType);
      return { text: result.text, error: null };
    } catch (e) {
      return { text: null, error: e?.message || String(e) };
    }
  }

  /**
   * TTS-only — used when we have text and just need audio.
   */
  async synthesizeOnly(text) {
    if (!this.tts) return { audio: null, error: 'No TTS configured' };
    try {
      const cleaned = this._cleanForTTS(text);
      if (!cleaned) return { audio: null, error: null };
      const audio = await this.tts.synthesize(cleaned);
      return { audio, error: null };
    } catch (e) {
      return { audio: null, error: e?.message || String(e) };
    }
  }

  /**
   * Clean text for TTS — remove markdown, code blocks, URLs, etc.
   * TTS engines produce garbage when fed raw markdown or code.
   */
  _cleanForTTS(text) {
    if (!text) return '';

    let cleaned = text;

    // Remove code blocks entirely (agent might return code — skip it in voice)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ' (code block omitted) ');

    // Remove inline code
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

    // Remove markdown bold/italic
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

    // Remove markdown headers
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

    // Remove markdown links, keep text
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove raw URLs
    cleaned = cleaned.replace(/https?:\/\/\S+/g, '(link)');

    // Remove bullet points
    cleaned = cleaned.replace(/^[\s]*[-*•]\s+/gm, '');

    // Collapse whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // Truncate excessively long responses for TTS (cost + UX)
    const MAX_TTS_CHARS = 3000;
    if (cleaned.length > MAX_TTS_CHARS) {
      const cutoff = cleaned.lastIndexOf('.', MAX_TTS_CHARS);
      cleaned = cleaned.slice(0, cutoff > MAX_TTS_CHARS * 0.5 ? cutoff + 1 : MAX_TTS_CHARS);
    }

    return cleaned;
  }
}

module.exports = { VoicePipeline };
