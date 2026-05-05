#!/usr/bin/env python3
"""
probe-events.py — implementation-level verification of the browser tool.

Spawns the zendriver helper subprocess directly (no spore, no agent),
points it at a local event-log page, runs each browser action, and
asserts the page received the right kind of events with isTrusted=true.

The point: tell us whether `click` / `type` / `scroll` actually emit real
CDP-level input events (which would have isTrusted=true on the page
side), or whether they're synthetic JS events (isTrusted=false).

Usage:
    docker exec -i sporebfl python3 /app/tests/browser-eventlog/probe-events.py

Or from outside the container:
    python3 -m http.server 0 --directory tests/browser-eventlog
    docker cp tests/browser-eventlog sporebfl:/tmp/probe
    docker exec -i sporebfl python3 /tmp/probe/probe-events.py
"""
import asyncio
import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time

HELPER = "/app/plugins/zendriver/helper/browser_helper.py"
PAGE_DIR = os.path.dirname(os.path.abspath(__file__))
PAGE_FILE = "eventlog.html"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_static_server(port: int):
    """Serve PAGE_DIR on 127.0.0.1:port in a daemon thread."""
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=PAGE_DIR, **kw)
    server = socketserver.TCPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


class HelperSession:
    """Drive the zendriver helper subprocess via its stdin/stdout JSON
    protocol. The helper expects one JSON object per line on stdin and
    emits one JSON object per line on stdout (events have `event`, RPC
    responses don't)."""

    def __init__(self):
        env = os.environ.copy()
        env.setdefault("SPORE_ZENDRIVER_FRAME_INTERVAL", "5.0")  # rare frames during probe
        self.proc = subprocess.Popen(
            ["python3", HELPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=env,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._lock = threading.Lock()
        self._inbox: list = []
        self._next_id = 1
        self._reader.start()

    def _read_loop(self):
        while True:
            line = self.proc.stdout.readline()
            if not line:
                return
            try:
                msg = json.loads(line)
            except Exception:
                continue
            with self._lock:
                self._inbox.append(msg)

    def _send(self, payload: dict, timeout: float = 60.0) -> dict:
        """Helper protocol: include `id` to get a response with matching
        id; responses without id are unsolicited events (frames, etc.).
        We assign a monotonic id per call and match on it."""
        rid = self._next_id
        self._next_id += 1
        payload = {**payload, "id": rid}
        line = json.dumps(payload) + "\n"
        self.proc.stdin.write(line)
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                for i, m in enumerate(self._inbox):
                    if m.get("id") != rid:
                        continue
                    self._inbox.pop(i)
                    if "error" in m:
                        return {"error": m["error"]}
                    return m.get("result") or {}
            time.sleep(0.05)
        raise TimeoutError(f"helper did not respond to {payload.get('action')} (id={rid}) in {timeout}s")

    def call(self, action: str, **kwargs) -> dict:
        timeout = kwargs.pop("_timeout", 60.0)
        return self._send({"action": action, **kwargs}, timeout=timeout)

    def close(self):
        try:
            self._send({"action": "shutdown"}, timeout=5)
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()


# ── Assertion helpers ────────────────────────────────────────────────

PASS, FAIL = "✓", "✗"

class Outcome:
    def __init__(self):
        self.failed = 0
        self.passed = 0

    def check(self, label: str, ok: bool, detail: str = ""):
        mark = PASS if ok else FAIL
        line = f"  {mark} {label}"
        if detail:
            line += f"  — {detail}"
        print(line)
        if ok: self.passed += 1
        else:  self.failed += 1


def evaluate_count(sess, target, event_types, only_trusted=True):
    """Run a small JS expression on the page that COUNTS matching events.
    Returns just the integer — avoids the helper's 4000-char JSON cap
    that bites when the event log is busy (e.g. scroll fires ~20+
    events). Returns -1 if the helper returned an error."""
    types = json.dumps(event_types if isinstance(event_types, list) else [event_types])
    expr = (
        f"window.__events.filter(e => "
        f"e.target === {json.dumps(target)} "
        f"&& {types}.includes(e.type) "
        f"&& {'e.isTrusted === true' if only_trusted else 'true'}"
        f").length"
    )
    r = sess.call("evaluate", expression=expr)
    v = r.get("result")
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.isdigit():
        return int(v)
    return -1


def evaluate_any_trusted(sess, target, event_types):
    types = json.dumps(event_types if isinstance(event_types, list) else [event_types])
    expr = (
        f"window.__events.some(e => "
        f"e.target === {json.dumps(target)} "
        f"&& {types}.includes(e.type) "
        f"&& e.isTrusted === true)"
    )
    r = sess.call("evaluate", expression=expr)
    return bool(r.get("result"))


# ── Probe ────────────────────────────────────────────────────────────

def run_probe():
    port = _free_port()
    server = _start_static_server(port)
    page_url = f"http://127.0.0.1:{port}/{PAGE_FILE}"
    print(f"event-log page: {page_url}")

    out = Outcome()
    sess = HelperSession()
    try:
        # Launch — chromium cold start can take 15-30s, give it room
        r = sess.call("launch", url=page_url, _timeout=120.0)
        if "error" in r:
            print(f"launch failed: {r['error']}")
            return 1
        print(f"launched via: {r.get('executable', '?')}")
        # Note this is the executable detection result — should be full
        # chromium, not chrome-headless-shell.
        out.check(
            "binary is full Chromium (not headless-shell)",
            "chrome-linux64" in (r.get("executable") or "") or "chromium" in (r.get("executable") or "").split("/")[-1],
            r.get("executable", ""),
        )

        # navigator.webdriver should be hidden by zendriver patches
        wd = sess.call("evaluate", expression="navigator.webdriver")
        out.check(
            "navigator.webdriver is hidden",
            wd.get("result") in (False, None, "false", 0),
            f"got {wd.get('result')!r}",
        )

        # ── click ─────────────────────────────────────────────────────
        sess.call("evaluate", expression="window.__resetEvents()")
        r = sess.call("click", selector="#target-button")
        click_via = r.get("via", "?")
        out.check(
            "click reports `via: mouse_click` (real CDP mouse path)",
            click_via == "mouse_click",
            f"got via={click_via!r}",
        )
        n_mousedown = evaluate_count(sess, "button", "mousedown")
        n_mouseup   = evaluate_count(sess, "button", "mouseup")
        n_click     = evaluate_count(sess, "button", "click")
        out.check("click produced trusted mousedown", n_mousedown >= 1, f"count={n_mousedown}")
        out.check("click produced trusted mouseup",   n_mouseup   >= 1, f"count={n_mouseup}")
        out.check("click produced trusted click event", n_click   >= 1, f"count={n_click}")

        # ── type ─────────────────────────────────────────────────────
        sess.call("evaluate", expression="window.__resetEvents()")
        text = "hello world"
        r = sess.call("type", selector="#target-input", text=text)
        type_via = r.get("via", "?")
        out.check(
            "type reports `via: down_and_up` (real keydown+keyup)",
            type_via == "down_and_up",
            f"got via={type_via!r}",
        )
        n_keydown = evaluate_count(sess, "input", "keydown")
        n_keyup   = evaluate_count(sess, "input", "keyup")
        n_input   = evaluate_count(sess, "input", "input")
        out.check(
            f"type produced ≥{len(text)} trusted keydown events",
            n_keydown >= len(text),
            f"keydown count={n_keydown} (text length={len(text)})",
        )
        out.check(
            f"type produced ≥{len(text)} trusted keyup events",
            n_keyup >= len(text),
            f"keyup count={n_keyup} (text length={len(text)})",
        )
        out.check(
            "type produced trusted input events",
            n_input >= 1,
            f"input count={n_input}",
        )
        v = sess.call("evaluate", expression="document.getElementById('target-input').value")
        out.check(
            "input value reflects what we typed",
            v.get("result") == text,
            f"value={v.get('result')!r}",
        )

        # ── scroll ────────────────────────────────────────────────────
        sess.call("evaluate", expression="window.__resetEvents()")
        r = sess.call("scroll", direction="down", amount=300)
        scroll_via = r.get("via", "?")
        out.check(
            "scroll reports `via: wheel` (CDP gesture, not JS fallback)",
            scroll_via == "wheel",
            f"got via={scroll_via!r}",
        )
        n_scroll = evaluate_count(sess, "window", ["scroll"])
        n_wheel = evaluate_count(sess, "scroll-target", ["wheel"])
        out.check(
            "scroll produced trusted scroll events on window",
            n_scroll >= 1,
            f"trusted scroll count={n_scroll}",
        )
        # We don't strictly need wheel events on the inner div for the
        # outer page scroll, but log it as info.
        if n_wheel >= 0:
            print(f"      (also: trusted wheel events on inner div = {n_wheel})")

        # ── tabs ─────────────────────────────────────────────────────
        # Open a 2nd tab to a different URL, list, switch, close.
        r = sess.call("tab_open", url="about:blank")
        out.check(
            "tab_open returns a new index ≥ 1",
            isinstance(r.get("index"), int) and r["index"] >= 1,
            f"got index={r.get('index')!r}, tab_count={r.get('tab_count')}",
        )
        r = sess.call("tab_list")
        tabs = r.get("tabs") or []
        out.check(
            "tab_list reports ≥2 tabs after tab_open",
            len(tabs) >= 2,
            f"tab_count={len(tabs)}",
        )
        out.check(
            "exactly one tab is marked active",
            sum(1 for t in tabs if t.get("active")) == 1,
            f"active marks={[t.get('active') for t in tabs]}",
        )
        # Switch back to tab 0 (the eventlog page) and confirm we can
        # still query it — proves switching retargets self.tab.
        r = sess.call("tab_switch", index=0)
        out.check(
            "tab_switch index=0 reports the original page url",
            (r.get("url") or "").endswith(PAGE_FILE),
            f"after switch url={r.get('url')!r}",
        )
        # The blank tab should still exist.
        r = sess.call("tab_list")
        out.check(
            "blank tab still in list after switch",
            any((t.get("url") or "").startswith("about:blank") for t in (r.get("tabs") or [])),
            f"urls={[t.get('url') for t in (r.get('tabs') or [])]}",
        )
        # Close the blank tab by index — find it first.
        blank_idx = next(
            (t["index"] for t in r.get("tabs") or [] if (t.get("url") or "").startswith("about:blank")),
            None,
        )
        if blank_idx is not None:
            r = sess.call("tab_close", index=blank_idx)
            out.check(
                "tab_close removes the blank tab",
                r.get("tab_count") == 1,
                f"tab_count={r.get('tab_count')}, closed_index={r.get('closed_index')}",
            )

        # ── snapshot ─────────────────────────────────────────────────
        # snapshot returns a structured page read: interactive[] with
        # selectors + text, headings[], plus Readability content.markdown.
        # This is the default discovery method — one call instead of
        # the agent rolling its own evaluate query.
        # The helper returns {structured: {...}, html, html_truncated};
        # the JS backend flattens that for the agent. We're calling the
        # helper directly here so we read from `structured`.
        r = sess.call("snapshot")
        s = r.get("structured") or {}
        out.check(
            "snapshot returns the active tab url",
            (s.get("url") or "").endswith(PAGE_FILE),
            f"got url={s.get('url')!r}",
        )
        out.check(
            "snapshot title matches page",
            (s.get("title") or "").startswith("Browser Tool Event Log"),
            f"got title={s.get('title')!r}",
        )
        out.check(
            "helper returned outerHTML for backend Readability extraction",
            isinstance(r.get("html"), str) and len(r.get("html") or "") > 200,
            f"html length={len(r.get('html') or '')}",
        )
        interactive = s.get("interactive") or []
        out.check(
            "snapshot lists ≥2 interactive elements",
            len(interactive) >= 2,
            f"interactive_count={len(interactive)} (eventlog page has button + input)",
        )
        # Spot-check: button and input should be in there with valid selectors
        kinds = [i.get("kind") for i in interactive]
        out.check(
            "interactive list contains a button",
            "button" in kinds,
            f"kinds={kinds[:8]}",
        )
        out.check(
            "interactive list contains an input",
            "input" in kinds,
            f"kinds={kinds[:8]}",
        )
        btn_sel = next((i.get("selector") for i in interactive if i.get("kind") == "button"), None)
        out.check(
            "button selector is non-empty",
            isinstance(btn_sel, str) and len(btn_sel) > 0,
            f"button selector={btn_sel!r}",
        )
        # Headings present
        headings = s.get("headings") or []
        out.check(
            "snapshot lists headings",
            len(headings) >= 1 and any(h.get("level") == 1 for h in headings),
            f"heading levels={[h.get('level') for h in headings]}",
        )
        # Selector validity is already covered by the earlier click test
        # — that verified `#target-button` (which is what snapshot
        # returns) produces trusted mouse events. We don't repeat that
        # here because by this point in the probe the page has been
        # scrolled / tabs opened+closed and may not be in a clean state
        # for another click without page-state setup.

        # ── contrast: evaluate-driven JS click should NOT be trusted ─
        sess.call("evaluate", expression="window.__resetEvents()")
        sess.call("evaluate",
            expression="document.getElementById('target-button').click()")
        synthetic_total = evaluate_count(sess, "button", "click", only_trusted=False)
        synthetic_trusted = evaluate_count(sess, "button", "click", only_trusted=True)
        out.check(
            "JS-driven .click() is observable as a click event…",
            synthetic_total >= 1,
            f"total click count={synthetic_total}",
        )
        out.check(
            "…but isTrusted=false (the bot tell)",
            synthetic_total >= 1 and synthetic_trusted == 0,
            f"trusted={synthetic_trusted} of total={synthetic_total}",
        )

    finally:
        sess.close()
        server.shutdown()

    print()
    print(f"PASS {out.passed}   FAIL {out.failed}")
    return 0 if out.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run_probe())
