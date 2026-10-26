/* Industry Scorer: macro conditions, chosen at runtime for one industry.
 *
 * Nothing here is a fixed list of indicators. Each run:
 *   1. catalog(): code reads what the connectors offer today: the Treasury
 *      curve, every economic release with an actual value in the last ~45
 *      days for every country (FMP calendar), every commodity, index and
 *      USD currency pair quote (FMP), and the EODHD rate and credit series
 *      when EODHD is connected.
 *   2. A macro planner agent (team.js) picks the 30-50 series that matter for
 *      this industry and groups them. If it can't run, fallbackPlan() picks
 *      from the data itself (the curve, high-impact releases in the
 *      industry's countries, the biggest commodity and currency moves).
 *   3. fetchRows(): code fetches each chosen series' latest value, prior
 *      reading, consensus and 1M/3M/1Y change, and gives it an ID (I1, ...).
 * movers() then ranks which series moved most, for the analysts to explain.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const day = (s) => String(s ?? "").slice(0, 10);
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const nn = (x) => { if (x === null || x === undefined || x === "") return null; const n = Number(x); return isNum(n) ? n : null; };
  const TENOR = (k) => { const m = /^(month|year)(\d+)$/.exec(k); return m ? `${m[2]}-${m[1]} Treasury` : k; };

  /**
   * Everything the connectors offer today, as selectable series.
   * @param fmp async (tool, input) => array
   * @param eod async (tool, input) => any | null
   * @param ctx {today, isFatal, onStep, eodTools: string[]}
   */
  async function catalog(fmp, eod, ctx) {
    const today = ctx.today;
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const items = [];
    // Treasury curve: every tenor the API returns
    const tr = ((await safe("Treasury curve", () => fmp("economics", { endpoint: "treasury-rates", from_date: addDays(today, -40), to_date: today }))) || []).filter((r) => r?.date).sort((a, b) => (a.date < b.date ? 1 : -1));
    const curve = { now: tr[0] || null, m1: tr.find((r) => r.date <= addDays(tr[0]?.date || today, -28)) || null };
    if (curve.now) for (const k of Object.keys(curve.now)) if (/^(month|year)\d+$/.test(k) && isNum(nn(curve.now[k]))) items.push({ key: "treasury:" + k, kind: "treasury", label: TENOR(k), value: nn(curve.now[k]), date: day(curve.now.date) });
    // Economic releases with an actual value, every country, last ~45 days (weekly windows)
    const rel = new Map();
    for (let k = 0; k < 6; k++) {
      const to = addDays(today, -k * 8), from = addDays(today, -k * 8 - 7);
      const rows = await safe("Economic releases", () => fmp("economics", { endpoint: "economics-calendar", from_date: from, to_date: to }));
      for (const r of rows || []) {
        if (r?.actual === null || r?.actual === undefined || !isNum(Number(r.actual)) || !/high|medium/i.test(String(r.impact))) continue;
        const name = String(r.event || "").replace(/\s*\((?:[A-Z][a-z]{2}|Q\d)[^)]*\)\s*$/, "").trim();
        const key = `release:${r.country}|${name}`;
        const cur = rel.get(key);
        if (!cur || String(r.date) > cur.date) rel.set(key, { key, kind: "release", country: r.country, label: `${r.country} ${name}`, event: r.event, value: Number(r.actual), prior: nn(r.previous), estimate: nn(r.estimate), unit: r.unit || "", impact: r.impact, date: String(r.date).slice(0, 10) });
      }
    }
    items.push(...[...rel.values()].sort((a, b) => (a.impact === b.impact ? (a.date < b.date ? 1 : -1) : a.impact === "High" ? -1 : 1)));
    // Commodities, indexes, USD currency pairs
    const cl = (await safe("Commodities", () => fmp("commodity", { endpoint: "commodities-list" }))) || [];
    const cname = Object.fromEntries(cl.map((c) => [c.symbol, c.name]));
    for (const q of (await safe("Commodities", () => fmp("commodity", { endpoint: "all-commodities-quotes", short: true }))) || []) if (isNum(Number(q.price)) && Number(q.price) > 0) items.push({ key: "commodity:" + q.symbol, kind: "commodity", symbol: q.symbol, label: cname[q.symbol] || q.symbol, value: Number(q.price), chg_1d: q.price - q.change ? (q.change / (q.price - q.change)) * 100 : null });
    const il = (await safe("Indexes", () => fmp("indexes", { endpoint: "indexes-list" }))) || [];
    const iname = Object.fromEntries(il.map((c) => [c.symbol, c.name]));
    for (const q of (await safe("Indexes", () => fmp("indexes", { endpoint: "all-index-quotes", short: true }))) || []) if (iname[q.symbol] && Number(q.price) > 0) items.push({ key: "index:" + q.symbol, kind: "index", symbol: q.symbol, label: iname[q.symbol], value: Number(q.price) });
    for (const q of (await safe("Currencies", () => fmp("forex", { endpoint: "all-forex-quotes", short: true }))) || []) if (/^USD[A-Z]{3}$|^[A-Z]{3}USD$/.test(q.symbol) && Number(q.price) > 0) items.push({ key: "fx:" + q.symbol, kind: "fx", symbol: q.symbol, label: `${q.symbol.slice(0, 3)}/${q.symbol.slice(3)}`, value: Number(q.price) });
    // EODHD rate and credit series (only the ones this connector exposes)
    const has = (t) => !!eod && (ctx.eodTools || []).includes(t);
    if (has("get_rates_reference_rates")) items.push({ key: "eod:sofr", kind: "eod", label: "SOFR (overnight funding rate)" });
    if (has("get_ust_real_yield_rates")) items.push({ key: "eod:real10y", kind: "eod", label: "10-year real yield (TIPS)" });
    if (has("get_credit_corporate_hqm_yields")) items.push({ key: "eod:hqm10y", kind: "eod", label: "High-grade corporate 10-year yield (HQM) and spread over Treasuries" });
    return { as_of: today, items, curve };
  }

  /** Compact text of the catalog for the planner. */
  function catalogText(cat) {
    const by = (k) => cat.items.filter((i) => i.kind === k);
    const f = (x) => (isNum(x) ? (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)) : "n/a");
    return [
      `TREASURY CURVE (keys treasury:<tenor>; spreads as spread:<tenorA>-<tenorB>): ${by("treasury").map((i) => `${i.key.slice(9)} ${f(i.value)}%`).join(", ")}`,
      `ECONOMIC RELEASES WITH ACTUALS, LAST ~45 DAYS (key = release:<country>|<event>)\n` + by("release").map((i) => `${i.key} = ${f(i.value)}${i.unit || ""} (${i.date}; prior ${f(i.prior)}; consensus ${f(i.estimate)}; ${i.impact})`).join("\n"),
      `COMMODITIES (key = commodity:<symbol>)\n` + by("commodity").map((i) => `${i.key} ${i.label} ${f(i.value)}`).join("\n"),
      `INDEXES (key = index:<symbol>)\n` + by("index").map((i) => `${i.key} ${i.label}`).join("\n"),
      `USD CURRENCY PAIRS (key = fx:<symbol>): ${by("fx").map((i) => i.symbol).join(", ")}`,
      by("eod").length ? `EODHD SERIES: ${by("eod").map((i) => `${i.key} ${i.label}`).join("; ")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  /** If the planner can't run: pick from the data itself, not from a list. */
  function fallbackPlan(cat, countries = ["US"]) {
    const series = [];
    const add = (key, group, reason) => { if (!series.some((s) => s.key === key) && cat.items.some((i) => i.key === key || key.startsWith("spread:"))) series.push({ key, group, label: "", reason }); };
    const tenors = cat.items.filter((i) => i.kind === "treasury");
    for (const t of tenors) add(t.key, "Rates", "Point on the Treasury curve");
    if (tenors.length >= 2) add(`spread:${tenors[tenors.length - 1].key.slice(9)}-${tenors[0].key.slice(9)}`, "Rates", "Curve slope");
    for (const r of cat.items.filter((i) => i.kind === "release" && i.impact === "High" && countries.includes(i.country)).slice(0, 25)) add(r.key, `Releases: ${r.country}`, "High-impact release in a country the industry depends on");
    const move = (i) => Math.abs(i.chg_1d || 0);
    for (const c of cat.items.filter((i) => i.kind === "commodity").sort((a, b) => move(b) - move(a)).slice(0, 8)) add(c.key, "Commodities", "Among today's biggest commodity moves");
    for (const e of cat.items.filter((i) => i.kind === "eod")) add(e.key, "Rates", "Funding and credit conditions");
    return { series, fallback: true };
  }

  /**
   * Fetch the chosen series. plan.series: [{key, group, label, reason}].
   * Returns {rows, groups, as_of}; each row gets an ID I1, I2, ...
   */
  async function fetchRows(fmp, eod, ctx, cat, plan) {
    const today = ctx.today;
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const byKey = Object.fromEntries(cat.items.map((i) => [i.key, i]));
    const rows = [];
    const add = (r) => { if (isNum(r.value)) rows.push({ ...r, value: Math.round(r.value * 1000) / 1000 }); };
    const { now, m1 } = cat.curve || {};
    for (const s of plan.series || []) {
      const it = byKey[s.key]; const base = { key: s.key, group: s.group || "Other", reason: s.reason || "", phrases: s.phrases || [], tags: s.tags || [] };
      if (s.key.startsWith("treasury:") && it) { const k = s.key.slice(9); add({ ...base, label: s.label || it.label, value: it.value, unit: "%", date: it.date, prior: m1 ? nn(m1[k]) : null, prior_label: "1 month ago", source: "FMP" }); continue; }
      if (s.key.startsWith("spread:") && now) {
        const [a, b] = s.key.slice(7).split("-"); const va = nn(now[a]), vb = nn(now[b]);
        if (isNum(va) && isNum(vb)) add({ ...base, label: s.label || `${TENOR(a)} minus ${TENOR(b)} spread`, value: (va - vb) * 100, unit: "bp", date: day(now.date), prior: m1 && isNum(nn(m1[a])) && isNum(nn(m1[b])) ? (nn(m1[a]) - nn(m1[b])) * 100 : null, prior_label: "1 month ago", source: "FMP" });
        continue;
      }
      if (!it) continue;
      if (it.kind === "release") { add({ ...base, label: s.label || it.label, value: it.value, unit: it.unit, date: it.date, period: (/\(([^)]+)\)\s*$/.exec(it.event) || [])[1] || "", prior: it.prior, prior_label: "previous", estimate: it.estimate, source: "FMP calendar", event: it.event, country: it.country }); continue; }
      if (it.kind === "commodity" || it.kind === "index" || it.kind === "fx") {
        const ch = ((await safe(`Changes for ${it.label}`, () => fmp("quote", { endpoint: "quote-change", symbol: it.symbol }))) || [])[0] || {};
        add({ ...base, label: s.label || it.label, value: it.value, unit: it.kind === "commodity" ? "$" : "", date: today, chg_1m: nn(ch["1M"]), chg_3m: nn(ch["3M"]), chg_1y: nn(ch["1Y"]), source: "FMP", symbol: it.symbol });
        continue;
      }
      if (it.kind === "eod" && eod) {
        if (s.key === "eod:sofr") {
          const d = await safe("SOFR", () => eod("get_rates_reference_rates", { code: "SOFR", date_from: addDays(today, -40), limit: 30 }));
          const sd = (d?.data || []).filter((r) => isNum(Number(r.rate))).sort((a, b) => (a.date < b.date ? 1 : -1));
          if (sd[0]) add({ ...base, label: s.label || it.label, value: Number(sd[0].rate), unit: "%", date: day(sd[0].date), prior: sd.length > 1 ? Number(sd[sd.length - 1].rate) : null, prior_label: "~1 month ago", source: "EODHD" });
        } else if (s.key === "eod:real10y") {
          const yr = Number(today.slice(0, 4));
          const meta = await safe("Real yields", () => eod("get_ust_real_yield_rates", { year: yr, limit: 1 }));
          const total = Number(meta?.meta?.total);
          if (total > 0) {
            const real = await safe("Real yields", () => eod("get_ust_real_yield_rates", { year: yr, offset: Math.max(0, total - 60), limit: 60 }));
            const r10 = (real?.data || []).filter((r) => r.tenor === "10Y").sort((a, b) => (a.date < b.date ? 1 : -1));
            if (r10[0]) add({ ...base, label: s.label || it.label, value: Number(r10[0].rate), unit: "%", date: day(r10[0].date), prior: r10.length > 1 ? Number(r10[r10.length - 1].rate) : null, prior_label: "earlier this period", source: "EODHD" });
          }
        } else if (s.key === "eod:hqm10y") {
          const h = await safe("Corporate bond yields", () => eod("get_credit_corporate_hqm_yields", { tenor: 10, type: "spot", date_from: addDays(today, -120), limit: 10 }));
          const yv = (r) => Number(r.yield_value ?? r.yield ?? r.rate ?? r.value);
          const hq = (h?.data || []).filter((r) => isNum(yv(r))).map((r) => ({ ...r, d: day(r.as_of_date ?? r.date) })).sort((a, b) => (a.d < b.d ? 1 : -1));
          if (hq[0]) {
            add({ ...base, label: "High-grade corporate 10-year yield (HQM, monthly)", value: yv(hq[0]), unit: "%", date: hq[0].d, prior: hq[1] ? yv(hq[1]) : null, prior_label: "previous month", source: "EODHD" });
            if (now && isNum(nn(now.year10))) add({ ...base, label: "High-grade corporate spread over the 10-year Treasury (approx.)", value: (yv(hq[0]) - nn(now.year10)) * 100, unit: "bp", date: hq[0].d, source: "EODHD + FMP" });
          }
        }
      }
    }
    const groups = [...new Set(rows.map((r) => r.group))];
    rows.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
    rows.forEach((r, i) => { r.id = "I" + (i + 1); });
    return { rows, groups, as_of: today, planned: (plan.series || []).length, fallback: !!plan.fallback };
  }

  /**
   * The indicators that moved most, scaled by what counts as a big move for
   * each kind of series: yields in basis points, prices in percent, survey
   * indexes in points. Returns [{id, label, move, score}] strongest first.
   */
  function movers(rows, n = 8) {
    const out = [];
    for (const r of rows || []) {
      const v = Number(r.value), p = r.prior === null || r.prior === undefined ? NaN : Number(r.prior);
      let score = 0, move = "";
      if (isNum(Number(r.chg_1m)) && r.chg_1m !== null) {
        const k = String(r.key || "");
        const typ = /VIX|MOVE|volatil/i.test(r.label) ? 10 : k.startsWith("fx:") ? 1.5 : k.startsWith("index:") ? 3 : 5;
        score = Math.abs(r.chg_1m) / typ; move = `${r.chg_1m >= 0 ? "+" : ""}${r.chg_1m.toFixed(1)}% over 1 month${isNum(Number(r.chg_1y)) && r.chg_1y !== null ? ` (${r.chg_1y >= 0 ? "+" : ""}${Number(r.chg_1y).toFixed(1)}% over 1 year)` : ""}`;
      } else if (isNum(v) && isNum(p)) {
        if (r.unit === "%" && /^(treasury|eod):/.test(String(r.key || ""))) { const bp = (v - p) * 100; score = Math.abs(bp) / 15; move = `${bp >= 0 ? "+" : ""}${Math.round(bp)} bp vs ${r.prior_label || "prior"}`; }
        else if (r.unit === "bp") { const d = v - p; score = Math.abs(d) / 10; move = `${d >= 0 ? "+" : ""}${Math.round(d)} bp vs ${r.prior_label || "prior"}`; }
        else if (r.unit === "%") { const d = v - p; score = Math.abs(d) / 0.3; move = `${d >= 0 ? "+" : ""}${d.toFixed(2)} pts vs ${r.prior_label || "prior"}`; }
        else if (p !== 0) { const c = (v / p - 1) * 100; score = Math.abs(c) / (/PMI|ISM|index|sentiment|optimism|Fed/i.test(r.label) ? 3 : 5); move = `${c >= 0 ? "+" : ""}${c.toFixed(1)}% vs ${r.prior_label || "prior"} (${p} → ${v})`; }
      }
      if (isNum(Number(r.estimate)) && r.estimate !== null && isNum(v)) { const miss = v - Number(r.estimate); if (Math.abs(miss) > 0) move += `${move ? "; " : ""}${miss >= 0 ? "above" : "below"} consensus ${r.estimate}`; score += Math.min(1, Math.abs(miss) / (Math.abs(Number(r.estimate)) * 0.05 || 1)); }
      if (score >= 0.8) out.push({ id: r.id, label: r.label, group: r.group, move, score: Math.round(score * 10) / 10 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  const Macro = { catalog, catalogText, fallbackPlan, fetchRows, movers };
  if (typeof module !== "undefined" && module.exports) module.exports = Macro;
  else root.Macro = Macro;
})(typeof window !== "undefined" ? window : globalThis);
