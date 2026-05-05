#!/usr/bin/env python3
"""
Amazon.ca order history client.
Uses cookie auth + curl_cffi Chrome impersonation.

Commands:
  set-cookies '<string>'     Save browser cookies
  orders [--all]             List recent orders
  order <order_id>           Order details
  search <query>             Search past orders
"""
import json
import sys
import os
import re
from datetime import datetime

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    print("pip install curl_cffi", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(SCRIPT_DIR, "amazon_cookies.txt")
SESSION_FILE = os.path.join(SCRIPT_DIR, "amazon_session.json")
BASE_URL = "https://www.amazon.ca"


def load_cookies():
    if not os.path.exists(COOKIE_FILE):
        print("No cookies. Run: amazon.py set-cookies '<cookie string>'", file=sys.stderr)
        sys.exit(1)
    with open(COOKIE_FILE) as f:
        return f.read().strip()


def save_cookies(cookie_str):
    with open(COOKIE_FILE, "w") as f:
        f.write(cookie_str.strip())
    print(f"✅ Cookies saved ({len(cookie_str)} chars)")


def fetch(url, cookies=None):
    """Fetch a page using subprocess curl (most reliable) or curl_cffi fallback."""
    if cookies is None:
        cookies = load_cookies()
    
    import subprocess
    
    # Use system curl — more reliable than curl_cffi for Amazon
    try:
        result = subprocess.run(
            ["curl", "-s", "-L", "--compressed",
             "-H", f"Cookie: {cookies}",
             "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
             "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
             "-H", "Accept-Language: en-CA,en-US;q=0.9,en;q=0.8",
             "--connect-timeout", "15",
             "--max-time", "30",
             url],
            capture_output=True, text=True, timeout=35
        )
        if result.returncode == 0 and len(result.stdout) > 1000:
            return result.stdout
    except Exception:
        pass
    
    # Fallback: curl_cffi
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
        "Cookie": cookies,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
    
    resp = curl_requests.get(url, headers=headers, impersonate="chrome131", timeout=30)
    if resp.status_code != 200:
        print(f"Error {resp.status_code}", file=sys.stderr)
        sys.exit(1)
    return resp.text


def parse_orders_page(html):
    """Parse order cards from the order history HTML."""
    orders = []
    
    # Extract product titles from yohtmlc-product-title divs
    # Pattern: <div class="yohtmlc-product-title"> <a ...> PRODUCT NAME </a> </div>
    items = re.findall(
        r'yohtmlc-product-title"[^>]*>\s*<a[^>]*>\s*(.+?)\s*</a>',
        html, re.DOTALL
    )
    items = [re.sub(r'<[^>]+>', '', i).strip() for i in items]  # strip any inner tags
    items = [re.sub(r'\s+', ' ', i).strip() for i in items if i.strip()]
    
    # Extract order totals
    totals = re.findall(r'\$([\d,]+\.\d{2})', html)
    
    # Extract delivery dates
    delivery_dates = re.findall(r'(?:Delivered|Arriving)\s+(\d+\s+\w+)', html, re.IGNORECASE)
    
    # Extract order IDs (701-xxx pattern, skip session-id)
    order_ids = re.findall(r'(701-\d{7}-\d{7})', html)
    order_ids = list(dict.fromkeys(order_ids))  # dedupe
    
    # Extract product links (for ASINs)
    asins = re.findall(r'/dp/([A-Z0-9]{10})', html)
    asins = list(dict.fromkeys(asins))
    
    # Build order list with items grouped by order
    # Split HTML by order blocks
    order_blocks = re.split(r'(?=order-card)', html, flags=re.IGNORECASE)
    
    # Simple approach: list items with their totals
    for i, oid in enumerate(order_ids):
        order = {
            "order_id": oid,
            "delivery": delivery_dates[i] if i < len(delivery_dates) else "?",
            "total": totals[i] if i < len(totals) else "?",
        }
        orders.append(order)
    
    return orders, items, asins


def cmd_orders(fetch_all=False):
    """Fetch order history."""
    url = f"{BASE_URL}/gp/your-account/order-history?orderFilter=year-2026"
    html = fetch(url)
    
    # Check if we're logged in
    if 'ap_email' in html or 'sign-in' in html.lower() and 'order' not in html.lower():
        print("❌ Not logged in — cookies may be expired", file=sys.stderr)
        sys.exit(1)
    
    orders, items, asins = parse_orders_page(html)
    
    if not orders and not items:
        print("No orders found or not logged in.")
        debug_file = os.path.join(SCRIPT_DIR, "debug_orders.html")
        with open(debug_file, "w") as f:
            f.write(html)
        print(f"   Debug HTML saved to {debug_file}", file=sys.stderr)
        return
    
    # Print items with order info
    print(f"📦 Amazon Orders (2026) — {len(orders)} orders, {len(items)} items\n")
    
    for item in items:
        print(f"  • {item[:80]}")
    
    print(f"\n💰 Order Totals:")
    for o in orders:
        print(f"  {o['order_id']} — ${o['total']} ({o['delivery']})")
    
    if fetch_all:
        next_pages = re.findall(r'orderFilter=year-\d{4}&startIndex=(\d+)', html)
        for start in next_pages[:5]:
            url = f"{BASE_URL}/gp/your-account/order-history?orderFilter=year-2026&startIndex={start}"
            more_html = fetch(url)
            more_orders, more_items, _ = parse_orders_page(more_html)
            for item in more_items:
                print(f"  • {item[:80]}")
            for o in more_orders:
                print(f"  {o['order_id']} — ${o['total']} ({o['delivery']})")


def cmd_search_orders(query):
    """Search past orders."""
    url = f"{BASE_URL}/gp/your-account/order-history?search={query.replace(' ', '+')}"
    html = fetch(url)
    orders, items, _ = parse_orders_page(html)
    
    if not orders and not items:
        print(f"No orders matching '{query}'")
        return
    
    for item in items:
        print(f"  • {item[:80]}")
    
    for o in orders:
        print(f"  {o['order_id']} — ${o['total']} ({o['delivery']})")


def parse_search_results(html):
    """Parse Amazon catalog search results."""
    results = []
    
    # Find all search result blocks by ASIN
    asins = re.findall(r'data-asin="([A-Z0-9]{10})"', html)
    seen = set()
    unique_asins = []
    for a in asins:
        if a not in seen and len(a) == 10:
            seen.add(a)
            unique_asins.append(a)
    
    for asin in unique_asins:
        # Find the block for this ASIN
        pattern = rf'data-asin="{asin}"(.*?)(?=data-asin="|$)'
        match = re.search(pattern, html, re.DOTALL)
        if not match:
            continue
        block = match.group(1)
        
        # Title - multiple patterns
        title = ""
        for tp in [
            r'<span[^>]*class="a-size-medium[^"]*a-text-normal"[^>]*>([^<]+)',
            r'<span[^>]*class="a-size-base-plus[^"]*a-text-normal"[^>]*>([^<]+)',
            r'<h2[^>]*>.*?<span>([^<]+)</span>',
            r'aria-label="([^"]{15,200})"',
        ]:
            m = re.search(tp, block, re.DOTALL)
            if m:
                title = re.sub(r'\s+', ' ', m.group(1)).strip()
                if len(title) > 15:
                    break
        
        if not title or len(title) < 10:
            continue
        
        # Price - whole + fraction
        price = ""
        price_match = re.search(r'<span class="a-offscreen">\$([\d,]+\.\d{2})</span>', block)
        if price_match:
            price = price_match.group(1)
        else:
            whole = re.search(r'<span class="a-price-whole">(\d+)', block)
            frac = re.search(r'<span class="a-price-fraction">(\d+)', block)
            if whole:
                price = f"{whole.group(1)}.{frac.group(1) if frac else '00'}"
        
        # Rating
        rating = ""
        rating_match = re.search(r'(\d+\.?\d*) out of 5 stars', block)
        if rating_match:
            rating = rating_match.group(1)
        
        # Review count
        reviews = ""
        reviews_match = re.search(r'aria-label="([\d,]+)"[^>]*>\s*<span[^>]*>([\d,]+)', block)
        if not reviews_match:
            reviews_match = re.search(r'<span[^>]*class="[^"]*s-underline-text"[^>]*>([\d,]+)', block)
        if reviews_match:
            reviews = reviews_match.group(1)
        
        # Prime
        is_prime = 'a-icon-prime' in block or 'FREE delivery' in block
        
        # Delivery estimate
        delivery = ""
        del_match = re.search(r'(FREE delivery[^<]*|Get it[^<]*|Arrives[^<]*)', block, re.IGNORECASE)
        if del_match:
            delivery = re.sub(r'\s+', ' ', del_match.group(1)).strip()
        
        # Coupon
        coupon = ""
        coupon_match = re.search(r'Save\s+(\d+%?\s*(?:with coupon)?)', block, re.IGNORECASE)
        if coupon_match:
            coupon = coupon_match.group(1).strip()
        
        results.append({
            "asin": asin,
            "title": title[:120],
            "price": price,
            "rating": rating,
            "reviews": reviews,
            "prime": is_prime,
            "delivery": delivery[:60],
            "coupon": coupon,
            "url": f"https://www.amazon.ca/dp/{asin}",
        })
    
    return results


def cmd_search(query, as_json=False):
    """Search Amazon catalog with authenticated session."""
    encoded = query.replace(' ', '+')
    url = f"{BASE_URL}/s?k={encoded}"
    html = fetch(url)
    
    # Check for actual captcha block (not just the word appearing in boilerplate)
    if ('captcha' in html.lower() and 'data-asin' not in html) or len(html) < 5000:
        print("⚠️  Amazon is showing a captcha — try again in a minute", file=sys.stderr)
        sys.exit(1)
    
    results = parse_search_results(html)
    
    if not results:
        # Save debug
        debug_file = os.path.join(SCRIPT_DIR, "debug_search.html")
        with open(debug_file, "w") as f:
            f.write(html)
        print(f"No results found for '{query}'")
        print(f"Debug HTML saved to {debug_file}", file=sys.stderr)
        return
    
    if as_json:
        print(json.dumps(results, indent=2))
        return
    
    print(f"🔍 Amazon Search: \"{query}\" — {len(results)} results\n")
    for r in results:
        prime = " 🟦Prime" if r['prime'] else ""
        rating = f" ⭐{r['rating']}" if r['rating'] else ""
        reviews = f" ({r['reviews']} reviews)" if r['reviews'] else ""
        coupon = f" 🏷️{r['coupon']}" if r['coupon'] else ""
        delivery = f"\n     📦 {r['delivery']}" if r['delivery'] else ""
        
        print(f"  ${r['price'] or '?':>8}  {r['title']}")
        print(f"     {rating}{reviews}{prime}{coupon}{delivery}")
        print(f"     {r['url']}")
        print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    
    cmd = sys.argv[1]
    
    if cmd == "set-cookies":
        if len(sys.argv) < 3:
            print("Usage: amazon.py set-cookies '<cookie string>'")
            sys.exit(1)
        save_cookies(sys.argv[2])
    
    elif cmd == "orders":
        fetch_all = "--all" in sys.argv
        cmd_orders(fetch_all)
    
    elif cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: amazon.py search <query>")
            sys.exit(1)
        as_json = "--json" in sys.argv
        query_args = [a for a in sys.argv[2:] if a != "--json"]
        cmd_search(" ".join(query_args), as_json=as_json)
    
    elif cmd == "search-orders":
        if len(sys.argv) < 3:
            print("Usage: amazon.py search-orders <query>")
            sys.exit(1)
        cmd_search_orders(" ".join(sys.argv[2:]))
    
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
