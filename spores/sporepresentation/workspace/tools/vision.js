#!/usr/bin/env node

/**
 * Vision tool — uses Qwen3.5-397B-A17B-FP8 via BFL endpoint
 * Usage: node vision.js --image <base64|url|path> --question <text>
 * 
 * Image can be:
 *   - A local file path (will be base64 encoded)
 *   - A base64 string (used directly)
 *   - A URL (passed as-is)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse args
const args = process.argv.slice(2);
let imageInput = '';
let question = 'Describe this image.';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--image' && args[i + 1]) imageInput = args[++i];
  if (args[i] === '--question' && args[i + 1]) question = args[++i];
}

if (!imageInput) {
  console.error('Usage: node vision.js --image <path|base64|url> --question <text>');
  process.exit(1);
}

// Determine image source type
let imageUrl;
if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
  imageUrl = imageInput;
} else if (imageInput.startsWith('data:')) {
  imageUrl = imageInput;
} else if (fs.existsSync(imageInput)) {
  // Local file — base64 encode it
  const ext = path.extname(imageInput).toLowerCase().replace('.', '') || 'png';
  const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
  const mime = `image/${mimeMap[ext] || 'png'}`;
  const b64 = fs.readFileSync(imageInput).toString('base64');
  imageUrl = `data:${mime};base64,${b64}`;
} else {
  // Assume it's already base64
  imageUrl = `data:image/png;base64,${imageInput}`;
}

// Read BFL key — env var first, then try vault temp files, then .env
let BFL_KEY = process.env.ANIMA_PROVIDER_BFL_KEY;
if (!BFL_KEY) {
  try { BFL_KEY = fs.readFileSync('/workspace/.env', 'utf8').match(/ANIMA_PROVIDER_BFL_KEY=(.+)/)?.[1]?.trim(); } catch(e) {}
}
if (!BFL_KEY) {
  // Try any vault temp file
  try {
    const vaultFiles = fs.readdirSync('/tmp').filter(f => f.startsWith('.env-ANIMA_PROVIDER_BFL_KEY'));
    if (vaultFiles.length) BFL_KEY = fs.readFileSync('/tmp/' + vaultFiles.sort().pop(), 'utf8').trim();
  } catch(e) {}
}

if (!BFL_KEY) {
  console.error('ERROR: ANIMA_PROVIDER_BFL_KEY not found');
  process.exit(1);
}

const payload = JSON.stringify({
  model: 'Qwen3.5-397B-A17B-FP8',
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'text', text: question }
    ]
  }],
  max_tokens: 2048
});

const options = {
  hostname: 'review-3398.us3.bfl.ai',
  path: '/v1/llm/chat/completions',
  method: 'POST',
  headers: {
    'x-key': BFL_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const msg = parsed.choices?.[0]?.message;
      if (msg?.content) {
        console.log(msg.content.trim());
      } else if (msg?.reasoning) {
        console.log('(reasoning only, no final answer)');
        console.log(msg.reasoning.trim());
      } else {
        console.error('Unexpected response:', data.slice(0, 500));
        process.exit(1);
      }
    } catch (e) {
      console.error('Parse error:', data.slice(0, 500));
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.write(payload);
req.end();
