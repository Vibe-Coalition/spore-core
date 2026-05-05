#!/usr/bin/env python3
"""Intercept cart deletion flow via zendriver."""
import asyncio, json, sys, os
sys.path.insert(0, "/root/.openclaw/workspace/.venv/lib/python3.11/site-packages")
import zendriver as zd

COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ue_cookies.txt")

async def main():
    browser = await zd.start(headless=True)
    page = await browser.get("https://www.ubereats.com")
    await asyncio.sleep(2)

    # Load cookies
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

    # Set up network capture
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

    # Navigate to the store page that has the cart
    # Xpress Donair House Coquitlam
    await page.get("https://www.ubereats.com/ca/store/xpress-donair-house-coquitlam/Cvv5I_5RShS0dW9PSUMPaA")
    await asyncio.sleep(8)

    text = await page.evaluate("document.body?.innerText?.substring(0, 2000)")
    print("=== PAGE TEXT ===")
    print(text[:1500])
    print()

    # Find all buttons/clickable elements with cart-related text
    buttons = await page.evaluate("""
        (() => {
            const results = [];
            // Find buttons
            document.querySelectorAll('button, [role="button"], a').forEach(el => {
                const text = el.innerText?.trim() || el.getAttribute('aria-label') || '';
                if (text && text.length < 100) {
                    results.push({tag: el.tagName, text: text, id: el.id, classes: el.className?.substring?.(0, 80) || ''});
                }
            });
            return results;
        })()
    """)
    
    print("=== ALL BUTTONS ===")
    for b in buttons:
        print(f"  [{b['tag']}] {b['text'][:60]}")
    print()

    # Look for trash/delete/remove/clear icons or buttons
    delete_els = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('[aria-label*="emove"], [aria-label*="elete"], [aria-label*="lear"], [aria-label*="rash"], [data-testid*="remove"], [data-testid*="delete"], [data-testid*="trash"]').forEach(el => {
                results.push({tag: el.tagName, text: el.innerText?.trim()?.substring(0, 50), aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid')});
            });
            return results;
        })()
    """)
    
    print("=== DELETE-LIKE ELEMENTS ===")
    for el in delete_els:
        print(f"  [{el['tag']}] text={el['text']} aria={el['aria']} testid={el['testid']}")

    print(f"\n=== CAPTURED {len(captured)} API CALLS ===")
    for req in captured:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"]
        print(f"  [{req['method']}] {ep}")

    await browser.stop()

asyncio.run(main())
