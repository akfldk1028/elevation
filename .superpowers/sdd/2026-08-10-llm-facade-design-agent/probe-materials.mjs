import { NodeIO } from "@gltf-transform/core";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const dir = "D:/Data/50_ELE/facade-agent-verification/llm-facade-design-agent-20260810/creative-020/llm-facade-subagent-v1/render-param-020-b/compiled";
const files = [];
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (p.endsWith(".glb")) files.push(p); } }
await walk(dir);
const doc = await new NodeIO().readBinary(new Uint8Array(await readFile(files[0])));
for (const m of doc.getRoot().listMaterials()) {
  const e = m.getExtras() ?? {};
  console.log(m.getName().padEnd(24), "base", m.getBaseColorFactor().map((v) => v.toFixed(3)).join(","), "metal", m.getMetallicFactor(), "rough", m.getRoughnessFactor(), "fill", e.elevation_fill ?? "-", "role", e.semantic_role ?? "-");
}
const g = JSON.parse(await readFile("D:/Data/50_ELE/facade-agent-verification/llm-facade-design-agent-20260810/creative-020/llm-facade-subagent-v1/grammar-param-020-b.json", "utf8"));
console.log(JSON.stringify(g.materials.map(({ id, substance, lightness, hue, finish }) => ({ id, substance, lightness, hue, finish }))));
