#!/usr/bin/env python3
"""Click into a specific cart, find edit/delete buttons."""
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

    # Navigate to home, click cart, then click into one of the carts
    await page.get("https://www.ubereats.com")
    await asyncio.sleep(5)

    # Click cart button
    await page.evaluate("""
        (() => {
            const btn = document.querySelector('[aria-label="2 carts"]');
            if (btn) btn.click();
        })()
    """)
    await asyncio.sleep(2)

    # Now click on the "We Grill Korean Eatery" cart entry to navigate to it
    clicked = await page.evaluate("""
        (() => {
            // Find links/clickable elements containing cart store names
            const els = document.querySelectorAll('a, div[role="button"], [data-testid]');
            for (const el of els) {
                const text = el.innerText || '';
                if (text.includes('Xpress Donair')) {
                    el.click();
                    return 'clicked Xpress Donair link';
                }
            }
            // Try finding by text content
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
                if (el.children.length === 0) continue;
                const text = el.innerText?.trim() || '';
                if (text.startsWith('Xpress Donair') && el.tagName !== 'BODY') {
                    // Click closest clickable ancestor
                    const link = el.closest('a') || el.closest('[role="button"]') || el;
                    link.click();
                    return 'clicked via text search: ' + link.tagName;
                }
            }
            return 'not found';
        })()
    """)
    print(f"Click result: {clicked}")
    await asyncio.sleep(8)

    # Check current URL
    url = await page.evaluate("window.location.href")
    print(f"Current URL: {url}")

    text = await page.evaluate("document.body?.innerText?.substring(0, 3000)")
    print(f"\n=== PAGE TEXT ===\n{text[:2000]}")

    # Find all buttons
    buttons = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('button, [role="button"]').forEach(el => {
                const text = el.innerText?.trim() || '';
                const aria = el.getAttribute('aria-label') || '';
                const testid = el.getAttribute('data-testid') || '';
                if (text || aria || testid) {
                    results.push({text: text.substring(0, 60), aria, testid});
                }
            });
            return results;
        })()
    """)
    
    print("\n=== BUTTONS ===")
    for b in buttons:
        parts = [b['text']]
        if b['aria']: parts.append(f"aria={b['aria']}")
        if b['testid']: parts.append(f"testid={b['testid']}")
        print(f"  {' | '.join(parts)}")

    print(f"\n=== API CALLS (last 15) ===")
    for req in captured[-15:]:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"][-60:]
        pd = ""
        if req.get("post_data"):
            pd = f" → {str(req['post_data'])[:100]}"
        print(f"  [{req['method']}] {ep}{pd}")

    await browser.stop()

asyncio.run(main())
