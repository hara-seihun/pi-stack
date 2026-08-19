"""Replay real research-lane sessions under different compaction caps."""
import sqlite3, statistics
from collections import defaultdict

DB = sqlite3.connect("/home/kenan/data/pi-usage/usage.sqlite3")
LANES = ('research-frontier','research-cayley-ci','research-cayley-ci-synthesis','research-cayley-ci-alignment',
         'research-formalization','research-admission','research-formalization-repair','research-cayley-ci-intake')

PRICE = {  # per token
  "claude-opus-5":  dict(inp=5e-6, out=25e-6, cr=0.5e-6, cw=6.25e-6, tier=None, base=25000),
  "gpt-5.6-sol":    dict(inp=5e-6, out=30e-6, cr=0.5e-6, cw=6.25e-6,
                         tier=(272000, dict(inp=10e-6, out=45e-6, cr=1e-6, cw=12.5e-6)), base=8000),
  "gpt-5.6-luna":   dict(inp=0.2e-6, out=1.2e-6, cr=0.02e-6, cw=0.25e-6,
                         tier=(272000, dict(inp=0.4e-6, out=1.8e-6, cr=0.04e-6, cw=0.5e-6)), base=8000),
}
KEEP_RECENT, SUMMARY_OUT = 20000, 4000

def prices(model, ctx):
    p = PRICE[model]
    if p["tier"] and ctx > p["tier"][0]:
        q = dict(p); q.update(p["tier"][1]); return q
    return p

def simulate(model, turns, cap):
    """turns: [(delta_tokens, output_tokens)]; returns (usd, prefix_tokens, compactions)"""
    p0 = PRICE[model]
    floor = p0["base"] + KEEP_RECENT + SUMMARY_OUT
    ctx, usd, prefix, compactions = 0, 0.0, 0, 0
    for delta, out in turns:
        if cap and ctx + delta > cap and ctx > floor:
            pc = prices(model, ctx)
            usd += ctx * pc["inp"] + SUMMARY_OUT * pc["out"]      # compaction call: uncached full context
            compactions += 1
            prefix += ctx
            ctx = floor
            usd += ctx * pc["cw"]                                  # rewrite the new cached prefix
        ctx += delta
        pc = prices(model, ctx)
        usd += (ctx - delta) * pc["cr"] + delta * pc["inp"] + out * pc["out"]
        prefix += ctx
    return usd, prefix, compactions

def load(model):
    sessions = defaultdict(list)
    q = """select r.session_id, r.started_at,
                  r.input_tokens+r.cache_read_tokens+r.cache_write_tokens ctx, r.output_tokens
           from request r join session s using(session_id)
           where s.owner_kind='orchestrator' and s.owner_label in %s and r.model=? and r.error_category='none'
           order by r.session_id, r.started_at, r.sequence""" % (LANES,)
    for sid, at, ctx, out in DB.execute(q, (model,)):
        sessions[sid].append((ctx or 0, out or 0))
    turns = {}
    for sid, seq in sessions.items():
        if len(seq) < 5: continue
        prev, ts = 0, []
        for ctx, out in seq:
            d = ctx - prev
            if d < 0: d = ctx          # a compaction or branch reset already happened
            ts.append((d, out)); prev = ctx
        turns[sid] = ts
    return turns

CAPS = [80_000, 120_000, 160_000, 200_000, 272_000, 400_000, None]
for model in ("claude-opus-5", "gpt-5.6-sol", "gpt-5.6-luna"):
    turns = load(model)
    if not turns: continue
    actual = sum(r[0] for r in DB.execute(
        "select sum(cost_total) from request r join session s using(session_id) where s.owner_kind='orchestrator' and s.owner_label in %s and r.model=? and r.error_category='none'" % (LANES,), (model,)) )
    peaks = sorted(sum(d for d, _ in t) for t in turns.values())
    print(f"\n=== {model}: {len(turns)} sessions, median total new content {statistics.median(peaks)/1000:.0f}k tok, "
          f"p90 {peaks[int(0.9*len(peaks))-1]/1000:.0f}k tok  (recorded spend ${actual:,.0f})")
    print(f"{'cap':>9s} {'sim $':>10s} {'vs uncapped':>12s} {'prefix Gtok':>12s} {'compactions/session':>20s} {'sessions compacting':>20s}")
    base = None
    for cap in CAPS:
        tot_usd = tot_prefix = tot_comp = 0; touched = 0
        for sid, ts in turns.items():
            usd, prefix, comp = simulate(model, ts, cap)
            tot_usd += usd; tot_prefix += prefix; tot_comp += comp; touched += 1 if comp else 0
        if base is None and cap is None: base = tot_usd
        label = f"{cap//1000}k" if cap else "none"
        print(f"{label:>9s} {tot_usd:10,.0f} {'':>12s} {tot_prefix/1e9:12.1f} {tot_comp/len(turns):20.2f} {touched:20d}", end="")
        print()
    # second pass for ratios
    uncapped = simulate_total = None
    tot = {}
    for cap in CAPS:
        tot[cap] = sum(simulate(model, ts, cap)[0] for ts in turns.values())
    print("  ratio vs uncapped: " + ", ".join(f"{(f'{c//1000}k' if c else 'none')}={tot[c]/tot[None]:.2f}x" for c in CAPS))
