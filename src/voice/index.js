/**
 * voice/index.js — Voice module barrel export
 */

const { DeepgramSTT, OpenAISTT, createSTT } = require('./stt');
const { ElevenLabsTTS, OpenAITTS, EdgeTTS, createTTS } = require('./tts');
const { VoicePipeline } = require('./pipeline');

module.exports = {
  DeepgramSTT,
  OpenAISTT,
  createSTT,
  ElevenLabsTTS,
  OpenAITTS,
  EdgeTTS,
  createTTS,
  VoicePipeline,
};
