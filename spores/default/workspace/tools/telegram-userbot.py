#!/usr/bin/env python3
"""
Telegram Userbot — full account control via Telethon.
Usage: python3 telegram-userbot.py <command> [args]

Commands:
  login              — Start interactive login (first time only)
  me                 — Show logged-in account info
  chats [limit]      — List recent chats (default 20)
  messages <chat> [limit]  — Read recent messages from a chat
  send <chat> <text> — Send a text message
  whoami             — Same as 'me'
"""

import sys
import os
import json
import asyncio
from telethon import TelegramClient
from telethon.tl.types import User, Chat, Channel

API_ID = 6620824
API_HASH = "f14fb6490e3b269e700793307127f3c7"
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tg_session")

client = TelegramClient(SESSION_FILE, API_ID, API_HASH)

async def login():
    await client.start()
    me = await client.get_me()
    print(f"Logged in as: {me.first_name} {me.last_name or ''} (@{me.username or 'no username'})")
    print(f"Phone: {me.phone}")
    print(f"ID: {me.id}")
    await client.disconnect()

async def me():
    await client.connect()
    if not await client.is_user_authorized():
        print("Not logged in. Run 'login' first.")
        await client.disconnect()
        return
    me = await client.get_me()
    print(f"Name: {me.first_name} {me.last_name or ''}")
    print(f"Username: @{me.username or 'none'}")
    print(f"Phone: {me.phone}")
    print(f"ID: {me.id}")
    await client.disconnect()

async def chats(limit=20):
    await client.connect()
    if not await client.is_user_authorized():
        print("Not logged in.")
        await client.disconnect()
        return
    async for dialog in client.iter_dialogs(limit=limit):
        entity = dialog.entity
        if isinstance(entity, User):
            kind = "DM"
            name = f"{entity.first_name} {entity.last_name or ''}".strip()
        elif isinstance(entity, Chat):
            kind = "Group"
            name = entity.title
        elif isinstance(entity, Channel):
            kind = "Channel" if entity.broadcast else "SuperGroup"
            name = entity.title
        else:
            kind = "?"
            name = dialog.name
        print(f"[{kind}] {name} (id:{dialog.id}) — {dialog.message.text[:60] if dialog.message.text else '...'}")
    await client.disconnect()

async def messages(chat_id, limit=20):
    await client.connect()
    if not await client.is_user_authorized():
        print("Not logged in.")
        await client.disconnect()
        return
    try:
        entity = await client.get_entity(int(chat_id))
    except:
        entity = await client.get_entity(chat_id)
    async for msg in client.iter_messages(entity, limit=limit):
        sender = "Unknown"
        if msg.sender:
            if isinstance(msg.sender, User):
                sender = f"{msg.sender.first_name} {msg.sender.last_name or ''}".strip()
            else:
                sender = getattr(msg.sender, 'title', 'Unknown')
        text = msg.text or "(media/no text)"
        print(f"[{msg.id}] {sender}: {text[:200]}")
    await client.disconnect()

async def send(chat_id, text):
    await client.connect()
    if not await client.is_user_authorized():
        print("Not logged in.")
        await client.disconnect()
        return
    try:
        entity = await client.get_entity(int(chat_id))
    except:
        entity = await client.get_entity(chat_id)
    result = await client.send_message(entity, text)
    print(f"Sent to {chat_id} (msg_id: {result.id})")
    await client.disconnect()

async def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1].lower()

    if cmd == "login":
        await login()
    elif cmd in ("me", "whoami"):
        await me()
    elif cmd == "chats":
        lim = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        await chats(lim)
    elif cmd == "messages":
        if len(sys.argv) < 3:
            print("Usage: messages <chat_id> [limit]")
            return
        chat = sys.argv[2]
        lim = int(sys.argv[3]) if len(sys.argv) > 3 else 20
        await messages(chat, lim)
    elif cmd == "send":
        if len(sys.argv) < 4:
            print("Usage: send <chat_id> <text>")
            return
        await send(sys.argv[2], " ".join(sys.argv[3:]))
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)

if __name__ == "__main__":
    asyncio.run(main())