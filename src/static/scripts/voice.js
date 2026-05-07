// voice.js — Chat input handling: file attachments, clipboard paste, mic push-to-talk,
// voice call, interrupt listener, sendChat / _dispatchChat / busy follow-up send.
// Extracted from src/static/scripts/app.js (was lines 7296-8083 of the post-Phase-2 monolith).

// ── File Attachments ──
let pendingFiles = [];

function updateAttachmentUI() {
  const container = document.getElementById('chat-attachments');
  container.innerHTML = '';
  container.className = pendingFiles.length ? 'has-files' : '';
  pendingFiles.forEach((f, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';
    if (f.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = f.dataUrl;
      thumb.appendChild(img);
    } else if (f.type.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = f.dataUrl;
      vid.muted = true;
      vid.style.cssText = 'width:60px;height:60px;object-fit:cover;display:block';
      vid.addEventListener('loadeddata', () => { try { vid.currentTime = 0.5; } catch {} });
      thumb.appendChild(vid);
      const badge = document.createElement('span');
      badge.style.cssText = 'position:absolute;bottom:2px;left:2px;font-size:9px;background:rgba(0,0,0,0.7);color:#fff;padding:1px 4px;border-radius:3px';
      badge.textContent = '▶';
      thumb.appendChild(badge);
    } else if (f.type.startsWith('audio/')) {
      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.innerHTML = '<div style="font-size:20px;margin-bottom:2px">♪</div><div>' + (f.name.length > 12 ? f.name.slice(0,9) + '…' : f.name) + '</div>';
      thumb.appendChild(icon);
    } else {
      const ext = f.name.split('.').pop()?.toUpperCase() || '?';
      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.innerHTML = '<div style="font-size:11px;font-weight:bold;opacity:0.7;margin-bottom:2px">' + esc(ext) + '</div><div>' + esc(f.name.length > 12 ? f.name.slice(0,9) + '…' : f.name) + '</div>';
      thumb.appendChild(icon);
    }
    const btn = document.createElement('button');
    btn.className = 'remove-attach';
    btn.textContent = '×';
    btn.onclick = () => { pendingFiles.splice(i, 1); updateAttachmentUI(); };
    thumb.appendChild(btn);
    container.appendChild(thumb);
  });
}

// ── Clipboard paste support ──
document.getElementById('chat-input').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.size > 20 * 1024 * 1024) { toast('Pasted file too large (max 20MB)', true); continue; }
    handled = true;
    const reader = new FileReader();
    reader.onload = () => {
      const name = file.name || ('pasted-' + Date.now() + '.' + (file.type.split('/')[1] || 'bin'));
      pendingFiles.push({ name, type: file.type, dataUrl: reader.result, data: reader.result.split(',')[1] });
      updateAttachmentUI();
    };
    reader.readAsDataURL(file);
  }
  if (handled) e.preventDefault();
});

document.getElementById('btn-attach').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('btn-clear-chat').addEventListener('click', () => {
  if (!confirm('Clear chat history? This clears the conversation for this spore.')) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat:clear' }));
  }
});

document.getElementById('file-input').addEventListener('change', (e) => {
  for (const file of e.target.files) {
    if (file.size > 20 * 1024 * 1024) { toast('File too large (max 20MB)', true); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      pendingFiles.push({ name: file.name, type: file.type, dataUrl: reader.result, data: reader.result.split(',')[1] });
      updateAttachmentUI();
    };
    reader.readAsDataURL(file);
  }
  e.target.value = '';
});

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if ((!text && !pendingFiles.length) || !ws || ws.readyState !== 1) return;

  if (chatBusy) {
    _sendFollowupWhileBusy(text);
    return;
  }

  _dispatchChat(text);
}

function _restoreChatDraft(text, attachments = []) {
  const input = document.getElementById('chat-input');
  input.value = text || '';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  pendingFiles = [...attachments];
  updateAttachmentUI();
}

function _dispatchChat(text) {
  const input = document.getElementById('chat-input');
  const attachments = [...pendingFiles];
  const userBubble = addChatMessage('user', text || '(attached files)', attachments.length ? attachments : undefined);

  const images = attachments
    .filter(f => f.type.startsWith('image/'))
    .map(f => ({ data: f.data, mediaType: f.type }));
  const files = attachments
    .filter(f => !f.type.startsWith('image/'))
    .map(f => ({ name: f.name, data: f.data, mediaType: f.type }));

  try {
    ws.send(JSON.stringify({
      type: 'chat',
      content: text || 'I\'ve attached some files. Please look at them.',
      userName: _currentUserDisplayName || _currentUserName,
      userId: _currentUserName,
      images: images.length ? images : undefined,
      files: files.length ? files : undefined,
    }));
  } catch (e) {
    if (typeof _removeChatBubble === 'function') _removeChatBubble(userBubble);
    _restoreChatDraft(text, attachments);
    addChatMessage('system', 'Message was not sent — connection lost. Your draft was restored.');
    return false;
  }
  input.value = '';
  input.style.height = 'auto';
  pendingFiles = [];
  updateAttachmentUI();
  return true;
}

function _sendFollowupWhileBusy(newText) {
  // Do not abort the active run. The server queues this as an
  // interjection and folds it into the in-flight turn at the next safe
  // iteration boundary. Failed WebSocket delivery restores the draft.
  _dispatchChat(newText);
}

document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-stop').addEventListener('click', () => {
  _chatStopped = true;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'chat:stop' }));
  }
  finalizeStreamingMsg();
  setActivity('stopping...');
  addChatMessage('system', 'Stopping...');
  // Brief delay to let abort propagate, then fully reset
  setTimeout(() => {
    setChatBusy(false);
    _chatStopped = true;
    setActivity(null);
    // Replace "Stopping..." with "Stopped."
    const msgs = document.getElementById('chat-messages');
    const systemMsgs = msgs?.querySelectorAll('.chat-msg.system');
    if (systemMsgs?.length) {
      const last = systemMsgs[systemMsgs.length - 1];
      if (last.textContent === 'Stopping...') last.textContent = 'Stopped.';
    }
  }, 1500);
});
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// Drag-and-drop onto chat panel
document.getElementById('chat-panel').addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.getElementById('chat-panel').addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    if (file.size > 20 * 1024 * 1024) { toast('File too large (max 20MB)', true); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      pendingFiles.push({ name: file.name, type: file.type, dataUrl: reader.result, data: reader.result.split(',')[1] });
      updateAttachmentUI();
    };
    reader.readAsDataURL(file);
  }
});

// ── Mic button: push-to-talk (no call) or mute/unmute (during call) ──
let micRecorder = null;
let micStream = null;
let micChunks = [];
let callMuted = false;
const btnMic = document.getElementById('btn-mic');

function updateMicButton() {
  if (voiceCallActive) {
    if (callMuted) {
      btnMic.classList.add('muted');
      btnMic.classList.remove('recording');
      btnMic.innerHTML = 'muted';
    } else {
      btnMic.classList.remove('muted', 'recording');
      btnMic.innerHTML = 'mic on';
    }
  } else {
    btnMic.classList.remove('muted', 'recording');
    btnMic.innerHTML = 'mic';
  }
}

// ── Click-to-toggle mic (tap to start, tap again to stop and send) ──
// Was push-to-talk (hold-to-record); switched because pointer-capture
// edge cases (mouse leaving button, touch cancel, etc.) could leave
// the recording stuck on with no obvious way for the user to stop it.

async function startMicRecording() {
  // Defensive cleanup — if a previous recording is still wired,
  // detach its onstop callback and stop the tracks before starting
  // fresh. Prevents stale recorders from firing late callbacks.
  if (micRecorder && micRecorder.state === 'recording') {
    try { micRecorder.onstop = null; micRecorder.stop(); } catch (_) {}
  }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    micRecorder = mimeType
      ? new MediaRecorder(micStream, { mimeType })
      : new MediaRecorder(micStream);
    micRecorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data); };
    micRecorder.onstop = async () => {
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
      btnMic.classList.remove('recording');
      btnMic.innerHTML = 'mic';
      if (!micChunks.length || window._micDiscard) { micChunks = []; window._micDiscard = false; return; }
      const blobType = micRecorder.mimeType || 'audio/webm';
      const blob = new Blob(micChunks, { type: blobType });
      micChunks = [];
      console.log('[mic] Recorded blob:', blob.size, 'bytes,', blobType);

      if (window._sttEnabled) {
        // Deepgram (server STT) — transcription comes back via voice:transcription
        window._micAutoSend = true;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          ws.send(JSON.stringify({ type: 'voice', audio: base64, mimeType: blobType, mode: 'transcribe' }));
        };
        reader.readAsDataURL(blob);
      } else if (WhisperSTT.isReady()) {
        let text = '';
        try {
          text = await Promise.race([
            WhisperSTT.transcribe(blob),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
          ]);
        } catch (err) {
          console.error('[mic] whisper failed:', err);
        }
        if (text && text.trim()) {
          const input = document.getElementById('chat-input');
          input.value = text.trim();
          sendChat();
        }
      } else {
        addChatMessage('system', 'No STT available — install the whisper or deepgram plugin (Settings → Plugins) to enable voice input.');
      }
    };
    micRecorder.start(250);
    btnMic.classList.add('recording');
    btnMic.innerHTML = 'rec';
  } catch (e) {
    addChatMessage('system', 'Mic access denied: ' + e.message);
  }
}

function stopMicRecording(discard) {
  if (discard) window._micDiscard = true;
  if (micRecorder && micRecorder.state === 'recording') {
    try { micRecorder.stop(); } catch (_) {}
  }
}

btnMic.addEventListener('click', async (e) => {
  e.preventDefault();
  // During a voice call: single-tap mutes (call is the only "modal" path)
  if (voiceCallActive) {
    callMuted = !callMuted;
    if (voiceCallStream) {
      voiceCallStream.getAudioTracks().forEach(t => { t.enabled = !callMuted; });
    }
    updateMicButton();
    voiceStatusText.textContent = callMuted ? 'muted' : 'listening...';
    return;
  }
  // Otherwise: toggle. If currently recording, stop and send. If idle,
  // start recording. Stop is recognised either by the button class or
  // by the underlying recorder state (whichever is true catches a stuck
  // state from a previous failed cycle).
  const recording = btnMic.classList.contains('recording')
    || (micRecorder && micRecorder.state === 'recording');
  if (recording) {
    stopMicRecording(false);
  } else {
    await startMicRecording();
  }
});
btnMic.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Voice Call ──
let voiceCallActive = false;
let voiceCallRecorder = null;
let voiceCallStream = null;
let agentNames = []; // populated from /api/identity
let currentTtsAudio = null; // reference to playing TTS so we can interrupt
let interruptRecorder = null;
let interruptStream = null;
let _voiceStreamEl = null;
let _voiceStreamText = '';
const btnVoiceCall = document.getElementById('btn-voice-call');
const voiceIndicator = document.getElementById('voice-indicator');
const voiceStatusText = document.getElementById('voice-status-text');

// Fetch agent identity (names/nicknames for interrupt detection)
async function loadAgentIdentity() {
  try {
    const resp = await fetch(API + '/api/identity');
    const data = await resp.json();
    agentNames = (data.names || [data.name]).map(n => n.toLowerCase());
    if (data.name) {
      // Chat header no longer shows the agent name; the document title still
      // surfaces it for the browser tab.
      document.title = data.name + ' · ' + (VB.name || 'Graph Viewer');
    }
    if (!data.voiceEnabled) {
      btnVoiceCall.title = 'Voice not configured (need TTS/STT keys)';
      btnVoiceCall.style.opacity = '0.3';
    }
    // Server STT (Deepgram) takes priority. Only load local WebGPU Whisper when no server STT.
    window._sttEnabled = !!data.sttEnabled;
    if (!window._sttEnabled) {
      initWhisperSTT();
    } else {
      try { addEventToFeed({ op: 'whisper', source: 'STT: Deepgram (server)' }); } catch {}
    }
  } catch {}
}

btnVoiceCall.addEventListener('click', async () => {
  if (voiceCallActive) {
    stopVoiceCall();
  } else {
    startVoiceCall();
  }
});

function playCallTone(type) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.value = 0.15;

  if (type === 'start') {
    // Rising two-tone chime
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.setValueAtTime(587, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(698, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } else {
    // Falling two-tone
    osc.frequency.setValueAtTime(587, ctx.currentTime);
    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(330, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.45);
  }
  osc.onended = () => ctx.close();
}

function requestGreeting() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'voice:tts', text: 'Hey! I\'m here.' }));
  }
}

function requestGoodbye() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'voice:tts', text: 'Talk to you later.' }));
  }
}

async function startVoiceCall() {
  try {
    voiceCallStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    addChatMessage('system', 'Mic access denied: ' + e.message);
    return;
  }
  voiceCallActive = true;
  callMuted = false;
  btnVoiceCall.classList.add('in-call');
  btnVoiceCall.innerHTML = 'end call';
  voiceIndicator.classList.add('active');
  voiceStatusText.textContent = 'connecting...';
  updateMicButton();
  const nameStr = agentNames.length ? '"' + agentNames[0] + '"' : 'their name';
  addChatMessage('system', 'Voice call started. Say ' + nameStr + ' to interrupt.');
  playCallTone('start');
  // Small delay for tone to play, then request TTS greeting
  setTimeout(() => {
    requestGreeting();
    voiceStatusText.textContent = 'call active — listening...';
  }, 600);
  // Start listening after greeting plays (handled in voice:audio handler)
  setTimeout(() => { if (voiceCallActive) voiceCallListen(); }, 2500);
}

function stopVoiceCall() {
  voiceCallActive = false;
  callMuted = false;
  btnVoiceCall.classList.remove('in-call');
  btnVoiceCall.innerHTML = 'call';
  voiceIndicator.classList.remove('active');
  if (voiceCallRecorder && voiceCallRecorder.state === 'recording') voiceCallRecorder.stop();
  if (voiceCallStream) { voiceCallStream.getTracks().forEach(t => t.stop()); voiceCallStream = null; }
  stopInterruptListener();
  if (currentTtsAudio) { currentTtsAudio.pause(); currentTtsAudio = null; }
  updateMicButton();
  playCallTone('end');
  requestGoodbye();
  addChatMessage('system', 'Voice call ended.');
}

function makeSafeRecorder(stream) {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
  for (const t of types) {
    if (!t || MediaRecorder.isTypeSupported(t)) {
      return t ? new MediaRecorder(stream, { mimeType: t }) : new MediaRecorder(stream);
    }
  }
  return new MediaRecorder(stream);
}

function voiceCallListen() {
  if (!voiceCallActive || !voiceCallStream) return;
  stopInterruptListener();
  const chunks = [];
  voiceCallRecorder = makeSafeRecorder(voiceCallStream);
  voiceCallRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  voiceCallRecorder.onstop = async () => {
    if (!voiceCallActive) return;
    if (!chunks.length) { voiceCallListen(); return; }
    const blob = new Blob(chunks, { type: voiceCallRecorder.mimeType || 'audio/webm' });
    sendVoiceBlob(blob, 'call');
  };
  voiceCallRecorder.start(250);
  voiceStatusText.textContent = 'listening...';

  startSilenceDetector(voiceCallStream, voiceCallRecorder);
}

async function sendVoiceBlob(blob, mode) {
  if (mode === 'call' && !window._sttEnabled && WhisperSTT.isReady()) {
    // No server STT — use local WebGPU/WASM Whisper, then send text to server for agent + TTS
    voiceStatusText.textContent = 'transcribing locally...';
    const text = await WhisperSTT.transcribe(blob);
    if (!text || !text.trim()) {
      voiceStatusText.textContent = 'no speech detected';
      if (voiceCallActive) setTimeout(voiceCallListen, 500);
      return;
    }
    voiceStatusText.textContent = 'thinking...';
    ws.send(JSON.stringify({ type: 'voice-chat', content: text.trim(), userName: _currentUserDisplayName || _currentUserName, userId: _currentUserName }));
  } else {
    // Deepgram (server STT) — send raw audio; server handles STT + agent + TTS
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      voiceStatusText.textContent = 'processing...';
      ws.send(JSON.stringify({ type: 'voice', audio: base64, mimeType: blob.type || 'audio/webm', mode, userName: _currentUserDisplayName || _currentUserName, userId: _currentUserName }));
    };
    reader.readAsDataURL(blob);
  }
}

function startSilenceDetector(stream, recorder) {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let silenceStart = null;
  let speaking = false;
  const SILENCE_THRESHOLD = 15;
  const SILENCE_DURATION = 1800;
  const MIN_RECORD_MS = 600;
  const startTime = Date.now();

  function check() {
    if (!voiceCallActive || recorder.state !== 'recording') { audioCtx.close(); return; }
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    if (avg > SILENCE_THRESHOLD) {
      speaking = true;
      silenceStart = null;
    } else if (speaking) {
      if (!silenceStart) silenceStart = Date.now();
      if (Date.now() - silenceStart > SILENCE_DURATION && Date.now() - startTime > MIN_RECORD_MS) {
        audioCtx.close();
        recorder.stop();
        return;
      }
    }
    requestAnimationFrame(check);
  }
  requestAnimationFrame(check);

  setTimeout(() => {
    if (recorder.state === 'recording') { audioCtx.close(); recorder.stop(); }
  }, 30000);
}

// ── Interrupt listener: runs while TTS is playing ──
// Uses voice-activity detection: only transcribes when actual speech is detected
// above the echo-cancelled noise floor.
function startInterruptListener() {
  if (!voiceCallActive || !voiceCallStream) return;
  const chunks = [];
  try {
    interruptRecorder = makeSafeRecorder(voiceCallStream);
  } catch { return; }

  interruptRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  interruptRecorder.onstop = async () => {
    if (!voiceCallActive) return;

    // Only transcribe if we detected real speech above the noise floor
    if (!chunks.length || !_interruptHadSpeech) {
      if (currentTtsAudio && !currentTtsAudio.paused && voiceCallActive) {
        startInterruptListener();
      }
      return;
    }

    const blob = new Blob(chunks, { type: interruptRecorder.mimeType || 'audio/webm' });

    if (!window._sttEnabled && WhisperSTT.isReady()) {
      const text = await WhisperSTT.transcribe(blob);
      console.log('[interrupt] Whisper heard:', JSON.stringify(text));
      if (text && checkInterruptMatch(text)) {
        if (currentTtsAudio) { currentTtsAudio.pause(); currentTtsAudio = null; }
        voiceStatusText.textContent = 'interrupted — processing...';
        addChatMessage('system', 'Interrupted: "' + text + '"');
        ws.send(JSON.stringify({ type: 'voice-chat', content: text, userName: _currentUserDisplayName || _currentUserName, userId: _currentUserName }));
      } else if (currentTtsAudio && !currentTtsAudio.paused) {
        startInterruptListener();
      }
    } else {
      // Deepgram (server-side) interrupt check — restart listener immediately
      // so we don't miss speech during the server round-trip
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        ws.send(JSON.stringify({ type: 'voice', audio: base64, mimeType: blob.type || 'audio/webm', mode: 'interrupt-check' }));
      };
      reader.readAsDataURL(blob);
      if (currentTtsAudio && !currentTtsAudio.paused && voiceCallActive) {
        startInterruptListener();
      }
    }
  };
  interruptRecorder.start();

  // Voice-activity detection with higher threshold to ignore TTS echo bleed
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(voiceCallStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  _interruptHadSpeech = false;
  let speaking = false;
  let silStart = null;
  const startTime = Date.now();
  const SPEECH_THRESHOLD = 35; // higher than default to filter echo bleed past AEC

  function checkVAD() {
    if (!voiceCallActive || !interruptRecorder || interruptRecorder.state !== 'recording') { audioCtx.close(); return; }
    analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length;

    if (avg > SPEECH_THRESHOLD) {
      speaking = true;
      _interruptHadSpeech = true;
      silStart = null;
    } else if (speaking) {
      if (!silStart) silStart = Date.now();
      if (Date.now() - silStart > 800 && Date.now() - startTime > 300) {
        audioCtx.close();
        interruptRecorder.stop();
        return;
      }
    }
    requestAnimationFrame(checkVAD);
  }
  requestAnimationFrame(checkVAD);

  // Fixed 3s segments — stop and process even without silence gap
  setTimeout(() => {
    if (interruptRecorder && interruptRecorder.state === 'recording') {
      audioCtx.close();
      interruptRecorder.stop();
    }
  }, 3000);
}
let _interruptHadSpeech = false;

function stopInterruptListener() {
  if (interruptRecorder && interruptRecorder.state === 'recording') {
    try { interruptRecorder.stop(); } catch {}
  }
  interruptRecorder = null;
}

function checkInterruptMatch(text) {
  if (!text || !agentNames.length) return false;
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, '');
  const words = lower.split(/\s+/);
  return agentNames.some(name => {
    if (lower.includes(name)) return true;
    return words.some(w => fuzzyNameMatch(w, name));
  });
}

function fuzzyNameMatch(word, name) {
  if (word.length < 3 || name.length < 3) return word === name;
  // Phonetic normalization: collapse common Whisper misspellings
  const norm = (s) => s
    .replace(/ph/g, 'f').replace(/ey$/, 'y').replace(/ie$/, 'y')
    .replace(/ee$/, 'y').replace(/ia$/, 'a').replace(/ck/g, 'k')
    .replace(/(.)\1+/g, '$1');
  if (norm(word) === norm(name)) return true;
  // Levenshtein distance — allow 1 edit for short names, 2 for longer
  const maxDist = name.length <= 5 ? 1 : 2;
  return levenshtein(word, name) <= maxDist;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, dp[i], dp[i-1]);
      prev = tmp;
    }
  }
  return dp[m];
}

// Handle voice WS messages
function handleVoiceMessage(msg) {
  if (msg.type === 'voice:transcription') {
    const input = document.getElementById('chat-input');
    const text = (msg.text || '').trim();
    if (window._micAutoSend) {
      window._micAutoSend = false;
      if (text) {
        input.value = text;
        sendChat();
      }
    } else {
      input.value = text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      addChatMessage('system', 'Transcribed: "' + text + '" — edit or press send');
    }
  } else if (msg.type === 'voice:transcribing') {
    voiceStatusText.textContent = 'transcribing...';
  } else if (msg.type === 'voice:interrupt-result') {
    const text = msg.text || '';
    console.log('[interrupt] Deepgram heard:', JSON.stringify(text));
    if (checkInterruptMatch(text)) {
      stopInterruptListener();
      if (currentTtsAudio) { currentTtsAudio.pause(); currentTtsAudio = null; }
      voiceStatusText.textContent = 'interrupted — processing...';
      addChatMessage('system', 'Interrupted: "' + text + '"');
      ws.send(JSON.stringify({ type: 'voice-chat', content: text, userName: _currentUserDisplayName || _currentUserName, userId: _currentUserName }));
    }
  } else if (msg.type === 'voice:user-text') {
    addChatMessage('user', msg.text);
  } else if (msg.type === 'voice:thinking') {
    voiceStatusText.textContent = 'thinking...';
    _voiceStreamText = '';
    _voiceStreamEl = addChatMessage('assistant', '');
    _voiceStreamEl.classList.add('streaming');
  } else if (msg.type === 'voice:delta') {
    _voiceStreamText += msg.text;
    if (_voiceStreamEl) {
      _voiceStreamEl.textContent = _voiceStreamText;
      if (typeof _syncAssistantRowVisibility === 'function') _syncAssistantRowVisibility(_voiceStreamEl);
    }
    voiceStatusText.textContent = 'responding...';
  } else if (msg.type === 'voice:tool') {
    addChatMessage('system', '\u2699 ' + msg.tool);
    voiceStatusText.textContent = 'using ' + msg.tool + '...';
  } else if (msg.type === 'voice:response') {
    if (_voiceStreamEl) {
      _voiceStreamEl.classList.remove('streaming');
      if (msg.text) {
        _voiceStreamEl.innerHTML = formatAssistantMsg(msg.text, msg);
        if (typeof _syncAssistantRowVisibility === 'function') _syncAssistantRowVisibility(_voiceStreamEl);
      } else if (typeof _removeChatBubble === 'function') {
        _removeChatBubble(_voiceStreamEl);
      }
      _voiceStreamEl = null; _voiceStreamText = '';
    } else if (msg.text) {
      const el = addChatMessage('assistant', '');
      el.innerHTML = formatAssistantMsg(msg.text, msg);
      if (typeof _syncAssistantRowVisibility === 'function') _syncAssistantRowVisibility(el);
    }
    if (msg.audio) {
      const audioBlob = base64ToBlob(msg.audio, msg.audioMime || 'audio/mp3');
      const url = URL.createObjectURL(audioBlob);
      currentTtsAudio = new Audio(url);
      currentTtsAudio.play().catch(() => {});
      // Start interrupt listener while audio plays
      if (voiceCallActive && agentNames.length) {
        startInterruptListener();
      }
      currentTtsAudio.onended = () => {
        URL.revokeObjectURL(url);
        currentTtsAudio = null;
        stopInterruptListener();
        if (voiceCallActive) setTimeout(voiceCallListen, 300);
      };
      voiceStatusText.textContent = 'speaking...';
    } else {
      if (voiceCallActive) setTimeout(voiceCallListen, 300);
    }
    if (msg.error) addChatMessage('system', 'Voice error: ' + msg.error);
  } else if (msg.type === 'voice:audio') {
    const audioBlob = base64ToBlob(msg.audio, msg.audioMime || 'audio/mp3');
    const url = URL.createObjectURL(audioBlob);
    new Audio(url).play().catch(() => {});
  } else if (msg.type === 'voice:error') {
    window._micAutoSend = false;
    addChatMessage('system', 'Voice error: ' + msg.error);
    voiceStatusText.textContent = 'error';
    if (voiceCallActive) setTimeout(voiceCallListen, 2000);
  }
}

function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
