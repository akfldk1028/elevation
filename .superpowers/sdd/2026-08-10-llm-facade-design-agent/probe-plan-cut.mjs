// Hypothesis: a plan seam appears where two ADJACENT facets whose normals differ by less than
// the detector's 2 degrees both carry a solid of the SAME material whose z ranges overlap and
// which reaches the fold they share. Same material, coplanar within tolerance, visible edge.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareFacadeContext } from "../../../tools/facade-pipeline/prepare.mjs";
import { runDirFor } from "../../../tools/facade-pipeline/config.mjs";
import { checkFacadeGrammar } from "../../../tools/facade-pipeline/index.mjs";
import { TERMINAL_MATERIALS } from "../../../plugins/elevation-3d/lib/facade-agent/facade-vocabulary.mjs";
const OPENING = new Set(["window", "door", "arch"]);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + (a[2] ?? 0) * (b[2] ?? 0)))) * 180 / Math.PI;
const SETS = [
  ["creative-013", [["grammar-blind-013-curtainwall.json","PASS"],["grammar-blind-013-brisesoleil.json","PASS"],
    ["grammar-blind-013-datum.json","PASS"],["grammar-blind-013-civic3.json","PASS"],["grammar-blind-013-own2.json","PASS"],
    ["grammar-blind-013-cw2.json","FAIL"],["grammar-blind-013-arcade.json","FAIL"],["grammar-blind-013-soaring.json","FAIL"]]],
  ["creative-020", [["grammar-own-020.json","FAIL"],["grammar-a.json","PASS"],["grammar-g.json","PASS"],["grammar-cw3.json","PASS"]]],
];
for (const [id, files] of SETS) {
  const { context } = await prepareFacadeContext({ candidateId: id });
  const dir = runDirFor(id);
  const seg = new Map(context.facade_segments.map((s) => [s.segment_id, s]));
  // Adjacent, near-coplanar pairs of the mass itself.
  const pairs = [];
  for (const face of ["front", "back", "left", "right"]) {
    const f = context.facade_segments.filter((s) => s.face_view === face).sort((a, b) => a.face_offset_m - b.face_offset_m);
    for (let i = 0; i + 1 < f.length; i++) if (angle(f[i].outward_normal, f[i + 1].outward_normal) < 2) pairs.push([f[i], f[i + 1]]);
  }
  for (const [name, outcome] of files) {
    try {
      const c = checkFacadeGrammar({ context, grammar: JSON.parse(await readFile(join(dir, name), "utf8")) });
      if (!c.resolved) { console.log(`${outcome} ${name} no-resolve`); continue; }
      const solidsBy = new Map();
      for (const p of c.resolved.primitives) {
        if (OPENING.has(p.kind) || !(p.depth_m > 1e-9)) continue;
        if (!solidsBy.has(p.segment_id)) solidsBy.set(p.segment_id, []);
        solidsBy.get(p.segment_id).push(p);
      }
      // A member "reaches the fold" when it touches either end of its facet's u range.
      const atFold = (p, s) => p.local_bounds.u_min < 0.02 || p.local_bounds.u_max > s.length_m - 0.02;
      let hits = 0;
      for (const [a, b] of pairs) {
        const A = (solidsBy.get(a.segment_id) ?? []).filter((p) => atFold(p, a));
        const B = (solidsBy.get(b.segment_id) ?? []).filter((p) => atFold(p, b));
        for (const p of A) for (const q of B) {
          if (TERMINAL_MATERIALS[p.kind] !== TERMINAL_MATERIALS[q.kind]) continue;
          const lo = Math.max(p.local_bounds.z_min, q.local_bounds.z_min);
          const hi = Math.min(p.local_bounds.z_max, q.local_bounds.z_max);
          if (hi - lo > 0.05) { hits++; }
        }
      }
      console.log(`${outcome}  ${id.slice(-3)} ${name.replace(/^grammar-(blind-013-)?/, "").replace(".json", "").padEnd(14)} coplanarPairs ${String(pairs.length).padStart(2)}  sameMaterialOverlapsAtFold ${hits}`);
    } catch (e) { console.log(`${outcome} ${name} THROWS ${String(e?.message ?? e).slice(0, 40)}`); }
  }
}
