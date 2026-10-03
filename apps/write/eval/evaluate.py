#!/usr/bin/env python3
"""Bounded, sequential public-audio replay and offline scoring for Write."""
import argparse
import asyncio
import hashlib
import io
import json
import math
import re
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import wave
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def tokens(text):
    return re.findall(r"[^\W_]+(?:'[^\W_]+)?", text.replace("’", "'").casefold())


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def contains(text, phrase):
    actual, wanted = tokens(text), tokens(phrase)
    return any(actual[i:i + len(wanted)] == wanted for i in range(len(actual) - len(wanted) + 1))


def meaning_checks(fixture, text):
    checks = fixture["meaning"]
    return {"missing": [alternatives for alternatives in checks["required"]
                        if not any(contains(text, phrase) for phrase in alternatives)],
            "forbidden": [phrase for phrase in checks["forbidden"] if contains(text, phrase)]}


def term_counts(text, terms):
    actual = [token.removesuffix("'s") for token in tokens(text)]
    result = Counter()
    for term in terms:
        wanted = tokens(term)
        result[term] = sum(actual[i:i + len(wanted)] == wanted
                           for i in range(len(actual) - len(wanted) + 1))
    return result


def score(fixture, final, dictionary, terms):
    target = fixture.get("dictionary_target", fixture["target"]) if dictionary else fixture["target"]
    raw, cleaned = final["raw"], final["text"]
    expected = Counter(fixture["expected_terms"])
    metrics = {}
    for label, reference, hypothesis in [("raw_verbatim", fixture["verbatim"], raw),
                                          ("raw_target", target, raw), ("clean_target", target, cleaned)]:
        count = len(tokens(reference))
        errors = distance(tokens(reference), tokens(hypothesis))
        metrics[label] = {"errors": errors, "reference_words": count, "wer": errors / max(1, count)}
    checks = meaning_checks(fixture, cleaned)
    lexical_exact = tokens(cleaned) == tokens(target)
    metrics.update(lexical_exact=lexical_exact, formatted_exact=cleaned.strip() == target,
                   meaning_proxy=checks, meaning_proxy_pass=not checks["missing"] and not checks["forbidden"],
                   expectation=fixture["expectation"])
    metrics["expectation_pass"] = metrics["meaning_proxy_pass"] and (
        fixture["expectation"] == "meaning" or metrics["formatted_exact"])
    metrics["dictionary"] = {}
    for label, text in [("raw", raw), ("clean", cleaned)]:
        observed = term_counts(text, terms)
        tp = sum(min(expected[term], observed[term]) for term in terms)
        fp = sum(max(0, observed[term] - expected[term]) for term in terms)
        fn = sum(max(0, expected[term] - observed[term]) for term in terms)
        metrics["dictionary"][label] = {"tp": tp, "fp": fp, "fn": fn,
                                          "unexpected": [term for term in terms if observed[term] > expected[term]]}
    metrics["expectation_pass"] = metrics["expectation_pass"] and metrics["dictionary"]["clean"]["fp"] == 0
    return metrics


def load_manifest():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    if manifest["version"] != 1:
        raise ValueError("unsupported fixture manifest version")
    return manifest


def pcm(fixture):
    path = (ROOT / fixture["audio"]).resolve()
    if ROOT not in path.parents:
        raise ValueError(f"fixture path escapes owner: {path}")
    audio = path.read_bytes()
    if hashlib.sha256(audio).hexdigest() != fixture["sha256"]:
        raise ValueError(f"{fixture['id']}: fixture checksum mismatch")
    with wave.open(io.BytesIO(audio)) as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError(f"{fixture['id']}: expected mono 16 kHz PCM16")
        return source.readframes(source.getnframes())


def check(manifest):
    seen = set()
    seconds = 0
    coverage = Counter()
    for fixture in manifest["fixtures"]:
        if len(set(fixture["tags"])) != len(fixture["tags"]):
            raise ValueError("duplicate coverage tags")
        if fixture["id"] in seen:
            raise ValueError("duplicate fixture id")
        seen.add(fixture["id"])
        if fixture["kind"] not in ("natural-meeting", "synthetic-espeak"):
            raise ValueError("unlabelled recording origin")
        if not fixture["verbatim"] or not fixture["target"]:
            raise ValueError("missing reference")
        if fixture["expectation"] not in ("strict", "meaning"):
            raise ValueError("invalid expectation")
        if not set(fixture["expected_terms"]).issubset(manifest["dictionary"]["words"]):
            raise ValueError("unknown expected dictionary term")
        for target in [fixture["target"], fixture.get("dictionary_target", fixture["target"])]:
            checks = meaning_checks(fixture, target)
            if checks["missing"] or checks["forbidden"]:
                raise ValueError(f"{fixture['id']}: target contradicts authored meaning checks")
        seconds += len(pcm(fixture)) / 32000
        coverage.update(fixture["tags"])
    print(json.dumps({"fixtures": len(seen), "seconds": round(seconds, 3), "coverage": coverage}, indent=2))


def convert(source):
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000",
                             "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-flags:a", "+bitexact",
                             "-f", "wav", "pipe:1"], input=source, capture_output=True, check=True, timeout=5)
    with wave.open(io.BytesIO(result.stdout)) as audio:
        data = audio.readframes(audio.getnframes())
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(data)
    return output.getvalue()


def download(url, maximum=2_000_000):
    with urllib.request.urlopen(url, timeout=15) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("fixture download exceeded 2 MB bound")
    return data


def fetch(fixtures):
    for fixture in fixtures:
        destination = ROOT / fixture["audio"]
        if destination.exists():
            pcm(fixture)
            continue
        if fixture["kind"] != "natural-meeting":
            raise ValueError("synthetic fixture absent: use synthetic.py with its pinned generator")
        source = fixture["source"]
        query = urllib.parse.urlencode({key: source[key] for key in ("dataset", "config", "split")} |
                                       {"offset": source["row"], "length": 1})
        rows = json.loads(download("https://datasets-server.huggingface.co/rows?" + query))["rows"]
        row = rows[0]["row"]
        if row["audio_id"] != source["audio_id"] or row["text"] != source["transcript"]:
            raise ValueError(f"{fixture['id']}: upstream row changed")
        original = download(row["audio"][0]["src"])
        if hashlib.sha256(original).hexdigest() != source["sha256"]:
            raise ValueError(f"{fixture['id']}: upstream bytes changed")
        converted = convert(original)
        if hashlib.sha256(converted).hexdigest() != fixture["sha256"]:
            raise ValueError(f"{fixture['id']}: conversion differs; refusing to install changed fixture")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(converted)
        print(f"Restored {fixture['id']}")


def tight_tail(data):
    # Conservative energy trim is not a phonetic alignment; retain a 20 ms guard.
    samples = struct.unpack(f"<{len(data)//2}h", data)
    end = len(samples)
    while end >= 160:
        window = samples[end - 160:end]
        rms = math.sqrt(sum(value * value for value in window) / 160) / 32768
        if rms > 0.0003:
            break
        end -= 160
    return data[:min(len(samples), end + 320) * 2]


async def replay_one(fixture, manifest, args, dictionary, finish):
    from websockets.asyncio.client import connect
    data = pcm(fixture)
    original_samples = len(data) // 2
    if finish == "tight":
        data = tight_tail(data)
    trimmed_samples = original_samples - len(data) // 2
    if finish == "silence":
        data += bytes(12800)  # 400 ms of actual transmitted PCM silence, not a sleep.
    start = {"type": "start", "audio": "pcm", "dictionary": manifest["dictionary"] if dictionary else {}, "context": ""}
    async with connect(args.url, open_timeout=5, close_timeout=2, max_size=4_000_000) as socket:
        await socket.send(json.dumps(start))
        partials = 0

        async def receive():
            nonlocal partials
            async for message in socket:
                result = json.loads(message)
                if result["type"] == "final":
                    if not isinstance(result.get("raw"), str) or not isinstance(result.get("text"), str):
                        raise ValueError("engine final must supply distinct raw and cleaned text")
                    return result
                if result["type"] == "error":
                    raise ValueError(f"engine error: {result}")
                if result["type"] == "partial":
                    partials += 1
            raise ValueError("engine closed without final")

        receiver = asyncio.create_task(receive())
        began = time.perf_counter()
        chunk = args.chunk_ms * 32
        try:
            for offset in range(0, len(data), chunk):
                if args.pace == "realtime":
                    await asyncio.sleep(max(0, began + offset / 32000 - time.perf_counter()))
                await socket.send(data[offset:offset + chunk])
            if args.pace == "realtime":
                await asyncio.sleep(max(0, began + len(data) / 32000 - time.perf_counter()))
            finished_at = time.perf_counter()
            await socket.send(json.dumps({"type": "finish"}))
            final = await asyncio.wait_for(receiver, args.final_timeout)
            finish_ms = (time.perf_counter() - finished_at) * 1000
        finally:
            if not receiver.done():
                receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
    return {"id": fixture["id"], "kind": fixture["kind"], "sha256": fixture["sha256"],
            "dictionary_enabled": dictionary, "finish": finish, "pace": args.pace, "chunk_ms": args.chunk_ms,
            "sent_seconds": len(data) / 32000, "trimmed_samples": trimmed_samples,
            "client_finish_ms": round(finish_ms, 3), "partial_messages": partials, "final": final,
            "metrics": score(fixture, final, dictionary, manifest["dictionary"]["words"])}


def summary(receipts):
    groups = {}
    for row in receipts:
        key = f"{'dictionary' if row['dictionary_enabled'] else 'plain'}/{row['finish']}/{row['kind']}"
        group = groups.setdefault(key, {"clips": 0, "passed": 0, "meaning_proxy_passed": 0,
                                        "client_finish_ms": [], "errors": Counter(), "words": Counter(),
                                        "dictionary_raw": Counter(), "dictionary_clean": Counter()})
        group["clips"] += 1
        group["passed"] += row["metrics"]["expectation_pass"]
        group["meaning_proxy_passed"] += row["metrics"]["meaning_proxy_pass"]
        group["client_finish_ms"].append(row["client_finish_ms"])
        for label in ("raw_verbatim", "raw_target", "clean_target"):
            group["errors"][label] += row["metrics"][label]["errors"]
            group["words"][label] += row["metrics"][label]["reference_words"]
        for stage in ("raw", "clean"):
            group[f"dictionary_{stage}"].update({k: row["metrics"]["dictionary"][stage][k] for k in ("tp", "fp", "fn")})
    for group in groups.values():
        group["wer"] = {label: group["errors"][label] / max(1, count) for label, count in group["words"].items()}
        for stage in ("raw", "clean"):
            counts = group[f"dictionary_{stage}"]
            counts["precision"] = counts["tp"] / (counts["tp"] + counts["fp"]) if counts["tp"] + counts["fp"] else None
            counts["recall"] = counts["tp"] / (counts["tp"] + counts["fn"]) if counts["tp"] + counts["fn"] else None
    return groups


async def replay(fixtures, manifest, args):
    dictionaries = [False, True] if args.dictionary == "paired" else [args.dictionary == "on"]
    finishes = ["immediate", "tight", "silence"] if args.finish == "all" else [args.finish]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    failures = 0
    with output.open("w") as file:
        for fixture in fixtures:
            for finish in finishes:
                for enabled in dictionaries:
                    receipt = await replay_one(fixture, manifest, args, enabled, finish)
                    file.write(json.dumps(receipt) + "\n")
                    file.flush()
                    failures += not receipt["metrics"]["expectation_pass"]
                    print(f"{fixture['id']} {'dictionary' if enabled else 'plain'} {finish}: "
                          f"{receipt['final']['text']} ({receipt['client_finish_ms']:.1f} ms)", flush=True)
    print(json.dumps(summary([json.loads(line) for line in output.read_text().splitlines()]), indent=2))
    return 1 if args.require_pass and failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "fetch", "replay", "score"])
    parser.add_argument("--id", action="append", help="fixture ID; repeat to select multiple")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=1, help="bounded selection, defaults to one clip")
    parser.add_argument("--url", default="ws://127.0.0.1:8797")
    parser.add_argument("--dictionary", choices=["off", "on", "paired"], default="paired")
    parser.add_argument("--finish", choices=["immediate", "tight", "silence", "all"], default="immediate")
    parser.add_argument("--pace", choices=["realtime", "burst"], default="realtime")
    parser.add_argument("--chunk-ms", type=int, choices=[20, 40, 200], default=20)
    parser.add_argument("--final-timeout", type=float, default=8)
    parser.add_argument("--output", default="/tmp/write-audio-eval.jsonl")
    parser.add_argument("--require-pass", action="store_true", help="exit 1 on failed authored expectations")
    args = parser.parse_args()
    if args.offset < 0 or args.limit < 1 or not 0 < args.final_timeout <= 30:
        parser.error("offset >= 0, limit >= 1 and final-timeout in (0, 30] required")
    manifest = load_manifest()
    fixtures = [fixture for fixture in manifest["fixtures"] if not args.id or fixture["id"] in args.id]
    if args.id and set(args.id) - {fixture["id"] for fixture in fixtures}:
        parser.error("unknown fixture id")
    fixtures = fixtures[args.offset:args.offset + args.limit]
    if args.command == "check":
        check(manifest)
    elif args.command == "fetch":
        fetch(fixtures)
    elif args.command == "score":
        by_id = {fixture["id"]: fixture for fixture in manifest["fixtures"]}
        rows = [json.loads(line) for line in Path(args.output).read_text().splitlines()]
        for row in rows:
            fixture = by_id[row["id"]]
            if row["sha256"] != fixture["sha256"]:
                raise ValueError("receipt belongs to changed fixture")
            row["metrics"] = score(fixture, row["final"], row["dictionary_enabled"], manifest["dictionary"]["words"])
        print(json.dumps(summary(rows), indent=2))
    else:
        if not fixtures:
            parser.error("empty fixture selection")
        return asyncio.run(replay(fixtures, manifest, args))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, TimeoutError) as error:
        print(f"Write evaluation failed: {error}", file=sys.stderr)
        sys.exit(2)
