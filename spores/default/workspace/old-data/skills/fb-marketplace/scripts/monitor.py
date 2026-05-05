#!/usr/bin/env python3
"""
Facebook Marketplace Deal Monitor
Tracks watches, deduplicates listings, learns preferences over time.

Usage:
    python3 monitor.py watch add "coffee table" --max 200 --radius 20
    python3 monitor.py watch list
    python3 monitor.py watch remove <watch_id>
    python3 monitor.py watch update <watch_id> --max 300 --radius 30
    python3 monitor.py learn <watch_id> "I prefer mid-century modern style"
    python3 monitor.py learn <watch_id> "no glass tops"
    python3 monitor.py learn <watch_id> "anything under $50 is a great deal"
    python3 monitor.py check [watch_id]          # check one or all watches
    python3 monitor.py seen <watch_id>            # show seen listings
    python3 monitor.py clear-seen <watch_id>      # reset seen listings
    python3 monitor.py report                     # full status report
"""

import json
import sys
import os
import hashlib
import argparse
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "monitor_data"
WATCHES_FILE = DATA_DIR / "watches.json"
SEEN_FILE = DATA_DIR / "seen.json"

# Ensure data directory exists
DATA_DIR.mkdir(exist_ok=True)


# ─── Data Persistence ────────────────────────────────────────────────────

def load_watches():
    try:
        with open(WATCHES_FILE) as f:
            return json.load(f)
    except:
        return {}

def save_watches(watches):
    with open(WATCHES_FILE, "w") as f:
        json.dump(watches, f, indent=2, ensure_ascii=False)

def load_seen():
    try:
        with open(SEEN_FILE) as f:
            return json.load(f)
    except:
        return {}

def save_seen(seen):
    with open(SEEN_FILE, "w") as f:
        json.dump(seen, f, indent=2, ensure_ascii=False)


def make_watch_id(query):
    """Generate a short ID from query."""
    return hashlib.md5(query.lower().encode()).hexdigest()[:8]


# ─── Watch Management ────────────────────────────────────────────────────

def cmd_watch_add(args):
    watches = load_watches()
    wid = make_watch_id(args.query)

    if wid in watches:
        print(f"⚠️ Watch already exists for '{args.query}' (ID: {wid})")
        return

    watch = {
        "id": wid,
        "query": args.query,
        "created": datetime.now().isoformat(),
        "last_checked": None,
        "params": {
            "min_price": args.min,
            "max_price": args.max,
            "radius_km": args.radius or 20,
            "days": args.days,
        },
        "preferences": [],
        "stats": {
            "total_seen": 0,
            "total_alerts": 0,
            "checks": 0,
        },
    }

    watches[wid] = watch
    save_watches(watches)

    # Initialize seen list
    seen = load_seen()
    seen[wid] = {}
    save_seen(seen)

    print(f"✅ Watch created: '{args.query}' (ID: {wid})")
    print(f"   💲 Price: {'$'+str(args.min) if args.min else '$0'} — {'$'+str(args.max) if args.max else 'any'}")
    print(f"   📍 Radius: {watch['params']['radius_km']}km")
    if args.days:
        print(f"   📅 Only last {args.days} day(s)")
    print(f"\n   Add preferences: python3 monitor.py learn {wid} \"I like mid-century modern\"")

def cmd_watch_list(args):
    watches = load_watches()
    if not watches:
        print("No active watches.")
        return

    print(f"📋 Active Watches ({len(watches)}):\n")
    for wid, w in watches.items():
        p = w["params"]
        price_str = f"${p.get('min_price') or 0}—${p.get('max_price') or '∞'}"
        prefs = len(w.get("preferences", []))
        seen_count = w["stats"]["total_seen"]
        alerts = w["stats"]["total_alerts"]
        last = w.get("last_checked", "never")
        if last and last != "never":
            last = last[:16]

        print(f"  🔍 [{wid}] \"{w['query']}\"")
        print(f"     {price_str} · {p.get('radius_km', 20)}km · {prefs} prefs · {seen_count} seen · {alerts} alerts")
        print(f"     Last checked: {last}")
        if w.get("preferences"):
            for pref in w["preferences"][-3:]:
                print(f"     💡 {pref['text']}")
        print()

def cmd_watch_remove(args):
    watches = load_watches()
    if args.watch_id not in watches:
        print(f"❌ Watch '{args.watch_id}' not found")
        return
    name = watches[args.watch_id]["query"]
    del watches[args.watch_id]
    save_watches(watches)

    seen = load_seen()
    seen.pop(args.watch_id, None)
    save_seen(seen)

    print(f"🗑️ Removed watch for '{name}'")

def cmd_watch_update(args):
    watches = load_watches()
    if args.watch_id not in watches:
        print(f"❌ Watch '{args.watch_id}' not found")
        return
    w = watches[args.watch_id]
    if args.min is not None:
        w["params"]["min_price"] = args.min
    if args.max is not None:
        w["params"]["max_price"] = args.max
    if args.radius is not None:
        w["params"]["radius_km"] = args.radius
    if args.days is not None:
        w["params"]["days"] = args.days
    save_watches(watches)
    print(f"✅ Updated watch '{w['query']}' ({args.watch_id})")


# ─── Preference Learning ─────────────────────────────────────────────────

def cmd_learn(args):
    watches = load_watches()
    if args.watch_id not in watches:
        print(f"❌ Watch '{args.watch_id}' not found")
        return

    w = watches[args.watch_id]
    w.setdefault("preferences", []).append({
        "text": args.preference,
        "added": datetime.now().isoformat(),
    })
    save_watches(watches)
    print(f"💡 Learned for '{w['query']}': {args.preference}")
    print(f"   Total preferences: {len(w['preferences'])}")


# ─── Checking ─────────────────────────────────────────────────────────────

def cmd_check(args):
    """Check one or all watches for new listings."""
    watches = load_watches()
    seen = load_seen()

    if args.watch_id:
        if args.watch_id not in watches:
            print(f"❌ Watch '{args.watch_id}' not found")
            return
        check_ids = [args.watch_id]
    else:
        check_ids = list(watches.keys())

    if not check_ids:
        print("No watches to check.")
        return

    # Import search function
    sys.path.insert(0, str(SCRIPT_DIR))
    from fbm import load_cookies, parse_cookies, extract_user_id, get_fb_dtsg
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        print("❌ curl_cffi required")
        return

    cookie_str = load_cookies()
    if not cookie_str:
        print("❌ No Facebook cookies set")
        return

    cookies_dict = parse_cookies(cookie_str)
    user_id = extract_user_id(cookies_dict)
    if not user_id:
        print("❌ Invalid cookies")
        return

    session = cffi_requests.Session(impersonate="chrome")
    dtsg = get_fb_dtsg(session, cookies_dict)
    if not dtsg:
        print("❌ Could not get session token — cookies may be expired")
        return

    all_new = {}

    for wid in check_ids:
        w = watches[wid]
        p = w["params"]
        result = _search_and_filter(
            session, cookie_str, user_id, dtsg,
            query=w["query"],
            min_price=p.get("min_price"),
            max_price=p.get("max_price"),
            radius_km=p.get("radius_km", 20),
            days=p.get("days"),
            seen_ids=set(seen.get(wid, {}).keys()),
        )

        if result == "AUTH_ERROR":
            print("🔴 COOKIES_EXPIRED — Facebook session is invalid. Need fresh cookies or re-login.")
            save_watches(watches)
            return

        new_listings = result

        # Mark as seen
        if wid not in seen:
            seen[wid] = {}
        for listing in new_listings:
            seen[wid][listing["id"]] = {
                "title": listing["title"][:100],
                "price": listing["price"],
                "first_seen": datetime.now().isoformat(),
            }

        w["last_checked"] = datetime.now().isoformat()
        w["stats"]["checks"] += 1
        w["stats"]["total_seen"] += len(new_listings)

        if new_listings:
            w["stats"]["total_alerts"] += len(new_listings)
            all_new[wid] = {
                "watch": w,
                "listings": new_listings,
            }

    save_watches(watches)
    save_seen(seen)

    # Output results
    if not all_new:
        print("NO_NEW_LISTINGS")
        return

    for wid, data in all_new.items():
        w = data["watch"]
        listings = data["listings"]
        prefs_text = ""
        if w.get("preferences"):
            prefs_text = "\nPreferences: " + " | ".join(p["text"] for p in w["preferences"])

        print(f"🔔 [{wid}] \"{w['query']}\" — {len(listings)} new listing(s){prefs_text}\n")
        for l in listings:
            pending_tag = " ⏳" if l.get("pending") else ""
            old_tag = f" (was {l['old_price']})" if l.get("old_price") else ""
            print(f"  💲{l['price']}{old_tag}{pending_tag}  {l['title'][:100]}")
            print(f"     📍 {l['city']} · 👤 {l['seller']}")
            print(f"     🔗 {l['url']}")
            if l.get('photo'):
                print(f"     📷 {l['photo'][:100]}...")
            print()


def _search_and_filter(session, cookie_str, user_id, dtsg, query, min_price, max_price, radius_km, days, seen_ids):
    """Run a marketplace search and return only new, unseen listings."""
    import json
    import urllib.parse

    variables = {
        "count": 24,
        "params": {
            "bqf": {"callsite": "COMMERCE_MKTPLACE_WWW", "query": query},
            "browse_request_params": {
                "commerce_enable_local_pickup": True,
                "commerce_enable_shipping": True,
                "commerce_search_and_rp_available": True,
                "commerce_search_and_rp_category_id": [],
                "commerce_search_and_rp_condition": None,
                "commerce_search_and_rp_ctime_days": str(days) if days else None,
                "filter_location_latitude": 49.290643774512,
                "filter_location_longitude": -122.84837739278,
                "filter_price_lower_bound": int(min_price * 100) if min_price else 0,
                "filter_price_upper_bound": int(max_price * 100) if max_price else 214748364700,
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
        "accept": "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "cookie": cookie_str,
        "origin": "https://www.facebook.com",
        "referer": f"https://www.facebook.com/marketplace/search?query={urllib.parse.quote(query)}",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "x-fb-friendly-name": "CometMarketplaceSearchContentPaginationQuery",
        "x-fb-lsd": dtsg,
    }

    try:
        resp = session.post("https://www.facebook.com/api/graphql/", headers=headers, data=body, timeout=30)
        if resp.status_code != 200:
            return "AUTH_ERROR" if resp.status_code in (401, 403) else []
    except:
        return []

    # Check for login/auth errors in response
    resp_text = resp.text
    if '"errorSummary":"Log in to continue"' in resp_text or '"error":1357001' in resp_text:
        return "AUTH_ERROR"

    # Parse response
    data = None
    for line in resp_text.strip().split("\n"):
        try:
            parsed = json.loads(line.strip())
            if "data" in parsed and "marketplace_search" in parsed.get("data", {}):
                data = parsed
                break
        except:
            continue
    if not data:
        return []

    # Extract listings
    new_listings = []
    try:
        edges = data["data"]["marketplace_search"]["feed_units"]["edges"]
        for edge in edges:
            node = edge.get("node", {})
            if "Listing" not in node.get("__typename", "") and node.get("__typename") != "MarketplaceFeedListingStoryObject":
                continue
            listing = node.get("listing", node)
            lid = listing.get("id", "")
            if not lid or lid in seen_ids:
                continue  # DEDUP: skip already seen

            pending = listing.get("is_pending", False)
            if pending:
                continue  # Skip pending by default

            title = listing.get("marketplace_listing_title", "?")
            price = listing.get("listing_price", {}).get("formatted_amount", "?")
            old_price = ""
            if listing.get("strikethrough_price"):
                old_price = listing["strikethrough_price"].get("formatted_amount", "")
            seller = listing.get("marketplace_listing_seller", {}).get("name", "?")
            city = "?"
            try:
                city = listing["location"]["reverse_geocode"]["city_page"]["display_name"]
            except:
                pass
            
            # Extract photo URL
            photo = ""
            try:
                photo = listing["primary_listing_photo"]["image"]["uri"]
            except:
                pass

            new_listings.append({
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
    except:
        pass

    return new_listings


def cmd_seen(args):
    seen = load_seen()
    watches = load_watches()
    wid = args.watch_id

    if wid not in watches:
        print(f"❌ Watch '{wid}' not found")
        return

    s = seen.get(wid, {})
    print(f"👁️ Seen listings for '{watches[wid]['query']}': {len(s)}\n")
    for lid, info in list(s.items())[-20:]:
        print(f"  {info.get('price', '?')}  {info.get('title', '?')[:80]}")
        print(f"     First seen: {info.get('first_seen', '?')[:16]}")


def cmd_clear_seen(args):
    seen = load_seen()
    wid = args.watch_id
    if wid in seen:
        count = len(seen[wid])
        seen[wid] = {}
        save_seen(seen)
        print(f"🗑️ Cleared {count} seen listings for '{wid}'")
    else:
        print(f"Nothing to clear for '{wid}'")


def cmd_digest(args):
    """Show all listings seen in the last N hours (default 24), grouped by watch."""
    watches = load_watches()
    seen = load_seen()
    hours = args.hours or 24
    cutoff = datetime.now() - timedelta(hours=hours)

    if not watches:
        print("No active watches.")
        return

    total = 0
    output = []

    for wid, w in watches.items():
        s = seen.get(wid, {})
        recent = []
        for lid, info in s.items():
            first_seen = info.get("first_seen", "")
            try:
                seen_dt = datetime.fromisoformat(first_seen)
                if seen_dt >= cutoff:
                    recent.append((lid, info))
            except:
                continue

        if not recent:
            continue

        # Sort by first_seen descending
        recent.sort(key=lambda x: x[1].get("first_seen", ""), reverse=True)
        total += len(recent)

        lines = [f"🔔 [{wid}] \"{w['query']}\" — {len(recent)} new in last {hours}h"]
        if w.get("preferences"):
            lines.append(f"   Prefs: {' | '.join(p['text'][:60] for p in w['preferences'][:3])}")
        lines.append("")

        for lid, info in recent:
            lines.append(f"  💲{info.get('price', '?')}  {info.get('title', '?')[:80]}")
            lines.append(f"     🔗 https://www.facebook.com/marketplace/item/{lid}")
            lines.append("")

        output.append("\n".join(lines))

    if not output:
        print(f"NO_NEW_LISTINGS (last {hours}h)")
        return

    print(f"📋 Daily Digest — {total} listings across {len(output)} watches (last {hours}h)\n")
    print("\n".join(output))


def cmd_report(args):
    watches = load_watches()
    seen = load_seen()

    if not watches:
        print("No active watches.")
        return

    total_seen = sum(len(seen.get(wid, {})) for wid in watches)
    print(f"📊 Monitor Report — {len(watches)} watches, {total_seen} total seen listings\n")

    for wid, w in watches.items():
        s = seen.get(wid, {})
        p = w["params"]
        print(f"  🔍 [{wid}] \"{w['query']}\"")
        print(f"     Price: ${p.get('min_price') or 0}—${p.get('max_price') or '∞'} · Radius: {p.get('radius_km')}km")
        print(f"     Seen: {len(s)} · Alerts sent: {w['stats']['total_alerts']} · Checks: {w['stats']['checks']}")
        if w.get("preferences"):
            print(f"     Preferences:")
            for pref in w["preferences"]:
                print(f"       💡 {pref['text']}")
        print()


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FB Marketplace Deal Monitor")
    sub = parser.add_subparsers(dest="command")

    # watch add
    p = sub.add_parser("watch", help="Manage watches")
    wsub = p.add_subparsers(dest="watch_command")

    wa = wsub.add_parser("add", help="Add a watch")
    wa.add_argument("query", help="Search query")
    wa.add_argument("--min", type=float, help="Min price")
    wa.add_argument("--max", type=float, help="Max price")
    wa.add_argument("--radius", type=int, help="Radius km")
    wa.add_argument("--days", type=int, help="Only listings from last N days")

    wl = wsub.add_parser("list", help="List watches")

    wr = wsub.add_parser("remove", help="Remove a watch")
    wr.add_argument("watch_id")

    wu = wsub.add_parser("update", help="Update watch params")
    wu.add_argument("watch_id")
    wu.add_argument("--min", type=float)
    wu.add_argument("--max", type=float)
    wu.add_argument("--radius", type=int)
    wu.add_argument("--days", type=int)

    # learn
    p = sub.add_parser("learn", help="Add preference to a watch")
    p.add_argument("watch_id")
    p.add_argument("preference")

    # check
    p = sub.add_parser("check", help="Check for new listings")
    p.add_argument("watch_id", nargs="?", help="Check specific watch (or all)")

    # seen
    p = sub.add_parser("seen", help="Show seen listings")
    p.add_argument("watch_id")

    # clear-seen
    p = sub.add_parser("clear-seen", help="Clear seen listings")
    p.add_argument("watch_id")

    # digest
    p = sub.add_parser("digest", help="Daily digest of recent listings")
    p.add_argument("--hours", type=int, default=24, help="Hours to look back (default 24)")

    # report
    sub.add_parser("report", help="Full status report")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    if args.command == "watch":
        if not args.watch_command:
            print("Usage: monitor.py watch [add|list|remove|update]")
            return
        {"add": cmd_watch_add, "list": cmd_watch_list,
         "remove": cmd_watch_remove, "update": cmd_watch_update}[args.watch_command](args)
    elif args.command == "learn":
        cmd_learn(args)
    elif args.command == "check":
        cmd_check(args)
    elif args.command == "seen":
        cmd_seen(args)
    elif args.command == "clear-seen":
        cmd_clear_seen(args)
    elif args.command == "digest":
        cmd_digest(args)
    elif args.command == "report":
        cmd_report(args)


if __name__ == "__main__":
    main()
