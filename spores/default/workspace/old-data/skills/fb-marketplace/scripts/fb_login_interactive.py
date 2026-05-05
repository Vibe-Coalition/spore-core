#!/usr/bin/env python3
"""
Interactive Facebook login — opens a browser with VNC access so user can solve CAPTCHA.
After login completes, extracts cookies automatically.

Usage:
    python3 fb_login_interactive.py          # Start browser, wait for login
    python3 fb_login_interactive.py --grab   # Just grab cookies from running browser
"""

import asyncio
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
CREDS_FILE = SCRIPT_DIR / "fb_creds.json"
COOKIES_FILE = SCRIPT_DIR / "fbm_cookies.txt"


async def start_interactive():
    import zendriver as zd

    creds = None
    try:
        with open(CREDS_FILE) as f:
            creds = json.load(f)
    except:
        pass

    print("🖥️  Starting browser (NOT headless — VNC required)...")
    print("   Connect via VNC to see the browser.")
    print()

    browser = await zd.start(
        headless=False,
        sandbox=False,
        browser_executable_path="/usr/bin/google-chrome-stable",
        user_data_dir="/tmp/fb_chrome_profile",
        browser_args=[
            "--window-size=1280,900",
        ],
    )

    page = await browser.get("https://www.facebook.com/login")
    await asyncio.sleep(3)

    # Pre-fill credentials if available
    if creds:
        print("✏️  Pre-filling credentials...")
        email_el = await page.query_selector('input[name="email"]')
        if not email_el:
            email_el = await page.query_selector("#email")
        if email_el:
            await email_el.click()
            await asyncio.sleep(0.3)
            for c in creds["email"]:
                await email_el.send_keys(c)
                await asyncio.sleep(0.04)

        await asyncio.sleep(0.5)

        pass_el = await page.query_selector('input[name="pass"]')
        if not pass_el:
            pass_el = await page.query_selector("#pass")
        if pass_el:
            await pass_el.click()
            await asyncio.sleep(0.3)
            for c in creds["password"]:
                await pass_el.send_keys(c)
                await asyncio.sleep(0.04)

    print()
    print("👆 Complete the login in the browser (solve CAPTCHA if needed).")
    print("   Waiting for login to complete...")
    print()

    # Poll for successful login
    for i in range(120):  # Wait up to 2 minutes
        await asyncio.sleep(2)
        try:
            url = await page.evaluate("window.location.href")
            # Login successful if we're past login/checkpoint pages
            if (
                "facebook.com" in url
                and "/login" not in url
                and "checkpoint" not in url
                and "two_step" not in url
            ):
                print(f"✅ Login detected! URL: {url}")
                break
        except:
            pass
    else:
        print("⏰ Timeout — login not completed in 2 minutes.")
        await browser.stop()
        return False

    # Extract cookies
    print("🍪 Extracting cookies...")
    cdp_cookies = await page.send(zd.cdp.network.get_cookies())

    cookie_parts = []
    required = {"c_user", "xs", "datr", "sb", "fr"}
    found = set()

    for cookie in cdp_cookies:
        if "facebook.com" in cookie.domain:
            cookie_parts.append(f"{cookie.name}={cookie.value}")
            if cookie.name in required:
                found.add(cookie.name)

    cookie_string = "; ".join(cookie_parts)
    with open(COOKIES_FILE, "w") as f:
        f.write(cookie_string)

    print(f"✅ Saved {len(cookie_parts)} cookies ({len(found)}/{len(required)} required)")
    print(f"   Found: {', '.join(sorted(found))}")

    await browser.stop()
    return True


async def grab_from_cdp(port=9222):
    """Connect to existing Chrome debug port and grab cookies."""
    import zendriver as zd

    print(f"🔌 Connecting to Chrome on port {port}...")
    browser = await zd.start(host="127.0.0.1", port=port)

    pages = await browser.get_tabs()
    if not pages:
        print("❌ No pages found")
        return False

    page = pages[0]
    url = await page.evaluate("window.location.href")
    print(f"📍 Current URL: {url}")

    cdp_cookies = await page.send(zd.cdp.network.get_cookies())
    cookie_parts = []
    required = {"c_user", "xs", "datr", "sb", "fr"}
    found = set()

    for cookie in cdp_cookies:
        if "facebook.com" in cookie.domain:
            cookie_parts.append(f"{cookie.name}={cookie.value}")
            if cookie.name in required:
                found.add(cookie.name)

    if not found.intersection({"c_user", "xs"}):
        print("❌ Not logged in (missing c_user/xs)")
        return False

    cookie_string = "; ".join(cookie_parts)
    with open(COOKIES_FILE, "w") as f:
        f.write(cookie_string)

    print(f"✅ Saved {len(cookie_parts)} cookies ({len(found)}/{len(required)} required)")
    return True


if __name__ == "__main__":
    if "--grab" in sys.argv:
        asyncio.run(grab_from_cdp())
    else:
        result = asyncio.run(start_interactive())
        if result:
            print("\n🎉 Facebook cookies refreshed successfully!")
        else:
            print("\n❌ Failed to get cookies.")
            sys.exit(1)
