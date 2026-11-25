/**
 * The cheap repair: finish the passages that were cut short when they were saved, and bring back the reasoning the
 * old fact-check removed, without rewriting whole reports.
 *
 *  - cuts(obj): every string in a report that ends in "…" (the old length limits), with its path. Source titles and
 *    quotes and the daily updates' own history are left out (they can end in "…" on their own).
 *  - fillPrompt(items, ...): one call finishes many passages. Each passage is shown with the object it sits in (its
 *    neighbours) and the sources it cites, and must be continued from where it was cut, in the same voice, with facts
 *    only from that text and those sources.
 *  - acceptFill(cut, fill): a fill counts only if it keeps the saved start word for word and adds to it.
 *  - recheck(doc, spec, RegBook): for a rule book or a regulatory verdict fact-checked before reasoning could be kept,
 *    the claims the old check removed (from the saved original, doc.raw), to be checked again under the new rule; then
 *    rebuild(doc, spec, newResults, RegBook) applies the old results for every other claim and the new ones for these,
 *    to a fresh copy of the original, so nothing else changes.
 * Code only here; the page makes the calls.
 */
(function (root) {
  "use strict";
  const SKIP = new Set(["sources", "quotes", "daily_refs", "daily_history", "daily", "daily_pending", "outlook_history", "coverage", "excerpt", "checks", "raw", "stats"]);
  const CUT = /…\s*$/;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  // The old check log kept a claim's text cut at 300 characters: match on its start.
  const ckey = (s) => norm(s).replace(/…$/, "").slice(0, 290).toLowerCase();

  function cuts(obj, path = [], out = []) {
    if (typeof obj === "string") { if (CUT.test(obj)) out.push({ path, text: obj }); return out; }
    if (Array.isArray(obj)) { obj.forEach((x, i) => cuts(x, [...path, i], out)); return out; }
    if (obj && typeof obj === "object") for (const [k, x] of Object.entries(obj)) if (!SKIP.has(k)) cuts(x, [...path, k], out);
    return out;
  }
  const getAt = (o, p) => p.reduce((a, k) => (a == null ? a : a[k]), o);
  function setAt(o, p, v) { const parent = getAt(o, p.slice(0, -1)); if (parent && typeof parent === "object") parent[p[p.length - 1]] = v; }

  /** The object a passage sits in, as short JSON, so the fill matches its neighbours (long siblings shortened, for the prompt only). */
  function context(obj, path) {
    const parent = path.length > 1 ? getAt(obj, path.slice(0, -1)) : obj;
    const shrink = (x, d = 0) => typeof x === "string" ? (x.length > 400 ? x.slice(0, 400) + " [...]" : x)
      : Array.isArray(x) ? (d > 2 ? `[${x.length} items]` : x.slice(0, 6).map((y) => shrink(y, d + 1)))
      : x && typeof x === "object" ? (d > 2 ? "{...}" : Object.fromEntries(Object.entries(x).filter(([k]) => !SKIP.has(k)).slice(0, 14).map(([k, y]) => [k, shrink(y, d + 1)]))) : x;
    return JSON.stringify(shrink(parent));
  }
  const idsIn = (s) => [...new Set([...String(s).matchAll(/\b([A-Z]{1,2}\d{1,5})\b/g)].map((m) => m[1]))];
  const snippet = (it) => it ? norm(`${it.title || ""}. ${it.summary || it.text || it.excerpt || it.content || ""}`).slice(0, 700) : "";

  /**
   * items: [{ id, where, text, context }]; sources: { ID: item }. The reply: {"fills": [{"id": "F1", "text": "..."}]}.
   */
  function fillPrompt(items, { subject, gist = "", sources = {} } = {}) {
    const used = [...new Set(items.flatMap((x) => idsIn(x.text + " " + x.context)))].filter((id) => sources[id]).slice(0, 80);
    return `You are the analyst who wrote this research on ${subject}. When it was saved, a length limit cut some passages off mid-way; each one below ends in "…". Finish each passage.

Rules:
- Start with the saved text exactly as it is, word for word (without the "…"), then continue it to a natural, complete end in the same voice and style, and about as long as the passage needed to be.
- The continuation may use only facts in the passage's neighbours (shown with it) and the sources below. No new figures, dates, names, quotes or company actions that aren't there. Keep its [ID] citations and cite the sources you use the same way.
- If the cut came mid-number or mid-name and you can't tell what it was from the text or the sources, end the sentence cleanly before it instead of guessing.
- Short fields (a name, a citation, a date, a value) only need the missing words.
${gist ? `\nWHAT THE ANALYSIS SAYS OVERALL\n${gist}\n` : ""}
SOURCES
${used.map((id) => `[${id}] ${sources[id].date || ""} · ${sources[id].source || ""}: ${snippet(sources[id])}`).join("\n") || "(none cited)"}

PASSAGES TO FINISH
${items.map((x) => `${x.id} (${x.where})
  neighbours: ${x.context}
  saved text: ${x.text}`).join("\n\n")}

Reply with ONLY JSON: {"fills": [{"id": "F1", "text": "the whole passage, finished"}]}`;
  }

  /** A fill stands only if it keeps the saved start (all but its last, possibly broken, word) and adds to it. */
  function acceptFill(cut, fill) {
    const base = norm(String(cut).replace(CUT, "")), f = norm(fill);
    if (!f || CUT.test(f) || f.length <= base.length) return null;
    const keep = base.replace(/\s*\S*$/, "");
    const lc = (s) => s.toLowerCase().replace(/[“”"']/g, "");
    if (keep.length >= 8 ? !lc(f).startsWith(lc(keep)) : !lc(f).startsWith(lc(base).slice(0, 4))) return null;
    return f;
  }

  /**
   * Fills, one call's worth at a time: [{ items, apply(results) }]. reports: [{ key, label, obj }]. Each chunk holds up
   * to `per` passages; apply writes the accepted fills into the objects and returns how many stood.
   */
  function plan(reports, { per = 40 } = {}) {
    const all = [];
    for (const r of reports) for (const c of cuts(r.obj)) all.push({ r, c });
    const chunks = [];
    for (let i = 0; i < all.length; i += per) {
      const part = all.slice(i, i + per).map((x, j) => ({ ...x, id: "F" + (j + 1) }));
      chunks.push({
        items: part.map((x) => ({ id: x.id, where: `${x.r.label}: ${x.c.path.join(".")}`, text: x.c.text, context: context(x.r.obj, x.c.path) })),
        apply(raw) {
          const byId = Object.fromEntries((Array.isArray(raw?.fills) ? raw.fills : []).map((f) => [String(f?.id || "").toUpperCase(), f?.text]));
          let ok = 0;
          for (const x of part) { const v = acceptFill(x.c.text, byId[x.id]); if (v) { setAt(x.r.obj, x.c.path, v); ok++; } }
          return { ok, of: part.length };
        } });
    }
    return chunks;
  }

  /**
   * A rule book or verdict fact-checked under the old rule: the claims of its original (doc.raw) that the check removed.
   * Returns { claims (to check again, with fresh ids), prev (the old results by claim text) } or null.
   */
  function recheck(doc, specOf, RegBook) {
    const raw = doc?.raw; if (!raw || !Array.isArray(doc.checks)) return null;
    const work = JSON.parse(JSON.stringify(raw)), cs = RegBook.claimsFor(work, specOf(work));
    const prev = {}; for (const c of doc.checks) prev[ckey(c.text)] = c;
    // Only the analyst's reasoning can come back (events and figures still need a source they didn't have).
    const again = cs.claims.filter((c) => { const p = prev[ckey(c.text)]; return c.kind === "analysis" && (!p || p.label === "unsupported"); });
    return { claims: again.map((c, i) => ({ ...c, id: "C" + (i + 1), orig: c.id })), prev };
  }
  /** Old results for every claim the check kept, new ones for the claims checked again; applied to a fresh copy of the original. */
  function rebuild(doc, specOf, newRaw, again, idx, RegBook, { keep = [], saved = null } = {}) {
    const work = JSON.parse(JSON.stringify(doc.raw)), cs = RegBook.claimsFor(work, specOf(work));
    const byNew = Object.fromEntries((Array.isArray(newRaw?.results) ? newRaw.results : []).map((r) => [String(r?.id || "").toUpperCase(), r]));
    const origOf = Object.fromEntries(again.claims.map((c) => [c.orig, c.id]));
    const results = cs.claims.map((c) => {
      if (origOf[c.id]) { const r = byNew[origOf[c.id]] || {}; return { ...r, id: c.id }; }
      const p = again.prev[ckey(c.text)] || {};
      return { id: c.id, label: p.label || "unsupported", quote: p.quote || "", source: p.source || "", fix: p.fix || "" };
    });
    const fc = RegBook.applyFactcheck(work, cs, { results }, idx);
    // Parts whose sources may have moved on since (a verdict's dated timeline) stay exactly as saved.
    for (const k of keep) if (saved && saved[k] !== undefined) work[k] = JSON.parse(JSON.stringify(saved[k]));
    return { work, checks: fc.checks, summary: fc.summary };
  }

  const Patch = { cuts, getAt, setAt, context, idsIn, snippet, fillPrompt, acceptFill, plan, recheck, rebuild, SKIP };
  if (typeof module !== "undefined" && module.exports) module.exports = Patch;
  else root.Patch = Patch;
})(typeof window !== "undefined" ? window : globalThis);
