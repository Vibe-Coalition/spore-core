#!/usr/bin/env python3
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        emit({"transport_error": f"invalid helper input: {exc}"})
        return

    try:
        from curl_cffi import requests as curl_requests
    except Exception as exc:
        emit({"transport_error": f"curl_cffi unavailable: {exc.__class__.__name__}: {exc}"})
        return

    url = payload.get("url")
    method = str(payload.get("method") or "GET").upper()
    headers = payload.get("headers") or {}
    body = payload.get("body")
    max_length = int(payload.get("maxLength") or 8000)
    preview_limit = max(1000, max_length * 3)
    timeout = float(payload.get("timeout") or 20)
    impersonate = payload.get("impersonate") or "chrome"

    request_kwargs = {
        "method": method,
        "url": url,
        "headers": headers,
        "timeout": timeout,
        "allow_redirects": True,
        "max_redirects": 3,
        "impersonate": impersonate,
    }
    if body is not None and method != "GET":
        if isinstance(body, (dict, list)):
            request_kwargs["json"] = body
        else:
            request_kwargs["data"] = body if isinstance(body, str) else json.dumps(body)

    try:
        response = curl_requests.request(**request_kwargs)
        content_type = response.headers.get("content-type", "")
        raw_bytes = response.content or b""
        text = response.text or ""
        if len(text) > preview_limit:
            text = text[:preview_limit]
        if response.status_code != 200:
            emit({
                "error": f"HTTP {response.status_code}",
                "detail": text[:500],
                "status": response.status_code,
                "url": str(response.url),
                "contentType": content_type,
                "transport": "curl_cffi",
            })
            return
        emit({
            "body": text,
            "status": response.status_code,
            "url": str(response.url),
            "contentType": content_type,
            "bytesRaw": len(raw_bytes),
            "transport": "curl_cffi",
        })
    except Exception as exc:
        emit({
            "error": f"Fetch failed: {exc}",
            "transport": "curl_cffi",
        })


if __name__ == "__main__":
    main()
