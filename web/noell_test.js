const assert = require("assert");
const { clean, strip } = require("./noell.js");
const cases = [
  ["Q4 GMV +7.9% cc; FY +2.9% cc; Mytheresa net sales +11.5% to EUR 994M; NAP/MRP +…", "Q4 GMV +7.9% cc; FY +2.9% cc; Mytheresa net sales +11.5% to EUR 994M"],
  ["Adjusted EBITDA margin 6.5% (Q3) on $886M revenue; FY adjusted EBITDA guide ~$2…", "Adjusted EBITDA margin 6.5% (Q3) on $886M revenue"],
  ["The VIX fell to 19.92. Brent dropped to $91.61 as Iran fears eased. The high-grade spread narrowed only to 98bp and the curve…", "The VIX fell to 19.92. Brent dropped to $91.61 as Iran fears eased."],
  ["6-12 months, entered only after the 202…", "6-12 months, entered only after the"],
  ["comprehensive privacy laws (opt-out, consent, AG … (in_force)", "comprehensive privacy laws (opt-out, consent, AG (in_force)"],
  ["chips used in edtech devices […] and more", "chips used in edtech devices and more"],
  ["IFF (Q3 2026) Earnings Call Highlights: ...", "IFF (Q3 2026) Earnings Call Highlights"],
  ["No cut here.", "No cut here."],
  ["Loading…", "Loading"],
  ["", ""],
];
for (const [a, b] of cases) assert.strictEqual(clean(a), b, `clean(${JSON.stringify(a)})`);
for (const [a] of cases) assert.ok(!clean(a).includes("…"), a);
assert.strictEqual(strip("Getting the latest from GitHub… 3 min"), "Getting the latest from GitHub 3 min");
assert.strictEqual(strip("Writing…"), "Writing");
const NoEll = require("./noell.js");
NoEll.setFull(["Taiwan Strait blockade or invasion. This is the structural chokepoint risk for chips used in edtech devices, and it would halt shipments for months."]);
assert.strictEqual(NoEll.clean("Taiwan Strait blockade or invasion. This is the structural chokepoint risk for chips used in edtech dev…"), "Taiwan Strait blockade or invasion. This is the structural chokepoint risk for chips used in edtech devices, and it would halt shipments for months.");
NoEll.setFull([]);
console.log("noell ok");
