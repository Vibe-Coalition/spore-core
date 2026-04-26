// Browser-side Whisper STT via Transformers.js.
// Loaded by graph-viewer.html when the whisper plugin is installed
// (via api.registerFrontendAsset → /api/plugins/frontend-assets →
// dynamic <script> insertion). Attaches to `window.WhisperSTT` so
// existing call sites in graph-viewer.html (`WhisperSTT.isReady()`,
// `WhisperSTT.transcribe(blob)`) keep working. When the plugin is
// uninstalled, this script no longer loads and `window.WhisperSTT`
// is undefined — call sites use `?.` chains so they no-op.
//
// Extracted from graph-viewer.html (Phase B of whisper extraction).
// Worker code + Transformers.js still load from CDN per user decision.

window.WhisperSTT = (() => {
  let worker = null;
  let ready = false;
  let loading = false;
  let pendingResolve = null;
  let onStatus = null;
  let onProgress = null;
  let firstTranscribe = true;

  const WORKER_CODE = `
    import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

    env.allowLocalModels = false;

    let transcriber = null;
    const MODEL = 'onnx-community/whisper-tiny.en';

    function progressCb(info) {
      self.postMessage({ type: 'progress', ...info });
    }

    self.onmessage = async (e) => {
      if (e.data.type === 'load') {
        const gpuHint = e.data.gpuAvailable;
        let device = null;
        const errors = [];

        // 1) Try WebGPU if main thread confirmed adapter exists
        if (gpuHint) {
          try {
            self.postMessage({ type: 'status', text: 'Loading Whisper (GPU)...', phase: 'download-webgpu' });
            transcriber = await pipeline('automatic-speech-recognition', MODEL, {
              progress_callback: progressCb,
              device: 'webgpu',
              dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
            });
            device = 'webgpu';
          } catch (err) {
            errors.push('webgpu: ' + err.message);
            self.postMessage({ type: 'status', text: 'GPU failed — loading CPU model...', phase: 'fallback' });
            transcriber = null;
          }
        }

        // 2) WASM fallback — MUST specify device explicitly to prevent ONNX from probing WebGPU
        if (!transcriber) {
          try {
            self.postMessage({ type: 'status', text: 'Loading Whisper (CPU)...', phase: 'download-wasm' });
            transcriber = await pipeline('automatic-speech-recognition', MODEL, {
              progress_callback: progressCb,
              device: 'wasm',
            });
            device = 'wasm';
          } catch (err1) {
            // Some versions don't accept 'wasm' — try 'cpu'
            try {
              transcriber = await pipeline('automatic-speech-recognition', MODEL, {
                progress_callback: progressCb,
                device: 'cpu',
              });
              device = 'wasm';
            } catch (err2) {
              errors.push('wasm: ' + err1.message + ' / cpu: ' + err2.message);
            }
          }
        }

        if (transcriber) {
          self.postMessage({ type: 'ready', device, gpuHint, errors });
        } else {
          self.postMessage({ type: 'error', errors, gpuHint });
        }
      } else if (e.data.type === 'transcribe') {
        if (!transcriber) { self.postMessage({ type: 'result', text: '', error: 'Not loaded' }); return; }
        try {
          const audio = e.data.audio;
          console.log('[worker] Audio:', audio?.length, 'samples');
          self.postMessage({ type: 'status', text: 'Transcribing...', phase: 'transcribe' });
          const t0 = performance.now();
          const result = await transcriber(audio);
          const ms = Math.round(performance.now() - t0);
          console.log('[worker] Result (' + ms + 'ms):', JSON.stringify(result));
          self.postMessage({ type: 'result', text: result.text || '' });
        } catch (err) {
          console.error('[worker] Transcribe error:', err);
          self.postMessage({ type: 'result', text: '', error: err.message });
        }
      }
    };
  `;

  async function init(statusCb, progressCb) {
    if (worker) return;
    onStatus = statusCb || (() => {});
    onProgress = progressCb || (() => {});

    // Probe WebGPU from the MAIN THREAD (Workers can't always access GPU adapters)
    let gpuAvailable = false;
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        gpuAvailable = !!adapter;
        console.log('[whisper] Main-thread WebGPU probe:', gpuAvailable ? 'adapter found' : 'no adapter');
      }
    } catch (e) {
      console.log('[whisper] Main-thread WebGPU probe failed:', e.message);
    }

    const blob = new Blob([WORKER_CODE], { type: 'text/javascript' });
    worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'ready') {
        ready = true; loading = false;
        const label = d.device === 'webgpu' ? 'GPU' : 'CPU';
        onStatus('Whisper ready (' + label + ')', 'ready');
        onProgress(null);
        if (d.device === 'webgpu') {
          onStatus('Whisper ready (GPU) — first use compiles shaders (~5s)', 'ready-warmup');
        }
        if (d.device === 'wasm' && d.gpuHint) {
          setTimeout(() => {
            if (typeof addChatMessage === 'function') {
              addChatMessage('system',
                'GPU detected but WebGPU failed in worker. Using CPU STT.\n' +
                'Try: chrome://flags/#enable-unsafe-webgpu → Enable → Restart Chrome for GPU acceleration.');
            }
          }, 2000);
        }
      } else if (d.type === 'status') {
        onStatus(d.text, d.phase || 'status');
      } else if (d.type === 'progress') {
        onProgress(d);
      } else if (d.type === 'error') {
        loading = false;
        console.error('[whisper] Load failed:', d.errors);
        onStatus('STT: server mode', 'error');
        onProgress(null);
        setTimeout(() => {
          if (typeof addChatMessage !== 'function') return;
          const tips = ['Local Whisper could not load. Using server STT.'];
          if (gpuAvailable) {
            tips.push('GPU found but WebGPU worker failed. Try chrome://flags/#enable-unsafe-webgpu.');
          }
          addChatMessage('system', tips.join('\n'));
        }, 2000);
      } else if (d.type === 'result') {
        console.log('[whisper] Result:', JSON.stringify({ text: d.text, error: d.error }));
        onStatus && onStatus('Whisper ready', 'ready');
        if (pendingResolve) { pendingResolve(d.text || ''); pendingResolve = null; }
      }
    };
    loading = true;
    worker.postMessage({ type: 'load', gpuAvailable });
  }

  async function transcribe(audioBlob) {
    if (!ready) return null;
    try {
      const arrayBuf = await audioBlob.arrayBuffer();
      console.log('[whisper] Blob size:', arrayBuf.byteLength, 'type:', audioBlob.type);
      if (arrayBuf.byteLength < 100) {
        console.warn('[whisper] Audio blob too small, skipping');
        return '';
      }

      // Use a persistent AudioContext for decoding (creating new ones can cause issues)
      if (!window.WhisperSTT._decodeCtx) window.WhisperSTT._decodeCtx = new AudioContext();
      const decoded = await window.WhisperSTT._decodeCtx.decodeAudioData(arrayBuf.slice(0));
      console.log('[whisper] Decoded:', decoded.duration.toFixed(2) + 's', decoded.numberOfChannels + 'ch', decoded.sampleRate + 'Hz');

      if (decoded.duration < 0.3) {
        console.warn('[whisper] Recording too short:', decoded.duration);
        return '';
      }

      // Check decoded audio has actual content
      const rawSamples = decoded.getChannelData(0);
      let maxAmp = 0;
      for (let i = 0; i < rawSamples.length; i++) {
        const abs = Math.abs(rawSamples[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      console.log('[whisper] Decoded max amplitude:', maxAmp.toFixed(4));
      if (maxAmp < 0.001) {
        console.warn('[whisper] Decoded audio is silent (max amp ' + maxAmp + ')');
        return '';
      }

      // Resample to 16kHz mono
      const targetLen = Math.ceil(decoded.duration * 16000);
      const offCtx = new OfflineAudioContext(1, targetLen, 16000);
      const src = offCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(offCtx.destination);
      src.start();
      const rendered = await offCtx.startRendering();
      const float32 = rendered.getChannelData(0);
      console.log('[whisper] Resampled to', float32.length, 'samples (' + (float32.length/16000).toFixed(2) + 's)');

      if (firstTranscribe) {
        firstTranscribe = false;
        onStatus && onStatus('First transcription (compiling shaders)...', 'shader');
      }

      return new Promise((resolve) => {
        pendingResolve = resolve;
        worker.postMessage({ type: 'transcribe', audio: float32 }, [float32.buffer]);
      });
    } catch (err) {
      console.error('[whisper] Transcribe error:', err);
      return '';
    }
  }

  return { init, transcribe, isReady: () => ready, isLoading: () => loading };
})();
