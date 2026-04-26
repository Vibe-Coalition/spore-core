/**
 * voice/index.js — Voice module barrel export
 *
 * STT provider classes (DeepgramSTT, OpenAIWhisperSTT) live in
 * plugins/deepgram and plugins/whisper respectively. Core only
 * re-exports the createSTT walker that the VoicePipeline uses.
 */

const { createSTT } = require('./stt');
const { ElevenLabsTTS, OpenAITTS, EdgeTTS, createTTS } = require('./tts');
const { VoicePipeline } = require('./pipeline');

module.exports = {
  createSTT,
  ElevenLabsTTS,
  OpenAITTS,
  EdgeTTS,
  createTTS,
  VoicePipeline,
};
