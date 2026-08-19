#!/usr/bin/env python3
"""Replay real lane sessions under mid-run context strategies, v2.

v2 models rung depletion honestly: new content splits into an evictable
share (tool-result bodies + thinking, ~90%) and an unevictable share
(tool args + assistant conclusions, ~10%). Rungs 1-2 remove only the
evictable mass outside the tail; the unevictable residue accumulates
across cuts and is only reset by a rung-3 handoff summary, which fires
when residue exceeds RESIDUE_MAX.

Pricing per provider:
  OpenAI:    cached @ cacheRead, new @ input, whole-request 2x/1.5x tier
             above 272k prompt tokens; a cut un-caches everything after head.
  Anthropic: cached @ cacheRead, new @ cacheWrite (1.25x input), no tier.
"""
import sqlite3
from collections import defaultdict

DB = sqlite3.connect("file:/home/kenan/data/pi-usage/usage.sqlite3?mode=ro", uri=True)

MODELS = {
    "gpt-5.6-sol": dict(
        inp=5e-6, out=30e-6, cr=0.5e-6, cw=None,
        tier=272_000, tin=2.0, tout=1.5, head=30_000),
    "claude-opus-5": dict(
        inp=5e-6, out=25e-6, cr=0.5e-6, cw=6.25e-6,
        tier=None, tin=1.0, tout=1.0, head=47_000),
}
EVICTABLE_SHARE = 0.90
SUMMARY_OUT = 5_000


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
            if d <= 0:
                d = 2_000
            steps.append((d, out))
            prev = ctx
        runs.append(steps)
    return runs


def rates(m, prompt):
    over = m["tier"] and prompt > m["tier"]
    fi = m["tin"] if over else 1.0
    fo = m["tout"] if over else 1.0
    return m["inp"] * fi, m["cr"] * fi, (m["cw"] * fi if m["cw"] else None), m["out"] * fo


def req_cost(m, prompt, cached, out_toks):
    inp, cr, cw, out = rates(m, prompt)
    return cached * cr + (prompt - cached) * (cw or inp) + out_toks * out


def summary_call(m, C):
    inp, cr, cw, out = rates(m, C)
    return C * cr + 500 * (cw or inp) + SUMMARY_OUT * out


def replay(m, runs, trigger, tail, residue_max, kind="ladder"):
    usd = cuts = sums = 0
    peak = land_total = land_n = 0
    for steps in runs:
        E = U = pinned = 0.0   # evictable / unevictable / pinned head+packet
        cached = 0.0
        first = True
        for d, o in steps:
            if first:
                pinned, first = d, False   # head + task packet: pinned, never cut
            else:
                E += d * EVICTABLE_SHARE
                U += d * (1 - EVICTABLE_SHARE)
            C = pinned + E + U
            if trigger and C >= trigger and E + U > tail:
                tail_E = tail * EVICTABLE_SHARE
                tail_U = tail * (1 - EVICTABLE_SHARE)
                land_12 = pinned + U + tail_E      # what rungs 1-2 land at
                if kind == "sum_always" or land_12 > residue_max:
                    usd += summary_call(m, C)
                    E, U = tail_E, SUMMARY_OUT + tail_U
                    sums += 1
                elif kind == "shallow":
                    need = C - (trigger - 30_000)
                    E = max(E - need, tail_E)
                    cuts += 1
                else:                               # ladder rungs 1-2
                    E = tail_E
                    cuts += 1
                C = pinned + E + U
                cached = pinned
                land_total += C
                land_n += 1
            usd += req_cost(m, C, cached, o)
            cached = C
            peak = max(peak, C)
    land = land_total / land_n if land_n else 0
    return usd, cuts, sums, land, peak


for model, m in MODELS.items():
    runs = load(model)
    print(f"\n=== {model}: {len(runs)} sessions, {sum(len(r) for r in runs)} steps ===")
    hdr = f"{'config':>28s} {'sim $':>8s} {'vs unc':>8s} {'cuts':>5s} {'sums':>5s} {'avg land':>9s} {'peak':>6s}"
    print(hdr)
    base = replay(m, runs, None, 0, 0)[0]
    print(f"{'uncapped':>28s} {base:>8.2f} {'100%':>8s} {'-':>5s} {'-':>5s} {'-':>9s} {'-':>6s}")
    grid = [(t, tl, 140_000) for t in (150_000, 200_000, 250_000) for tl in (20_000, 50_000, 80_000)]
    for trig, tl, rmax in grid:
        usd, cuts, sums, land, peak = replay(m, runs, trig, tl, rmax)
        print(f"{'ladder@%dk tail=%dk' % (trig//1000, tl//1000):>28s} {usd:>8.2f} "
              f"{usd/base:>7.1%} {cuts:>5d} {sums:>5d} {land/1000:>8.0f}k {peak/1000:>5.0f}k")
    for rmax in (100_000, 180_000):
        usd, cuts, sums, land, peak = replay(m, runs, 250_000, 50_000, rmax)
        print(f"{'ladder@250k rmax=%dk' % (rmax//1000):>28s} {usd:>8.2f} "
              f"{usd/base:>7.1%} {cuts:>5d} {sums:>5d} {land/1000:>8.0f}k {peak/1000:>5.0f}k")
    for kind, label in (("sum_always", "summary-always@250k"), ("shallow", "shallow@250k")):
        usd, cuts, sums, land, peak = replay(m, runs, 250_000, 50_000, 140_000, kind)
        print(f"{label:>28s} {usd:>8.2f} {usd/base:>7.1%} {cuts:>5d} {sums:>5d} "
              f"{land/1000:>8.0f}k {peak/1000:>5.0f}k")
