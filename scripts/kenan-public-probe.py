#!/usr/bin/env python3
"""Exercise the shell's Access headers; read a browser state file, never print credentials."""
import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--user")
    parser.add_argument("--key-stdin", action="store_true")
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    from urllib.parse import urlparse
    host = urlparse(origin).hostname
    state = json.loads(args.state.read_text())
    token = next(c["value"] for c in state["cookies"] if c["name"] == "CF_Authorization" and c["domain"].lstrip(".") == host)
    opener = urllib.request.build_opener(NoRedirect)
    proof = []

    def request(path, headers=None, method="GET", body=None, expected=200, read=True):
        req = urllib.request.Request(origin + path, headers={"User-Agent": "Dalvik/2.1.0 (Linux; U; Android 16; Pixel 7 Build/BP2A)", **(headers or {})}, method=method, data=body)
        try:
            response = opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = response.read() if read else b""
            status = response.code
            proof.append({"path": path, "method": method, "status": status,
                          "corsOrigin": response.headers.get("Access-Control-Allow-Origin")})
            assert status == expected, f"{method} {path}: HTTP {status}, expected {expected}"
            return result

    request("/v1/environment", expected=302)
    request("/v1/environment", {"cf-access-token": "invalid-test-token"}, expected=302)
    preflight = {"Origin": "http://localhost", "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "cf-access-token,x-pi-remote-session,content-type"}
    request("/v1/unlock", preflight, "OPTIONS", expected=200)
    access = {"cf-access-token": token, "Origin": "http://localhost", "accept": "application/json"}
    environment = json.loads(request("/v1/environment", access))
    assert isinstance(environment.get("environment", environment), dict)
    manifest = json.loads(request("/v1/app-update", access))
    release = manifest["release"]
    request("/v1/app-update/" + release["fileName"], access, read=False)
    if args.user:
        assert args.key_stdin, "--user requires --key-stdin"
        auth = {**access, "x-pi-remote-user": args.user, "content-type": "application/json"}
        session = json.loads(request("/v1/unlock", auth, "POST", json.dumps({"key": sys.stdin.read().strip()}).encode()))["session"]
        auth["x-pi-remote-session"] = session
        endpoints = json.loads(request("/v1/environments", auth))["environments"]
        for endpoint in endpoints:
            request(endpoint["baseUrl"] + "/v1/notifications?after=0", auth)
        request("/v1/environments", {**auth, "x-pi-remote-session": "invalid-test-session"}, expected=423)
        import base64
        import http.client
        import os
        from urllib.parse import quote
        for cookie_transport in [False, True]:
            connection = http.client.HTTPSConnection(host, timeout=10)
            headers = {"User-Agent": "okhttp/4.12.0", "Upgrade": "websocket", "Connection": "Upgrade",
                       "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode(),
                       "Origin": "http://localhost", "x-pi-remote-user": args.user, "x-pi-remote-session": session}
            headers.update({"Cookie": "CF_Authorization=" + token} if cookie_transport else {"cf-access-token": token})
            connection.request("GET", urlparse(origin).path + "/v1/write/stream?session=" + quote(session), headers=headers)
            response = connection.getresponse()
            proof.append({"path": "/v1/write/stream", "transport": "cookie" if cookie_transport else "cf-access-token", "status": response.status})
            assert response.status == 101, f"Write handshake: HTTP {response.status}"
            connection.close()
    print(json.dumps({"origin": origin, "requests": proof, "apk": {k: release.get(k) for k in ("revision", "versionCode", "fileName")}}, indent=2))


if __name__ == "__main__":
    main()
