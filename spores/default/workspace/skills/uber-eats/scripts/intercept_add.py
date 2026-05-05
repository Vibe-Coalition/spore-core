#!/usr/bin/env python3
"""Intercept the add-to-cart flow on a live store page."""
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
        if "_p/api/" in url:
            captured.append({
                "url": url,
                "post_data": getattr(event.request, "post_data", None),
            })

    page.add_handler(zd.cdp.network.RequestWillBeSent, on_req)
    await page.send(zd.cdp.network.enable())

    # Search for Grab and Go and click it
    await page.get("https://www.ubereats.com/ca/search?q=Grab+and+Go+Persian")
    await asyncio.sleep(8)

    text = await page.evaluate("document.body?.innerText?.substring(0, 500)")
    print(f"Search page: {text[:200]}")

    # Click on Grab and Go result
    clicked = await page.evaluate("""
        (() => {
            const links = document.querySelectorAll('a');
            for (const a of links) {
                if (a.innerText?.includes('Grab and Go')) {
                    a.click();
                    return 'clicked: ' + a.href;
                }
            }
            return 'not found';
        })()
    """)
    print(f"Click: {clicked}")
    await asyncio.sleep(8)

    url = await page.evaluate("window.location.href")
    title = await page.evaluate("document.title")
    print(f"URL: {url}")
    print(f"Title: {title}")

    text = await page.evaluate("document.body?.innerText?.substring(0, 1000)")
    print(f"\nPage: {text[:500]}")

    # Find menu items with + buttons
    items = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('[data-testid*="menu-item"], [data-testid*="store-item"], li, article').forEach(el => {
                const text = el.innerText?.trim()?.substring(0, 80) || '';
                if (text.includes('Kubideh') || text.includes('Joujeh')) {
                    results.push({text, testid: el.getAttribute('data-testid') || '', tag: el.tagName});
                }
            });
            // Also find + or Add buttons
            document.querySelectorAll('button').forEach(el => {
                const text = el.innerText?.trim() || '';
                const aria = el.getAttribute('aria-label') || '';
                if (text === '+' || text.includes('Add to cart') || aria.includes('Add') || aria.includes('Kubideh') || aria.includes('Joujeh')) {
                    results.push({text: text.substring(0, 50), aria, testid: el.getAttribute('data-testid') || '', tag: 'BUTTON'});
                }
            });
            return results;
        })()
    """)
    print(f"\nMenu items/buttons: {json.dumps(items, indent=2)[:2000]}")

    # Print API calls
    for req in captured:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"]
        if "store" in ep.lower() or "cart" in ep.lower() or "add" in ep.lower() or "item" in ep.lower():
            print(f"\nAPI: {ep}")
            if req.get("post_data"):
                print(f"  {str(req['post_data'])[:300]}")

    await browser.stop()

asyncio.run(main())
