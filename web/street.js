/**
 * Wall Street over the last year: how analysts' ratings, rating changes and price targets have moved, for one stock
 * or for a group (an industry's biggest companies, a fund's biggest holdings), and a plain-English read of the trend.
 * Code only: no Claude. Inputs are FMP's monthly rating counts (historical-grades), rating actions (grades) and the
 * price-target summary, already normalized by the page:
 *   rhist: [{ date, sb, b, h, s, ss }]   actions: [{ date, firm, from, to, action }]   ptrend: { m, m_n, q, q_n, y, y_n }
 * Text marks emphasis with **bold** and *italic*; the page turns that into tags after escaping.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const n0 = (x) => (isNum(+x) ? +x : 0);
  const pc = (x, d = 0) => `${(Math.abs(x) * 100).toFixed(d)}%`;
  const pts = (x) => { const v = Math.round(x * 100); return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)} point${Math.abs(v) === 1 ? "" : "s"}`; };
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = (d) => { const m = +String(d).slice(5, 7); return m ? `${MON[m - 1]} ${String(d).slice(0, 4)}` : String(d); };
  const dayName = (d) => { const m = +String(d).slice(5, 7), day = +String(d).slice(8, 10); return m && day ? `${MON[m - 1].slice(0, 3)} ${day}` : String(d); };
  const money = (x) => (isNum(x) ? `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}` : "n/a");
  const back = (today, days) => { if (!today) return ""; const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };

  /** One month of ratings: counts, total and the buy and sell shares. */
  function month(m) {
    const sb = n0(m.sb), b = n0(m.b), h = n0(m.h), s = n0(m.s), ss = n0(m.ss), tot = sb + b + h + s + ss;
    return { date: String(m.date || "").slice(0, 10), sb, b, h, s, ss, tot, buy: tot ? (sb + b) / tot : NaN, sell: tot ? (s + ss) / tot : NaN };
  }
  const tally = (xs) => ({ up: xs.filter((a) => a.action === "upgrade").length, down: xs.filter((a) => a.action === "downgrade").length,
    init: xs.filter((a) => /^init/i.test(a.action || "")).length, kept: xs.filter((a) => /maintain|reiterat/i.test(a.action || "")).length, n: xs.length });
  /** The path of the buy share across the year, in words. */
  function shape(ms) {
    const v = ms.map((m) => m.buy).filter(isNum); if (v.length < 3) return "";
    const a = v[0], z = v[v.length - 1], hi = Math.max(...v), lo = Math.min(...v), t = 0.02;
    if (hi - lo < 0.03) return "barely moved all year";
    if (z - a > t && hi - z < t) return "climbed through the year";
    if (a - z > t && z - lo < t) return "slid through the year";
    if (hi - Math.max(a, z) > t) return `peaked in ${monthName(ms[v.indexOf(hi)]?.date || "")} and has eased since`;
    if (Math.min(a, z) - lo > t) return `bottomed in ${monthName(ms[v.indexOf(lo)]?.date || "")} and has recovered since`;
    return z > a ? "drifted up" : z < a ? "drifted down" : "ended where it started";
  }
  const LABELS = { 2: "improving", 1: "leaning better", 0: "steady", "-1": "leaning worse", "-2": "cooling" };
  const label = (score) => LABELS[Math.max(-2, Math.min(2, score))];
  const signals = (dBuy, net90, tchg) => [isNum(dBuy) ? (dBuy > 0.03 ? 1 : dBuy < -0.03 ? -1 : 0) : 0, net90 > 0 ? 1 : net90 < 0 ? -1 : 0, isNum(tchg) ? (tchg > 0.03 ? 1 : tchg < -0.03 ? -1 : 0) : 0];

  /** One stock's last year on Wall Street. */
  function one({ sym, rhist = [], actions = [], ptrend = null, px = NaN, today = "" }) {
    const months = (rhist || []).map(month).filter((m) => m.tot > 0 && m.date).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-13);
    const now = months[months.length - 1] || null, ago = months.length > 1 ? months[0] : null;
    const acts = (actions || []).filter((a) => a && a.date && (!today || a.date >= back(today, 366))).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const a90 = tally(acts.filter((a) => !today || a.date >= back(today, 91))), a365 = tally(acts);
    const P = ptrend || {}, m = +P.m || NaN, y = +P.y || NaN, q = +P.q || NaN;
    const pt = isNum(m) || isNum(y) ? { m, q, y, m_n: n0(P.m_n), q_n: n0(P.q_n), y_n: n0(P.y_n), chg: isNum(m) && isNum(y) ? m / y - 1 : NaN, vs_px: isNum(m) && isNum(px) && px > 0 ? m / px - 1 : NaN } : null;
    const dBuy = now && ago ? now.buy - ago.buy : NaN, sig = signals(dBuy, a90.up - a90.down, pt?.chg), score = sig.reduce((x, s) => x + s, 0);
    return { sym, months, now, ago, dBuy, a90, a365, acts, pt, px, score, label: label(score), sig, path: shape(months) };
  }

  /** A group: each name's year, weighted. list: [{ sym, w, T }] where T = one(...). */
  function many(list) {
    const ok = (list || []).filter((x) => x?.T?.now && n0(x.w) > 0), W = ok.reduce((a, x) => a + n0(x.w), 0);
    if (!ok.length || !W) return null;
    const keys = [...new Set(ok.flatMap((x) => x.T.months.map((m) => m.date.slice(0, 7))))].sort().slice(-13);
    const months = keys.map((k) => { const at = ok.map((x) => ({ w: n0(x.w), m: x.T.months.find((m) => m.date.slice(0, 7) === k) })).filter((x) => x.m);
      const ww = at.reduce((a, x) => a + x.w, 0); if (!ww || at.length < Math.max(1, ok.length * 0.5)) return null;
      const f = (key) => at.reduce((a, x) => a + (x.w * x.m[key]) / x.m.tot, 0) / ww;
      return { date: k + "-01", sb: f("sb"), b: f("b"), h: f("h"), s: f("s"), ss: f("ss"), tot: 1, buy: f("sb") + f("b"), sell: f("s") + f("ss"), n: at.reduce((a, x) => a + x.m.tot, 0) }; }).filter(Boolean);
    const now = months[months.length - 1] || null, ago = months.length > 1 ? months[0] : null;
    const sum = (k, p) => ok.reduce((a, x) => a + x.T[k][p], 0);
    const a90 = { up: sum("a90", "up"), down: sum("a90", "down"), init: sum("a90", "init"), n: sum("a90", "n") }, a365 = { up: sum("a365", "up"), down: sum("a365", "down"), init: sum("a365", "init"), n: sum("a365", "n") };
    const tp = ok.filter((x) => isNum(x.T.pt?.chg)), tw = tp.reduce((a, x) => a + n0(x.w), 0), tchg = tw ? tp.reduce((a, x) => a + n0(x.w) * x.T.pt.chg, 0) / tw : NaN;
    const up = ok.filter((x) => isNum(x.T.pt?.vs_px)), uw = up.reduce((a, x) => a + n0(x.w), 0), upside = uw ? up.reduce((a, x) => a + n0(x.w) * x.T.pt.vs_px, 0) / uw : NaN;
    const names = ok.map((x) => ({ sym: x.sym, w: n0(x.w), T: x.T })).sort((a, b) => b.w - a.w);
    const moved = names.filter((x) => isNum(x.T.dBuy)).sort((a, b) => b.T.dBuy - a.T.dBuy);
    const dBuy = now && ago ? now.buy - ago.buy : NaN, sig = signals(dBuy, a90.up - a90.down, tchg), score = sig.reduce((x, s) => x + s, 0);
    const latest = names.flatMap((x) => x.T.acts.map((a) => ({ ...a, sym: x.sym }))).sort((a, b) => (a.date < b.date ? 1 : -1));
    return { many: true, n: ok.length, of: (list || []).length, weight: W, months, now, ago, dBuy, a90, a365, pt: isNum(tchg) ? { chg: tchg, vs_px: upside, n: tp.length } : null,
      names, up: moved.filter((x) => x.T.dBuy > 0.02).slice(0, 3), down: moved.filter((x) => x.T.dBuy < -0.02).reverse().slice(0, 3), acts: latest, score, label: label(score), sig, path: shape(months) };
  }

  const direction = (d) => (!isNum(d) ? "" : d > 0.03 ? "up" : d < -0.03 ? "down" : "about level");
  /** The read, as short paragraphs. */
  function text(T, { what = "", coverage = NaN } = {}) {
    if (!T?.now) return [];
    const out = [], reasons = [];
    if (T.many) {
      out.push(`Across the ${T.n} biggest ${what || "names"} with analyst coverage${isNum(coverage) ? ` (${pc(coverage)} of it by weight)` : ""}, a weighted **${pc(T.now.buy)}** of ratings are buys${T.ago ? `, against ${pc(T.ago.buy)} in ${monthName(T.ago.date)}: *${direction(T.dBuy)}* (${pts(T.dBuy)})` : ""}.${T.path ? ` The buy share ${T.path}.` : ""}`);
      const mv = [T.up.length ? `Most improved: ${T.up.map((x) => `**${x.sym}** (${pts(x.T.dBuy)}, to ${pc(x.T.now.buy)} buys)`).join(", ")}.` : "", T.down.length ? `Most cooled: ${T.down.map((x) => `**${x.sym}** (${pts(x.T.dBuy)}, to ${pc(x.T.now.buy)} buys)`).join(", ")}.` : ""].filter(Boolean).join(" ");
      if (mv) out.push(mv);
    } else {
      out.push(`**${pc(T.now.buy)}** of the ${T.now.tot} analysts covering ${T.sym} rate it a buy${T.ago ? `, against ${pc(T.ago.buy)} of ${T.ago.tot} in ${monthName(T.ago.date)}: *${direction(T.dBuy)}* (${pts(T.dBuy)})` : ""}.${T.path ? ` The buy share ${T.path}.` : ""}`);
      const sNow = T.now.s + T.now.ss, sAgo = T.ago ? T.ago.s + T.ago.ss : NaN;
      if (sNow || sAgo) out.push(`Sell ratings: **${sNow}** now${isNum(sAgo) ? `, ${sAgo} a year ago` : ""}. Holds: ${T.now.h}${T.ago ? `, ${T.ago.h} a year ago` : ""}.`);
    }
    if (T.a365.n) {
      const last = T.acts[0];
      out.push(`Over the last 12 months: **${T.a365.up} upgrade${T.a365.up === 1 ? "" : "s"}** and **${T.a365.down} downgrade${T.a365.down === 1 ? "" : "s"}**, with ${T.a365.init} new initiation${T.a365.init === 1 ? "" : "s"}. In the last 90 days, ${T.a90.up} up and ${T.a90.down} down${T.a90.up === T.a90.down ? ", *a wash*" : T.a90.up > T.a90.down ? ", *more firms turning positive*" : ", *more firms turning cautious*"}.${last ? ` The latest: ${last.firm || "a firm"} ${last.action === "upgrade" ? "upgraded" : last.action === "downgrade" ? "downgraded" : /^init/i.test(last.action || "") ? "started coverage on" : "reiterated"} ${T.many && last.sym ? `**${last.sym}**` : "it"}${last.to ? ` at *${last.to}*` : ""} on ${dayName(last.date)}.` : ""}`);
    }
    if (T.pt && isNum(T.pt.chg)) {
      out.push(T.many ? `New price targets on these names moved **${T.pt.chg >= 0 ? "up" : "down"} ${pc(T.pt.chg, 1)}** (last month's average against the year's, weighted)${isNum(T.pt.vs_px) ? `, and sit ${pc(T.pt.vs_px, 1)} ${T.pt.vs_px >= 0 ? "above" : "below"} today's prices` : ""}.`
        : `New price targets averaged **${money(T.pt.m)}** over the last month (${T.pt.m_n} target${T.pt.m_n === 1 ? "" : "s"}) against ${money(T.pt.y)} over the year (${T.pt.y_n}): *${T.pt.chg >= 0 ? "up" : "down"} ${pc(T.pt.chg, 1)}*${isNum(T.pt.vs_px) ? `, and ${pc(T.pt.vs_px, 1)} ${T.pt.vs_px >= 0 ? "above" : "below"} today's price` : ""}.`);
    }
    if (T.sig[0]) reasons.push(T.sig[0] > 0 ? "more buy ratings than a year ago" : "fewer buy ratings than a year ago");
    if (T.sig[1]) reasons.push(T.sig[1] > 0 ? "more upgrades than downgrades lately" : "more downgrades than upgrades lately");
    if (T.sig[2]) reasons.push(T.sig[2] > 0 ? "rising targets" : "falling targets");
    out.push(`**The trend: ${T.label}.** ${reasons.length ? reasons.join(", ").replace(/^./, (c) => c.toUpperCase()) + "." : "Ratings, rating changes and targets are all roughly where they were."}`);
    return out;
  }

  const Street = { month, one, many, text, shape, label, monthName, dayName };
  if (typeof module !== "undefined" && module.exports) module.exports = Street;
  else root.Street = Street;
})(typeof window !== "undefined" ? window : globalThis);
