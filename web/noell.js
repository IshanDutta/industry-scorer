/**
 * No "…" on screen, ever. Text saved before the length limits were lifted can end in "…" (cut mid-sentence or
 * mid-number) or carry one inside ("[…]", "AG … (in force)"). On screen such text ends at its last complete sentence,
 * or its last complete item in a list of figures ("a; b; c"), or its last whole word, without the mark.
 *  - clean(s): the text as it should read on screen.
 *  - strip(s): only removes the marks (for labels and fragments where no word is broken).
 */
(function (root) {
  "use strict";
  const END = /\s*(?:…|\.{3})[\s"”’')\]]*$/;
  const strip = (s) => String(s ?? "").replace(/\s*[\[(]…[\])]\s*/g, " ").replace(/\s*…\s*/g, (m, i, all) => (i === 0 || i + m.length >= all.length ? "" : " ")).replace(/ {2,}/g, " ");
  // Whole texts a cut copy may have come from (an industry's reports, lead analysis, rule books and sources): a copy
  // saved cut short is shown as the whole original when one is found.
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
  let FULL = null;
  function setFull(strings) {
    FULL = new Map();
    for (const x of strings || []) { if (typeof x !== "string" || x.length < 40 || END.test(x)) continue; const k = norm(x).slice(0, 36); const a = FULL.get(k); if (a) { if (a.length < 8) a.push(x); } else FULL.set(k, [x]); }
  }
  function whole(base) {
    if (!FULL) return null;
    const probe = norm(base.replace(/\s+\S*$/, "")); if (probe.length < 36) return null;
    const c = (FULL.get(probe.slice(0, 36)) || []).filter((x) => { const n = norm(x); return n.startsWith(probe) && n.length > probe.length + 2; });
    return c.length ? c.sort((a, b) => a.length - b.length)[0] : null;
  }
  function clean(s) {
    s = String(s ?? "");
    if (!s.includes("…") && !/\.{3}[\s"”’')\]]*$/.test(s)) return s;
    let t = s.replace(/\s*[\[(]…[\])]\s*/g, " ");
    if (END.test(t)) {
      const base = t.replace(END, "").replace(/\s+$/, "");
      const w0 = whole(base); if (w0) return strip(w0).trim();
      const ends = [...base.matchAll(/[.!?]["”’')\]]*(?=\s|$)/g)].map((m) => m.index + m[0].length);
      const lastEnd = ends.length ? ends[ends.length - 1] : -1;
      const semi = Math.max(base.lastIndexOf("; "), base.lastIndexOf(" · "));
      if (lastEnd >= 20 && lastEnd >= base.length * 0.5) t = base.slice(0, lastEnd);
      else if (semi >= 8 && semi >= base.length * 0.35) t = base.slice(0, semi);
      else if (lastEnd >= 20) t = base.slice(0, lastEnd);
      else {
        // A mark after a space or punctuation means the last word is whole; right after a letter or digit, it was cut.
        const whole = /(?:\s|[:;,.)\]])(?:…|\.{3})[\s"”’')\]]*$/.test(t);
        const w = whole ? base : base.replace(/\s+\S*$/, "");
        t = (w.length >= 3 && w !== base ? w : base).replace(/[\s,;:–—\-/(+&]+$/, "");
      }
    }
    return strip(t).trim();
  }
  const NoEll = { clean, strip, setFull };
  if (typeof module !== "undefined" && module.exports) module.exports = NoEll;
  else root.NoEll = NoEll;
})(typeof window !== "undefined" ? window : globalThis);
