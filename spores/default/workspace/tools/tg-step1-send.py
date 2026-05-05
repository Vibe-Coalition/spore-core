#!/usr/bin/env python3
"""Step 1: Send code, save hash"""
from telethon.sync import TelegramClient

api_id = 6620824
api_hash = "f14fb6490e3b269e700793307127f3c7"
phone = "+17788146832"

client = TelegramClient("userbot_session", api_id, api_hash)
client.connect()
result = client.send_code_request(phone)
with open("/tmp/tg_hash.txt", "w") as f:
    f.write(result.phone_code_hash)
print(f"CODE_SENT")
client.disconnect()