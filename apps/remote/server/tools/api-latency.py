#!/usr/bin/env python3
"""Read-only Remote probes. Only timing, size, status and opaque locators leave memory."""
import argparse
import gzip
import json
import math
import os
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--session-id", required=True, help="An accessible own-person session; no automatic account traversal")
    parser.add_argument("--output", required=True, type=Path, help="Private metadata-only receipt, never in public source")
    parser.add_argument("--samples", type=int, default=6)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--routes", help="Comma-separated labels; split runs to stay within the attended command budget")
    parser.add_argument("--export", action="store_true", help="Also count the streamed full-context export; it is not an opening dependency")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.base_url)
    if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
        parser.error("base-url must be a credential-free HTTP(S) endpoint")
    if args.samples < 3 or args.samples > 100 or args.timeout <= 0 or args.timeout > 30:
        parser.error("samples must be 3..100 and timeout must be >0..30 seconds")
    base = args.base_url.rstrip("/")
    session = "/v1/sessions/" + urllib.parse.quote(args.session_id, safe="")
    headers = {"Content-Type": "application/json", "Accept-Encoding": "gzip"}
    cookie_file = os.environ.get("PI_PERFORMANCE_COOKIE_FILE")
    if cookie_file:
        headers["Cookie"] = Path(cookie_file).read_text().strip()
    token = os.environ.get("PI_THREAD_TOKEN")
    if token:
        headers["x-pi-thread-token"] = token
    samples = []

    def fetch(label, path, body=None, collect=False):
        started = time.perf_counter()
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        response = None
        result_envelope = path.startswith("/v1/threads/")
        try:
            try:
                response = urllib.request.urlopen(req, timeout=args.timeout)
            except urllib.error.HTTPError as failure:
                response = failure
            first = time.perf_counter()
            chunks, size = [], 0
            for chunk in iter(lambda: response.read(64 * 1024), b""):
                size += len(chunk)
                if (collect or result_envelope) and size <= 8 * 1024 * 1024:
                    chunks.append(chunk)
            row = {"route": label, "status": response.code, "bytes": size,
                   "ttfb_ms": round((first - started) * 1000, 3),
                   "total_ms": round((time.perf_counter() - started) * 1000, 3),
                   "encoding": response.headers.get("Content-Encoding", "identity")}
            samples.append(row)
            if (collect or result_envelope) and size <= 8 * 1024 * 1024 and 200 <= response.code < 300:
                payload = b"".join(chunks)
                if row["encoding"] == "gzip":
                    payload = gzip.decompress(payload)
                if len(payload) <= 8 * 1024 * 1024:
                    try:
                        value = json.loads(payload)
                    except (ValueError, UnicodeError):
                        row["error"] = "invalid_json"
                        return None
                    if result_envelope:
                        if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
                            row["error"] = "invalid_result"
                        elif not value["ok"]:
                            row["error"] = "api_error"
                            row["error_code"] = value.get("error", {}).get("code")
                    return value if collect else None
                row["error"] = "oversized_response"
            return None
        except (urllib.error.URLError, TimeoutError, OSError):
            samples.append({"route": label, "status": None, "error": "transport",
                            "total_ms": round((time.perf_counter() - started) * 1000, 3)})
            return None
        finally:
            if response is not None:
                response.close()

    routes = [
        ("health", "/v1/health", None), ("environment", "/v1/environment", None),
        ("workspaces", "/v1/workspaces", None), ("sessions", "/v1/sessions", None),
        ("all-agents", "/v1/sessions?allAgents=1", None),
        ("archived", "/v1/sessions/archived?limit=30", None),
        ("thread-list", "/v1/threads/list", {"limit": 100, "archived": False}),
        ("actions", "/v1/actions", None), ("voice", "/v1/voice", None),
        ("sync", "/v1/reconcile", {"session": None, "dashboard": False, "workers": False}),
        ("workers-sync", "/v1/reconcile", {"session": None, "dashboard": False, "workers": True}),
        ("dashboard-sync", "/v1/reconcile", {"session": None, "dashboard": True, "workers": False}),
        ("selected-sync", "/v1/reconcile", {"session": args.session_id, "viewing": False, "selectionId": "performance-read-only", "dashboard": False}),
        ("detail", session, None), ("transcript", session + "/transcript?limit=60", None),
        ("context-window", "/v1/threads/inspect", {"threadId": args.session_id, "contextWindow": {"limit": 30}}),
        ("settings", session + "/settings", None), ("commands", session + "/commands", None),
        ("questions", session + "/questions", None), ("children", session + "/children", None),
        ("images", session + "/images", None),
    ]
    if args.export:
        routes.append(("context-export", session + "/context", None))
    selected = None if args.routes is None else set(args.routes.split(","))
    available = {route[0] for route in routes} | {"older-page", "lazy-body"}
    if selected and not selected <= available:
        parser.error("unknown route labels: " + ",".join(sorted(selected - available)))
    locators = None
    if selected is None or selected & {"older-page", "lazy-body"}:
        page = fetch("locator-discovery", session + "/transcript?limit=60", collect=True)
        if page and isinstance(page.get("items"), list) and page["items"]:
            item = max(page["items"], key=lambda entry: entry.get("size", 0))
            locators = {"generation": page["generation"], "itemId": item["id"], "before": page["items"][0]["seq"]}
            routes += [("older-page", session + "/transcript?" + urllib.parse.urlencode({"before": locators["before"], "limit": 60, "generation": locators["generation"]}), None),
                       ("lazy-body", session + "/items/" + urllib.parse.quote(locators["itemId"], safe=""), None)]
    routes = [route for route in routes if selected is None or route[0] in selected]
    for _ in range(args.samples):
        for label, path, body in routes:
            fetch(label, path, body)
    summary = []
    for label, _, _ in routes:
        rows = [row for row in samples if row["route"] == label]
        warm = sorted(row["total_ms"] for row in rows[1:])
        summary.append({"route": label, "first_observed_ms": rows[0]["total_ms"],
                        "warm_p50_ms": statistics.median(warm), "warm_p95_ms": warm[math.ceil(len(warm) * .95) - 1],
                        "bytes_min": min((row["bytes"] for row in rows if "bytes" in row), default=None),
                        "bytes_max": max((row["bytes"] for row in rows if "bytes" in row), default=None),
                        "statuses": sorted({row["status"] for row in rows if row["status"] is not None}),
                        "failures": sum("error" in row for row in rows)})
    report = {"schema": 1, "sessionId": args.session_id, "locators": locators, "summary": summary, "samples": samples}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 1 if any(row["failures"] or any(status >= 400 for status in row["statuses"]) for row in summary) else 0


if __name__ == "__main__":
    raise SystemExit(main())
