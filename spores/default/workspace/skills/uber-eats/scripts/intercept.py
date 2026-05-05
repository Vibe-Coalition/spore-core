#!/usr/bin/env python3
"""
Intercept Uber Eats API calls using zendriver with pre-loaded cookies.
"""
import asyncio
import json
import sys
import os

sys.path.insert(0, "/root/.openclaw/workspace/.venv/lib/python3.11/site-packages")

import zendriver as zd

COOKIE_FILE = os.path.join(os.path.dirname(__file__), "ue_cookies.txt")

async def main():
    # Load cookies
    with open(COOKIE_FILE) as f:
        cookie_str = f.read().strip()
    
    browser = await zd.start(headless=True)
    page = await browser.get("about:blank")
    
    # Set cookies on ubereats.com domain
    # First navigate to ubereats to set domain
    await page.get("https://www.ubereats.com")
    await asyncio.sleep(3)
    
    # Parse and set cookies
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            k, v = k.strip(), v.strip()
            try:
                await page.send(zd.cdp.network.set_cookie(
                    name=k, value=v, domain=".ubereats.com", path="/"
                ))
            except:
                pass
    
    # Capture network requests
    captured = []
    
    async def on_request(event):
        url = str(event.request.url)
        if "_p/api/" in url or "graphql" in url:
            captured.append({
                "url": url,
                "method": event.request.method,
                "headers": dict(event.request.headers) if event.request.headers else {},
                "post_data": event.request.post_data if hasattr(event.request, 'post_data') else None,
            })
    
    page.add_handler(zd.cdp.network.RequestWillBeSent, on_request)
    await page.send(zd.cdp.network.enable())
    
    # Navigate to orders page
    await page.get("https://www.ubereats.com/orders")
    await asyncio.sleep(10)
    
    # Print captured API calls
    print(f"\n=== Captured {len(captured)} API calls ===\n")
    for req in captured:
        print(f"[{req['method']}] {req['url']}")
        if req.get('post_data'):
            try:
                pd = json.loads(req['post_data'])
                print(f"  Payload: {json.dumps(pd, indent=2)[:500]}")
            except:
                print(f"  Payload: {str(req['post_data'])[:500]}")
        # Print key headers
        for h in ['x-csrf-token', 'cookie', 'authorization', 'x-uber-source']:
            if h in req.get('headers', {}):
                val = req['headers'][h]
                if h == 'cookie':
                    val = val[:100] + "..."
                print(f"  {h}: {val}")
        print()
    
    # Also get page content
    title = await page.evaluate("document.title")
    print(f"Page title: {title}")
    
    # Check if logged in
    body_text = await page.evaluate("document.body?.innerText?.substring(0, 500)")
    print(f"\nPage text preview:\n{body_text}")
    
    await browser.stop()

asyncio.run(main())
