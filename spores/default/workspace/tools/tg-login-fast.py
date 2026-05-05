#!/usr/bin/env python3
"""
One-shot login: sends code, reads it from /tmp/tg_code.txt (polling every 0.5s)
Run with a LONG timeout, write code to /tmp/tg_code.txt from another process
"""
import os, time, sys
from telethon.sync import TelegramClient

api_id = 6620824
api_hash = "f14fb6490e3b269e700793307127f3c7"
phone = "+17788146832"
code_file = "/tmp/tg_code.txt"

# Clean up
if os.path.exists(code_file):
    os.remove(code_file)

client = TelegramClient("userbot_session", api_id, api_hash)
client.connect()

result = client.send_code_request(phone)
print(f"CODE_SENT:{result.phone_code_hash}", flush=True)

# Fast poll — every 0.5s, 90s timeout
for i in range(180):
    if os.path.exists(code_file):
        with open(code_file) as f:
            code = f.read().strip()
        os.remove(code_file)
        try:
            client.sign_in(phone, code, phone_code_hash=result.phone_code_hash)
            me = client.get_me()
            print(f"SUCCESS:{me.first_name}|{me.last_name or ''}|{me.username or ''}|{me.id}", flush=True)
        except Exception as e:
            print(f"ERROR:{e}", flush=True)
        client.disconnect()
        sys.exit(0)
    time.sleep(0.5)

print("TIMEOUT", flush=True)
client.disconnect()