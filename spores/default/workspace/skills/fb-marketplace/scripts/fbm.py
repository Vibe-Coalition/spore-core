#!/usr/bin/env python3
"""
Facebook Marketplace CLI — authenticated search.
Uses real Facebook GraphQL with cookie auth.

Usage:
    python3 fbm.py search "coffee table" [--radius 25] [--min 0] [--max 500] [--days 1]
    python3 fbm.py search "ps5" --sort price_asc
    python3 fbm.py set-cookies '<cookie string from browser>'
"""

import json
import sys
import re
import argparse
import os
import urllib.parse
from pathlib import Path

try:
    from curl_cffi import requests as cffi_requests
    HAS_CFFI = True
except ImportError:
    HAS_CFFI = False

GRAPHQL_URL = "https://www.facebook.com/api/graphql/"
DOC_ID_SEARCH = "26058421810481206"

SCRIPT_DIR = Path(__file__).parent
COOKIE_FILE = SCRIPT_DIR / "fbm_cookies.txt"
CONFIG_FILE = SCRIPT_DIR / "fbm_config.json"

DEFAULT_LAT = 49.290643774512
DEFAULT_LNG = -122.84837739278
DEFAULT_LOCATION = "Port Moody, BC"
DEFAULT_RADIUS = 11


def load_cookies():
    try:
        return COOKIE_FILE.read_text().strip()
    except:
        return None


def save_cookies(cookie_str):
    COOKIE_FILE.write_text(cookie_str.strip())
    print(f"✅ Cookies saved to {COOKIE_FILE}")


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except:
        return {"latitude": DEFAULT_LAT, "longitude": DEFAULT_LNG,
                "location_name": DEFAULT_LOCATION, "radius": DEFAULT_RADIUS}


def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "cookie": cookie_str,
    }
    resp = session.get("https://www.facebook.com/marketplace/", headers=headers, timeout=15)
    m = re.search(r'"DTSGInitialData".*?"token":"([^"]+)"', resp.text)
    if m:
        return m.group(1)
    # Try alternate pattern
    m = re.search(r'fb_dtsg.*?value["\s:]+([^"&\s]+)', resp.text)
    if m:
        return m.group(1)
    return None


def get_lsd(session, cookies_dict):
    """Extract LSD token."""
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies_dict.items())
    headers = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "cookie": cookie_str,
    }
    resp = session.get("https://www.facebook.com/marketplace/", headers=headers, timeout=15)
    m = re.search(r'"LSD"[^}]*?"token":"([^"]+)"', resp.text)
    if m:
        return m.group(1)
    return None


def cmd_search(args):
    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No cookies set. Run: python3 fbm.py set-cookies '<cookie string>'")
        return

    cookies_dict = parse_cookies(cookie_str)
    user_id = extract_user_id(cookies_dict)
    if not user_id:
        print("❌ No c_user in cookies — need authenticated Facebook cookies")
        return

    if not HAS_CFFI:
        print("❌ curl_cffi required: pip install curl_cffi --break-system-packages")
        return

    session = cffi_requests.Session(impersonate="chrome")
    cfg = load_config()

    lat = args.lat or cfg.get("latitude", DEFAULT_LAT)
    lng = args.lng or cfg.get("longitude", DEFAULT_LNG)
    location_name = cfg.get("location_name", DEFAULT_LOCATION)
    radius_km = args.radius or cfg.get("radius", DEFAULT_RADIUS)
    min_price = int(args.min * 100) if args.min is not None else 0
    max_price = int(args.max * 100) if args.max is not None else 214748364700

    # Days since listed filter
    days_filter = None
    if args.days:
        days_filter = str(args.days)

    # Get DTSG + LSD tokens
    print("🔑 Getting session tokens...", file=sys.stderr)
    dtsg = get_fb_dtsg(session, cookies_dict)
    if not dtsg:
        print("❌ Could not get fb_dtsg token — cookies may be expired")
        return
    lsd = get_lsd(session, cookies_dict)
    if not lsd:
        lsd = dtsg  # fallback

    # Build variables
    variables = {
        "count": 24,
        "params": {
            "bqf": {
                "callsite": "COMMERCE_MKTPLACE_WWW",
                "query": args.query,
            },
            "browse_request_params": {
                "commerce_enable_local_pickup": True,
                "commerce_enable_shipping": True,
                "commerce_search_and_rp_available": True,
                "commerce_search_and_rp_category_id": [],
                "commerce_search_and_rp_condition": None,
                "commerce_search_and_rp_ctime_days": days_filter,
                "filter_location_latitude": float(lat),
                "filter_location_longitude": float(lng),
                "filter_price_lower_bound": min_price,
                "filter_price_upper_bound": max_price,
                "filter_radius_km": radius_km,
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

    # Build request body (match real browser payload)
    body = {
        "av": user_id,
        "__user": user_id,
        "__a": "1",
        "__comet_req": "15",
        "fb_dtsg": dtsg,
        "lsd": lsd,
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "CometMarketplaceSearchContentPaginationQuery",
        "variables": json.dumps(variables),
        "doc_id": DOC_ID_SEARCH,
        "server_timestamps": "true",
    }

    headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "cookie": cookie_str,
        "origin": "https://www.facebook.com",
        "referer": f"https://www.facebook.com/marketplace/search?query={urllib.parse.quote(args.query)}",
        "sec-ch-prefers-color-scheme": "dark",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "x-asbd-id": "359341",
        "x-fb-friendly-name": "CometMarketplaceSearchContentPaginationQuery",
        "x-fb-lsd": lsd,
    }

    print("🔍 Searching...", file=sys.stderr)
    try:
        resp = session.post(GRAPHQL_URL, headers=headers, data=body, timeout=30)
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        return

    if args.raw:
        print(resp.text[:8000])
        return

    # Facebook may return multiple JSON objects separated by newlines
    text = resp.text.strip()
    data = None
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            # Look for the one with marketplace_search data
            if "data" in parsed and "marketplace_search" in parsed.get("data", {}):
                data = parsed
                break
            if not data:
                data = parsed
        except json.JSONDecodeError:
            continue

    if not data:
        print("❌ Could not parse response")
        return

    # Extract listings
    all_listings = []
    try:
        edges = data["data"]["marketplace_search"]["feed_units"]["edges"]
        for edge in edges:
            node = edge.get("node", {})
            typename = node.get("__typename", "")

            if "Listing" not in typename and typename != "MarketplaceFeedListingStoryObject":
                continue

            listing = node.get("listing", node)
            lid = listing.get("id", "?")
            title = listing.get("marketplace_listing_title", "?")
            price = listing.get("listing_price", {}).get("formatted_amount", "?")

            old_price = ""
            if listing.get("strikethrough_price"):
                old_price = listing["strikethrough_price"].get("formatted_amount", "")

            pending = listing.get("is_pending", False)

            seller = "?"
            if listing.get("marketplace_listing_seller"):
                seller = listing["marketplace_listing_seller"].get("name", "?")

            city = "?"
            try:
                city = listing["location"]["reverse_geocode"]["city_page"]["display_name"]
            except:
                pass

            photo = ""
            try:
                photo = listing["primary_listing_photo"]["image"]["uri"]
            except:
                pass

            all_listings.append({
                "id": lid,
                "title": title,
                "price": price,
                "old_price": old_price,
                "pending": pending,
                "seller": seller,
                "city": city,
                "photo": photo,
                "url": f"https://www.facebook.com/marketplace/item/{lid}",
            })
    except (KeyError, TypeError) as e:
        print(f"❌ Parse error: {e}")
        # Show raw for debugging
        print(json.dumps(data, indent=2)[:3000])
        return

    if not all_listings:
        # Check if no results message
        try:
            edges = data["data"]["marketplace_search"]["feed_units"]["edges"]
            for edge in edges:
                if edge.get("node", {}).get("__typename") == "MarketplaceSearchFeedNoResults":
                    print(f"No listings found for '{args.query}' near {location_name}")
                    return
        except:
            pass
        print(f"No listings found for '{args.query}' near {location_name}")
        return

    # Sort
    if args.sort == "price_asc":
        all_listings.sort(key=lambda x: _parse_price(x["price"]))
    elif args.sort == "price_desc":
        all_listings.sort(key=lambda x: _parse_price(x["price"]), reverse=True)

    # Filter pending
    if not args.show_pending:
        all_listings = [l for l in all_listings if not l["pending"]]

    print(f"🏪 Facebook Marketplace: \"{args.query}\" near {location_name} ({len(all_listings)} results)\n")
    for l in all_listings:
        pending_tag = " ⏳PENDING" if l["pending"] else ""
        old_tag = f" (was {l['old_price']})" if l["old_price"] else ""
        print(f"  💲{l['price']}{old_tag}{pending_tag}  {l['title'][:100]}")
        print(f"     📍 {l['city']} · 👤 {l['seller']}")
        print(f"     🔗 {l['url']}")
        print()


def _parse_price(price_str):
    try:
        cleaned = re.sub(r'[^\d.]', '', price_str)
        return float(cleaned) if cleaned else 999999
    except:
        return 999999


def cmd_set_cookies(args):
    save_cookies(args.cookies)
    cookies = parse_cookies(args.cookies)
    uid = extract_user_id(cookies)
    if uid:
        print(f"👤 User ID: {uid}")
    else:
        print("⚠️ No c_user found — make sure you're copying all cookies from facebook.com")


def main():
    parser = argparse.ArgumentParser(description="Facebook Marketplace CLI")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("search", help="Search marketplace listings")
    p.add_argument("query", help="Search query")
    p.add_argument("--radius", type=int, help="Search radius in km (default: 11)")
    p.add_argument("--min", type=float, help="Minimum price")
    p.add_argument("--max", type=float, help="Maximum price")
    p.add_argument("--days", type=int, help="Only show listings from last N days")
    p.add_argument("--sort", choices=["price_asc", "price_desc"], help="Sort results")
    p.add_argument("--lat", type=float, help="Override latitude")
    p.add_argument("--lng", type=float, help="Override longitude")
    p.add_argument("--raw", action="store_true", help="Raw response")
    p.add_argument("--show-pending", action="store_true", help="Include pending listings")

    p = sub.add_parser("set-cookies", help="Set Facebook cookies")
    p.add_argument("cookies", help="Cookie string from browser DevTools")

    p = sub.add_parser("listing", help="Get listing details and full-size photos")
    p.add_argument("listing_id", help="Listing ID")
    p.add_argument("--raw", action="store_true", help="Just print image URLs")
    p.add_argument("--json", dest="json_out", action="store_true")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    if args.command == "search":
        cmd_search(args)
    elif args.command == "set-cookies":
        cmd_set_cookies(args)
    elif args.command == "listing":
        cmd_listing(args)


def cmd_listing(args):
    """Fetch full listing details including high-res images."""
    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No cookies set")
        return

    if not HAS_CFFI:
        print("❌ curl_cffi required")
        return

    import html
    session = cffi_requests.Session(impersonate="chrome")
    resp = session.get(
        f"https://www.facebook.com/marketplace/item/{args.listing_id}",
        headers={
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            "cookie": cookie_str,
        },
        timeout=15,
    )

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        return

    # Extract high-res images
    images = re.findall(r'(https://scontent[^"]+?\.jpg[^"]*)', resp.text)
    big = []
    seen_urls = set()
    for img in images:
        img = html.unescape(img).replace("\\/", "/")
        if ("s960x960" in img or "p720x720" in img or "p1080x1080" in img) and "84726" not in img:
            # Deduplicate by base filename
            base = img.split("?")[0]
            if base not in seen_urls:
                seen_urls.add(base)
                big.append(img)

    # Also get listing-specific marketplace images
    for img in images:
        img = html.unescape(img).replace("\\/", "/")
        if "t45.5328" in img and ("s960x960" in img or "p720x720" in img):
            base = img.split("?")[0]
            if base not in seen_urls:
                seen_urls.add(base)
                big.insert(0, img)

    # Fetch listing title/description for context
    title = ""
    description = ""
    try:
        import re as regex
        title_match = regex.search(r'<h1[^>]*>([^<]+)</h1>', resp.text)
        if title_match:
            title = title_match.group(1).strip()
        desc_match = regex.search(r'<div[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</div>', resp.text, regex.DOTALL)
        if desc_match:
            description = regex.sub(r'<[^>]+>', '', desc_match.group(1)).strip()[:500]
    except:
        pass

    if args.raw:
        # Output JSON for programmatic use
        result = {
            "listing_id": args.listing_id,
            "title": title,
            "description": description,
            "images": big[:10],
            "url": f"https://www.facebook.com/marketplace/item/{args.listing_id}",
        }
        print(json.dumps(result, indent=2))
        return

    print(f"📸 Listing {args.listing_id} — {len(big)} photos found\n")
    if title:
        print(f"   {title}")
    for i, img in enumerate(big[:8], 1):
        print(f"  [{i}] {img[:120]}...")
    
    if args.json_out:
        print(json.dumps({"listing_id": args.listing_id, "images": big[:10]}, indent=2))


if __name__ == "__main__":
    main()
