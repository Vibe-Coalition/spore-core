#!/usr/bin/env python3
"""Resolve actual usernames for all channels in the account"""
from telethon.sync import TelegramClient

API_ID = 6620824
API_HASH = "f14fb6490e3b269e700793307127f3c7"

client = TelegramClient("/workspace/tools/userbot_session", API_ID, API_HASH)
client.connect()

for dialog in client.iter_dialogs():
    if dialog.is_channel:
        entity = dialog.entity
        uname = getattr(entity, 'username', None)
        members = getattr(entity, 'participants_count', '?')
        print(f"{dialog.name} | @{uname or 'PRIVATE'} | id:{entity.id} | subs:{members}")

client.disconnect()