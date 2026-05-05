#!/usr/bin/env python3
import os, requests
token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
url = f'https://api.telegram.org/bot{token}/sendMessage'
r = requests.post(url, json={'chat_id': '697706930', 'text': '🧪 Market report scheduler test — if you see this, the pipeline works!'}, timeout=15)
print(r.status_code, r.json().get('ok'))