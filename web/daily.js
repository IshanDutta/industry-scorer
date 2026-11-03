/* Industry Scorer: the daily update.
 *
 * The full analysis (a dozen analysts and the lead strategist) runs weekly. In between, each day:
 *   1. code refreshes every number (prices, returns, estimates, positioning, macro values, news) - no Claude;
 *   2. code compares today with the last update and lists what moved (deltas) and any hard triggers;
 *   3. with no trigger, a quick model reads the deltas and says whether anything is material (triage);
 *   4. if something is, one call revisits the 1M-12M calls against what changed and writes a short
 *      "what changed today" note; calls it leaves alone stay exactly as they were.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase().trim();
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const noIds = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,6}\d{1,5}(?:\s*,\s*[A-Z]{1,6}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
  const pc = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const HZ = ["1M", "3M", "6M", "12M"];

  /** What we keep from the last update to compare against. rec: the saved industry run. */
  function prevState(rec) {
    const d = rec?.industry || {}, ag = rec?.agent || {}, res = ag.result || {};
    const idx = d.index || {}, n = (idx.dates || []).length;
    return {
      as_of: res.daily?.as_of || (n ? idx.dates[n - 1] : d.as_of) || ag.as_of || null,
      updated: res.daily?.date || ag.as_of || null,
      cons: Object.fromEntries((d.constituents || []).filter((c) => isNum(num(c.px))).map((c) => [c.symbol, num(c.px)])),
      items: (rec?.research?.items || []).map((i) => lc(i.title).slice(0, 90)),
      world: (rec?.world?.items || []).map((i) => lc(i.title).slice(0, 90)),
      macro: Object.fromEntries((rec?.macro?.rows || []).filter((r) => r.id || r.key).map((r) => [r.id || r.key, { value: num(r.value), id: r.id }])),
      rev30: num(d.forward?.rev30), breadth: num(d.forward?.breadth), sent7: num(rec?.research?.sentiment?.last_7d), rsi: num(d.positioning?.price?.rsi14),
    };
  }

  const levelAt = (ser, date) => { const ds = ser?.dates || [], v = ser?.levels || ser?.closes || []; let k = -1; for (let i = 0; i < ds.length; i++) { if (ds[i] <= date) k = i; else break; } return k >= 0 ? num(v[k]) : NaN; };
  const lastOf = (ser) => { const v = ser?.levels || ser?.closes || []; return num(v[v.length - 1]); };

  /**
   * Today against the last update. cur: {doc (refreshed industry), pack (refreshed research), world (wire), macroRows, calendar (the lead's), spy (series), relevance ({I#: high|medium|low})}.
   * Returns {since, to, days, move, spy, z, sigma, movers, news, world, macro, passed, ahead, revisions, sentiment, rsi, triggers}.
   */
  function deltas(prev, cur, today) {
    const d = cur.doc || {}, idx = d.index || {}, dates = idx.dates || [];
    const to = dates[dates.length - 1] || today, since = prev.as_of || to;
    const days = dates.filter((x) => x > since && x <= to).length;
    const l0 = levelAt(idx, since), l1 = lastOf(idx), move = l0 > 0 && l1 > 0 ? l1 / l0 - 1 : NaN;
    const s0 = levelAt(cur.spy, since), s1 = cur.spy ? levelAt(cur.spy, to) : NaN, spy = s0 > 0 && s1 > 0 ? s1 / s0 - 1 : NaN;
    const vol = num(d.summary?.vol_1y), sigma = isNum(vol) && days > 0 ? vol * Math.sqrt(days / 252) : NaN, z = isNum(move) && sigma > 0 ? move / sigma : NaN;
    const movers = (d.constituents || []).map((c) => { const p0 = prev.cons[c.symbol], p1 = num(c.px), r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : NaN; return { symbol: c.symbol, name: c.name, weight: num(c.weight), ret: r, contrib: r * num(c.weight) }; })
      .filter((m) => isNum(m.ret)).sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib)).slice(0, 8);
    const seen = new Set(prev.items), seenW = new Set(prev.world);
    let k = 0;
    const fresh = (cur.pack?.items || []).filter((i) => i.title && ["N", "P", "E", "M"].includes(i.kind) && !seen.has(lc(i.title).slice(0, 90)) && (!i.date || i.date >= since))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 25)
      .map((i) => ({ id: "D" + ++k, kind: i.kind, date: i.date || "", source: i.source || "", title: trim(i.title, 200), summary: trim(i.summary, 260), symbol: i.symbol || "", url: i.url || "" }));
    const world = (cur.world?.items || []).filter((i) => i.title && !seenW.has(lc(i.title).slice(0, 90)) && (!i.date || i.date >= since))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 12)
      .map((i) => ({ id: "D" + ++k, kind: "W", date: i.date || "", source: i.source || "", title: trim(i.title, 200), summary: trim(i.summary, 200), url: i.url || "" }));
    const macro = (cur.macroRows || []).map((r) => { const p = prev.macro[r.id || r.key]; const v = num(r.value), pv = p ? p.value : NaN;
      const ch = isNum(v) && isNum(pv) ? v - pv : NaN, rel = isNum(ch) && pv ? ch / Math.abs(pv) : NaN, pctUnit = r.unit === "%";
      const big = isNum(ch) && (pctUnit ? Math.abs(ch) >= 0.1 : Math.abs(rel) >= 0.02);
      return { id: r.id, key: r.key, label: r.label, value: v, unit: r.unit || "", prev: pv, change: ch, rel, big, relevance: cur.relevance?.[r.id] || "" }; })
      .filter((m) => m.big).sort((a, b) => Math.abs(b.rel || 0) - Math.abs(a.rel || 0)).slice(0, 12);
    const evs = (cur.calendar?.events || []).map((e) => ({ id: e.id, date: (e.dates || [])[0] || "", title: trim(e.title, 160), importance: e.importance || "", kind: e.kind || "", tickers: e.tickers || [], detail: noIds(e.detail, 220) })).filter((e) => e.date);
    const passed = evs.filter((e) => e.date > since && e.date <= today), ahead = evs.filter((e) => e.date > today && e.date <= addDays(today, 7));
    const revisions = { rev30: num(d.forward?.rev30), was: prev.rev30, breadth: num(d.forward?.breadth), breadth_was: prev.breadth };
    const sentiment = { now: num(cur.pack?.sentiment?.last_7d), was: prev.sent7 };
    const rsi = { now: num(d.positioning?.price?.rsi14), was: prev.rsi };
    // Hard triggers: any of these sends the calls straight to review, without asking the quick model.
    const wOf = Object.fromEntries((d.constituents || []).map((c) => [c.symbol, num(c.weight)]));
    const top10 = new Set((d.constituents || []).slice().sort((a, b) => num(b.weight) - num(a.weight)).slice(0, 10).map((c) => c.symbol));
    const triggers = [];
    if (isNum(z) && Math.abs(z) >= 1.5) triggers.push(`the industry moved ${pc(move)} since ${since}, ${Math.abs(z).toFixed(1)} times its normal move`);
    for (const e of passed) { const big = e.tickers.some((t) => top10.has(t)); if (e.kind === "earnings" && big) triggers.push(`${e.tickers.filter((t) => top10.has(t)).join(", ")} reported (${e.date})`); else if (e.importance === "high") triggers.push(`${e.title} (${e.date}) has passed`); }
    for (const m of movers) if (Math.abs(m.ret) >= 0.08 && (m.weight || 0) >= 0.03) triggers.push(`${m.symbol} moved ${pc(m.ret)} (${(m.weight * 100).toFixed(0)}% of the industry)`);
    for (const m of macro) if (m.relevance === "high" && (m.unit === "%" ? Math.abs(m.change) >= 0.15 : Math.abs(m.rel) >= 0.05)) triggers.push(`${m.label} moved to ${m.value}${m.unit} from ${m.prev}${m.unit}`);
    if (isNum(revisions.rev30) && isNum(revisions.was) && Math.abs(revisions.rev30 - revisions.was) >= 0.01) triggers.push(`EPS revisions moved from ${pc(revisions.was)} to ${pc(revisions.rev30)} over 30 days`);
    if (fresh.length >= 18) triggers.push(`${fresh.length} new company headlines`);
    void wOf;
    return { since, to, days, move, spy, z, sigma, movers, news: fresh, world, macro, passed, ahead, revisions, sentiment, rsi, triggers: [...new Set(triggers)].slice(0, 10) };
  }
  function addDays(d, k) { const t = new Date(String(d).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  /** The deltas as prompt text (D-IDs for new headlines, I-IDs for macro rows). */
  function deltaText(x) {
    const L = [];
    L.push(`Since ${x.since} (${x.days} trading day${x.days === 1 ? "" : "s"}): industry ${pc(x.move)} vs SPY ${pc(x.spy)}${isNum(x.z) ? `; that is ${x.z.toFixed(1)} times a normal move of ±${(x.sigma * 100).toFixed(1)}%` : ""}.`);
    if (x.movers.length) L.push(`Biggest contributors: ${x.movers.map((m) => `${m.symbol} ${pc(m.ret)} (${isNum(m.weight) ? (m.weight * 100).toFixed(1) : "?"}% weight)`).join(", ")}.`);
    if (x.passed.length) L.push(`Events that have now passed: ${x.passed.map((e) => `${e.date} ${e.title}${e.tickers.length ? ` (${e.tickers.join(", ")})` : ""}`).join("; ")}.`);
    if (x.ahead.length) L.push(`Coming in the next 7 days: ${x.ahead.map((e) => `${e.date} ${e.title}`).join("; ")}.`);
    if (x.macro.length) L.push(`Macro moves: ${x.macro.map((m) => `[${m.id}] ${m.label} ${m.prev}${m.unit} -> ${m.value}${m.unit}${m.relevance ? ` (${m.relevance} relevance)` : ""}`).join("; ")}.`);
    if (isNum(x.revisions.rev30)) L.push(`EPS revisions over 30 days: ${pc(x.revisions.rev30)} (was ${pc(x.revisions.was)}); breadth ${isNum(x.revisions.breadth) ? x.revisions.breadth.toFixed(2) : "n/a"} (was ${isNum(x.revisions.breadth_was) ? x.revisions.breadth_was.toFixed(2) : "n/a"}).`);
    if (isNum(x.sentiment.now)) L.push(`News sentiment, last 7 days: ${x.sentiment.now.toFixed(2)} (was ${isNum(x.sentiment.was) ? x.sentiment.was.toFixed(2) : "n/a"}).`);
    if (isNum(x.rsi.now)) L.push(`Industry RSI: ${x.rsi.now.toFixed(0)} (was ${isNum(x.rsi.was) ? x.rsi.was.toFixed(0) : "n/a"}).`);
    L.push(`New company headlines:\n${x.news.map((n) => `[${n.id}] ${n.date} ${n.symbol ? n.symbol + " · " : ""}${n.source}: ${n.title}${n.summary ? ". " + n.summary : ""}`).join("\n") || "(none)"}`);
    L.push(`New world headlines:\n${x.world.map((n) => `[${n.id}] ${n.date} ${n.source}: ${n.title}`).join("\n") || "(none)"}`);
    return L.join("\n");
  }
  const callsText = (res) => HZ.filter((h) => res?.horizons?.[h]).map((h) => { const x = res.horizons[h];
    return `${h}: ${x.call}, ${x.conviction || "?"} conviction, ${(x.expected_move || []).join(" to ")}%, ${x.probability_up ?? "?"}% chance higher. Why: ${noIds(x.drivers, 500)}${(x.decisions || []).length ? ` Decisions in the window: ${x.decisions.slice(0, 6).map((c) => `${c.date || ""} ${noIds(c.event, 90)}`).join("; ")}.` : ""}`; }).join("\n");

  /** Step 3: is anything material? A short prompt for the quick model. */
  function triagePrompt(name, res, x, today) {
    return `You watch the "${name}" industry for an investment team. Today is ${today}. The team's current calls (from ${res?.daily?.date || "its last full analysis"}):
${callsText(res)}

WHAT CHANGED SINCE THE LAST UPDATE (computed from market data and news)
${deltaText(x)}

Is any of this material enough that the 1M, 3M, 6M or 12M call could change (direction, range or the chance of a gain)? Routine moves inside the normal range, expected events landing as expected and generic headlines are not material.
Reply with ONLY this JSON: {"material": true or false, "horizons": ["the horizons worth revisiting, e.g. 1M"], "why": "one sentence"}`;
  }

  /** Step 4: revisit the calls against what changed. */
  function updatePrompt(name, res, x, today, facts) {
    const sc = res?.scenarios || {};
    return `You are the lead strategist for the "${name}" industry. Today is ${today}. Your full analysis is below in brief; since then, the market and news moved (WHAT CHANGED). Update your 1M, 3M, 6M and 12M calls only where the evidence warrants: keep a call that still holds exactly as it is (status "unchanged"); revise it only for a real change in what drives it.

YOUR CURRENT CALLS
${callsText(res)}

YOUR THESIS IN BRIEF: ${noIds(res?.headline, 300)} ${noIds(res?.summary || res?.thesis, 900)}
SCENARIOS (12 months): ${["bull", "base", "bear"].filter((k) => sc[k]).map((k) => `${k} ${sc[k].probability}% (${(sc[k].price_move || []).join(" to ")}%)`).join("; ") || "n/a"}
KEY DRIVERS: ${(res?.drivers || []).slice(0, 5).map((d) => `${d.title} (${d.direction})`).join("; ") || "n/a"}
NORMAL MOVES NOW (one sigma): ${(facts || []).map((f) => `${f.h} ±${f.sigma}%`).join(", ") || "n/a"}

WHAT CHANGED SINCE THE LAST UPDATE
${deltaText(x)}
${x.triggers.length ? `\nFLAGGED BY CODE: ${x.triggers.join("; ")}` : ""}

RULES
- Cite what you rely on with its ID in square brackets: [D#] for today's headlines, [I#] for macro rows. Never invent a fact or figure.
- A revised range is the LIKELY range (the middle half of outcomes): its half-width about two-thirds of the one-sigma move for that window, never more.
- Events that have passed: say how they landed and what that does to the call.

Reply with ONLY this JSON:
{"material": true or false, "headline": "one sentence: what changed today for this industry", "summary": "2-4 sentences, cited", "changes": [{"text": "one change and what it means, cited", "effect": "positive | negative | mixed"}],
 "horizons": {${HZ.map((h) => `"${h}": {"status": "unchanged | revised", "call": "bullish | neutral | bearish", "conviction": "high | medium | low", "expected_move": [-3, 4], "probability_up": 52, "why": "1-2 sentences: why it stands or what changed, cited"}`).join(", ")}},
 "scenario_probabilities": {"bull": 25, "base": 50, "bear": 25} or null if unchanged, "watch": ["1-3 things to watch tomorrow"]}`;
  }

  /**
   * Apply an update to the lead's result (returns a new result). upd: the update JSON (or null for "nothing material"); via: "code" | "triage" | "update".
   * Each revised horizon keeps where it came from; a daily history of the last 20 updates is kept.
   */
  function apply(res, upd, x, { today, via, tri = null, sources = [] }) {
    const out = JSON.parse(JSON.stringify(res || {}));
    const ids = new Set(sources.map((s) => s.id).concat((x.macro || []).map((m) => m.id)));
    const cite = (t, k = 600) => trim(String(t || "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter((i) => ids.has(i)); return keep.length ? `[${keep.join(", ")}]` : ""; }), k);
    const en = (v, list, dflt) => (list.includes(lc(v)) ? lc(v) : dflt);
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : []);
    const hz = {};
    if (upd?.horizons) for (const h of HZ) { const y = upd.horizons[h], old = out.horizons?.[h]; if (!y || !old) continue;
      const revised = lc(y.status) === "revised";
      hz[h] = { status: revised ? "revised" : "unchanged", why: cite(y.why, 500) };
      if (revised) { const to = { call: en(y.call, ["bullish", "neutral", "bearish"], old.call), conviction: en(y.conviction, ["high", "medium", "low"], old.conviction || ""), expected_move: rng(y.expected_move).length ? rng(y.expected_move) : old.expected_move, probability_up: isNum(num(y.probability_up)) ? Math.max(0, Math.min(100, Math.round(num(y.probability_up)))) : old.probability_up };
        const from = { call: old.call, conviction: old.conviction || "", expected_move: old.expected_move, probability_up: old.probability_up };
        if (JSON.stringify(from) === JSON.stringify(to)) hz[h].status = "unchanged";
        else { Object.assign(old, to, { daily: { date: today, why: hz[h].why, from } }); hz[h].from = from; hz[h].to = to; } } }
    const sp = upd?.scenario_probabilities;
    if (sp && typeof sp === "object" && out.scenarios) { const ks = ["bull", "base", "bear"].filter((k) => out.scenarios[k] && isNum(num(sp[k])));
      const tot = ks.reduce((a, k) => a + num(sp[k]), 0);
      if (ks.length === Object.keys(out.scenarios).length && tot > 0) { const was = Object.fromEntries(ks.map((k) => [k, out.scenarios[k].probability]));
        ks.forEach((k) => (out.scenarios[k].probability = Math.round((num(sp[k]) / tot) * 100)));
        const diff = 100 - ks.reduce((a, k) => a + out.scenarios[k].probability, 0); if (out.scenarios.base) out.scenarios.base.probability += diff;
        if (ks.some((k) => was[k] !== out.scenarios[k].probability)) hz._scenarios = { from: was, to: Object.fromEntries(ks.map((k) => [k, out.scenarios[k].probability])) }; } }
    const changed = Object.values(hz).some((v) => v.status === "revised") || !!hz._scenarios;
    const entry = { date: today, as_of: x.to, since: x.since, via, material: !!(upd ? upd.material !== false && (changed || (upd.changes || []).length) : false),
      headline: upd ? cite(upd.headline, 300) : trim(tri?.why || "Nothing material since the last update; the calls stand.", 300), summary: upd ? cite(upd.summary, 900) : "",
      changes: upd ? (Array.isArray(upd.changes) ? upd.changes : []).slice(0, 6).map((c) => ({ text: cite(c?.text, 400), effect: en(c?.effect, ["positive", "negative", "mixed"], "mixed") })).filter((c) => c.text) : [],
      horizons: hz, revised: changed, watch: upd ? (Array.isArray(upd.watch) ? upd.watch : []).slice(0, 3).map((w) => cite(w, 200)).filter(Boolean) : [], triggers: x.triggers || [],
      move: isNum(x.move) ? Math.round(x.move * 1000) / 10 : null, spy: isNum(x.spy) ? Math.round(x.spy * 1000) / 10 : null, z: isNum(x.z) ? Math.round(x.z * 10) / 10 : null,
      movers: (x.movers || []).slice(0, 5).map((m) => ({ symbol: m.symbol, ret: Math.round(m.ret * 1000) / 10 })),
      sources: sources.filter((s) => JSON.stringify(upd || {}).includes(s.id)).map(({ id, date, source, title, url }) => ({ id, date, source, title, url })) };
    const hist = [entry, ...((out.daily_history || []).filter((h) => h.date !== today))].slice(0, 20).map((h, i) => (i === 0 ? h : { date: h.date, via: h.via, material: h.material, revised: h.revised, headline: h.headline, move: h.move }));
    out.daily = entry; out.daily_history = hist;
    return { result: out, changed };
  }

  const Daily = { prevState, deltas, deltaText, triagePrompt, updatePrompt, apply, HZ };
  if (typeof module !== "undefined" && module.exports) module.exports = Daily;
  else root.Daily = Daily;
})(typeof window !== "undefined" ? window : globalThis);
