#!/usr/bin/env python3
"""Regenerate the explicitly synthetic extras, never natural AMI recordings."""
import argparse
import hashlib
import io
import json
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RECIPES = [
    ("domain-kenan", "Send the file to Kenan.", "Send the file to Kenan.", ["Kenan"]),
    ("domain-kelana", "Kelana opens the file.", "Kelana opens the file.", ["Kelana"]),
    ("negative-canon", "Send the file to Canon.", "Send the file to Canon.", []),
    ("negative-call-anna", "Call Anna tomorrow.", "Call Anna tomorrow.", []),
    ("replacement-positive", "Open lantern works.", "Open lantern works.", ["LanternWorks"]),
    ("replacement-negative", "Open the lantern and close the window.", "Open the lantern and close the window.", []),
]


def render(text):
    audio = subprocess.run(["espeak-ng", "-v", "en-gb", "-s", "155", "--stdout", text],
                           check=True, capture_output=True, timeout=5).stdout
    converted = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000",
                                "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
                               input=audio, check=True, capture_output=True, timeout=5).stdout
    with wave.open(io.BytesIO(converted)) as source:
        pcm = source.readframes(source.getnframes())
    result = io.BytesIO()
    with wave.open(result, "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(pcm)
    return result.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare to committed hashes without writing")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    existing = {item["id"]: item for item in manifest["fixtures"]}
    version = subprocess.run(["espeak-ng", "--version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    generated = []
    for name, text, target, terms in RECIPES:
        audio = render(text)
        digest = hashlib.sha256(audio).hexdigest()
        if args.check:
            if digest != existing[name]["sha256"]:
                raise SystemExit(f"{name}: generator output differs; do not silently change fixture")
            continue
        path = f"audio/{name}.wav"
        (ROOT / path).write_bytes(audio)
        fixture = {"id": name, "audio": path, "sha256": digest, "kind": "synthetic-espeak",
                   "license": "CC0-1.0", "exposure": "authored-diagnostic-not-holdout",
                   "source": {"generator": version, "voice": "en-gb", "speed": 155, "text": text},
                   "verbatim": text, "target": target, "expectation": "strict", "expected_terms": terms,
                   "tags": ["synthetic", "dictionary-positive" if terms else "dictionary-negative"],
                   "meaning": {"required": [[target.rstrip(".")]], "forbidden": []}}
        if name == "replacement-positive":
            fixture["dictionary_target"] = "Open LanternWorks."
            fixture["meaning"]["required"] = [["open"], ["lantern works", "LanternWorks"]]
            fixture["tags"].append("dictionary-replacement")
        generated.append(fixture)
    if not args.check:
        manifest["fixtures"] = [item for item in manifest["fixtures"] if item["kind"] != "synthetic-espeak"] + generated
        (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{'Checked' if args.check else 'Generated'} {len(RECIPES)} synthetic clips; {version}")


if __name__ == "__main__":
    main()
