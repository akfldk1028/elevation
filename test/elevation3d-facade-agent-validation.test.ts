import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { validateEnrichment } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";

const roots: string[] = [];
let canonicalGlb: string;

const sourceMesh = {
	vertices: [
		[-4, -2, 0], [4, -2, 0], [4, 2, 0], [-4, 2, 0],
		[-4, -2, 6.6], [4, -2, 6.6], [4, 2, 6.6], [-4, 2, 6.6],
	],
	triangles: [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
		[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	],
};
const floorGuides = { floor_guides_m: [0, 3.3, 6.6] };
const facadePlanes = { facade_planes: [
	{ view: "front", origin: [-4, -2, 0], normal: [0, -1, 0], extent_m: [8, 6.6] },
	{ view: "right", origin: [4, -2, 0], normal: [1, 0, 0], extent_m: [4, 6.6] },
	{ view: "back", origin: [4, 2, 0], normal: [0, 1, 0], extent_m: [8, 6.6] },
	{ view: "left", origin: [-4, 2, 0], normal: [-1, 0, 0], extent_m: [4, 6.6] },
] };
const grammar = {
	system: "brick-punched-window-v1", surfaces: ["front", "right", "back", "left"],
	materials: ["brick", "precast", "window-frame", "glass"], corner_datum_m: 0,
	bay_width_m: 2.4, window_width_m: 1.2, window_height_m: 1.65, sill_height_m: 0.85,
	reveal_depth_m: 0.22, frame_width_m: 0.06, lintel_height_m: 0.18, sill_depth_m: 0.08,
	cladding_depth_m: 0.12, brick_module_m: [0.215, 0.065], confidence: 0.92,
	unresolved_surfaces: [], wall_opacity: "opaque", curtain_wall_allowed: false,
	floor_elevations_m: floorGuides.floor_guides_m,
	facade_lengths_m: { front: 8, right: 4, back: 8, left: 4 },
};
const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];

before(async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-validation-canonical-"));
	roots.push(root);
	canonicalGlb = join(root, "canonical.glb");
	await writeEnrichedGlb(buildEnrichedScene({ mesh: sourceMesh, floorGuides, facadePlanes, grammar, safeFallback: false }), canonicalGlb);
});
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(mutate?: (document: any) => void | Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "facade-validation-case-"));
	roots.push(root);
	const path = join(root, "facade.glb");
	await copyFile(canonicalGlb, path);
	if (mutate) {
		const io = new NodeIO();
		const document = await io.read(path);
		await mutate(document);
		await io.write(path, document);
	}
	await mkdir(join(root, "viewer"), { recursive: true });
	await mkdir(join(root, "drawings"), { recursive: true });
	const configPath = join(root, "viewer", "config.json");
	await writeFile(configPath, JSON.stringify({ strategies: { hunyuan: { glb: "../facade.glb" } } }));
	const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#884422" } }).png().toBuffer();
	const drawings: Record<string, string> = {};
	for (const name of drawingNames) {
		drawings[name] = join(root, "drawings", `${name}.png`);
		await writeFile(drawings[name], png);
	}
	const glbHash = sha256(await readFile(path));
	const configHash = sha256(await readFile(configPath));
	const entries = Object.fromEntries(drawingNames.map((name) => [name, {
		path: drawings[name], sha256: sha256(png), width: 2, height: 3,
		glb_sha256: glbHash, viewer_config_sha256: configHash,
	}]));
	await writeFile(join(root, "drawing-provenance.json"), JSON.stringify({
		selected_glb: { path, sha256: glbHash }, viewer_config: { path: configPath, sha256: configHash }, drawings: entries,
	}));
	return { artifact: { path, sha256: glbHash }, drawings };
}

async function validate(mutate?: (document: any) => void | Promise<void>, grammarInput: any = grammar) {
	const value = await fixture(mutate);
	return validateEnrichment({ sourceMesh, artifact: value.artifact, grammar: grammarInput, requiredDrawings: value.drawings });
}

function details(document: any) {
	return document.getRoot().listMeshes().find((mesh: any) => mesh.getName() === "facade-details").listPrimitives();
}

test("rejects a changed exact-MASS index with the canonical surface code", async () => {
	const report = await validate((document) => {
		const primitive = document.getRoot().listMeshes().find((mesh: any) => mesh.getName() === "exact-mass").listPrimitives()[0];
		primitive.getIndices().getArray()[0] = 1;
	});
	assert.deepEqual(report.codes, ["CANONICAL_SURFACE_MISMATCH"]);
});

test("rejects a missing canonical back facade and a curtain-wall substitution", async () => {
	const missing = await validate((document) => {
		const mesh = document.getRoot().listMeshes().find((item: any) => item.getName() === "facade-details");
		for (const primitive of [...mesh.listPrimitives()]) if (primitive.getExtras().view === "back") mesh.removePrimitive(primitive);
	});
	assert.ok(missing.codes.includes("FACADE_ORIENTATION_COVERAGE_MISSING"));
	assert.ok(missing.metrics.facade_orientation_coverage < 1);
	const curtain = await validate((document) => {
		const material = document.createMaterial("curtain-wall");
		details(document).find((primitive: any) => primitive.getExtras().kind === "brick-cladding").setMaterial(material);
	});
	assert.ok(curtain.codes.includes("OPAQUE_WALL_COVERAGE_MISSING"));
	assert.ok(curtain.codes.includes("MATERIAL_SET_INVALID"));
});

test("rejects shallow persisted reveals and mismatched corner anchors", async () => {
	const shallow = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "window-reveal");
		primitive.setExtras({ ...primitive.getExtras(), depth_m: 0.05 });
	});
	assert.ok(shallow.codes.includes("PUNCHED_REVEAL_DEPTH_MISSING"));
	assert.equal(shallow.metrics.minimum_reveal_depth_m, 0.05);
	const corner = await validate((document) => {
		const joined = Map.groupBy(details(document).filter((item: any) => item.getExtras().kind === "corner-return"), (item: any) => item.getExtras().corner_anchor_id);
		const pair: any[] = [...joined.values()].find((items: any) => new Set(items.map((item: any) => item.getExtras().view)).size > 1);
		const primitive = pair[0];
		const extras = primitive.getExtras();
		primitive.setExtras({ ...extras, anchor_position: [extras.anchor_position[0] + 0.02, ...extras.anchor_position.slice(1)] });
	});
	assert.ok(corner.codes.includes("CORNER_DATUM_MISMATCH"));
	assert.ok(corner.metrics.corner_max_gap_m >= 0.02 - 1e-6);
	const missingCorner = await validate((document) => {
		const mesh = document.getRoot().listMeshes().find((item: any) => item.getName() === "facade-details");
		const primitive = mesh.listPrimitives().find((item: any) => item.getExtras().kind === "corner-return");
		mesh.removePrimitive(primitive);
	});
	assert.ok(missingCorner.codes.includes("CORNER_DATUM_MISMATCH"));
});

test("rejects a window crossing its authored floor band, a detached detail, and excessive outward bounds", async () => {
	const crossing = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "glazing" && item.getExtras().floor_m === 0);
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]);
			if (point[2] > 2) point[2] = 3.4;
			positions.setElement(index, point);
		}
	});
	assert.ok(crossing.codes.includes("WINDOW_CROSSES_FLOOR_BAND"));
	assert.ok(crossing.metrics.floor_alignment_max_error_m >= 0.1 - 1e-6);
	const detached = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "glazing");
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]); point[1] = 0; positions.setElement(index, point);
		}
	});
	assert.ok(detached.codes.includes("DETAIL_COMPONENT_UNATTACHED"));
	const outward = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().view === "front");
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]); point[1] -= 0.4; positions.setElement(index, point);
		}
	});
	assert.ok(outward.codes.includes("DETAIL_BOUNDS_EXCEEDED"));
});

test("accepts a complete immutable opaque brick facade and exposes deterministic gate metrics", async () => {
	const valid = await validate();
	assert.equal(valid.accepted, true);
	assert.deepEqual(valid.codes, []);
	assert.equal(valid.metrics.canonical_surface_match, 1);
	assert.equal(valid.metrics.opaque_wall_coverage, 1);
	assert.equal(valid.metrics.minimum_reveal_depth_m, 0.22);
	assert.ok(valid.metrics.corner_max_gap_m <= 1e-5);
	assert.ok(valid.metrics.floor_alignment_max_error_m <= 1e-5);
	assert.equal(valid.metrics.facade_orientation_coverage, 1);
});

test("rejects invalid typed grammar and incomplete procedural PBR bindings", async () => {
	const invalidGrammar = await validate(undefined, { ...grammar, curtain_wall_allowed: true });
	assert.ok(invalidGrammar.codes.includes("FACADE_GRAMMAR_INVALID"));
	const invalidPbr = await validate((document) => {
		const brick = document.getRoot().listMaterials().find((material: any) => material.getName() === "brick");
		brick.setNormalTexture(null);
	});
	assert.ok(invalidPbr.codes.includes("PBR_MATERIAL_INVALID"));
	const forgedPbr = await validate((document) => {
		const texture = document.getRoot().listMaterials().find((material: any) => material.getName() === "brick").getBaseColorTexture();
		texture.setExtras({ ...texture.getExtras(), sha256: "0".repeat(64) });
	});
	assert.ok(forgedPbr.codes.includes("PBR_MATERIAL_INVALID"));
});
