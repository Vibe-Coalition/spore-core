#!/usr/bin/env python3
"""
Facebook auto-login via B-API (mobile API).
Logs in using Facebook's internal Android API, extracts session cookies.

Usage:
    python3 fb_login.py                    # Auto-login and refresh cookies
    python3 fb_login.py --check            # Check if current cookies work
    python3 fb_login.py --set-creds EMAIL PASSWORD  # Store credentials
"""

import hashlib
import json
import os
import random
import string
import sys
import time
from pathlib import Path
from uuid import uuid4

SCRIPT_DIR = Path(__file__).parent
CREDS_FILE = SCRIPT_DIR / "fb_creds.json"
COOKIES_FILE = SCRIPT_DIR / "fbm_cookies.txt"
DEVICE_FILE = SCRIPT_DIR / "fb_device.json"

API_KEY = "882a8490361da98702bf97a021ddc14d"
APP_SECRET = "62f8ce9f74b12f84c123cc23437a4a32"


def encmd5(s):
    return hashlib.md5(s.encode()).hexdigest()


def getSig(data):
    sig = ""
    for k in sorted(data.keys()):
        sig += k + "=" + str(data[k])
    return encmd5(sig + APP_SECRET)


def load_creds():
    try:
        with open(CREDS_FILE) as f:
            return json.load(f)
    except:
        return None


def save_creds(email, password):
    with open(CREDS_FILE, "w") as f:
        json.dump({"email": email, "password": password}, f)
    os.chmod(CREDS_FILE, 0o600)
    print(f"✅ Credentials saved")


def load_device():
    """Load or create persistent device identifiers."""
    try:
        with open(DEVICE_FILE) as f:
            return json.load(f)
    except:
        device = {
            "device_id": str(uuid4()),
            "family_device_id": str(uuid4()),
            "advertiser_id": str(uuid4()),
            "machine_id": "".join(random.choices(string.ascii_lowercase + string.digits, k=24)),
        }
        with open(DEVICE_FILE, "w") as f:
            json.dump(device, f, indent=2)
        return device


def check_cookies():
    """Check if current cookies are still valid."""
    try:
        from curl_cffi import requests as cffi_requests

        sys.path.insert(0, str(SCRIPT_DIR))
        from fbm import load_cookies, parse_cookies, extract_user_id, get_fb_dtsg

        cookie_str = load_cookies()
        if not cookie_str:
            return False

        cookies_dict = parse_cookies(cookie_str)
        user_id = extract_user_id(cookies_dict)
        if not user_id:
            return False

        session = cffi_requests.Session(impersonate="chrome")
        dtsg = get_fb_dtsg(session, cookies_dict)
        if not dtsg:
            return False

        # Test with actual API call
        variables = {
            "count": 1,
            "params": {
                "bqf": {"callsite": "COMMERCE_MKTPLACE_WWW", "query": "test"},
                "browse_request_params": {
                    "commerce_enable_local_pickup": True,
                    "commerce_enable_shipping": True,
                    "commerce_search_and_rp_available": True,
                    "commerce_search_and_rp_category_id": [],
                    "commerce_search_and_rp_condition": None,
                    "commerce_search_and_rp_ctime_days": None,
                    "filter_location_latitude": 49.290643774512,
                    "filter_location_longitude": -122.84837739278,
                    "filter_price_lower_bound": 0,
                    "filter_price_upper_bound": 214748364700,
                    "filter_radius_km": 10,
                },
                "custom_request_params": {
                    "browse_context": None,
                    "contextual_filters": [],
                    "referral_code": None,
                    "referral_ui_component": None,
                    "saved_search_strid": None,
                    "search_vertical": "C2C",
                    "seo_url": None,
                    "serp_landing_settings": {"virtual_category_id": ""},
                    "surface": "SEARCH",
                    "virtual_contextual_filters": [],
                },
            },
            "scale": 1,
        }

        body = {
            "av": user_id,
            "__user": user_id,
            "__a": "1",
            "fb_dtsg": dtsg,
            "fb_api_caller_class": "RelayModern",
            "fb_api_req_friendly_name": "CometMarketplaceSearchContentPaginationQuery",
            "variables": json.dumps(variables),
            "doc_id": "26058421810481206",
            "server_timestamps": "true",
        }

        headers = {
            "content-type": "application/x-www-form-urlencoded",
            "cookie": cookie_str,
            "origin": "https://www.facebook.com",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "x-fb-friendly-name": "CometMarketplaceSearchContentPaginationQuery",
            "x-fb-lsd": dtsg,
        }

        resp = session.post(
            "https://www.facebook.com/api/graphql/",
            headers=headers,
            data=body,
            timeout=15,
        )
        if (
            '"errorSummary":"Log in to continue"' in resp.text
            or '"error":1357001' in resp.text
        ):
            return False
        if "marketplace_search" in resp.text:
            return True
        return False
    except Exception as e:
        print(f"Check error: {e}", file=sys.stderr)
        return False


def do_login():
    """Login via Facebook B-API (mobile API)."""
    import requests

    creds = load_creds()
    if not creds:
        print("❌ No credentials stored. Run: python3 fb_login.py --set-creds EMAIL PASSWORD")
        return False

    device = load_device()
    ts = str(int(time.time()))

    data = {
        "adid": device["advertiser_id"],
        "advertiser_id": device["advertiser_id"],
        "api_key": API_KEY,
        "client_country_code": "CA",
        "cpl": "true",
        "credentials_type": "password",
        "currently_logged_in_userid": "0",
        "device_id": device["device_id"],
        "email": creds["email"],
        "error_detail_type": "button_with_disabled",
        "family_device_id": device["family_device_id"],
        "fb_api_caller_class": "com.facebook.account.login.protocol.Fb4aAuthHandler",
        "fb_api_req_friendly_name": "authenticate",
        "format": "json",
        "generate_session_cookies": "1",
        "generate_machine_id": "1",
        "locale": "en_US",
        "machine_id": device["machine_id"],
        "meta_inf_fbmeta": "",
        "method": "auth.login",
        "password": f"#PWD_FB4A:0:{ts}:{creds['password']}",
        "source": "device_based_login",
    }
    data["sig"] = getSig(data)

    headers = {
        "user-agent": "Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230901.001) "
        "[FBAN/FB4A;FBAV/438.0.0.33.118;FBBV/516207782;"
        "FBDM/{density=2.75,width=1080,height=2400};"
        "FBLC/en_US;FBRV/518024038;FBCR/TELUS;FBMF/Google;FBBD/google;"
        "FBPN/com.facebook.katana;FBDV/Pixel 7;FBSV/13;FBOP/1;"
        "FBCA/armeabi-v7a:arm64-v8a;]",
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-http-engine": "Liger",
        "x-fb-connection-quality": "EXCELLENT",
        "x-fb-connection-type": "wifi",
    }

    resp = requests.post(
        "https://b-api.facebook.com/method/auth.login",
        data=data,
        headers=headers,
        timeout=15,
    )
    result = json.loads(resp.text)

    if "session_cookies" in result:
        cookies = result["session_cookies"]
        cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
        with open(COOKIES_FILE, "w") as f:
            f.write(cookie_str)
        print(f"✅ Login successful! Got {len(cookies)} cookies")
        if "access_token" in result:
            print(f"   Access token: {result['access_token'][:40]}...")
        return True
    elif "error_code" in result:
        error_data = result.get("error_data", "{}")
        if isinstance(error_data, str):
            try:
                error_data = json.loads(error_data)
            except:
                error_data = {}

        code = result["error_code"]
        msg = result.get("error_msg", "")
        print(f"❌ Login error {code}: {msg}")

        if isinstance(error_data, dict):
            if error_data.get("uid"):
                print(f"   UID: {error_data['uid']}")
            if error_data.get("error_title"):
                print(f"   Title: {error_data['error_title']}")
            if error_data.get("url"):
                print(f"   Checkpoint URL: {error_data['url'][:100]}")
        return False
    else:
        print(f"❌ Unexpected response: {json.dumps(result, indent=2)[:300]}")
        return False


def main():
    if "--set-creds" in sys.argv:
        idx = sys.argv.index("--set-creds")
        if len(sys.argv) > idx + 2:
            save_creds(sys.argv[idx + 1], sys.argv[idx + 2])
        else:
            print("Usage: fb_login.py --set-creds EMAIL PASSWORD")
            sys.exit(1)
        return

    if "--check" in sys.argv:
        if check_cookies():
            print("✅ Cookies are valid")
        else:
            print("❌ Cookies expired or invalid")
            sys.exit(1)
        return

    # Auto-login flow
    print("🔍 Checking current cookies...")
    if check_cookies():
        print("✅ Cookies still valid, no refresh needed")
        return

    print("❌ Cookies expired, logging in via B-API...")
    if do_login():
        print("\n🔍 Verifying new cookies...")
        if check_cookies():
            print("✅ New cookies verified — marketplace API working!")
        else:
            print("⚠️ Cookies saved but API verification failed.")
            sys.exit(1)
    else:
        print("❌ Login failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
