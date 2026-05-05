#!/usr/bin/env python3
"""Find the place order endpoint by navigating to checkout."""
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

    # Go to checkout page
    await page.get("https://www.ubereats.com/ca/checkout?draftOrderUUID=83192e48-de4e-4dc8-992c-b93bccd52eec")
    await asyncio.sleep(8)

    url = await page.evaluate("window.location.href")
    print(f"URL: {url}")

    text = await page.evaluate("document.body?.innerText?.substring(0, 2000)")
    print(f"\n{text[:1500]}")

    # Find the place order button
    buttons = await page.evaluate("""
        (() => {
            const results = [];
            document.querySelectorAll('button, [role="button"]').forEach(el => {
                const text = el.innerText?.trim() || '';
                const testid = el.getAttribute('data-testid') || '';
                if (text.length > 0 && text.length < 100) {
                    results.push({text, testid, disabled: el.disabled});
                }
            });
            return results;
        })()
    """)
    print("\n=== BUTTONS ===")
    for b in buttons:
        extra = []
        if b.get('testid'): extra.append(f"testid={b['testid']}")
        if b.get('disabled'): extra.append("DISABLED")
        print(f"  [{', '.join(extra)}] {b['text'][:60]}")

    print(f"\n=== API CALLS ({len(captured)}) ===")
    for req in captured:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"][-60:]
        print(f"  {ep}")

    await browser.stop()

asyncio.run(main())
