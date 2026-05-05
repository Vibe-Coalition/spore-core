#!/usr/bin/env python3
"""
Uber Eats private API client.
Uses cookie auth + curl_cffi Chrome impersonation.
Location-locked to 150 April Rd, Port Moody, BC.

Commands:
  set-cookies '<string>'     Save browser cookies
  orders [--all] [--raw]     List past orders (--all paginates)
  search <query> [--raw]     Search restaurants delivering here
  store <uuid> [--raw]       View store menu
  carts [--raw]              View all carts
  add <store> <item> [notes] Add item to cart (via createDraftOrderV2)
  reorder <order_uuid>       Reorder a past order
  user [--raw]               User profile
"""

import json
import sys
import os
import uuid as _uuid

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print("Need curl_cffi: pip install curl_cffi", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(SCRIPT_DIR, "ue_cookies.txt")
STORE_CACHE_FILE = os.path.join(SCRIPT_DIR, "ue_stores.json")
BASE = "https://www.ubereats.com"
LOCALE = "localeCode=ca"

# ── Delivery location (150 April Rd, Port Moody) ───────────────────────

DELIVERY_ADDRESS = {
    "address1": "150 April Rd",
    "address2": "Port Moody, BC V3H 3M6",
    "aptOrSuite": "",
    "eaterFormattedAddress": "150 April Rd, Port Moody, BC V3H 3M6, CA",
    "subtitle": "Port Moody, BC V3H 3M6",
    "title": "150 April Rd",
    "uuid": "",
}
DELIVERY_LOCATION = {
    "address": DELIVERY_ADDRESS,
    "latitude": 49.299475,
    "longitude": -122.860276,
    "reference": "1c820f19-9e53-fe73-89d7-3d7d444f3862",
    "referenceType": "uber_places",
    "type": "uber_places",
    "addressId": "",
}


# ── Session ─────────────────────────────────────────────────────────────

def load_cookies():
    if os.path.exists(COOKIE_FILE):
        with open(COOKIE_FILE) as f:
            return f.read().strip()
    return None

def save_cookies(cookie_str):
    os.makedirs(SCRIPT_DIR, exist_ok=True)
    with open(COOKIE_FILE, "w") as f:
        f.write(cookie_str)

def get_session():
    cookies = load_cookies()
    if not cookies:
        print("No cookies. Run: ue.py set-cookies '<cookie string>'", file=sys.stderr)
        sys.exit(1)

    s = cffi_requests.Session(impersonate="chrome")
    for part in cookies.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            s.cookies.set(k.strip(), v.strip())

    s.headers.update({
        "accept": "application/json",
        "content-type": "application/json",
        "x-csrf-token": "x",
        "origin": BASE,
        "referer": f"{BASE}/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })
    return s

def api(endpoint, payload=None):
    """POST to /_p/api/<endpoint>?localeCode=ca."""
    s = get_session()
    url = f"{BASE}/_p/api/{endpoint}"
    if "?" not in endpoint:
        url += f"?{LOCALE}"
    r = s.post(url, json=payload or {})
    if r.status_code != 200:
        print(f"Error {r.status_code} on {endpoint}: {r.text[:500]}", file=sys.stderr)
        sys.exit(1)
    return r.json()


# ── Store cache ─────────────────────────────────────────────────────────

def load_store_cache():
    if os.path.exists(STORE_CACHE_FILE):
        with open(STORE_CACHE_FILE) as f:
            return json.load(f)
    return {}

def save_store_cache(cache):
    with open(STORE_CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)

def resolve_store_name(store_uuid):
    cache = load_store_cache()
    if store_uuid in cache:
        return cache[store_uuid]
    try:
        data = get_store(store_uuid)
        name = data.get("data", {}).get("title", "Unknown")
        cache[store_uuid] = name
        save_store_cache(cache)
        return name
    except:
        return "Unknown"


# ── API calls ───────────────────────────────────────────────────────────

def get_orders(cursor=""):
    return api("getPastOrdersV1", {"lastWorkflowUUID": cursor})

def get_all_orders():
    all_orders, all_uuids, cursor, page = {}, [], "", 0
    while True:
        page += 1
        data = get_orders(cursor)
        d = data.get("data", {})
        om = d.get("ordersMap", {})
        ou = d.get("orderUuids", [])
        if not om:
            break
        all_orders.update(om)
        all_uuids.extend(ou)
        pag = d.get("paginationData", {})
        if not pag.get("hasMore"):
            break
        cursor = pag.get("lastWorkflowUUID", "")
        if not cursor:
            break
        print(f"  📄 Page {page} ({len(all_uuids)} orders)...", file=sys.stderr)
    return {"data": {"ordersMap": all_orders, "orderUuids": all_uuids}}

def search_stores(query):
    return api("getSearchFeedV1", {
        "userQuery": query, "date": "", "startTime": 0, "endTime": 0,
        "sortAndFilters": [], "vertical": "", "searchSource": "",
        "displayType": "SEARCH_RESULTS", "searchType": "",
        "keyName": "", "cacheKey": "", "recaptchaToken": "",
    })

def get_store(store_uuid):
    return api("getStoreV1", {
        "storeUuid": store_uuid,
        "diningMode": "DELIVERY",
        "time": {"asap": True},
        "cbType": "EATER_ENDORSED",
    })

def get_carts():
    return api("getCartsViewForEaterUuidV1", {})

def get_user():
    return api("getUserV1", {"shouldGetSubsMetadata": True})

def get_active_orders():
    return api("getActiveOrdersV1", {
        "orderUuid": None,
        "timezone": "America/Los_Angeles",
        "showAppUpsellIllustration": True,
        "isDirectTracking": False,
    })

def get_store_item_map(store_uuid):
    """Return {itemUuid: {sectionUuid, subsectionUuid, title, price}} for a store."""
    data = get_store(store_uuid)
    d = data.get("data", {})
    csm = d.get("catalogSectionsMap", {})
    item_map = {}
    for sec_uuid, sections in csm.items():
        if not isinstance(sections, list):
            continue
        for section in sections:
            sub_uuid = section.get("catalogSectionUUID", "")
            items = (section.get("payload", {})
                     .get("standardItemsPayload", {})
                     .get("catalogItems", []))
            for item in items:
                iid = item.get("uuid", "")
                if iid and iid not in item_map:
                    item_map[iid] = {
                        "sectionUuid": sec_uuid,
                        "subsectionUuid": sub_uuid,
                        "title": item.get("title", ""),
                        "price": item.get("price", 0),
                        "imageURL": item.get("imageUrl", ""),
                    }
    return item_map

CART_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ue_cart_cache.json")


def load_cart_cache(store_uuid):
    """Load cached cart items for a store from local file."""
    if os.path.exists(CART_CACHE_FILE):
        try:
            with open(CART_CACHE_FILE) as f:
                cache = json.load(f)
            if cache.get("storeUuid") == store_uuid:
                return cache.get("items", [])
        except Exception:
            pass
    return []


def save_cart_cache(store_uuid, items):
    """Save cart items to local cache after a successful createDraftOrderV2."""
    with open(CART_CACHE_FILE, "w") as f:
        json.dump({"storeUuid": store_uuid, "items": items}, f, indent=2, ensure_ascii=False)


def create_cart(store_uuid, items, append=True):
    """
    Add items to cart via createDraftOrderV2.
    items = [{"uuid": itemUuid, "quantity": N, "specialInstructions": "..."}]
    If append=True (default), loads cached cart items and includes them.
    After success, caches all items for next append.
    Resolves section/subsection UUIDs automatically from the store menu.
    """
    item_map = get_store_item_map(store_uuid)

    cart_items = []

    # Preserve existing cart items from local cache
    if append:
        cached = load_cart_cache(store_uuid)
        cart_items.extend(cached)

    # Add new items
    for item in items:
        iid = item["uuid"]
        info = item_map.get(iid, {})
        if not info:
            print(f"⚠️  Item {iid} not found in store menu", file=sys.stderr)
            continue
        ci = {
            "uuid": iid,
            "shoppingCartItemUuid": str(_uuid.uuid4()),
            "storeUuid": store_uuid,
            "sectionUuid": info["sectionUuid"],
            "subsectionUuid": info["subsectionUuid"],
            "price": info["price"],
            "title": info["title"],
            "quantity": item.get("quantity", 1),
            "customizations": {},
        }
        if item.get("specialInstructions"):
            ci["specialInstructions"] = item["specialInstructions"]
        if info.get("imageURL"):
            ci["imageURL"] = info["imageURL"]
        cart_items.append(ci)

    if not cart_items:
        print("No valid items to add.", file=sys.stderr)
        sys.exit(1)

    result = api("createDraftOrderV2", {
        "isMulticart": True,
        "shoppingCartItems": cart_items,
    })

    # Cache the full cart for future appends
    save_cart_cache(store_uuid, cart_items)

    return result


# ── Formatters ──────────────────────────────────────────────────────────

def format_orders(data):
    d = data.get("data", data)
    orders_map = d.get("ordersMap", {})
    order_uuids = d.get("orderUuids", list(orders_map.keys()))
    if not orders_map:
        print("No orders found.")
        return
    for uid in order_uuids:
        o = orders_map.get(uid, {})
        base = o.get("baseEaterOrder", {})
        store_uuid = base.get("storeUuid", "")
        store_name = resolve_store_name(store_uuid) if store_uuid else "Unknown"
        cart = base.get("shoppingCart", {})
        items, total_cents = [], 0
        for item in cart.get("items", []):
            name = item.get("title", "?")
            qty = item.get("quantity", 1)
            price = item.get("price", 0)
            notes = item.get("specialInstructions", "")
            total_cents += price * qty
            label = f"{name} x{qty}" if qty > 1 else name
            if notes:
                label += f" 📝{notes}"
            items.append(label)
        fare = o.get("eaterOrderFare", {})
        total = fare.get("total", {}).get("amountE5")
        total_str = f"${total / 100000:.2f}" if total else (f"~${total_cents / 100:.2f}" if total_cents else "?")
        completed = base.get("completedAt", base.get("lastStateChangeAt", "?"))
        if completed and completed != "?":
            completed = completed.replace("T", " ").split(".")[0][:16]
        print(f"🍔 {store_name} — {total_str}")
        print(f"   📅 {completed}")
        if items:
            print(f"   📦 {', '.join(items)}")
        print(f"   🆔 {uid}")
        print()

def format_search(data):
    d = data.get("data", {})
    feed = d.get("feedItems", [])
    if not feed:
        print("No results.")
        return
    for item in feed:
        if not isinstance(item, dict) or "store" not in item:
            continue
        si = item["store"]
        uid = si.get("storeUuid", "")
        title_obj = si.get("title", {})
        title = title_obj.get("text", title_obj) if isinstance(title_obj, dict) else str(title_obj)
        meta_parts = []
        for m in si.get("meta", []):
            if isinstance(m, dict):
                t = m.get("text", "")
                if t and "Sponsored" not in t:
                    meta_parts.append(t)
        meta_str = " · ".join(meta_parts[:3]) if meta_parts else ""
        print(f"🏪 {title}")
        if meta_str:
            print(f"   {meta_str}")
        print(f"   🆔 {uid}")
        print()

def format_store_menu(data):
    d = data.get("data", {})
    title = d.get("title", "?")
    is_open = d.get("isOpen", True)
    closed_msg = d.get("closedMessage", "")
    print(f"🏪 {title}")
    if not is_open:
        print(f"   ❌ CLOSED{' — ' + closed_msg if closed_msg else ''}")
    print()
    csm = d.get("catalogSectionsMap", {})
    for sec_uuid, sections in csm.items():
        if not isinstance(sections, list) or not sections:
            continue
        for section in sections:
            sip = section.get("payload", {}).get("standardItemsPayload", {})
            sec_title = sip.get("title", {}).get("text", "")
            items = sip.get("catalogItems", [])
            if not items:
                continue
            if sec_title:
                print(f"📋 {sec_title}")
            for item in items:
                name = item.get("title", "?")
                price = item.get("price", 0)
                price_str = f"${price / 100:.2f}" if price else ""
                desc = (item.get("itemDescription", "") or "")[:60]
                sold_out = item.get("isSoldOut", False)
                line = f"  • {name}"
                if price_str:
                    line += f" — {price_str}"
                if sold_out:
                    line += " ❌ SOLD OUT"
                print(line)
                if desc:
                    print(f"    {desc}")
                print(f"    🆔 {item.get('uuid', '')}")
            print()

def format_active_orders(data):
    orders = data.get("data", {}).get("orders", [])
    if not orders:
        print("No active orders.")
        return
    for o in orders:
        overview = o.get("activeOrderOverview", {})
        title = overview.get("title", "?")
        subtitle = overview.get("subtitle", "")

        # Extract status from feedCards
        status_text = "Unknown"
        eta_text = ""
        latest_arrival = ""
        order_status = ""
        
        # Check analytics for simple status
        analytics = o.get("analytics", {}).get("data", {})
        order_status = analytics.get("order_status", "")

        for card in o.get("feedCards", []):
            st = card.get("status", {})
            if st:
                ts = st.get("titleSummary", {}).get("summary", {}).get("text", "")
                if ts:
                    status_text = ts
                ss = st.get("subtitleSummary", {}).get("summary", {}).get("text", "")
                if ss:
                    eta_text = ss
                sm = st.get("statusSummary", {}).get("text", "")
                if sm:
                    latest_arrival = sm

        # Check activeOrderStatus (top-level)
        aos = o.get("activeOrderStatus", {})
        if aos:
            ts = aos.get("titleSummary", {}).get("summary", {}).get("text", "")
            if ts:
                status_text = ts
            ss = aos.get("subtitleSummary", {}).get("summary", {}).get("text", "")
            if ss:
                eta_text = ss

        uid = o.get("uuid", "")
        phase = o.get("orderInfo", {}).get("orderPhase", "")

        print(f"🍔 {title} — {subtitle}")
        print(f"   📍 {status_text}")
        if eta_text:
            print(f"   🕐 {eta_text}")
        if latest_arrival:
            print(f"   ⏰ {latest_arrival}")
        if order_status:
            print(f"   📊 {order_status}")
        if phase:
            print(f"   Phase: {phase}")
        print(f"   🆔 {uid}")
        print()


def format_carts(data):
    d = data.get("data", {})
    carts = d.get("cartsView", {}).get("carts", [])
    if not carts:
        print("No carts.")
        return
    for c in carts:
        title = c.get("title", "?")
        subtotal = c.get("tagline1", {}).get("text", "")
        count = c.get("itemCount", 0)
        draft_id = c.get("draftOrderUUID", "")
        print(f"🛒 {title} — {subtotal} ({count} items)")
        print(f"   🆔 {draft_id}")
        print()


# ── Main ────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Uber Eats CLI — delivering to 150 April Rd, Port Moody")
        print()
        print("Commands:")
        print("  set-cookies '<string>'        Save browser cookies")
        print("  orders [--all] [--raw]        Past orders (--all = full history)")
        print("  search <query> [--raw]        Search restaurants")
        print("  store <uuid> [--raw]          Store menu")
        print("  carts [--raw]                 View all carts")
        print("  status [--raw]                Track active orders")
        print("  add <store> <item> [notes]    Add item to cart")
        print("  reorder <order_uuid>          Reorder past order")
        print("  user [--raw]                  Profile")
        sys.exit(1)

    cmd = sys.argv[1]
    raw = "--raw" in sys.argv
    all_pages = "--all" in sys.argv

    if cmd == "set-cookies":
        if len(sys.argv) < 3:
            print("Usage: ue.py set-cookies '<full cookie string>'")
            sys.exit(1)
        save_cookies(sys.argv[2])
        print("✅ Cookies saved")

    elif cmd == "orders":
        data = get_all_orders() if all_pages else get_orders()
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            format_orders(data)

    elif cmd == "search":
        query = " ".join([a for a in sys.argv[2:] if not a.startswith("--")])
        if not query:
            print("Usage: ue.py search <query>")
            sys.exit(1)
        data = search_stores(query)
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False)[:5000])
        else:
            format_search(data)

    elif cmd == "store":
        if len(sys.argv) < 3:
            print("Usage: ue.py store <uuid>")
            sys.exit(1)
        data = get_store(sys.argv[2])
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False)[:10000])
        else:
            format_store_menu(data)

    elif cmd == "carts":
        data = get_carts()
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            format_carts(data)

    elif cmd == "status":
        data = get_active_orders()
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False)[:5000])
        else:
            format_active_orders(data)

    elif cmd == "add":
        # ue.py add <store_uuid> <item1> [qty1] <item2> [qty2] ... [--notes "text"]
        # Notes apply to ALL items. Multiple items in one call = one cart.
        # Example: ue.py add <store> <item1> <item2> 2 <item3> --notes "extra spicy"
        raw_args = sys.argv[2:]
        notes = ""
        if "--notes" in raw_args:
            idx = raw_args.index("--notes")
            if idx + 1 < len(raw_args):
                notes = raw_args[idx + 1]
            raw_args = raw_args[:idx] + raw_args[idx+2:]
        # Remove other flags
        args = [a for a in raw_args if not a.startswith("--")]
        if len(args) < 2:
            print("Usage: ue.py add <store_uuid> <item_uuid> [qty] [item_uuid2] [qty2] ... [--notes 'text']")
            sys.exit(1)
        store_uuid = args[0]
        # Parse remaining args: uuid [qty] uuid [qty] ...
        items = []
        i = 1
        while i < len(args):
            item_uuid = args[i]
            qty = 1
            if i + 1 < len(args):
                try:
                    qty = int(args[i + 1])
                    i += 1
                except ValueError:
                    pass
            item = {"uuid": item_uuid, "quantity": qty}
            if notes:
                item["specialInstructions"] = notes
            items.append(item)
            i += 1
        data = create_cart(store_uuid, items)
        draft_uuid = data.get("data", {}).get("draftOrder", {}).get("uuid", "?")
        item_map = get_store_item_map(store_uuid)
        print(f"✅ Cart created (draft: {draft_uuid})")
        for item in items:
            info = item_map.get(item["uuid"], {})
            name = info.get("title", item["uuid"])
            print(f"   • {name} x{item['quantity']} — ${info.get('price', 0)/100:.2f}")

    elif cmd == "reorder":
        if len(sys.argv) < 3:
            print("Usage: ue.py reorder <order_uuid>")
            sys.exit(1)
        order_uuid = sys.argv[2]
        orders_data = get_orders()
        d = orders_data.get("data", {})
        om = d.get("ordersMap", {})
        if order_uuid not in om:
            print(f"Order {order_uuid} not found in recent orders.")
            sys.exit(1)
        o = om[order_uuid]
        base = o.get("baseEaterOrder", {})
        store_uuid = base.get("storeUuid", "")
        cart = base.get("shoppingCart", {})
        items = []
        for item in cart.get("items", []):
            ci = {"uuid": item.get("uuid", ""), "quantity": item.get("quantity", 1)}
            si = item.get("specialInstructions", "")
            if si:
                ci["specialInstructions"] = si
            items.append(ci)
        if not items:
            print("No items in order.")
            sys.exit(1)
        store_name = resolve_store_name(store_uuid)
        print(f"🔄 Reordering from {store_name}:")
        for item in cart.get("items", []):
            si = item.get("specialInstructions", "")
            label = f"   • {item.get('title', '?')} x{item.get('quantity', 1)}"
            if si:
                label += f" 📝{si}"
            print(label)
        data = create_cart(store_uuid, items)
        draft_uuid = data.get("data", {}).get("draftOrder", {}).get("uuid", "?")
        print(f"\n✅ Cart ready! (draft: {draft_uuid})")

    elif cmd == "user":
        data = get_user()
        if raw:
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            d = data.get("data", data)
            name = d.get("name") or d.get("firstName", "?")
            email = d.get("email") or "?"
            phone = d.get("phoneNumber") or "?"
            print(f"👤 {name}")
            print(f"📧 {email}")
            print(f"📱 {phone}")

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
