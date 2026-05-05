#!/usr/bin/env python3
"""List all Telegram dialogs with proper names"""
from telethon.sync import TelegramClient
from telethon.tl.types import Chat, Channel, User, ChatForbidden, ChannelForbidden

api_id = 6620824
api_hash = "f14fb6490e3b269e700793307127f3c7"

client = TelegramClient("userbot_session", api_id, api_hash)
client.connect()

dialogs = []
for dialog in client.iter_dialogs():
    entity = dialog.entity
    info = {
        "id": entity.id,
        "name": dialog.name or "Unknown",
        "type": type(entity).__name__,
        "is_group": False,
        "is_channel": False,
        "is_user": False,
        "members": None,
        "username": None,
        "unread": dialog.unread_count,
    }
    
    if isinstance(entity, User):
        info["is_user"] = True
        info["username"] = entity.username
        info["bot"] = entity.bot
    elif isinstance(entity, Chat):
        info["is_group"] = True
        info["members"] = entity.participants_count
    elif isinstance(entity, Channel):
        info["username"] = entity.username
        if entity.megagroup:
            info["is_group"] = True
        else:
            info["is_channel"] = True
        info["members"] = entity.participants_count
    
    dialogs.append(info)

client.disconnect()

users = [d for d in dialogs if d["is_user"]]
groups = [d for d in dialogs if d["is_group"]]
channels = [d for d in dialogs if d["is_channel"]]

print(f"=== DMs ({len(users)}) ===")
for d in sorted(users, key=lambda x: x["name"].lower()):
    bot_tag = " [BOT]" if d.get("bot") else ""
    print(f"  {d['name']}{bot_tag} @{d['username'] or ''} | unread: {d['unread']}")

print(f"\n=== GROUPS ({len(groups)}) ===")
for d in sorted(groups, key=lambda x: x["name"].lower()):
    print(f"  {d['name']} | {d['members']} members | unread: {d['unread']}")

print(f"\n=== CHANNELS ({len(channels)}) ===")
for d in sorted(channels, key=lambda x: x["name"].lower()):
    print(f"  {d['name']} @{d['username'] or ''} | {d['members']} subs | unread: {d['unread']}")

print(f"\nTotal: {len(dialogs)} ({len(users)} DMs, {len(groups)} groups, {len(channels)} channels)")