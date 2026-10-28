#!/usr/bin/env node
// Merge shared libraries (facts sectors researched) into one: newer entries win, same as the page's libMerge.
//   node lib/libmerge.mjs out.json.gz a.json.gz [b.json.gz ...]   (missing inputs are skipped)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

const read = (p) => { const b = readFileSync(p); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8")); };
const at = (e) => Date.parse(e?.at || 0) || 0;
const newer = (a, b) => (!a ? b : !b ? a : at(b) > at(a) ? b : a);

export function merge(into, from) {
  if (!from || from.v !== 1) return into;
  into.wire = newer(into.wire, from.wire);
  for (const k of ["situations", "countries"]) for (const [key, e] of Object.entries(from[k] || {})) into[k][key] = newer(into[k][key], e);
  for (const [key, b] of Object.entries(from.bodies || {})) {
    const cur = into.bodies[key] || { name: b.name, at: b.at, instruments: {} };
    for (const [ik, e] of Object.entries(b.instruments || {})) cur.instruments[ik] = newer(cur.instruments[ik], e);
    if (at(b) > at(cur)) cur.at = b.at;
    into.bodies[key] = cur;
  }
  return into;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...ins] = process.argv.slice(2);
  const lib = { v: 1, wire: null, situations: {}, countries: {}, bodies: {} };
  for (const p of ins) if (p && existsSync(p)) { try { merge(lib, read(p)); } catch (e) { console.error(`Skipped ${p}: ${e.message}`); } }
  writeFileSync(out, gzipSync(Buffer.from(JSON.stringify(lib))));
  const n = Object.values(lib.bodies).reduce((a, b) => a + Object.keys(b.instruments).length, 0);
  console.log(`Library: ${Object.keys(lib.situations).length} situations, ${Object.keys(lib.countries).length} countries, ${n} regulator instruments in ${Object.keys(lib.bodies).length} bodies${lib.wire ? `, news wire from ${lib.wire.at}` : ""}`);
}
