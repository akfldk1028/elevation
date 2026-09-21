import assert from "node:assert/strict";
import test from "node:test";

import { parseFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { validateResolvedFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

// A lattice is the parametric operator (spec 2026-09-16): cells are PLACED by an evaluated
// ModelSpec, not by the split grammar, and each cell brings its own outline in host metres.
// The terminal that carries `lattice` is instantiated once per cell inside its scope.
const HASH = "a".repeat(64);
const diamond = (cx: number, cy: number, w = 0.6, h = 0.4) => [[cx - w / 2, cy], [cx, cy + h / 2], [cx + w / 2, cy], [cx, cy - h / 2]];
const cell = (id: string, cx: number, cy: number, attributes: Record<string, number> = {}) =>
	({ id, center_m: [cx, cy], outline_m: diamond(cx, cy), attributes });

test('wall polygon openings retain their evaluated contour and enforce slab and true boundary clearances',async(t)=>{
 const {context,program:base}=await createFacadeDesignFixture(t);
 const segment=context.facade_segments[0];
 const lattice={scope:'wall_openings',model_hash:HASH,family:'backing',z_datum_m:0,
  instances:[{...cell('pane',1,1.5),segment_id:segment.segment_id}]};
 const parse=(l:any)=>parseFacadeDesign(grammar(base,{F:[{terminal:'glass',depth_m:-.05,lattice:l}]}),{sourceAuthority:context.source});
 const program=parse(lattice),resolved=resolveFacadeProgram(program,context);
 assert.ok(resolved.primitives.find(p=>p.wall_opening)?.outline);
 assert.ok(!validateResolvedFacadeProgram({program,context,resolved}).codes.includes('SEGMENT_BOUNDS_INVALID'));
 const bad=structuredClone(lattice);bad.instances[0]= {...cell('bad',.15,1.5),segment_id:segment.segment_id};
 const p=parse(bad);assert.ok(validateResolvedFacadeProgram({program:p,context,resolved:resolveFacadeProgram(p,context)}).codes.includes('SEGMENT_BOUNDS_INVALID'));
 const slab=structuredClone(lattice);slab.instances[0]={...cell('slab',1,3.4),segment_id:segment.segment_id};
 const s=parse(slab);assert.ok(validateResolvedFacadeProgram({program:s,context,resolved:resolveFacadeProgram(s,context)}).codes.includes('FLOOR_BAND_INTRUSION'));
});

test('wall-patch evaluation survives parsing and derivation, while out-of-wall solids and opening misuse are refused',async(t)=>{
 const {context,program:base}=await createFacadeDesignFixture(t);
 const segment=context.facade_segments[0];
 const mesh={vertices:[[0,1,0],[.5,1,0],[.5,1.5,0],[0,1.5,0],[0,1,1],[.5,1,1],[.5,1.5,1],[0,1.5,1]],
  triangles:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]};
 const lattice={scope:'wall_patch',model_hash:HASH,family:'module',z_datum_m:0,
  instances:[{...cell('clip',.25,1.25,{depth_m:.25}),segment_id:segment.segment_id,mesh_uzn:mesh,aperture_area_m2:0}]};
 const parse=(l:any,terminal='louvre')=>parseFacadeDesign(grammar(base,{F:[{terminal,depth_m:.3,lattice:l}]}),{sourceAuthority:context.source});
 const program=parse(lattice),resolved=resolveFacadeProgram(program,context);
 const drawn=resolved.primitives.find(p=>p.wall_patch);
 assert.deepEqual(drawn.mesh_uzn,mesh);
 assert.equal(drawn.depth_m,.25,'evaluated depth field is consumed');
 assert.ok(!validateResolvedFacadeProgram({program,context,resolved}).codes.includes('SEGMENT_BOUNDS_INVALID'));
 assert.throws(()=>parse(lattice,'glass'),/solid louvres/);
 const bad=structuredClone(lattice);bad.instances[0].mesh_uzn.vertices=mesh.vertices.map(([u,z,n])=>[u-1,z,n]);
 const wrongProgram=parse(bad),wrong=resolveFacadeProgram(wrongProgram,context);
 assert.ok(validateResolvedFacadeProgram({program:wrongProgram,context,resolved:wrong}).codes.includes('SEGMENT_BOUNDS_INVALID'));
});

test("lattice allocation admits a cheap 5000-cell list and still refuses unbounded input", async (t) => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	const parse = (count: number) => parseFacadeDesign(grammar(base, {
		F: [{ terminal: "louvre", depth_m: 0.1, lattice: { model_hash: HASH, family: "lens",
			instances: Array.from({length:count}, (_,i) => cell(`c${i}`, i, 2)) } }],
	}), {sourceAuthority:context.source});
	assert.doesNotThrow(() => parse(5000));
	assert.throws(() => parse(25000), /instances/);
});

function grammar(base: any, rules: any, extra: Record<string, unknown> = {}) {
	return {
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "lattice-probe", source_photograph: null,
		start: "F", entrance: base.entrance,
		materials: [{ id: "amber-glazing", substance: "glazing", lightness: "mid-dark", hue: "warm", finish: "matte", joint_m: null, reads_as: null }],
		rules, ...extra,
	};
}

test("a terminal carrying a lattice is instantiated once per cell, clipped to its scope, and the cells pass the opening gates a veil must ignore", async (t) => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	// The fixture box is 8 x 4 x 6.6 with slabs at 3.3: the front facet is 8 m wide, its scope inset
	// by the 0.3 m fold clearance. Host (0, 0) is the FACET origin - the same origin the SVG/DXF use -
	// and cells are clipped to the inset scope. Three cells: two 0.1 m apart straddling the slab
	// line, one crossing the scope's far edge (7.7).
	const lattice = { model_hash: HASH, family: "lens", instances: [cell("c1", 1.0, 3.3), cell("c2", 1.7, 3.3, { scoop_deg: 20 }), cell("c3", 7.5, 3.3)] };
	const program = parseFacadeDesign(grammar(base, {
		F: [{ terminal: "glass", depth_m: -0.2, material: "amber-glazing", lattice }],
	}), { sourceAuthority: context.source });
	const resolved = resolveFacadeProgram(program, context);
	const front = context.facade_segments.find((s: any) => s.face_view === "front");
	const cells = resolved.primitives.filter((p: any) => p.lattice && p.segment_id === front.segment_id);
	assert.equal(cells.length, 3, "one primitive per cell on the front facet");
	const byId = Object.fromEntries(cells.map((p: any) => [p.lattice.cell, p]));
	assert.deepEqual(byId.c1.local_bounds, { u_min: 0.7, u_max: 1.3, z_min: 3.1, z_max: 3.5 });
	assert.equal(byId.c1.kind, "window");
	assert.equal(byId.c1.material, "amber-glazing");
	assert.equal(byId.c1.depth_m, -0.2);
	assert.equal(byId.c2.scoop_deg, 20, "a cell attribute rides on the primitive");
	assert.ok(byId.c1.outline.length >= 3 && byId.c1.outline.every(([x, y]: number[]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
		"the outline travels normalized to the cell's own box");
	// c3 spans host 7.2..7.8; the scope ends at 7.7 (fold clearance), so it is clipped to 7.2..7.7.
	assert.equal(byId.c3.local_bounds.u_min, 7.2);
	assert.equal(byId.c3.local_bounds.u_max, 7.7);
	assert.ok(byId.c3.outline.length >= 3);
	// Every other facet carries the same three cells from the same rule (the fixture's back is 8 m too).
	assert.ok(resolved.primitives.filter((p: any) => p.lattice).length >= 6);
	const validation = validateResolvedFacadeProgram({ program, context, resolved });
	const codes = new Set(validation.codes ?? []);
	for (const code of ["FLOOR_BAND_INTRUSION", "OPENING_CLEARANCE_INVALID", "FOLD_CLEARANCE_INVALID", "PRIMITIVE_OVERLAP"]) {
		assert.ok(!codes.has(code), `${code} must not fire on lattice cells: ${JSON.stringify(validation.codes)}`);
	}
	assert.equal(validation.accepted, true, JSON.stringify(validation.codes));
});

test("a lattice belongs to a terminal that draws, and refuses a second shape beside it", async (t) => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	const parse = (rules: any) => parseFacadeDesign(grammar(base, rules), { sourceAuthority: context.source });
	const lattice = { model_hash: HASH, family: "lens", instances: [cell("c1", 1.0, 3.3)] };
	assert.throws(() => parse({ F: [{ split: { axis: "z", parts: [{ size: "~1", symbol: "W" }] }, lattice }], W: [{ terminal: "wall" }] }), /lattice/);
	assert.throws(() => parse({ F: [{ terminal: "wall", lattice }] }), /lattice/);
	assert.throws(() => parse({ F: [{ terminal: "glass", depth_m: -0.2, lattice, outline: [[0, 0], [1, 0], [0.5, 1]] }] }), /lattice/);
	assert.throws(() => parse({ F: [{ terminal: "glass", depth_m: -0.2, lattice: { ...lattice, model_hash: "nope" } }] }), /model_hash/);
	assert.throws(() => parse({ F: [{ terminal: "glass", depth_m: -0.2, lattice: { ...lattice, instances: [{ id: "x", center_m: [1, 1], outline_m: [[0, 0], [1, 1]] }] } }] }), /outline_m/);
});

// A grammar on disk names its cells by file; the CLI inlines them before parsing and refuses a
// file whose model hash is not the one the grammar wrote. The hash is what ties this drawing to
// the SVG/DXF written from the same evaluation, so a stale file must not pass as the design.
test("a cell carries any shape mode the spec declared as an attribute, and refuses a key that is not a name", async (t) => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	const lattice = (attributes: Record<string, number>) => ({ model_hash: HASH, family: "lens", instances: [cell("c1", 1.0, 3.3, attributes)] });
	const parse = (attributes: Record<string, number>) => parseFacadeDesign(grammar(base, {
		F: [{ terminal: "glass", depth_m: -0.2, material: "amber-glazing", lattice: lattice(attributes) }],
	}), { sourceAuthority: context.source });
	// taper and bulge are the evaluator's shape modes; the 3D reads neither, both ride along.
	const program = parse({ taper: 0.2, bulge: 0.1, depth_m: -0.3 });
	const resolved = resolveFacadeProgram(program, context);
	const first = resolved.primitives.find((p: any) => p.lattice);
	assert.equal(first.depth_m, -0.3, "a cell's depth_m overrides the terminal's");
	assert.throws(() => parse({ "Bad Key": 1 }), /is not an attribute name/);
	assert.throws(() => parse({ taper: Number.NaN }), /must be finite/);
});

test("a cell clipped at an unrounded scope edge never rounds past it", async () => {
	const { latticeCells } = await import("../plugins/elevation-3d/lib/facade-agent/design/grammar/lattice.mjs");
	// creative-013's facets carry lengths like 7.284812029999999; the scope is that less 0.3.
	const scope = { u_min: 0.3, u_max: 6.9848120299, z_min: 0, z_max: 3.3 };
	const cells = latticeCells({ family: "lens", instances: [cell("edge", 6.9, 1.5), cell("first", 0.2, 1.5)] }, scope, undefined, { u: 0, z: 0 });
	const edge = cells.find((c: any) => c.id === "edge"), first = cells.find((c: any) => c.id === "first");
	assert.ok(edge.local_bounds.u_max <= scope.u_max, `u_max ${edge.local_bounds.u_max} past the scope ${scope.u_max}`);
	assert.equal(first.local_bounds.u_min, 0.3);
});

// The cell as a module: a mouth (the lattice's tile) that flows in to a throat (the lens). The
// throat rides on the primitive as outline_far with the same point count, also after a clip.
test("a funnel cell carries its throat through derivation, clipped or whole", async (t) => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	const mouth = (cx: number, cy: number) => [[cx - 0.4, cy - 0.35], [cx + 0.4, cy - 0.35], [cx + 0.45, cy], [cx + 0.4, cy + 0.35], [cx - 0.4, cy + 0.35], [cx - 0.45, cy]];
	const throat = (cx: number, cy: number) => [[cx - 0.2, cy], [cx, cy + 0.12], [cx + 0.2, cy], [cx, cy - 0.12], [cx - 0.1, cy - 0.08], [cx - 0.15, cy - 0.03]];
	const funnel = (id: string, cx: number, cy: number) => ({ id, center_m: [cx, cy], outline_m: [...mouth(cx, cy), mouth(cx, cy)[0]], outline_far_m: [...throat(cx, cy), throat(cx, cy)[0]] });
	// 7.5: the mouth runs to 7.95, past the 7.7 scope edge, so it is clipped and re-partnered.
	const lattice = { model_hash: HASH, family: "funnel", instances: [funnel("whole", 2.0, 1.5), funnel("cut", 7.5, 1.5)] };
	const program = parseFacadeDesign(grammar(base, {
		F: [{ terminal: "glass", depth_m: -0.5, material: "amber-glazing", lattice }],
	}), { sourceAuthority: context.source });
	const resolved = resolveFacadeProgram(program, context);
	const front = context.facade_segments.find((s: any) => s.face_view === "front");
	const cells = Object.fromEntries(resolved.primitives.filter((p: any) => p.lattice && p.segment_id === front.segment_id).map((p: any) => [p.lattice.cell, p]));
	assert.ok(cells.whole.outline_far, "the throat travels");
	assert.equal(cells.whole.outline_far.length, cells.whole.outline.length, "mouth and throat keep one vertex count");
	assert.ok(cells.whole.outline_far.every(([x, y]: number[]) => x > 0 && x < 1 && y > 0 && y < 1), "the throat sits inside the mouth's box");
	assert.equal(cells.cut.local_bounds.u_max, 7.7, "the mouth is clipped at the scope");
	assert.equal(cells.cut.outline_far.length, cells.cut.outline.length, "a clipped funnel is re-partnered");
	// a throat with the wrong count is refused at the contract
	const bad = { ...lattice, instances: [{ ...funnel("bad", 2, 1.5), outline_far_m: throat(2, 1.5).slice(0, 4) }] };
	assert.throws(() => parseFacadeDesign(grammar(base, { F: [{ terminal: "glass", depth_m: -0.5, material: "amber-glazing", lattice: bad }] }), { sourceAuthority: context.source }), /outline_far_m/);
});

test("cells named by file are inlined only when the model hash matches", async () => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { inlineLatticeInstances } = await import("../tools/facade-pipeline/lattice.mjs");
	const dir = await mkdtemp(join(tmpdir(), "lattice-inline-"));
	try {
		const evaluated = { schema_version: "arr.elevation3d.facade-instances.v1", model_hash: HASH,
			instances: [{ ...cell("c1", 1, 1), unit: "lens", outline_far_m: diamond(1, 1, 0.3, 0.2), tile_m: diamond(1, 1, 0.8, 0.6), throat_scale: 1, profile: { kind: "quarter_ellipse", rings: 3 } }, { ...cell("x1", 2, 2), unit: "other" }] };
		await writeFile(join(dir, "instances.json"), JSON.stringify(evaluated));
		const grammar = () => ({ rules: { F: [{ terminal: "glass", lattice: { model_hash: HASH, family: "lens", instances: "instances.json" } }] } });
		const authored = grammar();
		const inlined = await inlineLatticeInstances(authored, dir);
		assert.deepEqual(inlined.rules.F[0].lattice.instances.map((c: any) => c.id), ["c1"], "only the named family is inlined");
		assert.equal(inlined.rules.F[0].lattice.instances[0].outline_far_m.length, 4, "a funnel's throat travels through the inline");
		assert.equal(inlined.rules.F[0].lattice.instances[0].tile_m.length, 4, "a module's tile travels through the inline");
		assert.deepEqual(inlined.rules.F[0].lattice.instances[0].profile, { kind: "quarter_ellipse", rings: 3 }, "the funnel's section travels through the inline");
		assert.equal(authored.rules.F[0].lattice.instances, "instances.json", "the grammar as read stays the file form");
		const stale = grammar(); stale.rules.F[0].lattice.model_hash = "b".repeat(64);
		await assert.rejects(() => inlineLatticeInstances(stale, dir), /model_hash mismatch/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// A lattice cell clipped at a facet edge carries a 10 mm edge where the cut meets the curve; a
// 20 mm jamb ring mitred across it folded and collapsed the whole compile (probe 2026-09-16,
// cell family_lens_01-r000-c003 on the synthetic box's 4 m face). The ring builder now merges
// edges shorter than its width before insetting.
test("a ring survives an outline edge shorter than the ring is wide", async () => {
	const { outlineFrameGeometry } = await import("../plugins/elevation-3d/lib/facade-agent/outline-frame.mjs");
	const clipped = [[0, 0.06887174], [0.02157821, 0.19248749], [0.05401925, 0.30975438], [0.09646532, 0.42003831], [0.14806276, 0.52271316], [0.20795168, 0.61714219], [0.27527843, 0.70269395], [0.34918726, 0.77873967], [0.4288183, 0.84464791], [0.51331788, 0.89978457], [0.60183027, 0.94352087], [0.69349767, 0.97522273], [0.78746225, 0.9942587], [0.88287244, 1], [0.97886628, 0.99181254], [1, 0.98679047], [1, 0.44397436], [0.96123857, 0.38285781], [0.89391183, 0.29730605], [0.82000299, 0.22126033], [0.74037195, 0.15535209], [0.65587237, 0.10021543], [0.56735998, 0.05647913], [0.47569258, 0.02477727], [0.381728, 0.0057413], [0.28631781, 0], [0.19032397, 0.00818746], [0.09459808, 0.03093511]];
	const plane = { origin: [0, 0, 0], normal: [0, -1, 0] };
	const localPoint = (_plane: unknown, _tangent: unknown, u: number, v: number, n: number) => [u, n, v];
	const bounds = { u0: 3.218542, u1: 3.7, v0: 0.311541, v1: 0.688459, n0: 0, n1: -0.15 };
	const ring = outlineFrameGeometry(plane, [1, 0, 0], { brick_module_m: [1, 1] }, bounds, clipped, 0.02, localPoint);
	assert.ok(ring.positions.length >= 4 * 3 && ring.indices.length > 0, "the ring is built");
	assert.ok(ring.positions.length < 4 * clipped.length, "the 10 mm edge was merged away before the inset");
});

// A veil records the line-density codes because its crests ink every cell edge. The test is ANY
// cell with a tile: once a host edge started leaving solid panels, one of them landed first in the
// list and the waiver vanished - the same drawing that had passed the day before failed
// LINE_DENSITY_EXCEEDED on its front.
test("a veil waives the line-density codes however its cells are ordered", async () => {
	const { veilWaivers } = await import("../plugins/elevation-3d/lib/facade-agent/design/authoring-kit.mjs");
	const module = { id: "m", outline_m: [[0, 0]], outline_far_m: [[0, 0]], tile_m: [[0, 0]] };
	const panel = { id: "p", outline_m: [[0, 0]] };
	const veil = (instances) => ({ rules: { F: [{ lattice: { instances }, depth_m: 0.45 }] } });
	const codes = ["LINE_DENSITY_EXCEEDED", "PLAN_TOP_LINE_DENSITY_EXCEEDED"];
	assert.deepEqual(veilWaivers(veil([module, panel])), codes);
	assert.deepEqual(veilWaivers(veil([panel, module])), codes, "a solid panel first is still a veil");
	assert.deepEqual(veilWaivers(veil([panel])), [], "panels alone are not a veil");
	assert.deepEqual(veilWaivers({ rules: { F: [{ lattice: { instances: [module] }, depth_m: -0.45 }] } }), [],
		"a carved funnel is not a veil standing on the wall");
	assert.deepEqual(veilWaivers({ rules: { F: [{ depth_m: 0.45 }] } }), []);
});
