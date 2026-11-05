/* Industry Scorer: the call scale, used by every 1M-12M call (industries and companies).
 *
 * Five levels: strongly bearish, slightly bearish, neutral, slightly bullish, strongly bullish. Neutral is kept for a
 * true coin flip (the chance of a gain within a few points of 50 AND an expected move near zero); anything else leans.
 * Conviction is 1-10: how sure the call is of its direction, from how well the history (Times like this and the base
 * rates), the evidence across sections and the catalysts in the window agree.
 *
 * Code holds the call to its own numbers: a call whose direction contradicts its chance of a gain or its range, or a
 * neutral that the numbers say leans, is set to what the numbers say (and the change is noted). Old calls ("bullish",
 * "neutral", "bearish"; conviction "high", "medium", "low") read as "slightly ..." and 8 / 5 / 3.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const LEVELS = ["strongly bearish", "slightly bearish", "neutral", "slightly bullish", "strongly bullish"];
  const SCORE = { "strongly bearish": -2, "slightly bearish": -1, neutral: 0, "slightly bullish": 1, "strongly bullish": 2 };
  const ENUM = LEVELS.join(" | ");

  /** Any spelling of a call -> one of LEVELS (or `fallback`). "bullish" -> "slightly bullish". */
  function norm(x, fallback = "neutral") {
    const s = String(x ?? "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return fallback;
    if (LEVELS.includes(s)) return s;
    const bull = /bull|positive|\bup\b|long|buy|overweight|outperform/.test(s), bear = /bear|negative|\bdown\b|short|sell|underweight|underperform/.test(s);
    if (bull === bear) return /neutral|flat|balanced|hold|in line|mixed|coin/.test(s) ? "neutral" : fallback;
    const strong = /strong|very|high conviction|significant/.test(s);
    return (strong ? "strongly " : "slightly ") + (bull ? "bullish" : "bearish");
  }
  /** -2..2 */
  const score = (call) => SCORE[norm(call, "neutral")] ?? 0;
  /** -1, 0 or 1: the direction (works for old and new calls). */
  const dir = (call) => Math.sign(score(call));
  const isStrong = (call) => Math.abs(score(call)) === 2;
  const label = (call) => { const c = norm(call, ""); return c ? c[0].toUpperCase() + c.slice(1) : "—"; };
  /** Pill class: pos2 / pos / neu / neg / neg2. */
  const cls = (call) => ({ 2: "pos2", 1: "pos", 0: "neu", "-1": "neg", "-2": "neg2" })[score(call)];

  /** 1-10, or null. "high" / "medium" / "low" -> 8 / 5 / 3. */
  function conviction(x) {
    if (x === null || x === undefined || x === "") return null;
    const w = { high: 8, medium: 5, med: 5, low: 3 }[String(x).toLowerCase().trim()];
    if (w) return w;
    const n = Number(String(x).replace(/\/\s*10$/, ""));
    return isNum(n) ? Math.max(1, Math.min(10, Math.round(n))) : null;
  }
  const convictionWord = (n) => (!isNum(n) ? "" : n >= 7 ? "high" : n >= 4 ? "medium" : "low");

  /**
   * The call the numbers imply. p = chance of a gain (0-100); mid = the expected move's midpoint (%); sigma = a
   * one-sigma move for the window (%). Neutral only when p is 46-54 and the midpoint is within a fifth of a sigma.
   */
  function implied({ p = null, mid = null, sigma = null } = {}) {
    const z = isNum(mid) && isNum(sigma) && sigma > 0 ? mid / sigma : null;
    const d = isNum(p) ? p - 50 : null;
    if (d === null && z === null) return null;
    const flatP = d === null || Math.abs(d) < 5, flatM = z === null ? !isNum(mid) || Math.abs(mid) < 0.5 : Math.abs(z) < 0.2;
    if (flatP && flatM) return "neutral";
    const sgn = d !== null && Math.abs(d) >= 5 ? Math.sign(d) : Math.sign(z ?? mid);
    const strong = (d !== null && Math.abs(d) >= 15 && (z === null || Math.sign(z) === sgn && Math.abs(z) >= 0.35)) || (z !== null && Math.abs(z) >= 0.8 && d !== null && Math.sign(d) === sgn && Math.abs(d) >= 10);
    return (strong ? "strongly " : "slightly ") + (sgn > 0 ? "bullish" : "bearish");
  }

  /**
   * Hold a call to its own numbers. x: {call, probability_up, expected_move}; sigma: the window's one-sigma move.
   * Returns {call, fixed} where fixed says what changed and why ("" when nothing did).
   */
  function reconcile(x, sigma = null) {
    const call = norm(x?.call, "neutral"), r = Array.isArray(x?.expected_move) ? x.expected_move.filter(isNum) : [];
    const mid = r.length ? r.reduce((a, v) => a + v, 0) / r.length : null;
    const imp = implied({ p: isNum(x?.probability_up) ? x.probability_up : null, mid, sigma });
    if (!imp) return { call, fixed: "" };
    const why = `${isNum(x?.probability_up) ? `${x.probability_up}% chance of a gain` : ""}${isNum(mid) ? `${isNum(x?.probability_up) ? ", " : ""}range centered on ${mid > 0 ? "+" : ""}${Math.round(mid * 10) / 10}%` : ""}`;
    if (dir(call) !== dir(imp) && dir(imp) !== 0) return { call: imp, fixed: `called ${call}, but its own numbers (${why}) say ${imp}` };
    if (dir(call) !== 0 && dir(imp) === 0) return { call: "neutral", fixed: `called ${call}, but its own numbers (${why}) are a coin flip` };
    if (isStrong(call) && !isStrong(imp)) return { call: imp, fixed: `called ${call}, but its own numbers (${why}) only support ${imp}` };
    return { call, fixed: "" };
  }

  /** The rules every call prompt shares. `who` = "the industry" or a ticker. */
  function rules(who = "the industry") {
    return `- "call" is one of: ${ENUM}. Neutral is ONLY for a true coin flip: "probability_up" 46-54 AND the expected move centered within a fifth of a one-sigma move of zero. Everything else leans: "slightly" when the edge is modest (about 55-64% or 36-45% chance of a gain), "strongly" when it is large (65%+ or 35%-, with the range clearly off zero). Code holds the call to its own "probability_up" and "expected_move" and changes it if they disagree, so make the three agree.
- Don't hide in neutral. A wide range around zero with a 50% chance is not an answer: take the base rates (Times like this, the history of similar setups), the evidence across every section and the catalysts in the window, and say which way ${who} is more likely to go. A "probability_up" of exactly 50 needs a stated reason.
- "conviction" is 1-10: how sure you are of the DIRECTION. 1-3 = the evidence conflicts or history is split; 4-6 = a lean most evidence supports; 7-8 = history (Times like this, base rates) and the evidence agree and a catalyst in the window can confirm it; 9-10 = rare, everything lines up. Conviction is separate from size: a slightly bullish call can carry high conviction, a strongly bullish one low. "conviction_why" says in one sentence what sets it and what would change it.`;
  }
  const schema = `"call": "${ENUM}", "conviction": 6, "conviction_why": "one sentence: what sets the conviction and what would change it"`;

  const Calls = { LEVELS, SCORE, ENUM, norm, score, dir, isStrong, label, cls, conviction, convictionWord, implied, reconcile, rules, schema };
  if (typeof module !== "undefined" && module.exports) module.exports = Calls;
  else root.Calls = Calls;
})(typeof window !== "undefined" ? window : globalThis);
