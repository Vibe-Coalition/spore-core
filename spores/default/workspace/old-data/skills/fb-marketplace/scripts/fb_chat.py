#!/usr/bin/env python3
"""
Facebook Messenger CLI — authenticated chat via GraphQL.
Uses the same cookies as fbm.py (Marketplace auth).

Usage:
    python3 fb_chat.py inbox
    python3 fb_chat.py send <user_id> "message text"
    python3 fb_chat.py threads
"""

import json
import sys
import re
import argparse
import os
from pathlib import Path
from urllib.parse import quote

try:
    from curl_cffi import requests as cffi_requests
    HAS_CFFI = True
except ImportError:
    HAS_CFFI = False

GRAPHQL_URL = "https://www.facebook.com/api/graphql/"

SCRIPT_DIR = Path(__file__).parent
COOKIE_FILE = SCRIPT_DIR / "fbm_cookies.txt"


def load_cookies():
    try:
        return COOKIE_FILE.read_text().strip()
    except:
        return None


def parse_cookies(cookie_str):
    """Parse cookie string into dict."""
    cookies = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def extract_user_id(cookies):
    """Extract c_user from cookies."""
    return cookies.get("c_user", "")


def get_fb_dtsg(session, cookies_dict):
    """Fetch fb_dtsg token from a Facebook page."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies_dict.items())
    headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "cookie": cookie_str,
    }
    resp = session.get("https://www.facebook.com", headers=headers, timeout=15)
    m = re.search(r'"DTSGInitialData".*?"token":"([^"]+)"', resp.text)
    if m:
        return m.group(1)
    m = re.search(r'fb_dtsg.*?value["\s:]+([^"&\s]+)', resp.text)
    if m:
        return m.group(1)
    return None


def get_lsd(session, cookies_dict):
    """Extract LSD token."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies_dict.items())
    headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "cookie": cookie_str,
    }
    resp = session.get("https://www.facebook.com", headers=headers, timeout=15)
    m = re.search(r'"LSD"[^}]*?"token":"([^"]+)"', resp.text)
    if m:
        return m.group(1)
    return None


def cmd_inbox(args):
    """Fetch recent conversations/inbox."""
    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No cookies found. Make sure fbm_cookies.txt exists.")
        return

    cookies_dict = parse_cookies(cookie_str)
    user_id = extract_user_id(cookies_dict)
    if not user_id:
        print("❌ No c_user in cookies")
        return

    if not HAS_CFFI:
        print("❌ curl_cffi required: pip install curl_cffi --break-system-packages")
        return

    session = cffi_requests.Session(impersonate="chrome")

    print("🔑 Getting session tokens...", file=sys.stderr)
    dtsg = get_fb_dtsg(session, cookies_dict)
    if not dtsg:
        print("❌ Could not get fb_dtsg token — cookies may be expired")
        return
    lsd = get_lsd(session, cookies_dict)
    if not lsd:
        lsd = dtsg

    # GraphQL query for inbox/threads
    # Using LSPlatformGraphQLLightspeedRequestQuery (doc_id from reverse engineering)
    variables = {
        "deviceId": "fb-chat-cli",
        "requestId": 0,
        "requestPayload": json.dumps({
            "database": 1,
            "version": 4680497022042598,
            "sync_params": json.dumps({
                "scale": 1,
                "preview_height": 200,
                "preview_width": 150,
                "snapshot_num_threads_per_page": 20,
                "locale": "en_US"
            }),
            "epoch_id": 0,
            "last_applied_cursor": None
        }),
        "requestType": 1
    }

    body = {
        "av": user_id,
        "__user": user_id,
        "__a": "1",
        "fb_dtsg": dtsg,
        "lsd": lsd,
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "LSPlatformGraphQLLightspeedRequestQuery",
        "variables": json.dumps(variables),
        "doc_id": "4476599072415612",
        "server_timestamps": "true",
    }

    headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.facebook.com",
        "referer": "https://www.facebook.com/messages/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "x-fb-friendly-name": "LSPlatformGraphQLLightspeedRequestQuery",
        "x-fb-lsd": lsd,
    }

    print("📬 Fetching inbox...", file=sys.stderr)
    try:
        resp = session.post(GRAPHQL_URL, headers=headers, data=body, timeout=30)
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        return

    try:
        data = json.loads(resp.text)
    except json.JSONDecodeError as e:
        print(f"❌ Could not parse response: {e}")
        print(resp.text[:500])
        return

    # Extract threads from response
    # The structure is nested: viewer -> threads -> nodes
    try:
        threads_data = data.get("data", {}).get("viewer", {}).get("threads", {})
        if not threads_data:
            print("⚠️ No threads found in response")
            print("Response structure:", json.dumps(list(data.get("data", {}).keys()), indent=2))
            return

        threads = threads_data.get("nodes", [])
        if not threads:
            print("No recent conversations found.")
            return

        print(f"\n💬 Recent conversations ({len(threads)}):\n")
        for thread in threads[:10]:  # Show first 10
            thread_id = thread.get("thread_key", {}).get("thread_fbid", "?")
            participants = thread.get("participants", [])
            names = [p.get("name", "Unknown") for p in participants if p.get("name")]
            participant_str = ", ".join(names) or "Unknown"

            last_message = thread.get("last_message", {})
            message_text = last_message.get("snippet", "") or last_message.get("body", "") or ""
            if not message_text and last_message.get("attachments"):
                message_text = "[media]"

            timestamp = last_message.get("timestamp_ms", 0)
            if timestamp:
                from datetime import datetime
                dt = datetime.fromtimestamp(timestamp / 1000)
                time_str = dt.strftime("%b %d %H:%M")
            else:
                time_str = "?"

            unread_count = thread.get("unread_count", 0)
            unread_tag = f" 🔴{unread_count}" if unread_count > 0 else ""

            print(f"  {thread_id}")
            print(f"    👥 {participant_str}")
            print(f"    📝 {message_text[:80]}")
            print(f"    ⏰ {time_str}{unread_tag}")
            print()

    except KeyError as e:
        print(f"⚠️ Could not parse threads: {e}")
        print("Raw response (first 2000 chars):")
        print(json.dumps(data, indent=2)[:2000])


def cmd_threads(args):
    """List all threads with IDs."""
    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No cookies found")
        return

    cookies_dict = parse_cookies(cookie_str)
    user_id = extract_user_id(cookies_dict)
    if not user_id:
        print("❌ No c_user in cookies")
        return

    if not HAS_CFFI:
        print("❌ curl_cffi required")
        return

    session = cffi_requests.Session(impersonate="chrome")

    dtsg = get_fb_dtsg(session, cookies_dict)
    if not dtsg:
        print("❌ Could not get fb_dtsg token")
        return
    lsd = get_lsd(session, cookies_dict) or dtsg

    # Use a simpler threads query
    variables = {
        "viewer": user_id,
        "limit": 50,
        "before": None,
        "after": None,
    }

    body = {
        "av": user_id,
        "__user": user_id,
        "__a": "1",
        "fb_dtsg": dtsg,
        "lsd": lsd,
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "MessengerUserThreadsQuery",
        "variables": json.dumps(variables),
        "doc_id": "499436985951784",  # Common threads query doc_id
        "server_timestamps": "true",
    }

    headers = {
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.facebook.com",
        "referer": "https://www.facebook.com/messages/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "x-fb-lsd": lsd,
    }

    try:
        resp = session.post(GRAPHQL_URL, headers=headers, data=body, timeout=30)
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        return

    try:
        data = json.loads(resp.text)
    except json.JSONDecodeError:
        print("❌ Could not parse response")
        return

    # Try to extract thread info
    try:
        threads = data.get("data", {}).get("viewer", {}).get("msgs_threads", {}).get("edges", [])
        if not threads:
            print("No threads found or different response structure")
            print("Available keys:", json.dumps(list(data.get("data", {}).keys()), indent=2))
            return

        print(f"\n🧵 Threads ({len(threads)}):\n")
        for edge in threads:
            node = edge.get("node", {})
            thread_id = node.get("thread_fbid", "?")
            participants = node.get("participants", [])
            names = [p.get("name", "Unknown") for p in participants if p.get("name")]
            print(f"  {thread_id}: {', '.join(names) or 'Unknown'}")

    except KeyError as e:
        print(f"⚠️ Parse error: {e}")
        print("Response:", json.dumps(data, indent=2)[:1500])


def cmd_send(args):
    """Send a message to a user or thread."""
    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No cookies found")
        return

    cookies_dict = parse_cookies(cookie_str)
    user_id = extract_user_id(cookies_dict)
    if not user_id:
        print("❌ No c_user in cookies")
        return

    if not HAS_CFFI:
        print("❌ curl_cffi required")
        return

    session = cffi_requests.Session(impersonate="chrome")

    dtsg = get_fb_dtsg(session, cookies_dict)
    if not dtsg:
        print("❌ Could not get fb_dtsg token")
        return
    lsd = get_lsd(session, cookies_dict) or dtsg

    # GraphQL mutation to send message
    # Using SyncMessagesMutation (common mutation name)
    variables = {
        "actor_id": user_id,
        "client_message_id": f"{user_id}_{int(__import__('time').time() * 1000)}",
        "recipient_fbid": args.user_id,
        "source": "ComposerXTypeaheadFriend",
        "source_author": user_id,
        "author": f"fbid://{user_id}",
        "status": "read",
        "tags": [],
        "thread_fbid": None,
        "offline_threading_id": None,
        "message": {
            "body": args.message,
            "author": f"fbid://{user_id}",
            "images": [],
            "videos": []
        },
        "attachments": [],
        "coords": {"source": "ComposerXTypeaheadFriend"},
        "manual_retry_idx": -1,
        "is_group": False,
        "threading_id": f"{user_id}_{int(__import__('time').time() * 1000)}"
    }

    body = {
        "av": user_id,
        "__user": user_id,
        "__a": "1",
        "fb_dtsg": dtsg,
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "MessengerSyncSenderMutation",
        "variables": json.dumps(variables),
        "doc_id": "6062634953804",  # SyncMessagesMutation doc_id
        "server_timestamps": "true",
    }

    headers = {
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.facebook.com",
        "referer": "https://www.facebook.com/messages/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    }

    print(f"📤 Sending message to {args.user_id}...", file=sys.stderr)
    try:
        resp = session.post(GRAPHQL_URL, headers=headers, data=body, timeout=30)
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        return

    try:
        data = json.loads(resp.text)
    except json.JSONDecodeError:
        print("❌ Could not parse response")
        return

    # Check for errors
    if "errors" in data:
        print(f"❌ GraphQL errors: {json.dumps(data['errors'], indent=2)}")
        return

    # Check if message was sent
    if data.get("data", {}).get("sync_message"):
        print("✅ Message sent successfully!")
        msg_data = data["data"]["sync_message"]
        if msg_data.get("message_id"):
            print(f"   Message ID: {msg_data['message_id']}")
    else:
        print("⚠️ Response doesn't contain expected message data")
        print("Response:", json.dumps(data, indent=2)[:1000])


def main():
    parser = argparse.ArgumentParser(description="Facebook Messenger CLI")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("inbox", help="Fetch recent conversations")
    p = sub.add_parser("threads", help="List all threads with IDs")
    p = sub.add_parser("send", help="Send a message")
    p.add_argument("user_id", help="User ID or thread ID to send to")
    p.add_argument("message", help="Message text")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    if args.command == "inbox":
        cmd_inbox(args)
    elif args.command == "threads":
        cmd_threads(args)
    elif args.command == "send":
        cmd_send(args)


if __name__ == "__main__":
    main()
