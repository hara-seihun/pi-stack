"""Regress reported context tokens on measured context bytes by category."""
import json, sqlite3, datetime
from pathlib import Path
import numpy as np

db = sqlite3.connect("/home/kenan/data/pi-usage/usage.sqlite3")
LANES = ('research-frontier','research-cayley-ci','research-cayley-ci-synthesis','research-cayley-ci-alignment')

def ts(e):
    try: return datetime.datetime.fromisoformat(e.get("timestamp","").replace("Z","+00:00")).timestamp()*1000
    except Exception: return 0.0

def session_series(file):
    """(time, category-bytes-cumulative) after each message."""
    cum = np.zeros(4)  # text-ish, signature, tool_result, tool_args
    series = []
    for line in open(file, errors="replace"):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") != "message": continue
        m = e["message"]; role = m.get("role"); c = m.get("content")
        if role == "toolResult":
            for b in c or []:
                if isinstance(b, dict) and b.get("type") == "text": cum[2] += len(str(b.get("text") or "").encode())
        elif role == "bashExecution": cum[2] += len(str(m.get("output") or "").encode())
        elif role in ("user", "custom"):
            if isinstance(c, str): cum[0] += len(c.encode())
            else:
                for b in c or []:
                    if isinstance(b, dict) and b.get("type") == "text": cum[0] += len(str(b.get("text") or "").encode())
        elif role == "assistant":
            for b in c or []:
                if not isinstance(b, dict): continue
                t = b.get("type")
                if t == "text": cum[0] += len(str(b.get("text") or "").encode())
                elif t == "thinking":
                    cum[0] += len(str(b.get("thinking") or "").encode())
                    cum[1] += len(str(b.get("thinkingSignature") or "").encode())
                elif t in ("toolCall", "tool_use"): cum[3] += len(json.dumps(b.get("arguments") or b.get("input") or {}).encode())
        series.append((ts(e), cum.copy()))
    return series

for family, like in (("claude", "claude%"), ("gpt-5.6", "gpt-5.6%")):
    rows = db.execute(f"""select distinct s.session_id, s.session_file from session s join request r on r.session_id=s.session_id
        where s.owner_kind='orchestrator' and s.owner_label in {LANES} and r.model like ? limit 40""", (like,)).fetchall()
    X, y = [], []
    for sid, file in rows:
        if not file or not Path(file).is_file(): continue
        series = session_series(file)
        if not series: continue
        times = np.array([t for t, _ in series]); vals = np.array([v for _, v in series])
        for at, ctx in db.execute("select started_at, input_tokens+cache_read_tokens+cache_write_tokens from request where session_id=? and error_category='none' and input_tokens+cache_read_tokens+cache_write_tokens>20000", (sid,)):
            i = np.searchsorted(times, at) - 1
            if i < 1: continue
            X.append(vals[i]); y.append(ctx)
    if len(X) < 30: print(family, "insufficient"); continue
    X = np.array(X); y = np.array(y)
    # add a constant column for system prompt + tool schemas
    A = np.hstack([X, np.ones((len(X), 1))])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    names = ["text/thinking", "signature/opaque", "tool_result", "tool_args", "const(sys+schema)"]
    pred = A @ coef
    print(f"\n{family}: n={len(y)}  R^2={1 - ((y-pred)**2).sum()/((y-y.mean())**2).sum():.4f}")
    for n, c in zip(names, coef):
        if n.startswith("const"): print(f"  {n:20s} {c:10.0f} tokens")
        else: print(f"  {n:20s} {c:8.3f} tok/byte  ({1/c if c>0 else float('nan'):.2f} bytes/token)")
    share = (X.mean(axis=0) * coef[:4]); share = share / share.sum() * 100
    print("  token share at mean:", ", ".join(f"{n}={s:.1f}%" for n, s in zip(names, share)))
