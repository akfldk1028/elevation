import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareFacadeContext } from "./tools/facade-pipeline/prepare.mjs";
import { runDirFor } from "./tools/facade-pipeline/config.mjs";
import { checkFacadeGrammar } from "./tools/facade-pipeline/index.mjs";
import { TERMINAL_MATERIALS } from "./plugins/elevation-3d/lib/facade-agent/facade-vocabulary.mjs";
const CUT = 1.2;
const OPENING = new Set(["window", "door", "arch"]);
const SETS = [
  ["creative-013", [["grammar-blind-013-curtainwall.json","PASS"],["grammar-blind-013-brisesoleil.json","PASS"],
    ["grammar-blind-013-datum.json","PASS"],["grammar-blind-013-civic3.json","PASS"],["grammar-blind-013-own2.json","PASS"],
    ["grammar-blind-013-cw2.json","FAIL"],["grammar-blind-013-arcade.json","FAIL"],["grammar-blind-013-soaring.json","FAIL"]]],
  ["creative-020", [["grammar-own-020.json","FAIL"],["grammar-a.json","PASS"],["grammar-g.json","PASS"],["grammar-cw3.json","PASS"]]],
];
for (const [id, files] of SETS) {
  const { context } = await prepareFacadeContext({ candidateId: id });
  const dir = runDirFor(id);
  for (const [name, outcome] of files) {
    try {
      const c = checkFacadeGrammar({ context, grammar: JSON.parse(await readFile(join(dir, name), "utf8")) });
      if (!c.resolved) { console.log(`${outcome} ${name} no-resolve`); continue; }
      const cross = c.resolved.primitives.filter((x) => !OPENING.has(x.kind)
        && x.local_bounds.z_min < CUT - 1e-9 && x.local_bounds.z_max > CUT + 1e-9);
      const deep = cross.filter((x) => (x.depth_m ?? 0) > 1e-9);
      const width = deep.reduce((s, x) => s + (x.local_bounds.u_max - x.local_bounds.u_min), 0);
      const maxDepth = deep.length ? Math.max(...deep.map((x) => x.depth_m)) : 0;
      // The hypothesis: every member's BACK face is the mass surface by construction, so the
      // only thing that can make that edge invisible - a same-material seam - is the member
      // wearing the same material as the mass. `precast` is the mass's own.
      const byMat = {};
      for (const x of deep) { const mat = TERMINAL_MATERIALS[x.kind] ?? "?"; byMat[mat] = (byMat[mat] ?? 0) + 1; }
      const sameAsMass = byMat.precast ?? 0;
      const massWidth = deep.filter((x) => TERMINAL_MATERIALS[x.kind] === "precast")
        .reduce((s, x) => s + (x.local_bounds.u_max - x.local_bounds.u_min), 0);
      console.log(`${outcome}  ${id.slice(-3)} ${name.replace(/^grammar-(blind-013-)?/, "").replace(".json","").padEnd(14)}`
        + ` cross ${String(cross.length).padStart(3)}`
        + `  sameMaterialAsMass ${String(sameAsMass).padStart(3)}  itsWidth ${massWidth.toFixed(2).padStart(6)} m`
        + `   ${JSON.stringify(byMat)}`);
    } catch (e) { console.log(`${outcome} ${name} THROWS ${String(e?.message ?? e).slice(0,40)}`); }
  }
}
