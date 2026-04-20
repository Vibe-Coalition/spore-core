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
        self.frame_interval = max(0.25, float(os.environ.get("ANIMA_ZENDRIVER_FRAME_INTERVAL", "1.0")))
        self._frame_lock = asyncio.Lock()
        self._last_frame_error = None
        try:
            import zendriver as zd

            self.zd = zd
        except Exception as exc:
            self.import_error = exc

    async def handle(self, payload):
        action = str(payload.get("action") or "").lower()
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
            if action == "status":
                return await self.status()
            if action == "close":
                return await self.close()
            if action == "shutdown":
                result = await self.close()
                result["shutdown"] = True
                return result
            return {"error": f"Unknown Zendriver helper action: {action}"}
        except Exception as exc:
            return {"error": str(exc)}

    def _detect_browser_executable(self):
        candidates = []
        env_override = os.environ.get("ANIMA_BROWSER_EXECUTABLE_PATH")
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
        candidates.extend(
            sorted(
                glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"),
                reverse=True,
            )
        )
        candidates.extend(
            sorted(
                glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"),
                reverse=True,
            )
        )
        for candidate in candidates:
            if candidate and pathlib.Path(candidate).exists():
                return candidate
        return None

    def _cleanup_user_data_dir(self):
        if not self.user_data_dir:
            return
        try:
            shutil.rmtree(self.user_data_dir, ignore_errors=True)
        finally:
            self.user_data_dir = None

    def _screenshot_dir(self):
        preferred = os.environ.get("ANIMA_BROWSER_SCREENSHOT_DIR", "/workspace/browser-screenshots")
        for candidate in (preferred, os.path.join(tempfile.gettempdir(), "anima-browser-screenshots")):
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
                "Could not determine a Chromium executable for Zendriver. "
                "Set ANIMA_BROWSER_EXECUTABLE_PATH or rebuild the image with a browser installed."
            )

        url = payload.get("url") or "about:blank"
        self.width = int(payload.get("width") or 1280)
        self.height = int(payload.get("height") or 720)
        self.user_data_dir = tempfile.mkdtemp(prefix="anima-zendriver-")

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
        await element.click()
        await asyncio.sleep(0.6)
        await self._frame_event()
        return {
            "status": "clicked",
            "selector": selector,
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
        await element.send_keys(str(text))
        await asyncio.sleep(0.25)
        await self._frame_event()
        return {
            "status": "typed",
            "selector": selector,
            "textLength": len(str(text)),
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
        delta = -amount if direction == "up" else amount
        tab = await self._require_tab()
        await tab.evaluate(f"window.scrollBy(0, {delta})")
        await asyncio.sleep(0.3)
        await self._frame_event()
        return {
            "status": "scrolled",
            "direction": direction,
            "amount": amount,
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

    async def status(self):
        if not self.browser or not self.tab:
            return {"status": "not_running", "preview": "stream", "screencast": False}
        return {
            "status": "running",
            "url": await self._url(),
            "title": await self._title(),
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
