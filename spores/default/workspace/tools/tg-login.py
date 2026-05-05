#!/usr/bin/env python3
"""
Telegram userbot login with HTTP callback for instant code delivery.
1. Run this script
2. It sends a code to your phone and prints a URL
3. Open the URL with ?code=XXXXX in browser or curl
"""
import os, sys, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from telethon.sync import TelegramClient

api_id = 6620824
api_hash = "f14fb6490e3b269e700793307127f3c7"
phone = "+17788146832"

code_received = threading.Event()
code_value = [None]
result_holder = [None]

class CodeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        if "code" in params:
            code_value[0] = params["code"][0]
            code_received.set()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Code received! Check terminal.")
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Send code via ?code=XXXXX")
    def log_message(self, *args): pass

# Start HTTP server
server = HTTPServer(("0.0.0.0", 18899), CodeHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

client = TelegramClient("userbot_session", api_id, api_hash)
client.connect()

result = client.send_code_request(phone)
print(f"\n✅ Code sent to {phone}")
print(f"👉 Open: http://localhost:18899/?code=YOUR_CODE")
print(f"   Or:   curl 'http://localhost:18899/?code=YOUR_CODE'\n")
print("Waiting for code...", flush=True)

code_received.wait(timeout=180)

if code_value[0]:
    print(f"Using code: {code_value[0]}", flush=True)
    try:
        client.sign_in(phone, code_value[0], phone_code_hash=result.phone_code_hash)
        me = client.get_me()
        print(f"\n🎉 SUCCESS: {me.first_name} {me.last_name or ''} (@{me.username or 'no username'}) ID:{me.id}", flush=True)
    except Exception as e:
        print(f"\n❌ ERROR: {e}", flush=True)
else:
    print("Timeout waiting for code", flush=True)

server.shutdown()
client.disconnect()