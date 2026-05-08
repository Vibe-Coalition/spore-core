#!/usr/bin/env python3
"""
simulate-chat.py — drive a real conversation against the live agent and
report what tools it used.

End-to-end verification: instead of testing the browser helper directly
(see probe-events.py), this sends a natural-language prompt over the WS
the way a human user would, and tells you which tools the agent picked.

Usage:
    python3 simulate-chat.py \\
        --base-url http://127.0.0.1:18801 \\
        --username test-user --password '...' \\
        --prompt "Open https://example.com and click the 'More information' link" \\
        [--require-tool-arg browser:click] \\
        [--forbid-tool-arg browser:evaluate]

The two assert flags help you verify the agent took the right approach.
For example, on a "fill this form" task you'd want:
    --require-tool-arg browser:type --forbid-tool-arg browser:evaluate

The script exits non-zero if any assert fails.
"""
import argparse
import asyncio
import json
import os
import sys
import urllib.parse
import urllib.request

import websockets


def http_post_json(url: str, body: dict, cookie: str = "") -> tuple[int, dict, str]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "Cookie": cookie} if cookie else {"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            set_cookie = r.headers.get("Set-Cookie", "")
            try: parsed = json.loads(raw)
            except: parsed = {"raw": raw}
            return r.status, parsed, set_cookie
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()}, ""


def http_get_json(url: str, cookie: str = "") -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"Cookie": cookie} if cookie else {})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()}


def login(base_url: str, username: str, password: str) -> str:
    """Returns the session cookie value for subsequent requests."""
    status, body, set_cookie = http_post_json(
        f"{base_url}/api/auth/login",
        {"username": username, "password": password},
    )
    if status != 200:
        raise RuntimeError(f"login failed ({status}): {body}")
    # set_cookie looks like 'spore_session=<sid>; Path=/; HttpOnly; ...'
    parts = [p.strip() for p in set_cookie.split(";")]
    for p in parts:
        if "=" in p and not p.lower().startswith(("path", "httponly", "samesite", "secure", "expires", "max-age")):
            return p
    raise RuntimeError(f"no session cookie in login response (set_cookie={set_cookie!r})")


def get_ws_token(base_url: str, cookie: str) -> str:
    status, body = http_get_json(f"{base_url}/api/ws-token", cookie=cookie)
    if status != 200:
        raise RuntimeError(f"ws-token failed ({status}): {body}")
    tok = body.get("token", "")
    if not tok:
        raise RuntimeError("empty ws token; auth may not have stuck")
    return tok


# ── Conversation ────────────────────────────────────────────────────

class ToolCall:
    __slots__ = ("name", "input")
    def __init__(self, name: str, input: dict):
        self.name = name
        self.input = input

    def matches(self, spec: str) -> bool:
        """spec syntax: `tool` or `tool:argvalue` (any input field == argvalue)."""
        if ":" not in spec:
            return self.name == spec
        tool, arg = spec.split(":", 1)
        if self.name != tool:
            return False
        return any(str(v) == arg for v in self.input.values())


async def run_chat(ws_url: str, prompt: str, idle_timeout: float, hard_timeout: float):
    """Returns (tool_calls, assistant_text, why_done)."""
    tool_calls: list[ToolCall] = []
    assistant_text = []
    started = False
    print(f"→ connecting {ws_url}")
    try:
        async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as ws:
            print("→ sending prompt")
            # Server reads chat body from msg.content (web.js:5305+).
            # `text` is ignored, which makes the agent see "undefined".
            await ws.send(json.dumps({
                "type": "chat",
                "content": prompt,
                "sessionId": "probe:simulate-chat",
            }))
            last_event = asyncio.get_event_loop().time()
            start = last_event
            while True:
                now = asyncio.get_event_loop().time()
                if now - start > hard_timeout:
                    return tool_calls, "".join(assistant_text), "hard-timeout"
                remaining = max(1.0, idle_timeout - (now - last_event))
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    if started:
                        return tool_calls, "".join(assistant_text), "idle-timeout"
                    return tool_calls, "", "idle-before-start"
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                last_event = asyncio.get_event_loop().time()
                t = msg.get("type", "")
                # Log every message type so we can see if chat:tool is
                # arriving but failing to parse, or not arriving at all.
                if os.environ.get("SIMCHAT_VERBOSE") == "1":
                    short = json.dumps({k: v for k, v in msg.items() if k != "data"})
                    if len(short) > 250: short = short[:250] + "…"
                    print(f"  ws-recv: {short}")
                if t == "chat:start":
                    started = True
                    print(f"  · chat:start (session={msg.get('sessionId', '?')})")
                elif t == "graph:event" and msg.get("op") == "tool:call":
                    # The agent loop emits each tool call as a graph
                    # event with tool name + serialized input. The
                    # `chat:tool` message also exists but only carries
                    # the tool name on the regular WS path, so we use
                    # graph:event tool:call which has the full payload.
                    raw_input = msg.get("input")
                    parsed: dict
                    if isinstance(raw_input, str):
                        try: parsed = json.loads(raw_input)
                        except Exception: parsed = {"_raw": raw_input}
                    else:
                        parsed = raw_input or {}
                    tc = ToolCall(msg.get("tool", "?"), parsed)
                    tool_calls.append(tc)
                    short = json.dumps(tc.input, ensure_ascii=False)
                    if len(short) > 200: short = short[:200] + "…"
                    print(f"  · tool {tc.name} {short}")
                elif t == "chat:tool":
                    # Fallback for code paths that emit chat:tool with
                    # full payload (legacy / proactive path).
                    if any(t2.name == msg.get("tool") for t2 in tool_calls[-3:]):
                        continue  # already accounted for via graph:event
                    tc = ToolCall(msg.get("tool", "?"), msg.get("input") or {})
                    tool_calls.append(tc)
                    short = json.dumps(tc.input, ensure_ascii=False)
                    if len(short) > 200: short = short[:200] + "…"
                    print(f"  · chat:tool {tc.name} {short}")
                elif t == "chat:delta":
                    assistant_text.append(msg.get("text", ""))
                elif t == "chat:done":
                    if msg.get("text") and not assistant_text:
                        assistant_text.append(msg["text"])
                    return tool_calls, "".join(assistant_text), "chat:done"
                elif t == "chat:error":
                    print(f"  · chat:error {msg.get('error')}")
                    return tool_calls, "".join(assistant_text), f"chat:error: {msg.get('error', '?')}"
    except Exception as e:
        return tool_calls, "".join(assistant_text), f"ws-error: {e}"


# ── Main ────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="e.g. http://127.0.0.1:18801")
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--require-tool-arg", action="append", default=[],
                    help="Assert at least one tool call matches `tool` or `tool:argvalue`. May be repeated.")
    ap.add_argument("--forbid-tool-arg", action="append", default=[],
                    help="Assert NO tool call matches the given pattern. May be repeated.")
    ap.add_argument("--max-tool-call", type=int, default=None,
                    help="Optional cap; fail if exceeded (catches the 'agent ran 18 evaluate calls' case).")
    ap.add_argument("--idle-timeout", type=float, default=120.0)
    ap.add_argument("--hard-timeout", type=float, default=600.0)
    args = ap.parse_args()

    cookie = login(args.base_url, args.username, args.password)
    token = get_ws_token(args.base_url, cookie)
    base = args.base_url.rstrip("/")
    ws_scheme = "wss" if base.startswith("https") else "ws"
    ws_host = base.split("://", 1)[1]
    ws_url = f"{ws_scheme}://{ws_host}/ws?token={urllib.parse.quote(token)}"

    print(f"prompt: {args.prompt!r}")
    tool_calls, text, reason = asyncio.run(run_chat(ws_url, args.prompt, args.idle_timeout, args.hard_timeout))

    print()
    print(f"=== conversation ended: {reason} ===")
    print(f"tool calls: {len(tool_calls)}")
    by_tool: dict[str, int] = {}
    for tc in tool_calls:
        by_tool[tc.name] = by_tool.get(tc.name, 0) + 1
    for name, count in sorted(by_tool.items(), key=lambda x: -x[1]):
        print(f"  {name}: {count}")
    if text:
        snippet = text.strip()[:600]
        print()
        print(f"=== assistant ({len(text)} chars) ===")
        print(snippet + ("…" if len(text) > 600 else ""))

    # Asserts
    failures = []
    for spec in args.require_tool_arg:
        if not any(tc.matches(spec) for tc in tool_calls):
            failures.append(f"required tool/arg not seen: {spec}")
    for spec in args.forbid_tool_arg:
        hits = [tc for tc in tool_calls if tc.matches(spec)]
        if hits:
            failures.append(f"forbidden tool/arg seen {len(hits)}× : {spec}")
    if args.max_tool_call is not None and len(tool_calls) > args.max_tool_call:
        failures.append(f"tool calls {len(tool_calls)} exceeded cap {args.max_tool_call}")

    print()
    if failures:
        print("ASSERT FAILED:")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    if reason in ("hard-timeout", "idle-timeout") or reason.startswith("chat:error") or reason.startswith("ws-error"):
        print(f"ASSERT FAILED: conversation ended with {reason}")
        return 1
    print("ASSERT OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
