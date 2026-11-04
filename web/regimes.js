/* Industry Scorer: "times like this" — the past months that looked most like today, for one industry.
 *
 * Each month since 2009 gets a fingerprint: the macro backdrop (the Fed funds rate and its 12-month change, CPI
 * inflation, unemployment and its change, Treasuries, credit, oil, the dollar, the VIX, the S&P 500's 6-month return
 * and drawdown) and the industry's own setup (3- and 12-month returns, distance from its 200-day average, 6 months vs
 * the S&P 500, P/E percentile, drawdown). Today's fingerprint is compared with every past month (each feature
 * standardized; missing ones skipped), and the closest months, at least 9 months apart, become the episodes. For each,
 * code measures what the industry and the S&P 500 did over the next 1, 3, 6 and 12 months, the worst drop in the
 * next 6 months, and the path. The 20 closest months (3+ months apart) give the base rates the calls start from.
 * Pure functions, no I/O.
 */
(function (root) {
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const H = { "1M": 21, "3M": 63, "6M": 126, "12M": 252 };
  const FEATURES = [
    // key, label, unit, group, weight
    ["ff", "Fed funds rate", "%", "macro", 1], ["ff12", "Fed funds change over 12 months", "pp", "macro", 1],
    ["cpi", "CPI inflation, year on year", "%", "macro", 1], ["un", "Unemployment rate", "%", "macro", 0.8], ["un12", "Unemployment change over 12 months", "pp", "macro", 0.8],
    ["rates6", "7-10 year Treasuries (IEF), 6 months (down = yields up)", "%", "macro", 1], ["credit6", "High-yield bonds vs Treasuries, 6 months", "pp", "macro", 0.8],
    ["oil6", "Oil (USO), 6 months", "%", "macro", 0.8], ["usd6", "US dollar (UUP), 6 months", "%", "macro", 0.7], ["vix", "VIX", "", "macro", 1],
    ["spy6", "S&P 500, 6 months", "%", "market", 1], ["spydd", "S&P 500 below its 12-month high", "%", "market", 0.8],
    ["i3", "Industry, 3 months", "%", "industry", 1.2], ["i12", "Industry, 12 months", "%", "industry", 1.2], ["v200", "Industry vs its 200-day average", "%", "industry", 1.1],
    ["rel6", "Industry vs S&P 500, 6 months", "pp", "industry", 1.1], ["pe", "Industry P/E percentile (own history)", "pctile", "industry", 1], ["idd", "Industry below its 12-month high", "%", "industry", 0.9],
  ];
  const FMAP = Object.fromEntries(FEATURES.map(([k, label, unit, group, w]) => [k, { key: k, label, unit, group, w }]));

  function quant(a, q) { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
  const stats = (a) => { const v = a.filter(isNum); return { n: v.length, median: quant(v, 0.5), p25: quant(v, 0.25), p75: quant(v, 0.75), pos: v.length ? v.filter((x) => x > 0).length / v.length : NaN }; };
  const sd = (a) => { const v = a.filter(isNum); if (v.length < 3) return NaN; const m = v.reduce((x, y) => x + y, 0) / v.length; return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / (v.length - 1)); };
  const r1 = (x, k = 1) => (isNum(x) ? Math.round(x * 10 ** k) / 10 ** k : null);

  /** Index of the last date <= d in a sorted date list (binary search), or -1. */
  function at(dates, d) { let lo = 0, hi = dates.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
  /** A daily series' value on or before d, if it is no more than `staleDays` old. */
  function valueAt(s, d, staleDays = 10) { if (!s?.dates?.length) return NaN; const i = at(s.dates, d); if (i < 0) return NaN; return (Date.parse(d) - Date.parse(s.dates[i])) / 864e5 <= staleDays ? s.values[i] : NaN; }
  const addMonths = (d, k) => { const t = new Date(d.slice(0, 10) + "T00:00:00Z"); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() + k); return t.toISOString().slice(0, 10); };
  const monthEnd = (d) => { const t = new Date(d.slice(0, 7) + "-01T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0); return t.toISOString().slice(0, 10); };
  /** n-month return of a daily series ending at d (in %). */
  function ret(s, d, months) { const a = valueAt(s, d), b = valueAt(s, monthEnd(addMonths(d, -months)), 12); return isNum(a) && isNum(b) && b > 0 ? (a / b - 1) * 100 : NaN; }
  /** How far below its 12-month high the series is at d (in %, <= 0). */
  function drawdown(s, d) { const i = at(s.dates, d); if (i < 200) return NaN; let hi = -Infinity; for (let j = Math.max(0, i - 252); j <= i; j++) hi = Math.max(hi, s.values[j]); return (s.values[i] / hi - 1) * 100; }

  /** Monthly indicator rows [{date, value}] -> {dates, values} (the reference month's first day). */
  const monthly = (rows) => { const pts = (rows || []).filter((r) => r?.date && isNum(+r.value)).map((r) => [String(r.date).slice(0, 10), +r.value]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const dates = [], values = []; for (const [d, v] of pts) { if (dates.length && dates[dates.length - 1] === d) continue; dates.push(d); values.push(v); } return { dates, values }; };

  /**
   * The fingerprint for month-end date d. mk: {spy, ief, hyg, uso, uup, vix} daily series {dates, values};
   * {ff, cpi, un} monthly series. ind: the industry's daily index {dates, values}; pePct(d): its P/E percentile or NaN.
   */
  function fingerprint(d, mk, ind, pePct) {
    // Monthly indicators are dated by the month they describe and come out 2-6 weeks later: take the latest reading
    // within ~3 months (today's often describes the month before last).
    const mv = (s, back = 0) => valueAt(s, back ? monthEnd(addMonths(d, -back)) : d, 100);
    const f = {};
    f.ff = mv(mk.ff); f.ff12 = isNum(f.ff) && isNum(mv(mk.ff, 12)) ? f.ff - mv(mk.ff, 12) : NaN;
    const c0 = mv(mk.cpi), c12 = mv(mk.cpi, 12); f.cpi = isNum(c0) && isNum(c12) && c12 > 0 ? (c0 / c12 - 1) * 100 : NaN;
    f.un = mv(mk.un); f.un12 = isNum(f.un) && isNum(mv(mk.un, 12)) ? f.un - mv(mk.un, 12) : NaN;
    f.rates6 = ret(mk.ief, d, 6); const hy = ret(mk.hyg, d, 6); f.credit6 = isNum(hy) && isNum(f.rates6) ? hy - f.rates6 : NaN;
    f.oil6 = ret(mk.uso, d, 6); f.usd6 = ret(mk.uup, d, 6); f.vix = valueAt(mk.vix, d);
    f.spy6 = ret(mk.spy, d, 6); f.spydd = mk.spy?.dates?.length ? drawdown(mk.spy, d) : NaN;
    f.i3 = ret(ind, d, 3); f.i12 = ret(ind, d, 12);
    const i = at(ind.dates, d); if (i >= 199) { let s = 0; for (let j = i - 199; j <= i; j++) s += ind.values[j]; f.v200 = (ind.values[i] / (s / 200) - 1) * 100; } else f.v200 = NaN;
    const i6 = ret(ind, d, 6); f.rel6 = isNum(i6) && isNum(f.spy6) ? i6 - f.spy6 : NaN;
    f.pe = pePct ? pePct(d) : NaN; f.idd = drawdown(ind, d);
    return f;
  }

  /** Forward returns from date d over each horizon (in %), the worst drop over the next 6 months, and a monthly path. */
  function forward(s, d) {
    const i = at(s.dates, d); const out = { ret: {}, maxdd6: null, path: [] }; if (i < 0) return out;
    for (const [h, n] of Object.entries(H)) out.ret[h] = i + n < s.values.length ? r1((s.values[i + n] / s.values[i] - 1) * 100) : null;
    let peak = s.values[i], dd = 0; for (let j = i + 1; j <= Math.min(s.values.length - 1, i + 126); j++) { peak = Math.max(peak, s.values[j]); dd = Math.min(dd, s.values[j] / peak - 1); }
    out.maxdd6 = i + 5 < s.values.length ? r1(dd * 100) : null;
    for (let m = 0; m <= 12; m++) { const j = i + Math.round(m * 21); if (j >= s.values.length) break; out.path.push(r1((s.values[j] / s.values[i] - 1) * 100)); }
    return out;
  }

  /**
   * The episodes. ind: {dates, values} (daily industry index since 2008); pe: {dates, pe} or null; mk: market and
   * macro series (any may be missing); today: the last date. Returns null without enough history.
   */
  function episodes({ ind, pe = null, mk = {}, today, k = 5, pool = 20, gapMonths = 9, recentMonths = 12 }) {
    if (!ind?.dates?.length || ind.dates.length < 600) return null;
    const last = ind.dates[ind.dates.length - 1], now = today && today < last ? today : last;
    let pePct = null;
    if (pe?.dates?.length > 250) { const sorted = [...pe.pe].filter(isNum).sort((a, b) => a - b); const ser = { dates: pe.dates, values: pe.pe };
      pePct = (d) => { const v = valueAt(ser, d, 20); if (!isNum(v)) return NaN; let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; } return (lo / sorted.length) * 100; }; }
    // Month-end trading days, from the first with 12 months of history behind it.
    const ends = []; for (let i = 0; i < ind.dates.length; i++) { const d = ind.dates[i]; if (i === ind.dates.length - 1 || ind.dates[i + 1].slice(0, 7) !== d.slice(0, 7)) ends.push(d); }
    const first = addMonths(ind.dates[0], 13);
    const months = ends.filter((d) => d >= first && d < now);
    const fNow = fingerprint(now, mk, ind, pePct);
    const rows = months.map((d) => ({ d, f: fingerprint(d, mk, ind, pePct) }));
    if (rows.length < 36) return null;
    const keys = FEATURES.map(([kk]) => kk).filter((kk) => isNum(fNow[kk]) && rows.filter((r) => isNum(r.f[kk])).length >= rows.length * 0.5);
    if (keys.length < 4) return null;
    const sds = Object.fromEntries(keys.map((kk) => [kk, sd(rows.map((r) => r.f[kk])) || 1]));
    const totW = keys.reduce((a, kk) => a + FMAP[kk].w, 0);
    for (const r of rows) { let s = 0, w = 0; for (const kk of keys) { if (!isNum(r.f[kk])) continue; s += FMAP[kk].w * ((r.f[kk] - fNow[kk]) / sds[kk]) ** 2; w += FMAP[kk].w; }
      r.dist = w >= totW * 0.6 ? Math.sqrt(s / w) : Infinity; }
    const cutoff = addMonths(now, -recentMonths);
    const ranked = rows.filter((r) => isNum(r.dist) && r.dist < Infinity).sort((a, b) => a.dist - b.dist);
    const N = ranked.length;
    const pick = (n, gap, list) => { const out = []; for (const r of list) { if (r.d > cutoff) continue; if (out.every((o) => Math.abs((Date.parse(o.d) - Date.parse(r.d)) / (30.44 * 864e5)) >= gap)) out.push(r); if (out.length >= n) break; } return out; };
    const top = pick(k, gapMonths, ranked), wide = pick(pool, 3, ranked);
    const spy = mk.spy?.dates?.length ? mk.spy : null;
    const fmt = (kk, v) => (isNum(v) ? r1(v, FMAP[kk].unit === "" || FMAP[kk].unit === "pctile" ? 0 : 1) : null);
    const ep = top.map((r) => {
      const fi = forward(ind, r.d), fs = spy ? forward(spy, r.d) : { ret: {}, path: [] };
      const diffs = keys.filter((kk) => isNum(r.f[kk])).map((kk) => ({ key: kk, z: Math.abs(r.f[kk] - fNow[kk]) / sds[kk] })).sort((a, b) => a.z - b.z);
      return { date: r.d, month: r.d.slice(0, 7), similarity: Math.round((1 - ranked.indexOf(r) / N) * 1000) / 10, distance: r1(r.dist, 2),
        then: Object.fromEntries(keys.map((kk) => [kk, fmt(kk, r.f[kk])])),
        alike: diffs.slice(0, 4).map((x) => x.key), unlike: diffs.slice(-3).reverse().map((x) => x.key),
        industry: fi.ret, spy: fs.ret, excess: Object.fromEntries(Object.keys(H).map((h) => [h, isNum(fi.ret[h]) && isNum(fs.ret[h]) ? r1(fi.ret[h] - fs.ret[h]) : null])),
        maxdd6: fi.maxdd6, path: fi.path, spy_path: fs.path };
    });
    const allIdx = rows.filter((r) => r.d <= cutoff).map((r) => r.d);
    const base = {};
    for (const h of Object.keys(H)) {
      const w = wide.map((r) => forward(ind, r.d).ret[h]), a = allIdx.map((d) => forward(ind, d).ret[h]);
      const ex = spy ? wide.map((r) => { const x = forward(ind, r.d).ret[h], y = forward(spy, r.d).ret[h]; return isNum(x) && isNum(y) ? x - y : NaN; }) : [];
      const t = top.map((r) => forward(ind, r.d).ret[h]).filter(isNum);
      base[h] = { top_up: t.filter((x) => x > 0).length, top_n: t.length, top_median: r1(quant(t, 0.5)),
        ...Object.fromEntries(Object.entries(stats(w)).map(([kk, v]) => [kk, kk === "n" ? v : kk === "pos" ? r1(v * 100, 0) : r1(v)])),
        beat_spy: spy ? r1(stats(ex).pos * 100, 0) : null, all_pos: r1(stats(a).pos * 100, 0), all_median: r1(quant(a, 0.5)) };
    }
    return { as_of: now, months: N, features: keys, now: Object.fromEntries(keys.map((kk) => [kk, fmt(kk, fNow[kk])])), episodes: ep, base, pool: wide.length,
      pool_dates: wide.map((r) => r.d.slice(0, 7)).sort() };
  }

  /** "Fed funds 5.3%, CPI 3.1%, ..." for a fingerprint (the keys in order given). */
  const fval = (kk, v) => { if (!isNum(v)) return "n/a"; const u = FMAP[kk].unit; return u === "pctile" ? `${Math.round(v)}th pct` : u === "" ? `${v}` : u === "pp" ? `${v > 0 ? "+" : ""}${v}pp` : `${kk === "ff" || kk === "cpi" || kk === "un" ? "" : v > 0 ? "+" : ""}${v}%`; };
  const pc = (x) => (isNum(x) ? `${x > 0 ? "+" : ""}${x}%` : "n/a");
  /** The episodes and base rates as prompt text (HE1-HE5 to cite). */
  function text(R) {
    if (!R?.episodes?.length) return "";
    const L = [`TIMES LIKE THIS (computed by code from ${R.months} month-ends since 2009: the macro backdrop and the industry's own setup, today vs every past month)`];
    L.push(`Today (${R.as_of}): ${R.features.map((kk) => `${FMAP[kk].label} ${fval(kk, R.now[kk])}`).join("; ")}.`);
    for (const [i, e] of R.episodes.entries()) {
      L.push(`[HE${i + 1}] ${e.month} (closer than ${e.similarity}% of all months). Then: ${R.features.map((kk) => `${FMAP[kk].label} ${fval(kk, e.then[kk])}`).join("; ")}. Most alike: ${e.alike.map((kk) => FMAP[kk].label).join(", ")}; least alike: ${e.unlike.map((kk) => FMAP[kk].label).join(", ")}. After: industry ${Object.keys(H).map((h) => `${h} ${pc(e.industry[h])}`).join(", ")}; S&P 500 ${Object.keys(H).map((h) => `${h} ${pc(e.spy[h])}`).join(", ")}; worst drop in the next 6 months ${pc(e.maxdd6)}.`);
    }
    L.push(`Base rates from the ${R.pool} closest months (3+ months apart) vs all months: ${Object.entries(R.base).map(([h, b]) => `${h}: up ${b.pos ?? "n/a"}% of the time (all months ${b.all_pos ?? "n/a"}%), median ${pc(b.median)} (middle half ${pc(b.p25)} to ${pc(b.p75)})${isNum(b.beat_spy) ? `, beat the S&P 500 ${b.beat_spy}%` : ""}; the 5 episodes: up ${b.top_up} of ${b.top_n}`).join("; ")}.`);
    return L.join("\n");
  }

  /** The historian's prompt: what was going on in each episode, what happened next and why, and what differs now. */
  function historianPrompt(name, R, { today, thesis = "" } = {}) {
    return `You are the market historian for the US-listed "${name}" industry. Today is ${today}. Code compared today's macro backdrop and the industry's own setup with every month since 2009 and found the five most similar past months (TIMES LIKE THIS). For each, it measured what the industry and the S&P 500 did next.
${thesis ? `\nTHE TEAM'S CURRENT VIEW: ${thesis}\n` : ""}
${text(R)}

For each episode, write from what you know of market history:
- "then": what was going on in markets and the economy that month, and for this industry (2 sentences; well-known events only, e.g. a Fed pivot, a recession scare, an oil collapse, a war, a pandemic wave).
- "after": what happened over the next 12 months and why, using the measured returns above for every number (2-3 sentences). Never invent a number: the returns come from code.
- "different": the most important way today differs from then, and which way it cuts (1-2 sentences).
Then "read": 3-4 sentences on what the five episodes and the base rates say about the next 1, 3, 6 and 12 months, how much weight they deserve given the differences, and which episode today most resembles. Cite episodes by their IDs, e.g. [HE2].
If you are not sure what happened in a given month, say so plainly rather than guessing.

Reply with ONLY this JSON: {"episodes": [{"id": "HE1", "then": "...", "after": "...", "different": "...", "lesson": "one short phrase"}], "read": "...", "closest": "HE#"}`;
  }
  function cleanHistorian(raw, R) {
    const n = R?.episodes?.length || 0, s = (x, k) => String(x || "").replace(/\s+/g, " ").trim().slice(0, k);
    const eps = Array.from({ length: n }, (_, i) => { const x = (Array.isArray(raw?.episodes) ? raw.episodes : []).find((y) => String(y?.id || "").toUpperCase().replace(/^E/, "HE") === `HE${i + 1}`) || (Array.isArray(raw?.episodes) ? raw.episodes[i] : null) || {};
      return { id: `HE${i + 1}`, month: R.episodes[i].month, then: s(x.then, 500), after: s(x.after, 600), different: s(x.different, 400), lesson: s(x.lesson, 120) }; });
    return { episodes: eps, read: s(raw?.read, 900), closest: /^H?E[1-9]$/.test(String(raw?.closest || "")) ? "HE" + String(raw.closest).replace(/^H?E/, "") : "", months: R.episodes.map((e) => e.month) };
  }

  const Regimes = { H, FEATURES, FMAP, monthly, fingerprint, forward, episodes, text, historianPrompt, cleanHistorian, fval };
  if (typeof module !== "undefined" && module.exports) module.exports = Regimes;
  else root.Regimes = Regimes;
})(typeof window !== "undefined" ? window : globalThis);
