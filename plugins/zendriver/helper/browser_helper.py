#!/usr/bin/env python3
import asyncio
import base64
import glob
import json
import os
import pathlib
import shutil
import sys
import tempfile

# Cached snapshot JS payload — loaded lazily on first snapshot call so
# the helper's startup cost stays cheap (most sessions won't snapshot).
_SNAPSHOT_JS = None


def env_float(name, default, minimum=0.1):
    try:
        value = float(os.environ.get(name, default))
    except Exception:
        return default
    return value if value >= minimum else default


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def json_safe(value):
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


class ZendriverSession:
    def __init__(self):
        self.zd = None
        self.import_error = None
        self.browser = None
        self.tab = None
        self.width = 1280
        self.height = 720
        self.user_data_dir = None
        self.preview_task = None
        self.executable_path = None
        self.frame_interval = max(0.25, float(os.environ.get("SPORE_ZENDRIVER_FRAME_INTERVAL", "1.0")))
        self._frame_lock = asyncio.Lock()
        self._last_frame_error = None
        self.default_timeout = env_float("SPORE_ZENDRIVER_ACTION_TIMEOUT_SECONDS", 20.0)
        self.navigation_timeout = env_float("SPORE_ZENDRIVER_NAVIGATION_TIMEOUT_SECONDS", 25.0)
        self.launch_timeout = env_float("SPORE_ZENDRIVER_LAUNCH_TIMEOUT_SECONDS", 30.0)
        try:
            import zendriver as zd

            self.zd = zd
        except Exception as exc:
            self.import_error = exc

    async def handle(self, payload):
        action = str(payload.get("action") or "").lower()
        try:
            return await asyncio.wait_for(
                self._handle_action(action, payload),
                timeout=self._timeout_for(action),
            )
        except asyncio.TimeoutError:
            try:
                return await self._handle_timeout(action, payload)
            except Exception as exc:
                return {"error": f"Zendriver {action} timed out and recovery failed: {exc}"}
        except Exception as exc:
            return {"error": str(exc)}

    async def _handle_action(self, action, payload):
        try:
            if action == "launch":
                return await self.launch(payload)
            if action == "navigate":
                return await self.navigate(payload)
            if action == "click":
                return await self.click(payload)
            if action == "type":
                return await self.type_text(payload)
            if action == "screenshot":
                return await self.screenshot(payload)
            if action == "scroll":
                return await self.scroll(payload)
            if action == "evaluate":
                return await self.evaluate(payload)
            if action == "tab_open":
                return await self.tab_open(payload)
            if action == "tab_list":
                return await self.tab_list(payload)
            if action == "tab_switch":
                return await self.tab_switch(payload)
            if action == "tab_close":
                return await self.tab_close(payload)
            if action == "snapshot":
                return await self.snapshot(payload)
            if action == "status":
                return await self.status()
            if action == "close":
                return await self.close()
            if action == "shutdown":
                result = await self.close()
                result["shutdown"] = True
                return result
            return {"error": f"Unknown Zendriver helper action: {action}"}
        except Exception:
            raise

    def _timeout_for(self, action):
        if action == "launch":
            return self.launch_timeout
        if action in ("navigate", "tab_open"):
            return self.navigation_timeout
        if action in ("status", "tab_list"):
            return 5.0
        if action in ("close", "shutdown"):
            return 10.0
        if action in ("screenshot", "snapshot", "evaluate", "click", "type", "scroll", "tab_switch", "tab_close"):
            return self.default_timeout
        return self.default_timeout

    async def _handle_timeout(self, action, payload=None):
        payload = payload or {}
        timeout = self._timeout_for(action)
        emit({"event": "log", "level": "warn", "message": f"Zendriver {action} timed out after {timeout:.0f}s"})
        if action in ("launch", "navigate", "tab_open") and self.browser:
            await self._stop_loading_after_timeout()
            summary = await self._safe_summary()
            if self.tab:
                result = {
                    "status": f"{action}_timeout",
                    "warning": f"Zendriver {action} timed out after {timeout:.0f}s; returned the partially loaded page.",
                    "preview": "stream",
                    "screencast": False,
                }
                if payload.get("url"):
                    result["requested_url"] = payload.get("url")
                result.update(summary)
                try:
                    await asyncio.wait_for(self._frame_event(), timeout=3.0)
                except Exception:
                    pass
                return result
        if action == "launch":
            await self._force_close_after_timeout()
        return {"error": f"Zendriver {action} timed out after {timeout:.0f}s."}

    async def _stop_loading_after_timeout(self):
        if not self.tab:
            return
        for script in ("window.stop()", "document.readyState"):
            try:
                await asyncio.wait_for(self.tab.evaluate(script), timeout=2.0)
                return
            except Exception:
                continue

    async def _safe_summary(self):
        async def collect():
            return {
                "url": await self._url(),
                "title": await self._title(),
            }
        try:
            return await asyncio.wait_for(collect(), timeout=3.0)
        except Exception:
            return {"url": None, "title": None}

    async def _force_close_after_timeout(self):
        await self._stop_preview_loop()
        if self.browser:
            try:
                await asyncio.wait_for(self.browser.stop(), timeout=5.0)
            except Exception:
                pass
        self.browser = None
        self.tab = None
        self.executable_path = None
        self._cleanup_user_data_dir()
        emit({"event": "closed"})

    def _detect_browser_executable(self):
        # Order matters: prefer full Chrome/Chromium (real surface area
        # for zendriver's stealth patches), then full Playwright
        # Chromium. We DO NOT fall back to chrome-headless-shell — it
        # identifies as `HeadlessChrome/...` in the User-Agent, exposes
        # navigator.webdriver=true, has no plugins/extensions surface,
        # and was built for perf testing, not stealth. Falling back to
        # it silently is the bug that caused the "zendriver" tag to
        # mask a fully-detectable headless build.
        candidates = []
        env_override = os.environ.get("SPORE_BROWSER_EXECUTABLE_PATH")
        if env_override:
            candidates.append(env_override)
        candidates.extend(
            [
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
            ]
        )
        # Playwright bundles full Chromium under either
        #   /opt/pw-browsers/chromium-<rev>/chrome-linux/chrome     (older)
        #   /opt/pw-browsers/chromium-<rev>/chrome-linux64/chrome   (newer, post-1217ish)
        # Match both — missing the 64 variant was silently sending us
        # to chrome-headless-shell.
        for pattern in (
            "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
            "/opt/pw-browsers/chromium-*/chrome-linux64/chrome",
        ):
            candidates.extend(sorted(glob.glob(pattern), reverse=True))
        for candidate in candidates:
            if candidate and pathlib.Path(candidate).exists():
                return candidate
        # Returning None lets zendriver use its own bundled / downloaded
        # patched binary. That's a better failure mode than handing it
        # chrome-headless-shell.
        return None

    def _cleanup_user_data_dir(self):
        if not self.user_data_dir:
            return
        try:
            shutil.rmtree(self.user_data_dir, ignore_errors=True)
        finally:
            self.user_data_dir = None

    def _screenshot_dir(self):
        preferred = os.environ.get("SPORE_BROWSER_SCREENSHOT_DIR", "/workspace/browser-screenshots")
        for candidate in (preferred, os.path.join(tempfile.gettempdir(), "spore-browser-screenshots")):
            try:
                pathlib.Path(candidate).mkdir(parents=True, exist_ok=True)
                return candidate
            except Exception:
                continue
        raise RuntimeError("Could not create a writable screenshot directory.")

    def _next_screenshot_path(self):
        stamp = (
            asyncio.get_running_loop()
            .time()
        )
        safe_stamp = f"{stamp:.6f}".replace(".", "-")
        return os.path.join(self._screenshot_dir(), f"browser-zendriver-{safe_stamp}.jpg")

    async def _stop_preview_loop(self):
        if not self.preview_task:
            return
        task = self.preview_task
        self.preview_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    def _start_preview_loop(self):
        if self.preview_task and not self.preview_task.done():
            return
        self.preview_task = asyncio.create_task(self._preview_loop())

    async def _preview_loop(self):
        try:
            while self.browser and self.tab:
                try:
                    await self._frame_event()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    msg = str(exc)
                    if msg != self._last_frame_error:
                        emit({"event": "log", "level": "warn", "message": f"Zendriver preview frame failed: {msg}"})
                        self._last_frame_error = msg
                await asyncio.sleep(self.frame_interval)
        except asyncio.CancelledError:
            raise
        finally:
            self._last_frame_error = None

    async def _frame_event(self, quality="normal"):
        if not self.tab:
            return
        if not hasattr(self.tab, "screenshot_b64"):
            return
        async with self._frame_lock:
            image_b64 = await self.tab.screenshot_b64(format="jpeg")
            emit(
                {
                    "event": "frame",
                    "data": image_b64,
                    "width": self.width,
                    "height": self.height,
                    "quality": quality,
                }
            )
            self._last_frame_error = None

    async def _title(self):
        if not self.tab:
            return ""
        return json_safe(await self.tab.evaluate("document.title"))

    async def _url(self):
        if not self.tab:
            return "about:blank"
        return json_safe(await self.tab.evaluate("window.location.href"))

    async def _require_tab(self):
        if not self.browser or not self.tab:
            raise RuntimeError("Browser not launched. Call browser with action:\"launch\" first.")
        return self.tab

    async def _require_element(self, selector):
        tab = await self._require_tab()
        element = await tab.query_selector(selector)
        if not element:
            raise RuntimeError(f'No element matched selector: {selector}')
        if hasattr(element, "scroll_into_view"):
            try:
                await element.scroll_into_view()
            except Exception:
                pass
        return element

    async def launch(self, payload):
        if self.import_error:
            raise RuntimeError(
                f"Zendriver is not installed in this container: {self.import_error.__class__.__name__}: {self.import_error}"
            )
        if self.browser:
            return {
                "status": "already_running",
                "message": "Zendriver browser is already open. Use navigate to go to a URL, or close first.",
                "preview": "stream",
            }

        executable = self._detect_browser_executable()
        if not executable:
            raise RuntimeError(
                "Could not find a full Chromium binary for Zendriver. "
                "Install Chromium / Chrome, or set SPORE_BROWSER_EXECUTABLE_PATH "
                "to a real Chromium executable. Note: chrome-headless-shell "
                "is intentionally NOT used here — its UA identifies as "
                "HeadlessChrome and defeats zendriver's stealth patches."
            )
        self.executable_path = executable

        url = payload.get("url") or "about:blank"
        self.width = int(payload.get("width") or 1280)
        self.height = int(payload.get("height") or 720)
        self.user_data_dir = tempfile.mkdtemp(prefix="spore-zendriver-")

        try:
            self.browser = await self.zd.Browser.create(
                headless=True,
                browser_executable_path=executable,
                browser_args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    f"--window-size={self.width},{self.height}",
                ],
                sandbox=False,
                user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                user_data_dir=self.user_data_dir,
            )
            self.tab = await self.browser.get(url)
            if hasattr(self.tab, "set_window_size"):
                await self.tab.set_window_size(width=self.width, height=self.height)
            await asyncio.sleep(0.5)
            emit({"event": "open"})
            self._start_preview_loop()
            await self._frame_event()
            return {
                "status": "launched",
                "url": await self._url(),
                "title": await self._title(),
                "viewport": {"width": self.width, "height": self.height},
                "executable": self.executable_path,
                "preview": "stream",
                "screencast": False,
                "message": "Browser launched with continuous preview updates sent to the control panel.",
            }
        except Exception:
            await self._stop_preview_loop()
            if self.browser:
                try:
                    await self.browser.stop()
                except Exception:
                    pass
            self.browser = None
            self.tab = None
            self._cleanup_user_data_dir()
            raise

    async def navigate(self, payload):
        if not self.browser:
            raise RuntimeError('Browser not launched. Call browser with action:"launch" first.')
        url = payload.get("url")
        if not url:
            raise RuntimeError("Missing required parameter: url")
        self.tab = await self.browser.get(url)
        await asyncio.sleep(0.4)
        await self._frame_event()
        return {
            "status": "navigated",
            "url": await self._url(),
            "title": await self._title(),
        }

    async def click(self, payload):
        selector = payload.get("selector")
        if not selector:
            raise RuntimeError("Missing required parameter: selector")
        element = await self._require_element(selector)
        # Prefer real CDP mouse events (Input.dispatchMouseEvent at
        # element coords) — that's what zendriver's stealth patches
        # exist to enable. element.click() is a JS fallback (CDP
        # runtime call_function_on with `(el) => el.click()`) which
        # leaves no mousedown/mouseup trail and is detectable.
        # mouse_click() can fail if the element has no resolvable
        # bounding box (off-screen, display:none, zero-size); fall
        # back to the JS path in that case so the action still
        # works on weird layouts.
        click_via = "mouse_click"
        try:
            if hasattr(element, "mouse_click"):
                await element.mouse_click()
            else:
                click_via = "js_fallback"
                await element.click()
        except Exception as exc:
            click_via = "js_fallback"
            try:
                await element.click()
            except Exception:
                raise exc
        await asyncio.sleep(0.6)
        await self._frame_event()
        return {
            "status": "clicked",
            "selector": selector,
            "via": click_via,
            "url": await self._url(),
            "title": await self._title(),
        }

    async def type_text(self, payload):
        selector = payload.get("selector")
        text = payload.get("text")
        if not selector or text is None:
            raise RuntimeError("Missing required parameters: selector, text")
        element = await self._require_element(selector)
        if hasattr(element, "clear_input"):
            await element.clear_input()
        else:
            await element.apply(
                """
                (el) => {
                    if ('value' in el) {
                        el.value = '';
                        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
                    }
                }
                """
            )
        # zendriver's element.send_keys uses KeyPressEvent.CHAR, which
        # only dispatches the CDP "char" event type — that fires
        # `keypress` + `input` but NOT `keydown` / `keyup`. Anti-bot
        # stacks watch for the full keydown→input→keyup pattern as the
        # signature of a real keystroke. Use DOWN_AND_UP so the full
        # event sequence fires for every character.
        type_via = "down_and_up"
        try:
            from zendriver import cdp
            from zendriver.core.keys import KeyEvents, KeyPressEvent
            await element.apply("(elem) => elem.focus()")
            cluster_list = KeyEvents.from_text(str(text), KeyPressEvent.DOWN_AND_UP)
            tab = await self._require_tab()
            for cluster in cluster_list:
                await tab.send(cdp.input_.dispatch_key_event(**cluster))
        except Exception:
            # Fallback to zendriver's stock send_keys (CHAR-only) if the
            # DOWN_AND_UP path errors on something exotic.
            type_via = "char_fallback"
            await element.send_keys(str(text))
        await asyncio.sleep(0.25)
        await self._frame_event()
        return {
            "status": "typed",
            "selector": selector,
            "textLength": len(str(text)),
            "via": type_via,
        }

    async def screenshot(self, payload):
        tab = await self._require_tab()
        if hasattr(tab, "screenshot_b64"):
            image_b64 = await tab.screenshot_b64(format="jpeg")
        else:
            raise RuntimeError("Zendriver tab screenshot capture is unavailable in this version.")
        file_path = self._next_screenshot_path()
        pathlib.Path(file_path).write_bytes(base64.b64decode(image_b64))
        emit(
            {
                "event": "frame",
                "data": image_b64,
                "width": self.width,
                "height": self.height,
                "quality": "high",
            }
        )
        return {
            "status": "screenshot_taken",
            "url": await self._url(),
            "title": await self._title(),
            "filePath": file_path,
            "message": "High-quality screenshot saved to disk and sent to the control panel.",
        }

    async def scroll(self, payload):
        direction = str(payload.get("direction") or "down").lower()
        amount = int(payload.get("amount") or 500)
        tab = await self._require_tab()
        # Prefer Input.synthesizeScrollGesture (real wheel + scroll
        # events). y_distance sign convention matches zendriver's
        # builtin scroll_down/scroll_up: NEGATIVE = scroll down (page
        # content moves up), POSITIVE = scroll up. Falls back to
        # window.scrollBy if the CDP path errors (rare but possible
        # on PDFs / chrome:// pages).
        y_distance = -amount if direction == "down" else amount
        scroll_via = "wheel"
        try:
            from zendriver import cdp  # noqa: WPS433 (local import keeps top-level light)
            await tab.send(cdp.input_.synthesize_scroll_gesture(
                x=0,
                y=0,
                y_distance=y_distance,
                y_overscroll=0,
                x_overscroll=0,
                prevent_fling=True,
                repeat_delay_ms=0,
                speed=800,
            ))
            # Wait for the gesture to play out (distance / speed).
            await asyncio.sleep(max(0.15, abs(amount) / 800))
        except Exception:
            scroll_via = "js_fallback"
            delta = -amount if direction == "up" else amount
            await tab.evaluate(f"window.scrollBy(0, {delta})")
            await asyncio.sleep(0.3)
        await self._frame_event()
        return {
            "status": "scrolled",
            "direction": direction,
            "amount": amount,
            "via": scroll_via,
        }

    async def evaluate(self, payload):
        expression = payload.get("expression")
        if not expression:
            raise RuntimeError("Missing required parameter: expression")
        tab = await self._require_tab()
        result = await tab.evaluate(str(expression))
        serialized = None
        try:
            serialized = json.dumps(result)
        except Exception:
            serialized = None
        return {
            "status": "evaluated",
            "result": (serialized[:4000] + "...") if serialized and len(serialized) > 4000 else json_safe(result),
        }

    # ── Tab management ─────────────────────────────────────────────
    # The wrapper keeps `self.tab` as the *active* tab — every action
    # (click, type, evaluate, scroll, screenshot) operates on it.
    # tab_open / tab_switch retarget self.tab; tab_list reads
    # browser.tabs (zendriver's live list, which auto-updates as new
    # CDP targets attach).

    async def _tab_summary(self, tab=None):
        """One-tab summary dict — used in status / tab_list / etc."""
        target = tab or self.tab
        if not target:
            return {"url": None, "title": None}
        try:
            url = json_safe(await target.evaluate("window.location.href"))
        except Exception:
            url = None
        try:
            title = json_safe(await target.evaluate("document.title"))
        except Exception:
            title = None
        return {"url": url, "title": title}

    def _tab_index(self, target=None):
        if not self.browser:
            return -1
        target = target or self.tab
        for i, t in enumerate(self.browser.tabs):
            if t is target:
                return i
        return -1

    async def tab_open(self, payload):
        if not self.browser:
            raise RuntimeError('Browser not launched. Call browser with action:"launch" first.')
        url = payload.get("url") or "about:blank"
        new_tab = await self.browser.get(url, new_tab=True)
        self.tab = new_tab
        await asyncio.sleep(0.4)
        await self._frame_event()
        summary = await self._tab_summary()
        return {
            "status": "tab_opened",
            "index": self._tab_index(),
            "url": summary["url"],
            "title": summary["title"],
            "active": True,
            "tab_count": len(self.browser.tabs),
        }

    async def tab_list(self, payload=None):
        if not self.browser:
            raise RuntimeError('Browser not launched. Call browser with action:"launch" first.')
        out = []
        for i, t in enumerate(self.browser.tabs):
            try:
                url = json_safe(await t.evaluate("window.location.href"))
                title = json_safe(await t.evaluate("document.title"))
            except Exception:
                url = None
                title = None
            out.append({
                "index": i,
                "url": url,
                "title": title,
                "active": (t is self.tab),
            })
        return {
            "status": "tabs_listed",
            "tabs": out,
            "active_index": self._tab_index(),
            "tab_count": len(out),
        }

    async def tab_switch(self, payload):
        if not self.browser:
            raise RuntimeError('Browser not launched. Call browser with action:"launch" first.')
        if "index" not in payload:
            raise RuntimeError("Missing required parameter: index")
        index = int(payload.get("index"))
        tabs = list(self.browser.tabs)
        if index < 0 or index >= len(tabs):
            raise RuntimeError(f"tab index {index} out of range (have {len(tabs)} tabs)")
        self.tab = tabs[index]
        # Bring the tab to the foreground via CDP so screenshots /
        # screencasts capture it. activate() exists on newer zendriver;
        # fall back gracefully on older builds.
        if hasattr(self.tab, "activate"):
            try: await self.tab.activate()
            except Exception: pass
        await asyncio.sleep(0.2)
        await self._frame_event()
        summary = await self._tab_summary()
        return {
            "status": "tab_switched",
            "index": index,
            "url": summary["url"],
            "title": summary["title"],
            "tab_count": len(tabs),
        }

    async def tab_close(self, payload):
        if not self.browser:
            raise RuntimeError('Browser not launched. Call browser with action:"launch" first.')
        tabs = list(self.browser.tabs)
        if "index" in payload and payload["index"] is not None:
            index = int(payload["index"])
            if index < 0 or index >= len(tabs):
                raise RuntimeError(f"tab index {index} out of range (have {len(tabs)} tabs)")
            target = tabs[index]
        else:
            target = self.tab
            index = self._tab_index(target)
        if len(tabs) <= 1:
            raise RuntimeError("Cannot close the last tab — use action:close to stop the entire browser instead.")
        # Pick the tab to switch to if we're closing the active one.
        new_active = None
        if target is self.tab:
            new_index = index - 1 if index > 0 else 1
            new_active = tabs[new_index]
        await target.close()
        if new_active is not None:
            self.tab = new_active
            if hasattr(self.tab, "activate"):
                try: await self.tab.activate()
                except Exception: pass
        await asyncio.sleep(0.2)
        await self._frame_event()
        return {
            "status": "tab_closed",
            "closed_index": index,
            "active_index": self._tab_index(),
            "tab_count": len(self.browser.tabs),
        }

    # ── Page snapshot ──────────────────────────────────────────────
    # Returns a structured view of the active tab so the agent can
    # interact without hand-rolling discovery JS each time. The DOM
    # extraction (interactive elements + headings + selectors) runs
    # in-page; the JS backend post-processes the outerHTML through
    # agent-fetch's Readability for a clean text view.
    async def snapshot(self, payload):
        tab = await self._require_tab()
        # Hard cap on outerHTML so we don't blow up the stdio JSON
        # channel on huge pages. Readability still works on truncated
        # HTML — it picks the best content block from what it sees.
        max_html = int(payload.get("max_html") or 500_000)
        # JS lives in browser-core/lib/snapshot-payload.js — shared with
        # the Playwright backend so both emit identical output. The
        # canonical install path is two dirs up from this helper:
        # plugins/zendriver/helper/browser_helper.py
        #     → ../../browser-core/lib/snapshot-payload.js
        # SPORE_BROWSER_SNAPSHOT_PAYLOAD env overrides for ad-hoc tests.
        global _SNAPSHOT_JS
        if _SNAPSHOT_JS is None:
            here = os.path.dirname(os.path.abspath(__file__))
            candidates = [
                os.environ.get("SPORE_BROWSER_SNAPSHOT_PAYLOAD"),
                os.path.join(here, "..", "..", "browser-core", "lib", "snapshot-payload.js"),
                os.path.join(here, "snapshot-payload.js"),
            ]
            payload_path = next((p for p in candidates if p and os.path.isfile(p)), None)
            if not payload_path:
                raise RuntimeError(
                    "snapshot-payload.js not found; tried: "
                    + ", ".join([p for p in candidates if p])
                )
            with open(payload_path, "r") as f:
                _SNAPSHOT_JS = f.read()
        structured = await tab.evaluate(_SNAPSHOT_JS)
        # Pull outerHTML (capped) for Readability post-processing.
        html = await tab.evaluate("document.documentElement.outerHTML")
        if isinstance(html, str) and len(html) > max_html:
            html = html[:max_html]
        return {
            "status": "snapshot",
            "structured": structured,
            "html": html,
            "html_truncated": isinstance(html, str) and len(html) >= max_html,
        }

    async def status(self):
        if not self.browser or not self.tab:
            return {"status": "not_running", "preview": "stream", "screencast": False}
        return {
            "status": "running",
            "url": await self._url(),
            "title": await self._title(),
            "executable": self.executable_path,
            "active_tab_index": self._tab_index(),
            "tab_count": len(self.browser.tabs),
            "preview": "stream",
            "screencast": False,
        }

    async def close(self):
        if not self.browser:
            return {"status": "not_running", "message": "No browser to close."}
        await self._stop_preview_loop()
        try:
            await self.browser.stop()
        finally:
            self.browser = None
            self.tab = None
            self.executable_path = None
            self._cleanup_user_data_dir()
        emit({"event": "closed"})
        return {
            "status": "closed",
            "message": "Browser closed and preview updates stopped.",
            "preview": "stream",
            "screencast": False,
        }


async def main():
    session = ZendriverSession()
    emit({"event": "ready"})
    loop = asyncio.get_running_loop()

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception as exc:
            emit({"error": f"invalid helper input: {exc}"})
            continue

        request_id = payload.get("id")
        result = await session.handle(payload)
        if request_id is not None:
            emit({"id": request_id, "result": result} if not result.get("error") else {"id": request_id, "error": result["error"]})
            if payload.get("action") == "shutdown":
                break


if __name__ == "__main__":
    asyncio.run(main())
