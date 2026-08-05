import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	correctGrammar,
	normalizeFacadeGrammar,
	resolveApprovedDesign,
} from "../plugins/elevation-3d/lib/facade-grammar.mjs";

const temporaryRoots: string[] = [];

after(async () => {
	await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(data: Uint8Array) {
	return createHash("sha256").update(data).digest("hex");
}

test("resolves the candidate-approved image and verifies its recorded SHA-256", async () => {
	const design = await resolveApprovedDesign({
		candidateId: "creative-013",
		memoryRoot: resolve("memory/elevation-3d"),
	});
	assert.match(design.image_path, /approved-detailed-isometric-v1\.png$/);
	assert.equal(design.image_sha256, sha256(await readFile(design.image_path)));
});

test("rejects an explicit image whose hash differs from approved metadata", async () => {
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation-3d-approved-design-"));
	temporaryRoots.push(memoryRoot);
	const assetRoot = join(memoryRoot, "assets", "creative-013");
	await mkdir(assetRoot, { recursive: true });
	const approvedImage = join(assetRoot, "approved.png");
	const changedImage = join(memoryRoot, "changed.png");
	const approvedBytes = Buffer.from("approved image");
	await writeFile(approvedImage, approvedBytes);
	await writeFile(changedImage, "changed image");
	await writeFile(join(assetRoot, "approved-design-v1.json"), JSON.stringify({
		candidate_id: "creative-013",
		image_path: "approved.png",
		image_sha256: sha256(approvedBytes),
		facade_grammar: {},
	}));

	await assert.rejects(
		() => resolveApprovedDesign({ candidateId: "creative-013", approvedImage: changedImage, memoryRoot }),
		/approved image hash mismatch/,
	);
});

test("normalizes approved grammar against MASS floor guides and facade extents", () => {
	const approvedDesign = {
		facade_grammar: {
			material_palette: { solid: "concrete", transparent: "glass", accent: "bronze" },
			bay_width_m: 0.5,
			frame_depth_m: 0.4,
			mullion_depth_m: 0.01,
			glazing_recess_m: 0.25,
			parapet_height_m: 0.1,
		},
	};
	const grammar = normalizeFacadeGrammar({
		approvedDesign,
		floorGuides: { floor_guides_m: [0, 3.3, 6.6, 9.9] },
		facadePlanes: {
			facade_planes: [
				{ view: "front", extent_m: [24.361488, 9.9] },
				{ view: "right", extent_m: [12.234058, 9.9] },
			],
		},
	});

	assert.deepEqual(grammar.floor_elevations_m, [0, 3.3, 6.6, 9.9]);
	assert.deepEqual(grammar.facade_lengths_m, { front: 24.361488, right: 12.234058 });
	assert.deepEqual(grammar.material_palette, { solid: "concrete", transparent: "glass", accent: "bronze" });
	assert.equal(grammar.bay_width_m, 0.9);
	assert.equal(grammar.frame_depth_m, 0.25);
	assert.equal(grammar.mullion_depth_m, 0.03);
	assert.equal(grammar.glazing_recess_m, 0.2);
	assert.equal(grammar.parapet_height_m, 0.15);
	assert.equal(Object.hasOwn(grammar, "window_width_m"), false);
});

const grammar = {
	bay_width_m: 1.5,
	frame_depth_m: 0.18,
	mullion_depth_m: 0.08,
	glazing_recess_m: 0.12,
	parapet_height_m: 0.35,
};

test("halves detail depths after an outward-bounds failure", () => {
	const corrected = correctGrammar(grammar, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.equal(corrected.frame_depth_m, grammar.frame_depth_m / 2);
	assert.equal(corrected.mullion_depth_m, grammar.mullion_depth_m / 2);
});

test("sets deterministic bay width after a primitive-budget failure", () => {
	for (const bayWidth of [1, 1.5, 2.5]) {
		assert.equal(
			correctGrammar({ ...grammar, bay_width_m: bayWidth }, ["PRIMITIVE_BUDGET_EXCEEDED"]).bay_width_m,
			2.25,
		);
	}
});

test("keeps repeated corrections within approved grammar limits", () => {
	const corrected = correctGrammar(
		{ ...grammar, bay_width_m: 2.5, frame_depth_m: 0.06, mullion_depth_m: 0.04 },
		["DETAIL_BOUNDS_EXCEEDED", "PRIMITIVE_BUDGET_EXCEEDED"],
	);
	assert.equal(corrected.bay_width_m, 2.25);
	assert.equal(corrected.frame_depth_m, 0.05);
	assert.equal(corrected.mullion_depth_m, 0.03);
});

const punchedGrammar = {
	system: "brick-punched-window-v1",
	surfaces: ["front", "right", "back", "left"],
	bay_width_m: 2.4,
	window_width_m: 1.2,
	window_height_m: 1.65,
	sill_height_m: 0.85,
	reveal_depth_m: 0.22,
	frame_width_m: 0.06,
	lintel_height_m: 0.18,
	sill_depth_m: 0.08,
	cladding_depth_m: 0.12,
	brick_module_m: [0.215, 0.065],
	corner_datum_m: 0,
	confidence: 0.92,
	unresolved_surfaces: [],
};

const punchedFloorGuides = { floor_guides_m: [0, 3.3, 6.6, 9.9] };
const punchedFacadePlanes = {
	facade_planes: [
		{ view: "front", extent_m: [24.361488, 9.9] },
		{ view: "right", extent_m: [12.234058, 9.9] },
		{ view: "back", extent_m: [24.361488, 9.9] },
		{ view: "left", extent_m: [12.234058, 9.9] },
	],
};

test("normalizes the typed opaque brick punched-window grammar", () => {
	const normalized = normalizeFacadeGrammar({
		approvedDesign: { facade_grammar: punchedGrammar },
		floorGuides: punchedFloorGuides,
		facadePlanes: punchedFacadePlanes,
	});
	assert.equal(normalized.system, "brick-punched-window-v1");
	assert.equal(normalized.wall_opacity, "opaque");
	assert.equal(normalized.curtain_wall_allowed, false);
	assert.deepEqual(normalized.materials, ["brick", "precast", "window-frame", "glass"]);
	assert.deepEqual(normalized.facade_lengths_m, { front: 24.361488, right: 12.234058, back: 24.361488, left: 12.234058 });
});

test("fails closed when a typed grammar leaves any canonical facade unresolved", () => {
	assert.throws(() => normalizeFacadeGrammar({
		approvedDesign: { facade_grammar: { ...punchedGrammar, unresolved_surfaces: ["back"] } },
		floorGuides: punchedFloorGuides,
		facadePlanes: punchedFacadePlanes,
	}), /unresolved facade/i);
});

test("applies only allowlisted typed-grammar corrections", () => {
	const typed = normalizeFacadeGrammar({
		approvedDesign: { facade_grammar: punchedGrammar },
		floorGuides: punchedFloorGuides,
		facadePlanes: punchedFacadePlanes,
	});
	assert.equal(correctGrammar(typed, ["WINDOW_CROSSES_FLOOR_BAND"]).window_height_m < typed.window_height_m, true);
	assert.equal(correctGrammar(typed, ["DETAIL_BOUNDS_EXCEEDED"]).cladding_depth_m, 0.09);
	assert.equal(correctGrammar(typed, ["DETAIL_BOUNDS_EXCEEDED"]).reveal_depth_m, 0.165);
	assert.equal(correctGrammar({ ...typed, corner_datum_m: 0.1 }, ["CORNER_DATUM_MISMATCH"]).corner_datum_m, 0);
	assert.equal(correctGrammar(typed, ["PRIMITIVE_BUDGET_EXCEEDED"]).bay_width_m, 3);
	assert.throws(() => correctGrammar(typed, ["CHANGE_MASSING"]), /unrecognized grammar failure code/i);
});

test("validates typed grammar before and after every correction", () => {
	const typed = normalizeFacadeGrammar({
		approvedDesign: { facade_grammar: punchedGrammar },
		floorGuides: punchedFloorGuides,
		facadePlanes: punchedFacadePlanes,
	});
	for (const malformed of [
		{ ...typed, raw_vertices: [[0, 0, 0]] },
		{ ...typed, materials: ["brick", "precast", "window-frame", "curtain-wall"] },
		{ ...typed, unresolved_surfaces: ["back"] },
		{ ...typed, reveal_depth_m: Number.NaN },
		{ ...typed, bay_width_m: 1.2, window_width_m: 1.2, frame_width_m: 0.08 },
		{ ...typed, floor_elevations_m: [0, 2.4], sill_height_m: 0.85, window_height_m: 1.65, lintel_height_m: 0.18 },
	]) {
		assert.throws(() => correctGrammar(malformed, ["DETAIL_BOUNDS_EXCEEDED"]), /grammar|facade|window|floor|unknown|range|material/i);
	}
	const corrected = correctGrammar(typed, ["WINDOW_CROSSES_FLOOR_BAND", "DETAIL_BOUNDS_EXCEEDED"]);
	assert.equal(corrected.system, "brick-punched-window-v1");
	assert.equal(corrected.window_height_m < typed.window_height_m, true);
	assert.equal(corrected.reveal_depth_m < typed.reveal_depth_m, true);
	assert.deepEqual(corrected.floor_elevations_m, typed.floor_elevations_m);
	assert.equal(corrected.curtain_wall_allowed, false);
	const narrowFacade = {
		...typed,
		bay_width_m: 0.9,
		window_width_m: 0.6,
		frame_width_m: 0.03,
		facade_lengths_m: { front: 1, right: 1, back: 1, left: 1 },
	};
	assert.throws(() => correctGrammar(narrowFacade, ["PRIMITIVE_BUDGET_EXCEEDED"]), /bay.*facade|facade.*bay/i);
});

test("requires authoritative floor and facade feasibility for direct typed corrections", () => {
	const typed = normalizeFacadeGrammar({
		approvedDesign: { facade_grammar: punchedGrammar },
		floorGuides: punchedFloorGuides,
		facadePlanes: punchedFacadePlanes,
	});
	const { floor_elevations_m: _floors, facade_lengths_m: _lengths, ...withoutAuthority } = typed;
	assert.throws(() => correctGrammar(withoutAuthority, ["DETAIL_BOUNDS_EXCEEDED"]), /authoritative.*floor|floor.*authority/i);
	assert.throws(() => correctGrammar({ ...typed, facade_lengths_m: undefined }, ["DETAIL_BOUNDS_EXCEEDED"]), /facade.*authority|authoritative.*facade/i);
	assert.throws(() => correctGrammar({
		...typed,
		sill_height_m: 0.85,
		window_height_m: 2.3,
		lintel_height_m: 0.25,
	}, ["DETAIL_BOUNDS_EXCEEDED"]), /floor band/i);
	assert.throws(() => correctGrammar({
		...typed,
		bay_width_m: 2.4,
		facade_lengths_m: { front: 2, right: 2, back: 2, left: 2 },
	}, ["DETAIL_BOUNDS_EXCEEDED"]), /bay.*facade|facade.*bay/i);
	const corrected = correctGrammar(typed, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.deepEqual(corrected.floor_elevations_m, typed.floor_elevations_m);
	assert.deepEqual(corrected.facade_lengths_m, typed.facade_lengths_m);
});
