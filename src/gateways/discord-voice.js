/**
 * discord-voice.js — Discord Voice Channel Handler
 *
 * Opus decoding, PCM chunking, STT → agent → TTS → playback.
 *
 */

let voiceModule = null;
let prismMedia = null;
try {
  voiceModule = require('@discordjs/voice');
  prismMedia = require('prism-media');
} catch (e) {
  console.warn('[discord-voice] require failed: ' + e.message);
}

class DiscordVoice {
  constructor(gateway) {
    this.gateway = gateway;
    this.config = gateway.config;
    this.log = gateway.log;
    this.agent = gateway.agent;

    this._sessions = new Map();
    this._pipeline = null;
  }

  _ensureVoicePipeline() {
    if (this._pipeline) return this._pipeline;
    if (!this.config.voice?.enabled) return null;
    try {
      const { VoicePipeline } = require('../voice');
      this._pipeline = new VoicePipeline(this.config, this.log);
      return this._pipeline;
    } catch (e) {
      this.log.warn(`[voice] Failed to init pipeline: ${e.message}`);
      return null;
    }
  }

  async handleJoin(message) {
    if (!voiceModule) {
      await message.reply('Voice support is not installed. Missing @discordjs/voice package.');
      return;
    }

    const pipeline = this._ensureVoicePipeline();
    if (!pipeline?.enabled) {
      await message.reply('Voice pipeline not configured. Need DEEPGRAM_API_KEY + XI_API_KEY (or OPENAI_API_KEY) in .env.');
      return;
    }

    const member = message.member;
    if (!member?.voice?.channel) {
      await message.reply('You need to be in a voice channel first.');
      return;
    }

    const voiceChannel = member.voice.channel;
    const guildId = message.guildId;

    const existing = this._sessions.get(guildId);
    if (existing?.channel?.id === voiceChannel.id) {
      await message.reply(`Already in **${voiceChannel.name}**. Listening.`);
      return;
    }

    if (existing) {
      this._destroySession(guildId);
    }

    try {
      const connection = voiceModule.joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const player = voiceModule.createAudioPlayer({
        behaviors: { noSubscriber: voiceModule.NoSubscriberBehavior.Pause },
      });

      connection.subscribe(player);

      const session = {
        connection,
        player,
        channel: voiceChannel,
        subscriptions: new Map(),
        processing: new Set(),
      };

      this._sessions.set(guildId, session);

      connection.receiver.speaking.on('start', (userId) => {
        this._handleVoiceStart(guildId, userId, message.guild);
      });

      connection.on(voiceModule.VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            voiceModule.entersState(connection, voiceModule.VoiceConnectionStatus.Signalling, 5_000),
            voiceModule.entersState(connection, voiceModule.VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this._destroySession(guildId);
        }
      });

      connection.on(voiceModule.VoiceConnectionStatus.Destroyed, () => {
        this._sessions.delete(guildId);
      });

      await voiceModule.entersState(connection, voiceModule.VoiceConnectionStatus.Ready, 10_000);

      await message.reply(`Joined **${voiceChannel.name}**. I'm listening — just talk and I'll respond.`);
      this.log.info(`[voice] Joined ${voiceChannel.name} in ${message.guild.name}`);
    } catch (e) {
      this._destroySession(guildId);
      await message.reply(`Failed to join voice: ${e.message}`).catch(() => { });
      this.log.error(`[voice] Join failed: ${e.message}`);
    }
  }

  async handleLeave(message) {
    const guildId = message.guildId;
    const session = this._sessions.get(guildId);
    if (!session) {
      await message.reply('Not in a voice channel.');
      return;
    }

    const channelName = session.channel?.name || 'voice';
    this._destroySession(guildId);
    await message.reply(`Left **${channelName}**.`);
    this.log.info(`[voice] Left ${channelName}`);
  }

  _handleVoiceStart(guildId, userId, guild) {
    const session = this._sessions.get(guildId);
    if (!session) return;

    if (session.subscriptions.has(userId)) return;
    if (userId === this.gateway.client.user.id) return;

    if (session.player?.state?.status === voiceModule.AudioPlayerStatus.Playing) {
      session.player.stop(true);
      this.log.info(`[voice] Barge-in: stopped playback — user ${userId} started speaking`);
    }

    if (session.processing.has(userId)) {
      session.processing.delete(userId);
    }

    const silenceMs = this.config.voice?.silenceThresholdMs || 400;
    const maxSecs = this.config.voice?.maxUtteranceSecs || 30;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: voiceModule.EndBehaviorType.AfterSilence,
        duration: silenceMs,
      },
    });

    session.subscriptions.set(userId, opusStream);

    const pcmChunks = [];
    let totalBytes = 0;
    const maxBytes = maxSecs * 48000 * 2;

    let decoder;
    try {
      decoder = new prismMedia.opus.Decoder({
        rate: 48000,
        channels: 1,
        frameSize: 960,
      });
    } catch (e) {
      this.log.error(`[voice] Opus decoder creation failed: ${e.message}`);
      session.subscriptions.delete(userId);
      return;
    }

    opusStream.pipe(decoder);

    decoder.on('data', (chunk) => {
      if (totalBytes < maxBytes) {
        pcmChunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    const cleanup = () => {
      session.subscriptions.delete(userId);
      opusStream.destroy();
      decoder.destroy();
    };

    decoder.on('end', () => {
      cleanup();

      if (totalBytes < 3200) {
        return;
      }

      const pcmBuffer = Buffer.concat(pcmChunks);
      this._processUtterance(guildId, userId, pcmBuffer, guild);
    });

    decoder.on('error', (e) => {
      this.log.warn(`[voice] Decoder error for ${userId}: ${e.message}`);
      cleanup();
    });

    opusStream.on('error', (e) => {
      this.log.warn(`[voice] Opus stream error for ${userId}: ${e.message}`);
      cleanup();
    });
  }

  async _processUtterance(guildId, userId, pcmBuffer, guild) {
    const session = this._sessions.get(guildId);
    if (!session) return;

    if (session.processing.has(userId)) return;
    session.processing.add(userId);

    try {
      const pipeline = this._ensureVoicePipeline();
      if (!pipeline) return;

      const wavBuffer = this._pcmToWav(pcmBuffer, 48000, 1, 16);

      let userName = 'Unknown';
      try {
        const member = await guild.members.fetch(userId);
        userName = member.displayName || member.user.username || userName;
      } catch (e) { this.log.warn('[discord-voice] guild.members.fetch failed: ' + e.message); }

      const channelId = session.channel?.id || guildId;
      const channelName = session.channel?.name || 'voice';

      const result = await pipeline.process(wavBuffer, 'audio/wav', this.agent, {
        channelId: `voice:${channelId}`,
        channelName: `voice:${channelName}`,
        userId,
        userName,
        guildName: guild.name,
        isDm: false,
        trigger: 'voice',
        platform: 'discord',
        suppressLearning: false,
      });

      if (result.error) {
        this.log.warn(`[voice] Pipeline error: ${result.error}`);
        return;
      }

      if (!result.audioBuffer && result.responseText) {
        this.log.info(`[voice] Got text response but no audio: "${result.responseText.slice(0, 80)}..."`);
        return;
      }

      if (result.audioBuffer && session.connection?.state?.status === 'ready') {
        if (session.player?.state?.status === voiceModule.AudioPlayerStatus.Playing) {
          this.log.info('[voice] Skipping playback — player already busy (barge-in race)');
          return;
        }

        const { Readable } = require('stream');
        const audioStream = Readable.from(result.audioBuffer);
        const resource = voiceModule.createAudioResource(audioStream, {
          inputType: voiceModule.StreamType.Arbitrary,
        });

        session.player.play(resource);

        await new Promise((resolve) => {
          const onIdle = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            session.player.removeListener(voiceModule.AudioPlayerStatus.Idle, onIdle);
            resolve();
          }, 60_000);
          session.player.once(voiceModule.AudioPlayerStatus.Idle, onIdle);
        });
      }
    } catch (e) {
      this.log.error(`[voice] Utterance processing failed: ${e.message}`);
    } finally {
      session.processing.delete(userId);
    }
  }

  _pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  _destroySession(guildId) {
    const session = this._sessions.get(guildId);
    if (!session) return;

    for (const [, stream] of session.subscriptions) {
      try { stream.destroy(); } catch (e) { this.log.warn('[discord-voice] stream.destroy failed: ' + e.message); }
    }
    session.subscriptions.clear();

    try { session.player?.stop(true); } catch (e) { this.log.warn('[discord-voice] stop failed: ' + e.message); }
    try { session.connection?.destroy(); } catch (e) { this.log.warn('[discord-voice] destroy failed: ' + e.message); }

    this._sessions.delete(guildId);
  }
}

module.exports = { DiscordVoice };
