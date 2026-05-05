#!/usr/bin/env python3
import subprocess, os, requests

PYTHON = "/workspace/.venv/bin/python3"
token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
CHAT_ID = '697706930'

# Generate the report
result = subprocess.run([PYTHON, '/workspace/scripts/market_report.py', 'open'], capture_output=True, text=True, timeout=120)
report = result.stdout.strip()

# Send to Telegram (split if needed)
url = f'https://api.telegram.org/bot{token}/sendMessage'
chunks = []
text = report
while len(text) > 4000:
    split_at = text.rfind("\n", 0, 4000)
    if split_at == -1:
        split_at = 4000
    chunks.append(text[:split_at])
    text = text[split_at:].lstrip("\n")
chunks.append(text)

for chunk in chunks:
    r = requests.post(url, json={'chat_id': CHAT_ID, 'text': chunk, 'parse_mode': 'Markdown'}, timeout=30)
    print(f"Sent chunk: {r.status_code} {r.json().get('ok')}")