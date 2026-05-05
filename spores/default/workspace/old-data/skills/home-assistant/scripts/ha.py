#!/usr/bin/env python3
"""Home Assistant REST API client."""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

HA_URL = os.environ.get("HA_URL", "https://ha.hyrule.vip")
HA_TOKEN = os.environ.get("HA_TOKEN", "")


def _headers():
    return {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type": "application/json",
    }


def _request(method, path, data=None):
    url = f"{HA_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode() if e.fp else str(e)
        print(json.dumps({"error": True, "status": e.code, "detail": err}), file=sys.stderr)
        sys.exit(1)


def _call_service(domain, service, entity_id, data=None):
    payload = {"entity_id": entity_id}
    if data:
        payload.update(data)
    result = _request("POST", f"/api/services/{domain}/{service}", payload)
    print(json.dumps({"ok": True, "entity_id": entity_id}))


# ── Commands ────────────────────────────────────────────────────────────

def cmd_on(args):
    data = {}
    if args.brightness is not None:
        data["brightness_pct"] = args.brightness
    if args.color_temp is not None:
        data["color_temp_kelvin"] = args.color_temp
    if args.rgb:
        r, g, b = [int(x) for x in args.rgb.split(",")]
        data["rgb_color"] = [r, g, b]
    entity = args.entity
    domain = entity.split(".")[0]
    _call_service(domain, "turn_on", entity, data if data else None)


def cmd_off(args):
    entity = args.entity
    domain = entity.split(".")[0]
    _call_service(domain, "turn_off", entity)


def cmd_toggle(args):
    entity = args.entity
    domain = entity.split(".")[0]
    _call_service(domain, "toggle", entity)


def cmd_state(args):
    result = _request("GET", f"/api/states/{args.entity}")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_states(args):
    result = _request("GET", "/api/states")
    filtered = result
    if args.domain:
        filtered = [s for s in filtered if s["entity_id"].startswith(args.domain + ".")]
    if args.search:
        q = args.search.lower()
        filtered = [s for s in filtered if q in s["entity_id"].lower() or q in s.get("attributes", {}).get("friendly_name", "").lower()]
    for s in filtered:
        name = s.get("attributes", {}).get("friendly_name", "")
        print(f"{s['entity_id']}  state={s['state']}  name={name}")


def cmd_climate(args):
    data = {}
    if args.temperature is not None:
        data["temperature"] = args.temperature
    if args.hvac_mode:
        data["hvac_mode"] = args.hvac_mode
    if data:
        if "hvac_mode" in data:
            _call_service("climate", "set_hvac_mode", args.entity, {"hvac_mode": data["hvac_mode"]})
        if "temperature" in data:
            _call_service("climate", "set_temperature", args.entity, {"temperature": data["temperature"]})
    else:
        result = _request("GET", f"/api/states/{args.entity}")
        print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_cover(args):
    service = "open_cover" if args.action == "open" else "close_cover"
    _call_service("cover", service, args.entity)


def cmd_lock(args):
    _call_service("lock", args.action, args.entity)


def cmd_media(args):
    if args.action == "play":
        _call_service("media_player", "media_play", args.entity)
    elif args.action == "pause":
        _call_service("media_player", "media_pause", args.entity)
    elif args.action == "stop":
        _call_service("media_player", "media_stop", args.entity)
    elif args.action == "volume":
        data = {"volume_level": args.level / 100.0}
        _call_service("media_player", "volume_set", args.entity, data)
    elif args.action == "source":
        data = {"source": args.source}
        _call_service("media_player", "select_source", args.entity, data)


def cmd_call(args):
    data = json.loads(args.data) if args.data else {}
    if args.entity:
        data["entity_id"] = args.entity
    result = _request("POST", f"/api/services/{args.domain}/{args.service}", data)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_trigger(args):
    _call_service("automation", "trigger", args.entity)


def cmd_history(args):
    import datetime
    hours = args.hours or 24
    end = datetime.datetime.now(datetime.timezone.utc)
    start = end - datetime.timedelta(hours=hours)
    path = f"/api/history/period/{start.isoformat()}?filter_entity_id={args.entity}&end_time={end.isoformat()}"
    result = _request("GET", path)
    if result and len(result) > 0:
        for entry in result[0][-20:]:
            print(f"{entry.get('last_changed', '')}  {entry.get('state', '')}")
    else:
        print("No history found")


def main():
    parser = argparse.ArgumentParser(description="Home Assistant CLI")
    sub = parser.add_subparsers(dest="command")

    # on
    p = sub.add_parser("on", help="Turn on entity")
    p.add_argument("entity")
    p.add_argument("-b", "--brightness", type=int, help="Brightness 0-100")
    p.add_argument("-ct", "--color-temp", type=int, help="Color temp in Kelvin")
    p.add_argument("--rgb", help="RGB color as r,g,b")

    # off
    p = sub.add_parser("off", help="Turn off entity")
    p.add_argument("entity")

    # toggle
    p = sub.add_parser("toggle", help="Toggle entity")
    p.add_argument("entity")

    # state
    p = sub.add_parser("state", help="Get entity state")
    p.add_argument("entity")

    # states
    p = sub.add_parser("states", help="List all states")
    p.add_argument("--domain", help="Filter by domain")
    p.add_argument("--search", help="Search by name")

    # climate
    p = sub.add_parser("climate", help="Control climate")
    p.add_argument("entity")
    p.add_argument("-t", "--temperature", type=float)
    p.add_argument("--hvac-mode", choices=["heat", "cool", "auto", "off", "heat_cool", "fan_only"])

    # cover
    p = sub.add_parser("cover", help="Control cover")
    p.add_argument("entity")
    p.add_argument("action", choices=["open", "close"])

    # lock
    p = sub.add_parser("lock", help="Control lock")
    p.add_argument("entity")
    p.add_argument("action", choices=["lock", "unlock"])

    # media
    p = sub.add_parser("media", help="Control media player")
    p.add_argument("entity")
    p.add_argument("action", choices=["play", "pause", "stop", "volume", "source"])
    p.add_argument("--level", type=int, help="Volume level 0-100")
    p.add_argument("--source", help="Source name")

    # call (raw service call)
    p = sub.add_parser("call", help="Raw service call")
    p.add_argument("domain")
    p.add_argument("service")
    p.add_argument("-e", "--entity", help="Entity ID")
    p.add_argument("-d", "--data", help="JSON data")

    # trigger
    p = sub.add_parser("trigger", help="Trigger automation")
    p.add_argument("entity")

    # history
    p = sub.add_parser("history", help="Get entity history")
    p.add_argument("entity")
    p.add_argument("--hours", type=int, default=24)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    if not HA_TOKEN:
        print("Error: HA_TOKEN not set", file=sys.stderr)
        sys.exit(1)

    cmds = {
        "on": cmd_on, "off": cmd_off, "toggle": cmd_toggle,
        "state": cmd_state, "states": cmd_states, "climate": cmd_climate,
        "cover": cmd_cover, "lock": cmd_lock, "media": cmd_media,
        "call": cmd_call, "trigger": cmd_trigger, "history": cmd_history,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
