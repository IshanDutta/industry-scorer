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

  const FundMore = { OVL, TYPES, ownFrom, ownPillars, scorecard, scoreText, cycleLook, debates, scenLook, season, seasonText, peersFor, peerStats, peerTable, peerText, dailyCheck, logDay, freshness, SECTOR_PEERS, STYLE_PEERS };
  if (typeof module !== "undefined" && module.exports) module.exports = FundMore;
  else root.FundMore = FundMore;
})(typeof window !== "undefined" ? window : globalThis);
