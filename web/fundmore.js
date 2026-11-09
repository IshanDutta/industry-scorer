/* Industry Scorer: the rest of a fund's analysis, made the company page's way (code only, no I/O).
 *
 * Phase 3, the scorecard: the same pillars and weights as the industry and company scores. The fund's own numbers
 * (momentum against SPY, risk, risk-adjusted return, income and cost) where it has them; every other pillar is its
 * industries' own, weighted by the fund. The analysis's fit judgment moves each investor's score at most 5 points
 * (strong +5, good +2, weak -2, poor -5) and "best fit" never goes to a type it calls a weak or poor fit when another fits.
 * Phase 4: the industries' cycle and KPIs, their debates and scenarios seen through the fund, the holdings' earnings
 * season, and how the fund compares with its peers. Phase 5: the daily check of what moved since the calls.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase();
  const Score = typeof module !== "undefined" && module.exports ? require("./score.js") : root.Score;
  const TYPES = ["income", "conservative", "growth", "aggressive"];
  const HZ = ["1M", "3M", "6M", "12M"];
  const pc = (v, d = 1) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "n/a");
  const sp = (v, d = 1) => (isNum(v) ? (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%" : "n/a");
  const r1 = (v) => Math.round(v * 10) / 10;
  const addDays = (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
  const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
  const inds = (cov, digests) => (cov?.industries || []).map((g) => ({ g, d: digests?.[lc(g.industry)] })).filter((x) => x.d);

  // ============================================================= phase 3: the scorecard
  /** The analysis's judgment of each fit, in points (the company page's). */
  const OVL = { strong: 5, good: 2, weak: -2, poor: -5 };
  /** The fund's own metrics the industry scorecard has rows for (same ranges), plus the fund's cost. */
  const OWN = {
    momentum: [["ex1m", "ex1m"], ["ex3m", "ex3m"], ["ex6m", "ex6m"], ["ex1y", "ex1y"]],
    risk: [["beta", "beta"], ["vol", "vol"], ["dvol", "dvol"], ["mdd", "mdd"], ["shp", "shp"], ["top5", "top5"]],
    risk_reward: [["shp", "shp"]],
    income: [["dy", "yield"]],
  };
  const EXPENSE = ["exp", "Expense ratio (the fund's cost)", null, 0.0003, 0.012, false, 0.6];
  /** The fund's own numbers for the scorecard, from the page's fund state (fractions). */
  function ownFrom(fd) {
    const R = (lab) => { const r = (fd.retRows || []).find((x) => x.label === lab); return r && isNum(n(r.value)) && isNum(n(r.spy)) ? (r.value - r.spy) / 100 : NaN; };
    const g = fd.gS && fd.bench?.symbol !== "SPY" ? fd.gS : fd.g1, g1 = fd.g1 || {};
    const hw = (fd.hold || []).map((h) => n(h.weight)).filter(isNum).sort((a, b) => b - a), top5 = hw.length >= 5 ? hw.slice(0, 5).reduce((a, x) => a + x, 0) : NaN;
    const y = isNum(n(fd.dist?.yield)) ? n(fd.dist.yield) : n(fd.facts?.yield);
    return { ex1m: R("1M"), ex3m: R("3M"), ex6m: R("6M"), ex1y: R("1Y"), beta: n(g?.beta), vol: n(g1.vol), dvol: n(g1.downside_vol), mdd: n(g1.max_dd), shp: n(g1.sharpe), top5, yield: y, expense: n(fd.facts?.expense) };
  }
  /** The pillars the fund's own numbers give: {p: {score, items: [{key, label, value, score, kind}]}}. */
  function ownPillars(o) {
    const out = {};
    for (const [p, list] of Object.entries(OWN)) {
      const rows = list.map(([k, f]) => [Score.METRICS[p].find((r) => r[0] === k), o[f]]).filter(([r]) => r);
      if (p === "income") rows.push([EXPENSE, o.expense]);
      let ws = 0, acc = 0; const items = [];
      for (const [[k, label, , lo, hi, up, w], v] of rows) {
        if (!isNum(v)) { items.push({ key: k, label, value: null, score: null }); continue; }
        const s = Score.anchored(v, lo, hi, up); acc += w * s; ws += w; items.push({ key: k, label, value: v, score: Math.round(s) });
      }
      if (ws > 0) out[p] = { score: acc / ws, items };
    }
    return out;
  }
  /**
   * The fund's scorecard. cov: Portfolio.coverage; digests: the industries' (v4, with "pillars"); own: ownFrom(fd);
   * fit: the analysis's {type: {fit}} or null. Pillars without the fund's own numbers are its industries', weighted.
   */
  function scorecard({ cov, digests, own = {}, fit = null }) {
    const L = inds(cov, digests).filter((x) => x.d.pillars), pillars = {};
    for (const p of [...Score.QUANT, ...Score.SECTION]) {
      let w = 0, s = 0; const items = [];
      for (const { g, d } of L) { const v = n(d.pillars[p]); if (isNum(v)) { w += g.weight; s += g.weight * v; items.push({ label: g.industry, weight: g.weight, score: Math.round(v), kind: d.kind }); } }
      if (w > 0) pillars[p] = { score: s / w, on: w, from: "industries", items: items.sort((a, b) => b.weight - a.weight) };
    }
    for (const [p, x] of Object.entries(ownPillars(own))) pillars[p] = { score: x.score, from: "fund", items: x.items, ind: pillars[p] || null };
    const profiles = {};
    for (const t of TYPES) {
      const W = Score.PROFILES[t].weights; let ws = 0, acc = 0, qa = 0, qw = 0, sa = 0, sw = 0;
      for (const [p, w] of Object.entries(W)) { const v = pillars[p]?.score; if (!isNum(v)) continue; acc += w * v; ws += w; if (Score.QUANT.includes(p)) { qa += w * v; qw += w; } else { sa += w * v; sw += w; } }
      const base = ws ? acc / ws : NaN, f = fit?.[t]?.fit || null, overlay = OVL[f] ?? 0, total = isNum(base) ? Math.max(0, Math.min(100, base + overlay)) : NaN;
      const pulls = Object.entries(W).filter(([p]) => isNum(pillars[p]?.score)).map(([p, w]) => ({ k: p, w, s: pillars[p].score, pull: (w * (pillars[p].score - 50)) / (ws || 1) }));
      profiles[t] = { base, overlay, total, grade: Score.grade(total), fit: f, fund: qw ? qa / qw : NaN, backdrop: sw ? sa / sw : NaN, coverage: ws / 100,
        lifts: pulls.filter((x) => x.pull > 0.4).sort((a, b) => b.pull - a.pull).slice(0, 3), holds: pulls.filter((x) => x.pull < -0.4).sort((a, b) => a.pull - b.pull).slice(0, 3) };
    }
    const ranked = TYPES.filter((t) => isNum(profiles[t].total)).sort((a, b) => profiles[b].total - profiles[a].total);
    const ok = ranked.filter((t) => !["weak", "poor"].includes(profiles[t].fit));
    return { pillars, profiles, ranked, best: (ok.length ? ok : ranked)[0] || null, n: L.length, on: L.reduce((a, x) => a + x.g.weight, 0) };
  }
  /** The scorecard as dossier lines (code's scores before the analysis's judgment). */
  function scoreText(sc) {
    if (!sc) return "";
    const lab = (p) => Score.PILLAR_LABELS[p] || p;
    const own = Object.entries(sc.pillars).filter(([, x]) => x.from === "fund").map(([p, x]) => `${lab(p)} ${Math.round(x.score)}`).join(", ");
    const ind = Object.entries(sc.pillars).filter(([, x]) => x.from !== "fund").map(([p, x]) => `${lab(p)} ${Math.round(x.score)}`).join(", ");
    return [`Code's score per investor type (0-100, before your fit judgment): ${TYPES.map((t) => `${t} ${isNum(sc.profiles[t].base) ? Math.round(sc.profiles[t].base) : "n/a"}`).join(", ")}; highest by score: ${sc.ranked[0] || "n/a"}.`,
      own ? `Pillars from the fund's own numbers: ${own}.` : "", ind ? `Pillars through its industries (weighted): ${ind}.` : ""].filter(Boolean).join(" ");
  }

  // ============================================================= phase 4: KPIs and cycle, debates and scenarios, earnings season, peers
  /** The industries' cycle and KPIs, weighted by the fund. */
  function cycleLook(cov, digests) {
    const L = inds(cov, digests).filter((x) => x.d.cycle), on = L.reduce((a, x) => a + x.g.weight, 0); if (!on) return null;
    const tally = (f) => { const o = {}; for (const { g, d } of L) { const k = f(d); if (k) o[lc(k)] = (o[lc(k)] || 0) + g.weight / on; } return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1])); };
    const tone = { positive: 0, negative: 0, mixed: 0, cautious: 0 }; let tw = 0;
    for (const { g, d } of L) { const t = d.cycle.tone || {}, tot = Object.values(t).reduce((a, x) => a + x, 0); if (!tot) continue; tw += g.weight; for (const k of Object.keys(tone)) tone[k] += (g.weight * (t[k] || 0)) / tot; }
    if (tw) for (const k of Object.keys(tone)) tone[k] /= tw;
    const next = L.flatMap(({ g, d }) => (d.cycle.next || []).map((x) => ({ ...x, industry: g.industry, weight: g.weight }))).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { on, phase: tally((d) => d.cycle.position), pricing: tally((d) => d.cycle.pricing), oplev: tally((d) => d.cycle.oplev), tone: tw ? tone : null,
      rows: L.map(({ g, d }) => ({ industry: g.industry, weight: g.weight, kind: d.kind, ...d.cycle })), next };
  }
  /** The biggest industries' debates (at most two each), with IDs for the analysts: [{id, industry, weight, q, bull, bear, lean, resolves}]. */
  function debates(cov, digests, k = 6) {
    const out = [];
    for (const { g, d } of inds(cov, digests)) { for (const x of (d.debates || []).slice(0, 2)) { if (out.length >= k) break; out.push({ id: "DB" + (out.length + 1), industry: g.industry, weight: g.weight, ...x }); } if (out.length >= k) break; }
    return out;
  }
  /** Each industry's bull, base and bear case at its weight, and the fund's weighted case. */
  function scenLook(cov, digests) {
    const rows = inds(cov, digests).filter((x) => x.d.scen && Object.keys(x.d.scen).length).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, scen: d.scen }));
    const on = rows.reduce((a, x) => a + x.weight, 0); if (!on) return null;
    const fund = {}; for (const k of ["bull", "base", "bear"]) { let w = 0, p = 0, m = 0, wm = 0; for (const r of rows) { const x = r.scen[k]; if (!x) continue; if (isNum(n(x.p))) { p += r.weight * x.p; w += r.weight; } if (isNum(n(x.move))) { m += r.weight * x.move; wm += r.weight; } }
      fund[k] = { p: w ? p / w : NaN, move: wm ? m / wm : NaN }; }
    const ps = ["bull", "base", "bear"].map((k) => fund[k].p), ms = ["bull", "base", "bear"].map((k) => fund[k].move), tp = ps.reduce((a, x) => a + (isNum(x) ? x : 0), 0);
    const ev = ps.every(isNum) && ms.every(isNum) && tp > 0 ? ps.reduce((a, p, i) => a + (p / tp) * ms[i], 0) : NaN;
    return { on, rows, fund, ev };
  }
  /**
   * The holdings' earnings season. earn: {ticker: {last: {date, act, est}, next: {date}}} (FMP, the biggest holdings);
   * hold: FundAn.holdings. Weighted by the fund: who has reported this season, the beat share and surprise, who's next.
   */
  function season(hold, earn, today) {
    const rows = []; for (const h of hold || []) { const e = earn?.[h.ticker]; if (!e) continue;
      const l = e.last, sur = l && isNum(n(l.act)) && isNum(n(l.est)) && n(l.est) !== 0 ? (n(l.act) - n(l.est)) / Math.abs(n(l.est)) : NaN;
      rows.push({ ticker: h.ticker, name: h.name, weight: h.weight, industry: h.industry, last: l?.date || null, act: n(l?.act), est: n(l?.est), surprise: sur, beat: isNum(sur) ? sur >= 0 : null, next: e.next?.date || h.next || null, beats: h.beats || "" }); }
    if (!rows.length) return null;
    const recent = rows.filter((r) => r.last && days(r.last, today) <= 75), upcoming = rows.filter((r) => r.next && r.next >= today).sort((a, b) => (a.next < b.next ? -1 : 1));
    const wsum = (a) => a.reduce((x, r) => x + r.weight, 0), rw = wsum(recent), sc = recent.filter((r) => r.beat !== null), sw = wsum(sc);
    const sur = sc.map((r) => r.surprise).sort((a, b) => a - b);
    const inDays = (k) => wsum(upcoming.filter((r) => days(today, r.next) <= k));
    const weeks = {}; for (const r of upcoming.filter((x) => days(today, x.next) <= 63)) { const t = new Date(r.next + "T00:00:00Z"), wk = addDays(r.next, -((t.getUTCDay() + 6) % 7)); (weeks[wk] = weeks[wk] || { week: wk, weight: 0, names: [] }).weight += r.weight; weeks[wk].names.push(r.ticker); }
    return { n: rows.length, on: wsum(rows), reported: rw, beat_share: sw ? wsum(sc.filter((r) => r.beat)) / sw : NaN, median_surprise: sur.length ? sur[Math.floor(sur.length / 2)] : NaN,
      next30: inDays(30), next60: inDays(60), weeks: Object.values(weeks).sort((a, b) => (a.week < b.week ? -1 : 1)), recent: recent.sort((a, b) => (a.last < b.last ? 1 : -1)), upcoming, rows };
  }
  /** The season as a dossier line. */
  function seasonText(s) {
    if (!s) return "";
    return `Earnings season for the ${s.n} biggest holdings (${pc(s.on, 0)} of the fund): ${pc(s.reported, 0)} of the fund reported in the last 75 days; ${pc(s.beat_share, 0)} of that beat EPS estimates (by weight), median surprise ${sp(s.median_surprise)}. ${s.recent.slice(0, 6).map((r) => `${r.ticker} ${r.last} ${isNum(r.surprise) ? sp(r.surprise) : "n/a"}`).join(", ")}. Next 30 days: ${pc(s.next30, 0)} of the fund reports (${s.upcoming.slice(0, 6).map((r) => `${r.ticker} ${r.next}`).join(", ") || "none"}).`;
  }
  /** Peer funds to compare with: by sector for a sector fund, else by style; the benchmark included, the fund itself left out. */
  const SECTOR_PEERS = { Technology: ["XLK", "VGT", "IYW", "FTEC"], Healthcare: ["XLV", "VHT", "IYH", "FHLC"], "Financial Services": ["XLF", "VFH", "IYF", "FNCL"], "Consumer Defensive": ["XLP", "VDC", "IYK", "FSTA"],
    Energy: ["XLE", "VDE", "IYE", "FENY"], Industrials: ["XLI", "VIS", "IYJ", "FIDU"], "Basic Materials": ["XLB", "VAW", "IYM", "FMAT"], "Real Estate": ["XLRE", "VNQ", "IYR", "FREL"], Utilities: ["XLU", "VPU", "IDU", "FUTY"],
    "Consumer Cyclical": ["XLY", "VCR", "IYC", "FDIS"], "Communication Services": ["XLC", "VOX", "IYZ", "FCOM"] };
  const STYLE_PEERS = [[/dividend|income|yield|equity income/i, ["SCHD", "VYM", "VIG", "DGRO", "HDV"]], [/small/i, ["IWM", "IJR", "VB", "SCHA"]], [/mid/i, ["IJH", "MDY", "VO", "SCHM"]],
    [/nasdaq/i, ["QQQ", "QQQM", "ONEQ", "VGT"]], [/growth/i, ["VUG", "IWF", "SCHG", "SPYG", "MGK", "QQQ"]], [/value/i, ["VTV", "IWD", "SCHV", "SPYV"]], [/equal/i, ["RSP", "SPY"]], [/./, ["SPY", "VTI", "IVV", "SCHX", "ITOT"]]];
  function peersFor(f, sectors, bench, k = 5) {
    const s = Object.entries(sectors || {}).sort((a, b) => b[1] - a[1])[0], txt = `${f?.name || ""} ${f?.category || ""}`, self = String(f?.symbol || "").toUpperCase();
    const list = s && s[1] >= 0.6 && SECTOR_PEERS[s[0]] ? SECTOR_PEERS[s[0]] : STYLE_PEERS.find(([re]) => re.test(txt))[1];
    return [...new Set([bench, ...list].filter((x) => x && x !== self))].slice(0, k);
  }
  /** One fund's numbers for the peer table, from its dividend-adjusted closes and SPY's. */
  function peerStats(ser, spy) {
    const c = ser?.closes || [], d = ser?.dates || []; if (c.length < 60) return null;
    const last = d[d.length - 1], at = (k) => { const from = addDays(last, -k); const i = d.findIndex((x) => x >= from); return i < 0 || d[i] > addDays(from, 7) ? NaN : c[i]; };
    const r = (k) => c[c.length - 1] / at(k) - 1, y1 = r(365), y3 = r(3 * 365), y5 = r(5 * 365);
    const i1 = Math.max(0, d.findIndex((x) => x >= addDays(last, -365))), rets = []; for (let i = i1 + 1; i < c.length; i++) rets.push(c[i] / c[i - 1] - 1);
    const m = rets.reduce((a, x) => a + x, 0) / (rets.length || 1), sd = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, rets.length - 1)), vol = sd * Math.sqrt(252);
    let pk = c[i1], dd = 0; for (let i = i1; i < c.length; i++) { pk = Math.max(pk, c[i]); dd = Math.min(dd, c[i] / pk - 1); }
    let beta = NaN; if (spy?.closes?.length) { const sm = new Map(spy.dates.map((x, i) => [x, spy.closes[i]])), a = [], b = []; for (let i = i1 + 1; i < c.length; i++) { const p0 = sm.get(d[i - 1]), p1 = sm.get(d[i]); if (p0 && p1) { a.push(c[i] / c[i - 1] - 1); b.push(p1 / p0 - 1); } }
      if (a.length > 60) { const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; let cv = 0, vb = 0; for (let i = 0; i < a.length; i++) { cv += (a[i] - ma) * (b[i] - mb); vb += (b[i] - mb) ** 2; } beta = vb ? cv / vb : NaN; } }
    return { r1y: y1, r3y: isNum(y3) ? Math.pow(1 + y3, 1 / 3) - 1 : NaN, r5y: isNum(y5) ? Math.pow(1 + y5, 1 / 5) - 1 : NaN, vol, max_dd: dd, sharpe: vol && isNum(y1) ? (y1 - 0.04) / vol : NaN, beta, last };
  }
  /** The peer table: this fund and its peers, each with its numbers and its rank among them (1 = best). */
  function peerTable(rows) {
    const keys = [["r1y", true], ["r3y", true], ["r5y", true], ["vol", false], ["max_dd", true], ["sharpe", true], ["expense", false]], rank = {};
    for (const [k, up] of keys) { const vs = rows.filter((r) => isNum(n(r[k]))).sort((a, b) => (up ? b[k] - a[k] : a[k] - b[k])); vs.forEach((r, i) => { (rank[r.sym] = rank[r.sym] || {})[k] = i + 1; }); }
    return rows.map((r) => ({ ...r, rank: rank[r.sym] || {}, of: rows.length }));
  }
  /** The peer comparison as a dossier line. */
  function peerText(sym, rows) {
    const me = rows?.find((r) => r.self); if (!me || rows.length < 2) return "";
    const f = (r) => `${r.sym}${r.self ? " (this fund)" : ""}: 1Y ${sp(r.r1y)}, 3Y ${sp(r.r3y)} a year, volatility ${pc(r.vol, 0)}, max drawdown ${sp(r.max_dd)}, expense ${pc(r.expense, 2)}`;
    return `Against its peers (${rows.length - 1}): ${rows.map(f).join("; ")}. ${sym} ranks ${me.rank.r1y || "?"} of ${rows.length} on 1-year return, ${me.rank.r3y || "?"} on 3-year, ${me.rank.expense || "?"} on cost.`;
  }

  // ============================================================= phase 5: the daily check
  /**
   * What moved since the fund's calls (code; no Claude), the industries' daily update's rules on a fund: its industries'
   * starting point moved, the price moved a normal month or more, a big holding reported, the write-up's inputs moved,
   * or the calls are a week old. Returns {why: [...], redo: "write" | "calls" | null, age, move, sigma}.
   */
  function dailyCheck({ outlook, stale = [], writeWhy = [], ser = null, sigma1m = null, seasonInfo = null, today }) {
    const why = []; let redo = null;
    if (!outlook || outlook.provisional) return { why: ["no calls yet"], redo: "calls", age: null, move: null };
    const age = outlook.date ? days(outlook.date, today) : null, px = ser?.closes?.[ser.closes.length - 1], mk = n(outlook.mark?.px), move = isNum(px) && mk > 0 ? px / mk - 1 : NaN;
    if (writeWhy.length && !(writeWhy.length === 1 && writeWhy[0] === "no write-up yet")) { why.push(...writeWhy.map((x) => `write-up: ${x}`)); redo = "write"; }
    for (const s of stale) why.push(s);
    if (isNum(move) && isNum(n(sigma1m)) && Math.abs(move * 100) >= n(sigma1m)) why.push(`the fund moved ${sp(move)} since the calls, more than a normal month (±${sigma1m}%)`);
    const rep = (seasonInfo?.recent || []).filter((r) => r.weight >= 0.03 && outlook.date && r.last > outlook.date && r.last <= today);
    if (rep.length) why.push(`${rep.map((r) => r.ticker).join(", ")} reported since the calls (${pc(rep.reduce((a, r) => a + r.weight, 0), 0)} of the fund)`);
    if (isNum(age) && age >= 7 && !why.length) why.push(`the calls are ${age} days old`);
    if (why.length && !redo) redo = "calls";
    return { why, redo, age, move: isNum(move) ? move : null };
  }
  /** The daily log: one entry per fund per day, newest first, at most 30. */
  function logDay(log, entry) { return [entry, ...(log || []).filter((x) => x.date !== entry.date)].slice(0, 30); }
  /** How fresh each input is: [{what, date, age}] (dates as YYYY-MM-DD). */
  function freshness(fd, full, today) {
    const ages = (fd.cov?.industries || []).filter((g) => g.saved_at && g.weight >= 0.01).map((g) => ({ w: g.weight, d: String(g.saved_at).slice(0, 10) }));
    const tw = ages.reduce((a, x) => a + x.w, 0), wAge = tw ? ages.reduce((a, x) => a + x.w * days(x.d, today), 0) / tw : NaN, oldest = ages.sort((a, b) => (a.d < b.d ? -1 : 1))[0];
    const row = (what, date, note = "") => ({ what, date: date || null, age: date ? days(String(date).slice(0, 10), today) : null, note });
    return [row("Holdings file", fd.raw?.holdings?.[0]?.date), row("Prices", fd.ser?.dates?.[fd.ser.dates.length - 1]), row("Fund data fetched", String(fd.raw?.fetched_at || "").slice(0, 10)),
      row("Its industries' analyses (weighted age)", isNum(wAge) ? addDays(today, -Math.round(wAge)) : null, oldest ? `oldest ${oldest.d}` : ""), row("Wall Street, news, earnings", String(fd.netAt || "").slice(0, 10)),
      row("The write-up", String(full?.at || "").slice(0, 10)), row("The 1M-12M calls", full?.outlook && !full.outlook.provisional ? full.outlook.date : null)];
  }

  // ============================================================= times like this, through its industries
  /**
   * Times like this, from the industry runs (the backend's own: regimes.js on each industry, the market historian's notes):
   * each industry the fund holds found the five past months most like today on the macro backdrop and its own setup. The
   * fund's version weights them: base rates by the fund's weights; the past months its industries pick most (each
   * industry's vote = its fund weight x how close the month was; months within two of each other count as one episode),
   * with what each of those industries did next, what the fund itself did (its own prices) and the S&P 500, and the
   * historians' notes. The macro backdrop is the same in every industry's fingerprint, so today's and each month's are shown.
   */
  const RG = typeof module !== "undefined" && module.exports ? require("./regimes.js") : root.Regimes;
  const mIdx = (m) => { const [y, mo] = String(m).split("-").map(Number); return y * 12 + mo - 1; };
  const MACRO_KEYS = () => RG.FEATURES.filter((f) => f[3] === "macro" || f[3] === "market").map((f) => f[0]);
  function timesLook(cov, digests, ser = null, { k = 5, gap = 6, merge = 2 } = {}) {
    const L = inds(cov, digests).filter((x) => x.d.times?.episodes?.length); if (!L.length) return null;
    const on = L.reduce((a, x) => a + x.g.weight, 0), wavg = (f) => { let w = 0, s = 0; for (const { g, d } of L) { const v = n(f(d)); if (isNum(v)) { w += g.weight; s += g.weight * v; } } return w ? s / w : NaN; };
    const base = Object.fromEntries(HZ.map((h) => [h, { pos: wavg((d) => d.times.base?.[h]?.pos), all_pos: wavg((d) => d.times.base?.[h]?.all_pos), median: wavg((d) => d.times.base?.[h]?.median), beat_spy: wavg((d) => d.times.base?.[h]?.beat_spy),
      top_share: wavg((d) => { const b = d.times.base?.[h]; return b?.top_n ? (100 * b.top_up) / b.top_n : NaN; }) }]));
    const top = L[0].d.times, MK = MACRO_KEYS(), now = Object.fromEntries(MK.filter((kk) => kk in (top.now || {})).map((kk) => [kk, top.now[kk]]));
    // Each industry's months, as votes; then the episodes: the strongest month, absorbing its industries' neighbours.
    const votes = [];
    for (const { g, d } of L) d.times.episodes.forEach((e, i) => { const note = (d.times.hist?.episodes || []).find((x) => x.month === e.month) || null;
      votes.push({ month: e.month, mi: mIdx(e.month), date: e.date, v: g.weight * (n(e.similarity) || 50) / 100, industry: g.industry, weight: g.weight, id: `HE${i + 1}`, similarity: n(e.similarity), ret: e.industry, excess: e.excess, maxdd6: e.maxdd6, path: e.path, spy: e.spy, spy_path: e.spy_path, then: e.then, note, closest: d.times.hist?.closest === `HE${i + 1}` }); });
    const byMonth = new Map(); for (const x of votes) { const c = byMonth.get(x.month) || { month: x.month, mi: x.mi, v: 0 }; c.v += x.v; byMonth.set(x.month, c); }
    const picks = [];
    for (const c of [...byMonth.values()].sort((a, b) => b.v - a.v)) { if (picks.length >= k) break; if (picks.some((p) => Math.abs(p.mi - c.mi) < gap)) continue; picks.push(c); }
    const fwdOf = (month) => { if (!ser?.dates?.length) return null; const end = month + "-31"; let i = -1; for (let q = 0; q < ser.dates.length && ser.dates[q] <= end; q++) i = q; if (i < 0 || ser.dates[i].slice(0, 7) !== month) return null;
      const f = RG.forward({ dates: ser.dates, values: ser.closes || ser.values }, ser.dates[i]); return f; };
    const episodes = picks.sort((a, b) => b.v - a.v).map((c, i) => {
      const xs = votes.filter((x) => Math.abs(x.mi - c.mi) <= merge).sort((a, b) => b.weight - a.weight), w = xs.reduce((a, x) => a + x.weight, 0);
      const wr = (f) => { let ww = 0, s = 0; for (const x of xs) { const v = n(f(x)); if (isNum(v)) { ww += x.weight; s += x.weight * v; } } return ww ? Math.round((s / ww) * 10) / 10 : null; };
      const ind = Object.fromEntries(HZ.map((h) => [h, wr((x) => x.ret?.[h])])), lead = xs.find((x) => x.month === c.month) || xs[0];
      const path = (lead.path || []).map((_, m) => wr((x) => x.path?.[m])), f = fwdOf(c.month);
      const own = f ? Object.fromEntries(HZ.map((h) => [h, f.ret[h]])) : null;
      return { id: `HE${i + 1}`, month: c.month, vote: c.v, reach: w, industries: xs.map((x) => ({ industry: x.industry, weight: x.weight, month: x.month, id: x.id, similarity: x.similarity, ret: x.ret, closest: x.closest, note: x.note })),
        then: Object.fromEntries(MK.filter((kk) => kk in (lead.then || {})).map((kk) => [kk, lead.then[kk]])), ind, spy: lead.spy || {}, fund: own, fund_path: f?.path || null, path, spy_path: lead.spy_path || [],
        maxdd6: wr((x) => x.maxdd6), fund_maxdd6: f?.maxdd6 ?? null, note: xs.find((x) => x.note?.then)?.note || null, note_from: xs.find((x) => x.note?.then)?.industry || null };
    });
    const reads = L.filter((x) => x.d.times.hist?.read).slice(0, 6).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, read: d.times.hist.read, closest: (() => { const m = /HE(\d)/.exec(d.times.hist.closest || ""); return m ? d.times.episodes[m[1] - 1]?.month || null : null; })() }));
    return { on, n: L.length, as_of: top.as_of, months: top.months, now, base, episodes, reads, setups: L.slice(0, 8).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, now: Object.fromEntries((d.times.features || []).filter((kk) => !MK.includes(kk)).map((kk) => [kk, d.times.now?.[kk]])) })) };
  }
  const fp = (v) => (isNum(n(v)) ? `${v > 0 ? "+" : ""}${v}%` : "n/a");
  /** The fund's Times like this as dossier text (HE1-HE5, the fund's own episodes). */
  function timesLookText(T, sym) {
    if (!T?.episodes?.length) return "";
    const L = [`TIMES LIKE THIS, THROUGH ITS INDUSTRIES (each industry run's own search of every month since 2009 on the macro backdrop and its setup; weighted by the fund; ${pc(T.on, 0)} of the fund has it)`];
    L.push(`Today's macro backdrop: ${Object.entries(T.now).map(([kk, v]) => `${RG.FMAP[kk]?.label || kk} ${RG.fval(kk, v)}`).join("; ")}.`);
    L.push(`Base rates, weighted by the fund (its industries' 20 closest months vs all months): ${HZ.map((h) => { const b = T.base[h]; return `${h}: up ${isNum(b.pos) ? Math.round(b.pos) : "n/a"}% of the time (all months ${isNum(b.all_pos) ? Math.round(b.all_pos) : "n/a"}%), median ${isNum(b.median) ? fp(Math.round(b.median * 10) / 10) : "n/a"}; their 5 closest episodes up ${isNum(b.top_share) ? Math.round(b.top_share) : "n/a"}% of the time`; }).join("; ")}.`);
    for (const e of T.episodes) L.push(`[${e.id}] ${e.month}: picked by ${e.industries.length} of its industries, ${pc(e.reach, 0)} of the fund: ${e.industries.slice(0, 6).map((x) => `${x.industry} (${pc(x.weight)}, closer than ${x.similarity}% of months${x.month !== e.month ? `, as ${x.month}` : ""})`).join(", ")}${e.industries.length > 6 ? ` and ${e.industries.length - 6} more` : ""}. Macro then: ${Object.entries(e.then).map(([kk, v]) => `${RG.FMAP[kk]?.label || kk} ${RG.fval(kk, v)}`).join("; ")}. After: those industries (weighted) ${HZ.map((h) => `${h} ${fp(e.ind[h])}`).join(", ")}; ${e.fund ? `${sym} itself ${HZ.map((h) => `${h} ${fp(e.fund[h])}`).join(", ")}; ` : `${sym} didn't trade yet; `}S&P 500 ${HZ.map((h) => `${h} ${fp(e.spy[h])}`).join(", ")}.${e.note ? ` The ${e.note_from} historian: ${e.note.then} ${e.note.after}${e.note.different ? ` Different now: ${e.note.different}` : ""}` : ""}`);
    for (const r of T.reads) L.push(`The ${r.industry} historian (${pc(r.weight)} of the fund)${r.closest ? `, closest month ${r.closest}` : ""}: ${r.read}`);
    return L.join("\n");
  }

  // ============================================================= macro, world events, trade and regulation: the full tables
  /**
   * The industry reports' macro, world-events, trade and regulation tables (each digest's "lens", read the company
   * page's way), merged across the fund's industries and weighted: every indicator its industries read, every world
   * situation, every country on their trade maps, every rule in their rule books and every policy, litigation and deal
   * item, each with how much of the fund it reaches, how its industries read it, the fullest industry's detail, and
   * which of the fund's holdings it names. IDs for the analysts: MI (indicators), WS (situations), TC (countries),
   * RL (rules), LI (policy, litigation, deals).
   */
  /** Which measured factor an indicator moves with (the fund's regressions: market, rates, oil, dollar, credit). */
  function factorOf(x) { const t = `${x.key || ""} ${x.label || ""}`;
    return /treasury|10y|10-year|year10|real yield|tips|mortgage rate|term premium/i.test(t) ? "rates" : /\boil\b|wti|brent|crude|gasoline|uso\b/i.test(t) ? "oil" : /dollar|dxy|uup|usd index/i.test(t) ? "dollar"
      : /high.?yield|hyg|credit spread|baa|junk|hy spread|corporate spread/i.test(t) ? "credit" : /s&p ?500|spy\b|vix|equity market/i.test(t) ? "market" : null; }
  /**
   * How the fund suffers when the macro turns (code): each measured factor (the fund's own regressions on SPY, the
   * 10-year yield, oil, the dollar and high-yield bonds), a bad month and a severe month for that factor (its 95th and
   * 99th percentile adverse one-month move since the series begins) and what each does to the fund and to its
   * industries; then combined shocks from the multi-factor betas. sens: the fund's Sensitivity.measure; indSens: its
   * industries' weighted (Portfolio.lookThrough .sens); series: {market, rates, oil, dollar, credit: {dates, values}}.
   */
  const KIND = { market: "ret", rates: "diff", oil: "ret", dollar: "ret", credit: "ret" };
  function monthMoves(s, kind) { const v = s?.values || s?.closes || []; const out = []; for (let i = 21; i < v.length; i += 5) { const a = v[i - 21], b = v[i]; if (isNum(a) && isNum(b) && (kind === "diff" || a > 0)) out.push(kind === "diff" ? b - a : b / a - 1); } return out.sort((x, y) => x - y); }
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))] : NaN);
  function macroStress({ sens, indSens = [], series = {} }) {
    const F = sens?.factors || []; if (!F.length) return null;
    const ind = new Map((indSens || []).map((x) => [x.key, x]));
    const mv = {}; for (const f of F) { const m = monthMoves(series[f.key], KIND[f.key]); if (m.length >= 24) mv[f.key] = { p1: q(m, 0.01), p5: q(m, 0.05), p95: q(m, 0.95), p99: q(m, 0.99), n: m.length }; }
    const unit = (k, x) => (KIND[k] === "diff" ? `${x > 0 ? "+" : ""}${x.toFixed(2)}pp` : `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
    const shockOf = (k) => ({ market: 0.01, rates: 0.25, oil: 0.1, dollar: 0.05, credit: -0.02 })[k];
    const rows = F.map((f) => { const beta = n(f.total?.beta) || (n(f.total?.effect) / shockOf(f.key)), m = mv[f.key], i = ind.get(f.key), ib = i ? n(i.effect) / shockOf(f.key) : NaN;
      if (!m || !isNum(beta)) return { key: f.key, label: f.label, shock_label: f.shock_label, effect: n(f.total?.effect), t: n(f.total?.t), ind_effect: i ? n(i.effect) : NaN, stable: f.stable };
      const bad = beta >= 0 ? m.p5 : m.p95, severe = beta >= 0 ? m.p1 : m.p99;
      return { key: f.key, label: f.label, shock_label: f.shock_label, effect: n(f.total?.effect), t: n(f.total?.t), ind_effect: i ? n(i.effect) : NaN, stable: f.stable,
        bad: { move: bad, label: unit(f.key, bad), fund: beta * bad, ind: isNum(ib) ? ib * bad : NaN }, severe: { move: severe, label: unit(f.key, severe), fund: beta * severe, ind: isNum(ib) ? ib * severe : NaN } }; })
      .sort((a, b) => (a.bad?.fund ?? 0) - (b.bad?.fund ?? 0));
    // Combined shocks, from the partial betas (each factor's effect holding the others fixed).
    // (When the multi-factor fit isn't available, each factor's own beta stands in, and the shock is marked approximate.)
    const multi = F.some((f) => isNum(n(f.partial?.beta))), pb = Object.fromEntries(F.map((f) => [f.key, multi ? n(f.partial?.beta) : n(f.total?.beta)]));
    const SC = [["Higher for longer", "the 10-year yield up a bad month, high-yield bonds down one, the dollar up one", { rates: "p95", credit: "p5", dollar: "p95" }],
      ["Oil shock", "oil up a severe month and yields up a bad one (an energy-led inflation scare)", { oil: "p99", rates: "p95" }],
      ["Credit crunch", "high-yield bonds down a severe month and the S&P 500 down a bad one", { credit: "p1", market: "p5" }],
      ["Equity selloff", "the S&P 500 down a severe month", { market: "p1" }],
      ["Stagflation", "yields, oil and the dollar up a bad month each, high-yield bonds down one", { rates: "p95", oil: "p95", dollar: "p95", credit: "p5" }],
      ["Soft landing", "yields down a bad month's size, high-yield bonds and the S&P 500 up a good one", { rates: "p5", credit: "p95", market: "p95" }]];
    const scenarios = SC.map(([name, what, legs]) => { const parts = Object.entries(legs).filter(([k]) => mv[k] && isNum(pb[k])).map(([k, p]) => ({ key: k, move: mv[k][p], label: unit(k, mv[k][p]), fund: pb[k] * mv[k][p] }));
      return parts.length ? { name, what, legs: parts, fund: parts.reduce((a, x) => a + x.fund, 0), biggest: parts.slice().sort((a, b) => a.fund - b.fund)[0]?.key, approx: !multi } : null; }).filter(Boolean)
      .map((x, i) => ({ id: "ST" + (i + 1), ...x }));
    return { rows, scenarios, r2: n(sens.r2), from: sens.from, to: sens.to, moves: mv };
  }
  /** The stress test as dossier lines (ST IDs for the combined shocks). */
  function stressText(T, sym) {
    if (!T) return "";
    const p = (x) => (isNum(x) ? `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "n/a");
    return [`## HOW ${sym} SUFFERS WHEN THE MACRO TURNS (code: the fund's own measured sensitivities, last year's daily returns, R² ${isNum(T.r2) ? Math.round(T.r2 * 100) + "%" : "n/a"}; a bad month = the factor's 95th-percentile adverse one-month move in its history, severe = 99th)`,
      ...T.rows.map((r) => `${r.label}: ${r.shock_label} moves ${sym} ${p(r.effect)} (its industries ${p(r.ind_effect)})${r.bad ? `; a bad month (${r.bad.label}) ${p(r.bad.fund)} (industries ${p(r.bad.ind)}), a severe month (${r.severe.label}) ${p(r.severe.fund)}` : ""}${r.stable === false ? "; unstable sign" : ""}.`),
      ...T.scenarios.map((x) => `[${x.id}] ${x.name} (${x.what}: ${x.legs.map((l) => `${l.key} ${l.label}`).join(", ")}): ${sym} ${p(x.fund)}, mostly from ${x.biggest}.`)].join("\n");
  }
  const SEVR = { critical: 0, high: 1, medium: 2, low: 3 }, THR = { none: 0, low: 1, moderate: 2, medium: 2, elevated: 3, high: 3, severe: 4, critical: 4 }, IMP = { existential: 3, high: 2, medium: 1, low: 0 };
  const tk = (t) => lc(t).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  function affairs(cov, digests, hold = [], { nI = 40, nW = 16, nC = 16, nR = 18, nL = 14 } = {}) {
    const L = inds(cov, digests).filter((x) => x.d.lens); if (!L.length) return null;
    const on = L.reduce((a, x) => a + x.g.weight, 0);
    const held = new Map((hold || []).filter((h) => h.ticker).map((h) => [h.ticker, h.weight]));
    const namesHeld = (syms) => [...new Set((syms || []).filter((x) => held.has(x)))].map((x) => ({ symbol: x, weight: held.get(x) })).sort((a, b) => b.weight - a.weight);
    const tally = (rows, f) => { const o = {}; for (const r of rows) { const k = f(r); if (k) o[k] = (o[k] || 0) + r.weight; } return o; };
    const merge = (getRows, keyOf) => { const m = new Map();
      for (const { g, d } of L) for (const x of getRows(d) || []) { const k = keyOf(x); if (!k) continue; const e = m.get(k) || { key: k, w: 0, rows: [] }; if (!e.rows.some((r) => r.industry === g.industry)) { e.w += g.weight; e.rows.push({ industry: g.industry, weight: g.weight, x }); } m.set(k, e); }
      return [...m.values()]; };
    // Macro: each industry's regime, then every indicator its industries read (the same indicator is matched by name).
    const regimes = L.filter((x) => x.d.lens.macro?.regime || x.d.lens.macro?.headline).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, ...d.lens.macro, indicators: undefined }));
    // The full macro table: every indicator in its industries' macro tables (matched by the data series, else the name),
    // the latest numbers, and each industry's read (relevance, effect, why it matters, what's driving it, what's next).
    const ikey = (x) => x.key || lc(x.label);
    const indicators = merge((d) => d.lens.macro?.rows, ikey).map((e) => { const rs = e.rows.sort((a, b) => b.weight - a.weight), rd = rs.filter((r) => r.x.ind), rel = rd.filter((r) => r.x.ind.relevance !== "low"), top = rs[0].x;
      const lead = (rd.find((r) => r.x.ind.relevance === "high" && r.x.ind.driver) || rd.find((r) => r.x.ind.driver) || {}).x?.ind || {};
      return { key: ikey(top), label: top.label, group: top.group, value: top.value, unit: top.unit, prior: top.prior, prior_label: top.prior_label, estimate: top.estimate, chg_1m: top.chg_1m, chg_3m: top.chg_3m, chg_1y: top.chg_1y,
        period: top.period, date: top.date, source: top.source, reason: top.reason, reach: e.w, read_by: rel.reduce((a, r) => a + r.weight, 0), effects: tally(rel, (r) => r.x.ind.effect), driver: lead.driver || "", next: lead.next || "",
        factor: factorOf(top), reads: rd.map((r) => ({ industry: r.industry, weight: r.weight, ...r.x.ind })) }; })
      .sort((a, b) => b.read_by - a.read_by || b.reach - a.reach).slice(0, nI).map((x, i) => ({ id: "MI" + (i + 1), ...x }));
    const gw = {}; for (const x of indicators) gw[x.group] = (gw[x.group] || 0) + x.read_by + x.reach / 10;
    const groups = Object.keys(gw).sort((a, b) => gw[b] - gw[a]);
    // What's moving and why, how the macro reaches its industries, what would flip them, and the releases ahead.
    const byInd = new Map(indicators.map((x) => [x.key, x]));
    const moves = merge((d) => d.lens.macro?.moves, (x) => x.key || lc(x.label)).map((e) => { const rs = e.rows.sort((a, b) => b.weight - a.weight); return { ...rs[0].x, reach: e.w, id: byInd.get(rs[0].x.key || lc(rs[0].x.label))?.id || "", so_whats: rs.map((r) => ({ industry: r.industry, weight: r.weight, so_what: r.x.so_what })) }; }).sort((a, b) => b.reach - a.reach).slice(0, 10);
    const channels = Object.fromEntries(["demand", "cost", "capital", "regulatory"].map((k) => [k, L.filter((x) => x.d.lens.macro?.channels?.[k]).slice(0, 3).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, text: d.lens.macro.channels[k] }))]));
    const flips = L.flatMap(({ g, d }) => (d.lens.macro?.flip || []).map((f) => ({ ...f, industry: g.industry, weight: g.weight }))).sort((a, b) => b.weight - a.weight).slice(0, 8);
    const watchNext = merge((d) => d.lens.macro?.watch_next, (x) => x.date + "|" + tk(x.event).split(" ").slice(0, 3).join(" ")).map((e) => ({ ...e.rows[0].x, reach: e.w, industries: e.rows.map((r) => r.industry) })).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 12);
    // World: every situation, matched by title; the fullest deep dive from the biggest industry that has one.
    const world = merge((d) => d.lens.world, (x) => tk(x.title)).map((e) => { const rs = e.rows.sort((a, b) => b.weight - a.weight), dv = (rs.find((r) => r.x.deep) || rs[0]).x;
      const st = tally(rs, (r) => r.x.stance);
      return { ...dv, reach: e.w, deep_any: rs.some((r) => r.x.deep), adverse: st.adverse || 0, favorable: st.supportive || st.favorable || 0, stances: st, industries: rs.map((r) => ({ industry: r.industry, weight: r.weight, stance: r.x.stance, deep: r.x.deep })),
        winners_held: namesHeld(rs.flatMap((r) => r.x.winners)), losers_held: namesHeld(rs.flatMap((r) => r.x.losers)) }; })
      .sort((a, b) => (b.deep_any - a.deep_any) || b.reach - a.reach).slice(0, nW).map((x, i) => ({ id: "WS" + (i + 1), ...x }));
    // Trade: every country on their trade maps; the industries' revenue there (filings, else the analyst's estimate) at the fund's weight.
    const trade = merge((d) => d.lens.trade?.countries, (x) => lc(x.country)).map((e) => { const rs = e.rows.sort((a, b) => b.weight - a.weight), top = rs[0].x;
      const rev = rs.reduce((a, r) => a + (isNum(n(r.x.share)) ? r.weight * r.x.share : 0), 0), est = rs.some((r) => r.x.est && isNum(n(r.x.share)));
      return { ...top, reach: e.w, rev: on ? rev / on : 0, rev_est: est, threat: rs.map((r) => r.x.threat).sort((a, b) => (THR[lc(b)] ?? 0) - (THR[lc(a)] ?? 0))[0] || "", importance: rs.map((r) => r.x.importance).sort((a, b) => (IMP[lc(b)] ?? 0) - (IMP[lc(a)] ?? 0))[0] || "",
        stances: tally(rs, (r) => r.x.stance), industries: rs.map((r) => ({ industry: r.industry, weight: r.weight, share: r.x.share, est: r.x.est, stance: r.x.stance, threat: r.x.threat, importance: r.x.importance })),
        exposed_held: namesHeld(rs.flatMap((r) => (r.x.exposed || []).map((y) => y.symbol))) }; })
      .sort((a, b) => b.rev - a.rev || b.reach - a.reach).slice(0, nC).map((x, i) => ({ id: "TC" + (i + 1), ...x }));
    const tradeVerdicts = L.filter((x) => x.d.lens.trade?.verdict).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, ...d.lens.trade.verdict }));
    // Regulation: every rule in their rule books (matched by name), then policy, litigation and deals; each verdict.
    const rules = merge((d) => d.lens.reg?.rules, (x) => tk(x.name)).map((e) => { const rs = e.rows.sort((a, b) => (SEVR[a.x.severity] ?? 4) - (SEVR[b.x.severity] ?? 4) || b.weight - a.weight), top = rs[0].x;
      const text = rs.map((r) => [r.x.name, r.x.what, r.x.impact, r.x.bottom_line, r.x.numeric].join(" ")).join(" ");
      return { ...top, reach: e.w, industries: rs.map((r) => ({ industry: r.industry, weight: r.weight, severity: r.x.severity, bottom_line: r.x.bottom_line })), named_held: namesHeld([...held.keys()].filter((t) => t.length >= 2 && new RegExp(`\\b${t.replace(/[.\-]/g, "\\$&")}\\b`).test(text))) }; })
      .sort((a, b) => (SEVR[a.severity] ?? 4) - (SEVR[b.severity] ?? 4) || b.reach - a.reach).slice(0, nR).map((x, i) => ({ id: "RL" + (i + 1), ...x }));
    const items = merge((d) => d.lens.reg?.items, (x) => tk(x.title)).map((e) => { const rs = e.rows.sort((a, b) => b.weight - a.weight), top = rs[0].x;
      return { ...top, reach: e.w, industries: rs.map((r) => ({ industry: r.industry, weight: r.weight, direction: r.x.direction })), named_held: namesHeld(rs.flatMap((r) => r.x.names)) }; })
      .sort((a, b) => (b.named_held.length > 0) - (a.named_held.length > 0) || b.reach - a.reach).slice(0, nL).map((x, i) => ({ id: "LI" + (i + 1), ...x }));
    const regVerdicts = L.filter((x) => x.d.lens.reg?.verdict).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, ...d.lens.reg.verdict }));
    return { on, n: L.length, regimes, regime_mix: tally(regimes, (r) => r.regime), indicators, groups, moves, channels, flips, watchNext, world, trade, tradeVerdicts, trade_mix: tally(tradeVerdicts, (r) => r.rating), rules, items, regVerdicts, reg_mix: tally(regVerdicts, (r) => r.stance) };
  }
  /** The tables as the analysts' dossier blocks (each row with its ID). */
  function affairsText(A) {
    if (!A) return { macro: "", world: "", trade: "", reg: "" };
    const w = (x) => pc(x, 0), mix = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${w(v / (Object.values(o).reduce((p, q) => p + q, 0) || 1))}`).join(", ") || "n/a";
    const val = (r) => `${r.value ?? "n/a"}${r.unit === "%" ? "%" : r.unit ? " " + r.unit : ""}${r.prior !== undefined && r.prior !== null ? ` (${r.prior_label || "prior"} ${r.prior}${r.unit === "%" ? "%" : ""})` : ""}${r.date ? `, ${r.date}` : ""}`;
    const cut = (t, k) => { t = String(t || ""); return t.length > k ? t.slice(0, t.lastIndexOf(" ", k)) + "…" : t; };
    const ch = (x) => [isNum(n(x.chg_1m)) ? `1M ${x.chg_1m > 0 ? "+" : ""}${x.chg_1m}%` : "", isNum(n(x.chg_3m)) ? `3M ${x.chg_3m > 0 ? "+" : ""}${x.chg_3m}%` : "", isNum(n(x.chg_1y)) ? `1Y ${x.chg_1y > 0 ? "+" : ""}${x.chg_1y}%` : ""].filter(Boolean).join(", ");
    const macro = [`## THE MACRO TABLE, FROM ITS INDUSTRIES' MACRO REPORTS (${A.n} industries, ${w(A.on)} of the fund; every indicator their macro planners chose, with each strategist's read)`,
      ...A.indicators.map((x) => `[${x.id}] ${x.label} (${x.group}): ${val(x)}${ch(x) ? `; ${ch(x)}` : ""}${x.estimate !== null && x.estimate !== undefined ? `; consensus ${x.estimate}` : ""}. In the macro tables of industries worth ${w(x.reach)} of the fund; relevant to ${w(x.read_by)}: ${mix(x.effects)}.${x.driver ? ` Driving it: ${cut(x.driver, 200)}` : ""}${x.next ? ` Next: ${cut(x.next, 120)}` : ""} Reads: ${x.reads.slice(0, 2).map((r) => `${r.industry} (${pc(r.weight)}, ${r.relevance}, ${r.effect}): ${cut(r.why, 170)}`).join(" | ")}${x.reads.length > 2 ? ` (+${x.reads.length - 2} more industries: ${mix(Object.fromEntries(Object.entries(x.reads.slice(2).reduce((o, r) => ((o[r.effect] = (o[r.effect] || 0) + r.weight), o), {}))))})` : ""}`),
      A.moves.length ? `What's moving and why: ${A.moves.map((x) => `${x.label}${x.id ? ` [${x.id}]` : ""}: ${x.move} Driver: ${x.driver} So what (${x.so_whats[0].industry}): ${x.so_whats[0].so_what}`).join(" || ")}` : "",
      A.flips.length ? `What would flip its industries' macro calls: ${A.flips.map((f) => `${f.industry}: ${f.trigger} (${f.mechanism})`).join("; ")}.` : "",
      A.watchNext.length ? `Releases ahead: ${A.watchNext.map((x) => `${x.date} ${x.event}: ${x.why}`).join("; ")}.` : ""].filter(Boolean).join("\n");
    const world = [`## WORLD EVENTS, FROM ITS INDUSTRIES' WORLD-EVENTS REPORTS`,
      ...A.world.map((x) => `[${x.id}] ${x.title} (${[x.category, x.region, x.status].filter(Boolean).join(", ")}): reaches ${w(x.reach)} of the fund; adverse for ${w(x.adverse)}, supportive for ${w(x.favorable)}; industries: ${x.industries.slice(0, 6).map((r) => `${r.industry} ${pc(r.weight)} ${r.stance}`).join(", ")}. ${x.summary || ""}${x.first_order ? ` First-order: ${x.first_order}` : ""}${x.channels?.length ? ` Channels: ${x.channels.join("; ")}.` : ""}${x.scenarios?.length ? ` Scenarios: ${x.scenarios.map((c) => `${c.probability ?? "?"}% ${c.name}: ${c.outcome || ""}`).join("; ")}.` : ""}${x.winners_held.length || x.losers_held.length ? ` Holdings named: winners ${x.winners_held.map((h) => `${h.symbol} ${pc(h.weight)}`).join(", ") || "none"}; losers ${x.losers_held.map((h) => `${h.symbol} ${pc(h.weight)}`).join(", ") || "none"}.` : ""}`)].join("\n");
    const trade = [`## TRADE, FROM ITS INDUSTRIES' TRADE MAPS AND COUNTRY DOSSIERS`, `Trade verdicts by fund weight: ${mix(A.trade_mix)}. ${A.tradeVerdicts.slice(0, 6).map((v) => `${v.industry} (${pc(v.weight)}): ${v.rating || "n/a"}${v.health !== null && v.health !== undefined ? `, health ${v.health}/100` : ""}. ${v.headline || ""}`).join(" | ")}`,
      ...A.trade.map((c) => `[${c.id}] ${c.country}: ${c.importance} importance, ${c.stance}, threat ${c.threat || "n/a"}; its industries' revenue there about ${pc(c.rev)}${c.rev_est ? " (partly estimates)" : ""}, named by industries worth ${w(c.reach)} of the fund. ${c.headline || c.why || ""}${c.risks?.length ? ` Risks: ${c.risks.map((r) => `${r.risk} (${[r.likelihood, r.impact].filter(Boolean).join("/")})`).join("; ")}.` : ""}${c.deps?.length ? ` Depends on: ${c.deps.map((d) => `${d.input} (${d.criticality})`).join("; ")}.` : ""}${c.freeze ? ` If trade froze: ${c.freeze}` : ""}${c.exposed_held.length ? ` Holdings named most exposed: ${c.exposed_held.map((h) => `${h.symbol} ${pc(h.weight)}`).join(", ")}.` : ""}`)].join("\n");
    const reg = [`## REGULATION, FROM ITS INDUSTRIES' RULE BOOKS AND LEGAL REPORTS`, `Regulatory verdicts by fund weight: ${mix(A.reg_mix)}. ${A.regVerdicts.slice(0, 6).map((v) => `${v.industry} (${pc(v.weight)}): ${v.stance}${v.intensity ? `, ${v.intensity}` : ""}. ${v.headline || ""}`).join(" | ")}`,
      ...A.rules.map((r) => `[${r.id}] ${r.name} (${r.body}; ${r.severity}, ${String(r.status).replace(/_/g, " ")}${r.effective ? `, effective ${r.effective}` : ""}): reaches ${w(r.reach)} of the fund (${r.industries.slice(0, 5).map((x) => x.industry).join(", ")}). ${r.bottom_line || r.impact || ""}${r.numeric ? ` Numbers: ${r.numeric}` : ""}${r.next12 ? ` Next 12 months: ${r.next12}` : ""}${r.named_held.length ? ` Names holdings: ${r.named_held.map((h) => `${h.symbol} ${pc(h.weight)}`).join(", ")}.` : ""}`),
      ...A.items.map((x) => `[${x.id}] ${x.kind}: ${x.title} (${x.status}${x.date ? `, ${x.date}` : ""}${x.direction ? `, ${x.direction}` : ""}): reaches ${w(x.reach)} of the fund. ${x.text || ""}${x.next ? ` Next: ${x.next}` : ""}${x.named_held.length ? ` Names holdings: ${x.named_held.map((h) => `${h.symbol} ${pc(h.weight)}`).join(", ")}.` : ""}`)].join("\n");
    return { macro, world, trade, reg };
  }

  const FundMore = { factorOf, macroStress, stressText, affairs, affairsText, timesLook, timesLookText, OVL, TYPES, ownFrom, ownPillars, scorecard, scoreText, cycleLook, debates, scenLook, season, seasonText, peersFor, peerStats, peerTable, peerText, dailyCheck, logDay, freshness, SECTOR_PEERS, STYLE_PEERS };
  if (typeof module !== "undefined" && module.exports) module.exports = FundMore;
  else root.FundMore = FundMore;
})(typeof window !== "undefined" ? window : globalThis);
