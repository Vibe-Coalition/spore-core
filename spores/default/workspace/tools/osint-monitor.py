#!/usr/bin/env python3
"""OSINT Raw Feed Collector — uses usernames only for reliable resolution"""
import json, hashlib, os, sys
from datetime import datetime, timedelta, timezone
from telethon.sync import TelegramClient
from telethon.tl.types import Channel

API_ID = 6620824
API_HASH = "f14fb6490e3b269e700793307127f3c7"
SESSION = "/workspace/tools/userbot_session"
SEEN_FILE = "/tmp/osint_seen_hashes.json"
OUTPUT_FILE = "/tmp/osint_raw_feed.json"
HOURS = 2

# Channel username -> display name mapping
CHANNELS = {
    # Israeli News
    "abualiexpress": "Abu Ali Express",
    "danielamram3": "Daniel Amram",
    "yediotnews25": "חדשות 100שטח",
    "newsil2022": "חדשות בזמן",
    "CabinetNewss": "הקבינט המורחב",
    "voiceofisrael": "גול איסראל",
    "israel_news_telegram_1": "חדשות ללא צנזורה",
    "News_il_h": "חדשות ישראל ללא צנזורה",
    "lelotsenzura": "חדשות בטחון מהשטח",
    "moriahdoron": "קבינט מדיני ביטחוני",
    "Yair_Altman_channel14": "יאיר אלטמן",
    "salehdesk1": "אבו צאלח הדסק הערבי",
    "hadeskshelmusa": "הדסק של מוסא",
    "realize_israel_heb": "בוט תרגום ערבית לעברית",
    "mirshammefadlim": "נתפסו על חם",
    # Middle East / OSINT
    "Middle_East_Spectator": "Middle East Spectator",
    "BellumActaNews": "Bellum Acta",
    "rnintel": "Rerum Novarum",
    "LebUpdate": "Lebanese News",
    "LebOSINT": "Lebanon News & OSINT",
    "VahidOnline": "Vahid Online",
    "naya_foriraq": "نايا - NAYA",
    "beholdisraelchannel": "Amir Tsarfati",
    "AssyriaNewsNetwork": "Assyria News Network",
    "VenezuelaNetwork": "Venezuela Network",
    "tupireport": "Tupi Report",
    "GLOBAL_Telegram_MOKED": "GLOBAL ANALYST",
}

def load_seen():
    if os.path.exists(SEEN_FILE):
        data = json.load(open(SEEN_FILE))
        cutoff = datetime.now(timezone.utc).timestamp() - 48*3600
        return {k: v for k, v in data.items() if (v if isinstance(v, (int,float)) else datetime.fromisoformat(v).timestamp()) > cutoff}
    return {}

def save_seen(seen):
    with open(SEEN_FILE, 'w') as f:
        json.dump(seen, f)

def msg_hash(text, channel):
    return hashlib.md5(f"{channel}:{text[:200]}".encode()).hexdigest()

client = TelegramClient(SESSION, API_ID, API_HASH)
client.connect()

seen = load_seen()
since = datetime.now(timezone.utc) - timedelta(hours=HOURS)
collected = []
new_hashes = []

for username, display_name in CHANNELS.items():
    try:
        entity = client.get_entity(username)
        messages = list(client.iter_messages(entity, limit=20, offset_date=None, reverse=False))
        for msg in messages:
            if msg.date.replace(tzinfo=timezone.utc) < since:
                continue
            text = msg.text or ""
            if not text.strip():
                continue
            h = msg_hash(text, username)
            if h in seen:
                continue
            collected.append({
                "channel": display_name,
                "username": username,
                "text": text[:1500],
                "date": msg.date.isoformat(),
                "hash": h
            })
            new_hashes.append(h)
    except Exception as e:
        collected.append({"channel": display_name, "error": str(e)[:200]})

for h in new_hashes:
    seen[h] = datetime.now(timezone.utc).isoformat()
save_seen(seen)

with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    json.dump(collected, f, ensure_ascii=False, indent=2)

print(f"COLLECTED:{len([c for c in collected if 'error' not in c])}")
client.disconnect()