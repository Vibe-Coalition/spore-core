#!/usr/bin/env python3
import json, base64, urllib.request

BFL_KEY = open("/tmp/.env-ANIMA_PROVIDER_BFL_KEY-1776355482198").read().strip()

from PIL import Image
import io
img = Image.new("RGB", (100, 100), color="red")
buf = io.BytesIO()
img.save(buf, format="PNG")
b64 = base64.b64encode(buf.getvalue()).decode()

payload = {
    "model": "Qwen3.5-397B-A17B-FP8",
    "messages": [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": "What color is this image? Answer in one word."}
        ]
    }],
    "max_tokens": 512
}

req = urllib.request.Request(
    "https://review-3398.us3.bfl.ai/v1/llm/chat/completions",
    data=json.dumps(payload).encode(),
    headers={"x-key": BFL_KEY, "Content-Type": "application/json"}
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
        msg = data["choices"][0]["message"]
        if msg.get("content"):
            print("ANSWER:", msg["content"])
        if msg.get("reasoning"):
            print("REASONING:", msg["reasoning"][:500])
except Exception as e:
    print(f"ERROR: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode()[:500])
