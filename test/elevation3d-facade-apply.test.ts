import assert from "node:assert/strict";
import test from "node:test";

import { chainFacets, veilGrammar } from "../tools/facade-pipeline/apply.mjs";
import * as apply from "../tools/facade-pipeline/apply.mjs";
import { measureFacadeCoverage } from "../tools/facade-pipeline/facade-coverage.mjs";
import { moduleBufferCost, MAX_LATTICE_CELLS } from "../plugins/elevation-3d/lib/facade-agent/lattice-budgets.mjs";
import { funnelModuleGeometry } from "../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs";
import { execFileSync } from "node:child_process";


test("both allocation contracts agree and section cost matches emitted module buffers", () => {
	const py = process.platform === 'win32' ? 'python' : 'python3';
	const count = Number(execFileSync(py, ['-c', 'import sys;sys.path.insert(0,"tools/facade-parametric");from facade_parametric.contracts import MAX_CELLS;print(MAX_CELLS)'], {cwd:new URL('..',import.meta.url),encoding:'utf8'}));
	assert.equal(MAX_LATTICE_CELLS,count);
	const ring = (radius:number) => Array.from({length:8}, (_,i)=>[0.5+radius*Math.cos(i*Math.PI/4),0.5+radius*Math.sin(i*Math.PI/4)]);
	for (const rings of [0,3]) {
		const g = funnelModuleGeometry({origin:[0,0,0]},null,{brick_module_m:[1,1]},
			{u0:0,u1:1,v0:0,v1:1,n0:0,n1:0.45},ring(0.5),ring(0.45),ring(0.25),
			(_p:any,_t:any,u:number,v:number,n:number)=>[u,n,v],{kind:rings?'quarter_ellipse':'linear',rings});
		const cost=moduleBufferCost(8,rings);
		assert.equal(cost.vertices,g.positions.length);
		assert.equal(cost.indices,g.indices.flat().length);
	}
});

test("coverage exposes the half of a triangular wall lost to its inscribed rectangle", () => {
	const mesh = { vertices: [[0,0,0],[4,0,0],[0,0,4],[4,0,4],[0,4,4]], triangles:[[0,1,2],[2,3,4]] };
	const measured = measureFacadeCoverage(mesh, [{length_m:2,local_z:[0,2],outward_normal:[0,1,0]}]);
	assert.equal(measured.wall_area_m2, 8, "the horizontal roof is not a missing wall");
	assert.equal(measured.placeable_rectangle_area_m2, 4);
	assert.equal(measured.covered_fraction, 0.5);
	assert.equal(measured.missing_area_m2, 4);
});

test("pleated host spends the section before enlarging cells beyond the median facet", () => {
	const base = { families: [{ lattice: { basis_a_uv_m: [0.8, 0], basis_b_uv_m: [0.4, 0.7] },
		mouth: { kind: "parallelogram", sides: [[-1,1],[-1,0]], points: 16, profile: { kind: "quarter_ellipse", rings: 3 } } }] };
	const host = { width_m: 210, height_m: 16, segments: Array.from({length:120}, () => ({length_m:1.75})) };
	const sized = apply.veilForMass({base,host});
	assert.ok(sized.cell_width_m <= 1.75, "cell footprint, not lattice pitch, fits the median pleat");
	assert.deepEqual(sized.profile, { kind: "linear", rings: 0 });
	const small = apply.veilForMass({base,host:{width_m:35,height_m:16,segments:[{length_m:2.2}]}});
	assert.equal(small.scale, 1, "a design that fits keeps its scale");
	assert.equal(small.profile, undefined, "a design that fits keeps its authored profile and hash");
});

test("sheet selection covers both normal signs of the double-sided renderer despite dimension labels", () => {
	const facets = [
		{ segment_id: "a", face_view: "front", outward_normal: [0, -1, 0] },
		{ segment_id: "b", face_view: "back", outward_normal: [0.8, -0.6, 0] },
		{ segment_id: "c", face_view: "front", outward_normal: [0, 1, 0] },
		{ segment_id: "edge", face_view: "left", outward_normal: [1, 0, 0] },
	];
	assert.equal(typeof apply.selectSheetFacets, "function", "sheet-facing selection must exist");
	const cameras = { views: { front: { projection_axes: { depth: [0, -1, 0] } } } };
	assert.deepEqual(apply.selectSheetFacets(facets, ["front"], cameras).map(s => s.segment_id), ["a", "b", "c"]);
	assert.deepEqual(apply.selectSheetFacets(facets, undefined, cameras), facets);
	assert.throws(() => apply.selectSheetFacets(facets, ["missing"], cameras), /camera/);
});

// A base model onto a mass: the facets are chained into one run around the building so the
// lattice can be laid over their unfolded length. Each facet's end is the next one's start,
// whatever order the authority listed them in.
test("facets chain into one run around a square plan, whatever order they were listed in", () => {
	// a 4 x 4 square, counter-clockwise: the tangent of an outward normal n is (-n.y, n.x)
	const facets = [
		{ segment_id: "east", origin_m: [4, 0, 0], outward_normal: [1, 0, 0], length_m: 4, local_z: [0, 6], face_view: "right" },
		{ segment_id: "south", origin_m: [0, 0, 0], outward_normal: [0, -1, 0], length_m: 4, local_z: [0, 6], face_view: "front" },
		{ segment_id: "west", origin_m: [0, 4, 0], outward_normal: [-1, 0, 0], length_m: 4, local_z: [0, 6], face_view: "left" },
		{ segment_id: "north", origin_m: [4, 4, 0], outward_normal: [0, 1, 0], length_m: 4, local_z: [0, 6], face_view: "back" },
	];
	const run = chainFacets(facets).map((s) => s.segment_id);
	assert.deepEqual(run, ["east", "north", "west", "south"]);
	// EVERY facet is in the run, chained where they chain. Stopping at the first break dropped the
	// rest of the building: the bent bar put 2 of its 37 facets in the run, the cleft block 1 of 113,
	// and the veil covered a corner and nothing else.
	const broken = chainFacets([facets[0], facets[2]]).map((s) => s.segment_id);
	assert.deepEqual(broken, ["east", "west"], "two facets that do not meet are two runs, both kept");
	const stepped = [
		facets[1],
		{ segment_id: "upper", origin_m: [10, 0, 0], outward_normal: [0, -1, 0], length_m: 3, local_z: [3, 9], face_view: "front" },
		{ segment_id: "upper-return", origin_m: [13, 0, 0], outward_normal: [1, 0, 0], length_m: 2, local_z: [3, 9], face_view: "right" },
	];
	const runs = chainFacets(stepped).map((s) => s.segment_id);
	assert.equal(runs.length, 3, "a stepped mass keeps every facet");
	assert.ok(runs.indexOf("upper") < runs.indexOf("upper-return"), "a chain stays in its own order");
});

// A veil laid on SOME faces leaves the others bare, and a bare elevation still has to say where
// the building stops - the composition gate asks every view for a course inside its top storey.
// The crown is only written when the run was limited, so a full run keeps the grammar it had.
test("a face-limited veil crowns the faces it does not cover, by the BUILDING's top storey", () => {
	const args = {
		name: "veil", base: { model_id: "base", families: [{ id: "fam", fields: {} }] }, family: "fam",
		candidateId: "candidate", facets: [{ length_m: 4 }], edits: { thickness: 0.45 },
		evaluated: { model_hash: "hash" }, zMin: 0, topStorey: 5,
	};
	const whole = veilGrammar({ ...args });
	assert.deepEqual(whole.rules.map((rule) => rule.name), ["F", "GlassBox", "GlassStorey", "SlabBand", "Pane", "Veil"],
		"a veil over the whole run is the grammar it always was: the veil terminates the faces itself");

	const limited = veilGrammar({ ...args, faces: ["front"] });
	const crown = limited.rules.find((rule) => rule.name === "Crown");
	assert.ok(crown, "a face-limited veil carries a crown");
	// `storey == last` is the last storey of the FACET's own scope, so on a mass of stacked courses
	// every facet terminated itself and the wall grew a cornice at 3.3 m. The building's own number.
	assert.equal(crown.alternatives[0].when, "storey == 5");
	assert.equal(crown.alternatives.at(-1).terminal, "wall", "a storey below the top draws nothing");
	const coping = limited.rules.find((rule) => rule.name === "Coping");
	assert.equal(coping.alternatives[0].terminal, "cornice");
	assert.ok(limited.rules.some((rule) => rule.name === "Storey"), "the crown is layered beside the glass, not instead of it");
});
