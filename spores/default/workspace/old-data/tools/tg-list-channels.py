#!/usr/bin/env python3
"""Get actual channel usernames from the account"""
from telethon.sync import TelegramClient

API_ID = 6620824
API_HASH = "f14fb6490e3b269e700793307127f3c7"

client = TelegramClient("userbot_session", API_ID, API_HASH)
client.connect()

# Get all channels
for dialog in client.iter_dialogs():
    if dialog.is_channel or dialog.is_group:
        entity = dialog.entity
        username = getattr(entity, 'username', None)
        title = dialog.name
        members = getattr(entity, 'participants_count', '?')
        print(f"{title} | @{username or 'N/A'} | id:{entity.id} | subs:{members}")

client.disconnect()