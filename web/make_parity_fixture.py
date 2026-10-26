"""Dump a demo dataset plus the Python engine's results, for web/parity_test.js."""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from industry_scorer import metrics as m  # noqa: E402
from industry_scorer.config import load_settings  # noqa: E402
from industry_scorer.pipeline import analyze_industry  # noqa: E402
from industry_scorer.providers import DemoProvider  # noqa: E402

settings = load_settings()
p = DemoProvider()
start, end = p.dates[0].date(), p.dates[-1].date()
bench = p.benchmark("SPY", start, end)
as_of = bench.index[-1]
rf_raw = p.risk_free(m.window_start(as_of, 12).date(), as_of.date())
rf_daily = m.to_daily_rf(rf_raw, bench.index)


def ser(s):
    s = s.dropna()
    return {"dates": [d.strftime("%Y-%m-%d") for d in s.index], "closes": [float(x) for x in s.values]}


def clean(v):
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


out = {"as_of": as_of.strftime("%Y-%m-%d"), "bench": ser(bench),
       "rf": [{"date": d.strftime("%Y-%m-%d"), "y": float(y)} for d, y in rf_raw.items()],
       "industries": []}
for ind in p.list_industries():
    raw = p.screener(ind)
    res = analyze_industry(p, settings, ind, bench, rf_daily, as_of)
    syms = raw["symbol"].tolist()
    px = p.prices(syms, start, end)
    out["industries"].append({
        "industry": ind,
        "screener": raw.to_dict(orient="records"),
        "prices": {s: ser(px[s]) for s in px.columns},
        "py_summary": {k: clean(v) for k, v in res.summary.items()},
        "py_constituents": [{k: clean(v) for k, v in r.items()} for r in res.constituents.to_dict(orient="records")],
        "py_index": [float(x) for x in res.index_level.values],
    })

dest = Path(sys.argv[1])
dest.write_text(json.dumps(out))
print("wrote", dest, f"{dest.stat().st_size/1e6:.1f} MB")
