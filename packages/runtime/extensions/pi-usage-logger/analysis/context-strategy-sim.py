#!/usr/bin/env python3
"""Replay real lane sessions under candidate mid-run context strategies.

Drives each strategy with the recorded per-step context growth (the work
stream) and prices requests with each provider's caching semantics:
  - OpenAI: cached tokens at cacheRead rate, new tokens at input rate,
    whole-request 2x/1.5x tier above 272k prompt tokens. Cache re-forms
    automatically; a cut makes everything after the head uncached once.
  - Anthropic: cached tokens at cacheRead, newly cached tokens at cacheWrite
    (1.25x input), no tier. A cut rewrites everything after the head once.

Strategies:
  uncapped              status quo mid-run (no check until run end)
  ladder@T              evict tool results + strip old reasoning at trigger T,
                        land at head + 10% residue + 50k verbatim tail;
                        falls back to in-context summary when residue > 140k
  shallow@250k          evict only enough to get 30k under the trigger
                        (the anti-pattern: frequent cuts, same invalidation)
  summary_incontext@250 always summarize via appended prompt (cache-hot read)
  summary_fresh@250     pi-style: serialize ~70% of context as fresh uncached
                        input to a separate call
"""
import sqlite3
from collections import defaultdict

DB = sqlite3.connect("file:/home/kenan/data/pi-usage/usage.sqlite3?mode=ro", uri=True)

MODELS = {
    "gpt-5.6-sol": dict(
        inp=5e-6, out=30e-6, cr=0.5e-6, cw=None,
        tier=272_000, tin=2.0, tout=1.5,
        head=30_000, keep=0.10),
    "claude-opus-5": dict(
        inp=5e-6, out=25e-6, cr=0.5e-6, cw=6.25e-6,
        tier=None, tin=1.0, tout=1.0,
        head=47_000, keep=0.10),
}
TAIL, SUMMARY_OUT, RESIDUE_MAX = 50_000, 5_000, 140_000


def load(model):
    q = """SELECT r.session_id, r.input_tokens+r.cache_read_tokens+r.cache_write_tokens,
                  r.output_tokens
           FROM request r JOIN session s USING(session_id)
           WHERE s.owner_kind='orchestrator' AND r.error_category='none'
             AND r.started_at > strftime('%s','now','-14 days')*1000 AND r.model=?
           ORDER BY r.session_id, r.started_at, r.sequence"""
    sess = defaultdict(list)
    for sid, ctx, out in DB.execute(q, (model,)):
        sess[sid].append((ctx or 0, out or 0))
    runs = []
    for seq in sess.values():
        if len(seq) < 10:
            continue
        prev, steps = 0, []
        for ctx, out in seq:
            d = ctx - prev
            if d <= 0:          # a recorded compaction/reset: nominal step
                d = 2_000
            steps.append((d, out))
            prev = ctx
        runs.append(steps)
    return runs


def rates(m, prompt):
    over = m["tier"] and prompt > m["tier"]
    f_in = m["tin"] if over else 1.0
    f_out = m["tout"] if over else 1.0
    return m["inp"] * f_in, m["cr"] * f_in, (m["cw"] * f_in if m["cw"] else None), m["out"] * f_out


def request_cost(m, prompt, cached, out_toks):
    inp, cr, cw, out = rates(m, prompt)
    new = prompt - cached
    new_rate = cw if cw else inp
    return cached * cr + new * new_rate + out_toks * out


def ladder_land(m, C):
    tail = min(TAIL, max(C - m["head"], 0))
    residue = m["head"] + m["keep"] * max(C - m["head"] - tail, 0)
    return residue + tail, residue


def summary_cost_incontext(m, C):
    inp, cr, cw, out = rates(m, C)
    return C * cr + 500 * (cw if cw else inp) + SUMMARY_OUT * out


def summary_cost_fresh(m, C):
    serialized = 0.7 * C
    inp, cr, cw, out = rates(m, serialized)
    return serialized * inp + SUMMARY_OUT * out


def replay(m, runs, kind, trigger):
    usd = cuts = summaries = 0
    peak = 0
    for steps in runs:
        C = cached = 0.0
        for d, o in steps:
            nxt = C + d
            if trigger and nxt >= trigger and C > m["head"] + TAIL:
                if kind == "ladder":
                    land, residue = ladder_land(m, C)
                    if residue > RESIDUE_MAX:
                        usd += summary_cost_incontext(m, C)
                        land = m["head"] + SUMMARY_OUT + min(TAIL, C - m["head"])
                        summaries += 1
                    else:
                        cuts += 1
                elif kind == "shallow":
                    land = trigger - 30_000
                    cuts += 1
                elif kind == "sum_ic":
                    usd += summary_cost_incontext(m, C)
                    land = m["head"] + SUMMARY_OUT + min(TAIL, C - m["head"])
                    summaries += 1
                elif kind == "sum_fresh":
                    usd += summary_cost_fresh(m, C)
                    land = m["head"] + SUMMARY_OUT + 20_000
                    summaries += 1
                C, cached = land, m["head"]
                nxt = C + d
            usd += request_cost(m, nxt, cached, o)
            C = cached = nxt
            peak = max(peak, nxt)
    return usd, cuts, summaries, peak


STRATS = [
    ("uncapped", None, None),
    ("ladder", "ladder", 150_000),
    ("ladder", "ladder", 200_000),
    ("ladder", "ladder", 250_000),
    ("ladder", "ladder", 300_000),
    ("shallow", "shallow", 250_000),
    ("sum_ic", "sum_ic", 250_000),
    ("sum_fresh", "sum_fresh", 250_000),
]

for model, m in MODELS.items():
    runs = load(model)
    n_steps = sum(len(r) for r in runs)
    print(f"\n=== {model}: {len(runs)} sessions, {n_steps} steps replayed ===")
    print(f"{'strategy':>22s} {'sim $':>9s} {'vs uncapped':>12s} {'cuts':>6s} {'summaries':>10s} {'peak ctx':>9s}")
    base = None
    for name, kind, trig in STRATS:
        usd, cuts, sums, peak = replay(m, runs, kind, trig)
        if base is None:
            base = usd
        label = name if not trig else f"{name}@{trig//1000}k"
        print(f"{label:>22s} {usd:>9.2f} {usd/base:>11.2%} {cuts:>6d} {sums:>10d} {peak/1000:>8.0f}k")
