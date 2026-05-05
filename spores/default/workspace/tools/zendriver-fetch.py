#!/usr/bin/env python3
"""
Zendriver-based web fetcher — renders JS, bypasses anti-bot.
Usage: python3 zendriver-fetch.py <url> [max_chars]
"""
import sys
import re
import asyncio
import zendriver as uc

async def fetch(url: str, max_chars: int = 8000):
    conf = uc.Config(sandbox=False, headless=True, browser_executable_path="/usr/bin/chromium")
    browser = await uc.start(config=conf)
    try:
        page = await browser.get(url)
        await asyncio.sleep(4)
        content = await page.get_content()
        # Strip tags, clean up
        text = re.sub(r"<script[^>]*>.*?</script>", "", content, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        print(text[:max_chars])
    finally:
        await browser.stop()

if __name__ == "__main__":
    url = sys.argv[1]
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    asyncio.run(fetch(url, max_chars))