#!/usr/bin/python3 -I
"""Read-only identity probe; source custody is distinct from installed delivery."""
import argparse
import hashlib
import json
import pwd
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent


def digest(path):
    try:
        return {"ok": True, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    except OSError as error:
        return {"ok": False, "error": "unreadable", "path": str(path), "detail": str(error)}


def valid_manifest(value):
    if not isinstance(value, dict) or value.get("schema") != "pi-stack-public-app-identity-v1":
        return False
    sha = lambda text: isinstance(text, str) and re.fullmatch(r"[a-f0-9]{64}", text) is not None
    source = value.get("source")
    if not isinstance(source, dict) or set(source) != {"install.py", "control.py", "sandbox.py", "gateway.py", "remote.py", "check.py", "verify.py", "app.py"}:
        return False
    for item in source.values():
        if not isinstance(item, dict) or set(item) != {"sha256", "installedPath"} or not sha(item["sha256"]):
            return False
        path = item["installedPath"]
        if path is not None and (not isinstance(path, str) or not path.startswith("/usr/local/")):
            return False
    units = value.get("installedUnits")
    if not isinstance(units, dict) or len(units) != 4 or not all(isinstance(path, str) and path.startswith("/etc/systemd/system/") and sha(checksum) for path, checksum in units.items()):
        return False
    targets = value.get("targets")
    if not isinstance(targets, dict) or set(targets) != {"gmktec", "converge"}:
        return False
    for item in targets.values():
        if not isinstance(item, dict) or not sha(item.get("configSha256")) or type(item.get("runtimeUid")) is not int or item["runtimeUid"] <= 0:
            return False
    receipt = value.get("installationVerification")
    return (isinstance(receipt, dict) and sha(receipt.get("sha256"))
            and value.get("configPath") == "/etc/pi-stack/delegations/martine-public.json"
            and isinstance(value.get("publicationOwner"), str) and bool(value["publicationOwner"]))


def inspect(mode, target):
    try:
        manifest = json.loads((BASE / "identity.json").read_text())
    except (OSError, ValueError) as error:
        return {"ok": False, "error": "invalid-identity-manifest", "detail": str(error)}
    if not valid_manifest(manifest):
        return {"ok": False, "error": "invalid-identity-manifest"}
    expected = {}
    if mode == "source":
        expected = {str(BASE / name): value["sha256"] for name, value in manifest["source"].items()}
        expected[str(BASE / "installation-verification.json")] = manifest["installationVerification"]["sha256"]
    elif mode == "installed" and target in manifest["targets"]:
        expected = {value["installedPath"]: value["sha256"] for value in manifest["source"].values() if value["installedPath"] is not None}
        expected.update(manifest["installedUnits"])
        expected[manifest["configPath"]] = manifest["targets"][target]["configSha256"]
    else:
        return {"ok": False, "error": "invalid-probe-mode-or-target"}
    files = {}
    for name, wanted in expected.items():
        actual = digest(Path(name))
        files[name] = {**actual, "expectedSha256": wanted}
        if actual["ok"] and actual["sha256"] != wanted:
            files[name] = {**files[name], "ok": False, "error": "identity-mismatch"}
    result = {"ok": all(item["ok"] for item in files.values()), "mode": mode, "target": target,
              "observedAt": datetime.now(timezone.utc).isoformat(), "files": files}
    if mode == "installed":
        try:
            config = json.loads(Path(manifest["configPath"]).read_text())
            uid = pwd.getpwnam("pi-stack-public-martine").pw_uid
        except (OSError, ValueError, KeyError) as error:
            return {**result, "ok": False, "error": "unreadable-installed-profile", "detail": str(error)}
        if not isinstance(config, dict):
            return {**result, "ok": False, "error": "invalid-installed-profile"}
        required = {"version": 1, "user": "pi-stack-public-martine", "uid": uid,
                    "workspace": "/srv/pi-public/martine", "port": 8899,
                    "remote": target == "converge", "origin": "http://127.0.0.1:8899",
                    "publicationOwner": manifest["publicationOwner"], "privatePlaneUnchanged": True}
        mismatches = [key for key, value in required.items() if key not in config or type(config[key]) is not type(value) or config[key] != value]
        result["profile"] = {"ok": not mismatches, "mismatchedFields": mismatches, "runtimeUid": uid}
        if mismatches:
            result.update(ok=False, error="installed-profile-mismatch")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    commands.add_parser("source")
    installed = commands.add_parser("installed")
    installed.add_argument("--target", required=True, choices=["gmktec", "converge"])
    args = parser.parse_args()
    result = inspect(args.mode, args.target if args.mode == "installed" else None)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
