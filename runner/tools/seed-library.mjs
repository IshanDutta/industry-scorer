#!/usr/bin/env node
// Build the shared library from sector checkpoints made before the library existed.
//   node tools/seed-library.mjs out/library.json.gz checkpoint-a.json.gz [checkpoint-b.json.gz ...]
// Takes, from each sector: its news wire, every world situation's facts, every country's facts and every
// regulator instrument's facts (with the sources each cites), the same entries the page saves as it runs.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { merge } from "../lib/libmerge.mjs";

const read = (p) => { const b = readFileSync(p); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8")); };
const libKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const LIB_ID = /^[A-Z]{1,2}\d+$/;
const cites = (o, f) => (typeof o === "string"
  ? (LIB_ID.test(o) ? f(o) : o.replace(/\[([^\]]+)\]/g, (all, inner) => "[" + inner.split(/,\s*/).map((x) => (LIB_ID.test(x.trim()) ? f(x.trim()) : x)).join(", ") + "]"))
  : Array.isArray(o) ? o.map((x) => cites(x, f)) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, cites(v, f)])) : o);
function items(obj, pools, rows = []) {
  const want = new Set(); cites(obj, (id) => { want.add(id); return id; });
  const out = [];
  for (const id of want) {
    const r = rows.find((x) => x.id === id); if (r) { out.push({ id, kind: "I", label: r.label }); continue; }
    for (const p of pools) { const it = (p || []).find((x) => x.id === id); if (it) { const { text, ...lean } = it; out.push(lean); break; } }
  }
  return out;
}

const [outPath, ...ins] = process.argv.slice(2);
const lib = { v: 1, wire: null, situations: {}, countries: {}, bodies: {} };
for (const p of ins) {
  const cp = read(p), recs = cp.records || {}, sector = cp.sector;
  const key = Object.keys(recs).find((k) => /^sector:[^:]+$/.test(k)); const base = key;
  const at = cp.exported_at;
  const one = { v: 1, wire: null, situations: {}, countries: {}, bodies: {} };
  const wire = recs[`${base}:wire`];
  const world = wire?.world?.items || [];
  const store = Object.keys(recs).filter((k) => k.startsWith(`${base}:store:`)).sort((a, b) => Number(a.split(":").pop()) - Number(b.split(":").pop())).flatMap((k) => recs[k] || []);
  const rows = recs[`${base}:macro`]?.macro?.rows || [];
  if (wire?.world) one.wire = { at: wire.world.run_at || at, sector, world: wire.world, macroCat: wire.macroCat, eodTools: wire.eodTools || [] };
  for (const [k, d] of Object.entries(recs)) {
    if (k.startsWith(`${base}:dive:`) && d?.facts?.title) one.situations[libKey(d.facts.title)] = { at, sector, title: d.facts.title, facts: d.facts, items: items(d.facts, [world, store], rows) };
    if (k.startsWith(`${base}:country:`) && d?.facts) {
      const country = d.facts.country || k.split(":country:")[1];
      const news = (d.news || []).map((id) => store.find((x) => x.id === id) || world.find((x) => x.id === id)).filter(Boolean).map(({ text, ...x }) => x);
      one.countries[libKey(country)] = { at, sector, country, facts: d.facts, news, items: items(d.facts, [world, store], rows) };
    }
  }
  // Regulator instruments: each industry's saved rule book holds the instrument's facts next to its own impact.
  for (const [k, r] of Object.entries(recs)) {
    if (!k.startsWith("run:")) continue;
    for (const b of Object.values(r.regbooks || {})) {
      const body = (one.bodies[b.body_key] ||= { name: b.body, at, instruments: {} });
      for (const rule of b.raw?.rules || []) {
        const ik = libKey(rule.name); if (!ik || body.instruments[ik]) continue;
        const facts = { name: rule.name, citation: rule.citation, category: rule.category, status: rule.status, effective: rule.effective, numeric_value: rule.numeric_value,
          what_this_is: rule.what_this_is, last_12_months: rule.last_12_months, next_12_months: rule.next_12_months };
        if (!facts.what_this_is) continue;
        body.instruments[ik] = { at, sector, name: rule.name, citation: rule.citation, facts, items: items(facts, [b.sources || []]) };
      }
    }
  }
  merge(lib, one);
  const n = Object.values(one.bodies).reduce((a, b) => a + Object.keys(b.instruments).length, 0);
  console.log(`${sector} (${at}): ${Object.keys(one.situations).length} situations, ${Object.keys(one.countries).length} countries, ${n} instruments in ${Object.keys(one.bodies).length} bodies${one.wire ? ", wire" : ""}`);
}
writeFileSync(outPath, gzipSync(Buffer.from(JSON.stringify(lib))));
const n = Object.values(lib.bodies).reduce((a, b) => a + Object.keys(b.instruments).length, 0);
console.log(`Library: ${Object.keys(lib.situations).length} situations, ${Object.keys(lib.countries).length} countries, ${n} instruments in ${Object.keys(lib.bodies).length} bodies`);
