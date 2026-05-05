#!/usr/bin/env python3
"""Step 2: Sign in with code — usage: python3 tg-step2-signin.py 12345"""
import sys
from telethon.sync import TelegramClient

api_id = 6620824
api_hash = "f14fb6490e3b269e700793307127f3c7"
phone = "+17788146832"

code = sys.argv[1]
with open("/tmp/tg_hash.txt") as f:
    phone_code_hash = f.read().strip()

client = TelegramClient("userbot_session", api_id, api_hash)
client.connect()
try:
    client.sign_in(phone, code, phone_code_hash=phone_code_hash)
    me = client.get_me()
    print(f"SUCCESS: {me.first_name} {me.last_name or ''} (@{me.username or 'no username'}) ID:{me.id}")
except Exception as e:
    print(f"ERROR: {e}")
client.disconnect()