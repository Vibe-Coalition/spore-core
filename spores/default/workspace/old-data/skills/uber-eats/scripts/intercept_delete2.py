#!/usr/bin/env python3
"""Click cart button, find delete flow."""
import asyncio, json, sys, os
sys.path.insert(0, "/root/.openclaw/workspace/.venv/lib/python3.11/site-packages")
import zendriver as zd

COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ue_cookies.txt")

async def main():
    browser = await zd.start(headless=True)
    page = await browser.get("https://www.ubereats.com")
    await asyncio.sleep(2)

    with open(COOKIE_FILE) as f:
        cookies = f.read().strip()
    for part in cookies.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                await page.send(zd.cdp.network.set_cookie(
                    name=k.strip(), value=v.strip(), domain=".ubereats.com", path="/"))
            except:
                pass

    captured = []
    async def on_req(event):
        url = str(event.request.url)
        if "_p/api/" in url or "graphql" in url.lower():
            captured.append({
                "url": url,
                "method": event.request.method,
                "post_data": getattr(event.request, "post_data", None),
            })

    page.add_handler(zd.cdp.network.RequestWillBeSent, on_req)
    await page.send(zd.cdp.network.enable())

    # Go to home page (logged in)
    await page.get("https://www.ubereats.com")
    await asyncio.sleep(5)
    
    # Click the cart button (shows "2")
    print("=== Clicking cart button ===")
    clicked = await page.evaluate("""
        (() => {
            // Find button with text "2" that's the cart
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                const text = btn.innerText?.trim();
                if (text === '2' && btn.offsetWidth < 100) {
                    btn.click();
                    return 'clicked cart button with text 2';
                }
            }
            // Try aria-label approach
            const cart = document.querySelector('[aria-label*="cart"], [aria-label*="Cart"], [data-testid*="cart"]');
            if (cart) {
                cart.click();
                return 'clicked via aria/testid: ' + (cart.getAttribute('aria-label') || cart.getAttribute('data-testid'));
            }
            return 'not found';
        })()
    """)
    print(f"  Result: {clicked}")
    await asyncio.sleep(3)

    # Check what appeared
    text = await page.evaluate("document.body?.innerText?.substring(0, 3000)")
    print("\n=== PAGE TEXT AFTER CART CLICK ===")
    print(text[:2000])

    # Find all interactive elements now
    buttons = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('button, [role="button"]').forEach(el => {
                const text = el.innerText?.trim() || '';
                const aria = el.getAttribute('aria-label') || '';
                const testid = el.getAttribute('data-testid') || '';
                if ((text || aria || testid) && text.length < 100) {
                    results.push({text, aria, testid, tag: el.tagName});
                }
            });
            return results;
        })()
    """)
    
    print("\n=== BUTTONS AFTER CART CLICK ===")
    for b in buttons:
        extra = []
        if b['aria']: extra.append(f"aria={b['aria']}")
        if b['testid']: extra.append(f"testid={b['testid']}")
        extras = f" ({', '.join(extra)})" if extra else ""
        print(f"  [{b['tag']}] {b['text'][:60]}{extras}")

    # Look for delete/remove/trash SVG icons or hidden elements
    icons = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('svg, [class*="trash"], [class*="delete"], [class*="remove"]').forEach(el => {
                const parent = el.parentElement;
                const pText = parent?.innerText?.trim()?.substring(0, 30) || '';
                const pAria = parent?.getAttribute('aria-label') || '';
                const pTestid = parent?.getAttribute('data-testid') || '';
                if (pAria || pTestid || el.getAttribute('data-testid') || el.getAttribute('aria-label')) {
                    results.push({tag: el.tagName, pText, pAria, pTestid, aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid')});
                }
            });
            return results;
        })()
    """)
    print("\n=== SVG/DELETE ICONS ===")
    for i in icons[:20]:
        print(f"  {i}")

    print(f"\n=== NEW API CALLS ({len(captured)}) ===")
    for req in captured[-10:]:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"]
        print(f"  [{req['method']}] {ep}")

    await browser.stop()

asyncio.run(main())
