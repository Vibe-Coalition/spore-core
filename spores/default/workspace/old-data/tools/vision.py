#!/usr/bin/env python3
"""Vision Service — Analyze images using a vision-capable LLM."""
import sys, os, json, base64, argparse

CONFIG_PATH = "/workspace/.config/vision_config.json"
ENV_BASE_URL = os.environ.get("LOCAL_MODEL_BASE_URL", "")
ENV_API_KEY = os.environ.get("LOCAL_MODEL_API_KEY", "")

def load_config():
    cfg = {"model": os.environ.get("VISION_MODEL", "local/qwen3.5-vl"), "base_url": ENV_BASE_URL, "api_key": ENV_API_KEY}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f: cfg.update({k:v for k,v in json.load(f).items() if v})
        except: pass
    return cfg

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f: json.dump(cfg, f, indent=2)

def resolve_model(model_str, base_url):
    if model_str.startswith("local/"): return model_str[6:], base_url
    elif model_str.startswith("openrouter/"): return model_str[11:], "https://openrouter.ai/api/v1"
    return model_str, base_url

def encode_image(path):
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    mime_map = {'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png', 'gif': 'gif', 'webp': 'webp'}
    mime = mime_map.get(ext, 'jpeg')
    with open(path, "rb") as f: b64 = base64.b64encode(f.read()).decode()
    return f"data:image/{mime};base64,{b64}"

def analyze(image_source, prompt):
    import urllib.request
    cfg = load_config()
    model_id, base_url = resolve_model(cfg["model"], cfg["base_url"])
    image_content = {"type": "image_url", "image_url": {"url": image_source if image_source.startswith("http") else encode_image(image_source)}}
    if not image_source.startswith("http") and not os.path.exists(image_source):
        print(f"❌ Not found: {image_source}"); return
    payload = {"model": model_id, "messages": [{"role": "user", "content": [image_content, {"type": "text", "text": prompt}]}], "max_tokens": 1024, "temperature": 0.3}
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        # BFL uses x-key header, others use Bearer — auto-detect
        if cfg.get("auth_header") == "x-key":
            headers["x-key"] = cfg["api_key"]
        else:
            headers["Authorization"] = f"Bearer {cfg['api_key']}"
    url = f"{base_url.rstrip('/')}/chat/completions"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
            msg = data["choices"][0]["message"]
            # Qwen3 thinking models put output in "reasoning" when content is null
            result = msg.get("content") or msg.get("reasoning") or "No response"
            print(result)
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2: print("Usage: vision analyze <image> [prompt] | vision config [--model X] [--provider X]"); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "analyze" and len(sys.argv) >= 3:
        analyze(sys.argv[2], " ".join(sys.argv[3:]) if len(sys.argv) > 3 else "Describe this image in detail.")
    elif cmd == "config":
        cfg = load_config(); i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "--model" and i+1 < len(sys.argv): cfg["model"] = sys.argv[i+1]; i += 2
            elif sys.argv[i] == "--provider" and i+1 < len(sys.argv): cfg["base_url"] = sys.argv[i+1]; i += 2
            else: i += 1
        save_config(cfg); print(f"Model: {cfg['model']}\nURL: {cfg['base_url'][:40]}...")
    else: print("Unknown command. Use: analyze, config")