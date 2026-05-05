#!/usr/bin/env python3
"""Click a menu item and intercept the add-to-cart API call."""
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

    # Go to store page directly
    await page.get("https://www.ubereats.com/ca/store/grab-and-go-persian-restaurant/K_7V3vDcSh6cU5rwb48FmQ?diningMode=DELIVERY")
    await asyncio.sleep(6)

    # Click on Kubideh item to open the item modal
    clicked = await page.evaluate("""
        (() => {
            const el = document.querySelector('[data-testid="store-item-83e24f3e-3f42-4d08-905f-05a3f515113d"]');
            if (el) { el.click(); return 'clicked Kubideh'; }
            // Fallback
            const items = document.querySelectorAll('[data-testid^="store-item-"]');
            for (const item of items) {
                if (item.innerText?.includes('Kubideh Kebob')) {
                    item.click();
                    return 'clicked via text: ' + item.getAttribute('data-testid');
                }
            }
            return 'not found';
        })()
    """)
    print(f"Item click: {clicked}")
    await asyncio.sleep(3)

    # Now look for Add to Cart button and modal content
    modal = await page.evaluate("""
        (() => {
            const results = {};
            // Find modal/dialog
            const dialog = document.querySelector('[role="dialog"], [data-testid*="modal"], [data-testid*="dialog"]');
            if (dialog) {
                results.dialog = dialog.innerText?.substring(0, 500);
            }
            // Find all buttons in potential modal
            const btns = [];
            document.querySelectorAll('button').forEach(el => {
                const text = el.innerText?.trim() || '';
                const aria = el.getAttribute('aria-label') || '';
                const testid = el.getAttribute('data-testid') || '';
                if (text.includes('Add') || text.includes('cart') || text.includes('Cart') || 
                    aria.includes('Add') || testid.includes('add') || testid.includes('cart')) {
                    btns.push({text: text.substring(0, 80), aria, testid});
                }
            });
            results.buttons = btns;
            return results;
        })()
    """)
    print(f"\nModal: {json.dumps(modal, indent=2)[:1500]}")

    # Now set up capture and click "Add to order/cart"
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

    # Click the add to cart/order button
    add_result = await page.evaluate("""
        (() => {
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                const text = btn.innerText?.trim() || '';
                if (text.includes('Add to order') || text.includes('Add 1 to order') || 
                    text.includes('Add to cart') || text.includes('Add 1')) {
                    btn.click();
                    return 'clicked: ' + text;
                }
            }
            // Try testid
            const addBtn = document.querySelector('[data-testid*="add-to-cart"], [data-testid*="add-to-order"]');
            if (addBtn) {
                addBtn.click();
                return 'clicked testid: ' + addBtn.getAttribute('data-testid');
            }
            return 'no add button found';
        })()
    """)
    print(f"\nAdd click: {add_result}")
    await asyncio.sleep(5)

    # Show ALL captured API calls
    print(f"\n=== CAPTURED {len(captured)} API CALLS ===")
    for req in captured:
        ep = req["url"].split("/api/")[1] if "/api/" in req["url"] else req["url"]
        print(f"  {ep}")
        if req.get("post_data"):
            print(f"    {str(req['post_data'])[:500]}")

    await browser.stop()

asyncio.run(main())
