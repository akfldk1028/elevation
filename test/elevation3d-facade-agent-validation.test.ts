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
import { deriveFacadeSegmentsFromMass } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

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
const facadeSegmentAuthority = deriveFacadeSegmentsFromMass({ mesh: sourceMesh });
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
	return validateEnrichment({ sourceMesh, artifact: value.artifact, grammar: grammarInput, requiredDrawings: value.drawings, facadeSegmentAuthority });
}

function details(document: any) {
	return document.getRoot().listMeshes().find((mesh: any) => mesh.getName() === "facade-details").listPrimitives();
}

function pngHeaderOnly(width = 2048, height = 2048) {
	const bytes = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
	return bytes;
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
	assert.ok(missing.codes.includes("FACADE_SEGMENT_AUTHORITY_MISMATCH"));
	assert.equal(missing.metrics.segment_authority_match, false);
	const curtain = await validate((document) => {
		const material = document.createMaterial("curtain-wall");
		details(document).find((primitive: any) => primitive.getExtras().kind === "brick-cladding").setMaterial(material);
	});
	assert.ok(curtain.codes.includes("OPAQUE_WALL_COVERAGE_MISSING"));
	assert.ok(curtain.codes.includes("MATERIAL_SET_INVALID"));
});

test("rejects facade geometry persisted outside the one canonical detail node", async () => {
	const report = await validate((document) => {
		const root = document.getRoot();
		const template = details(document).find((primitive: any) => primitive.getExtras().kind === "glazing");
		const bypass = document.createPrimitive()
			.setAttribute("POSITION", template.getAttribute("POSITION"))
			.setIndices(template.getIndices())
			.setMaterial(template.getMaterial())
			.setExtras({ ...template.getExtras(), slot: "curtain-wall-bypass" });
		const mesh = document.createMesh("curtain-wall-bypass").addPrimitive(bypass);
		(root.getDefaultScene() ?? root.listScenes()[0]).addChild(document.createNode("curtain-wall-bypass").setMesh(mesh));
	});
	assert.ok(report.codes.includes("NON_CANONICAL_GEOMETRY"));
});

test("rejects shallow persisted reveals and mismatched corner anchors", async () => {
	const shallow = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "window-reveal");
		const positions = primitive.getAttribute("POSITION");
		const ys = Array.from({ length: positions.getCount() }, (_, index) => positions.getElement(index, [0, 0, 0])[1]);
		const outer = Math.min(...ys);
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]);
			point[1] = Math.min(outer + 0.05, point[1]); positions.setElement(index, point);
		}
	});
	assert.ok(shallow.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
	const corner = await validate((document) => {
		const joined = Map.groupBy(details(document).filter((item: any) => item.getExtras().kind === "corner-return"), (item: any) => item.getExtras().corner_anchor_id);
		const pair: any[] = [...joined.values()].find((items: any) => new Set(items.map((item: any) => item.getExtras().view)).size > 1);
		const primitive = pair[0];
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]); point[0] += 0.4; positions.setElement(index, point);
		}
	});
	assert.ok(corner.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
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
	assert.ok(crossing.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
	const detached = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "glazing");
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]); point[1] += 1.5; positions.setElement(index, point);
		}
	});
	assert.ok(detached.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
	const outward = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().view === "front");
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]); point[1] -= 0.4; positions.setElement(index, point);
		}
	});
	assert.ok(outward.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
});

test("derives glazing floor bands from world geometry and only cross-checks optional floor labels", async () => {
	const unlabeled = await validate((document) => {
		for (const primitive of details(document)) {
			if (primitive.getExtras().kind === "glazing") {
				const { floor_m: _removed, ...extras } = primitive.getExtras();
				primitive.setExtras(extras);
			}
		}
	});
	assert.equal(unlabeled.accepted, true);

	const relabeled = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "glazing" && item.getExtras().floor_m === 0);
		primitive.setExtras({ ...primitive.getExtras(), floor_m: 3.3 });
	});
	assert.ok(relabeled.codes.includes("WINDOW_FLOOR_KEY_MISMATCH"));

	const crossing = await validate((document) => {
		const primitive = details(document).find((item: any) => item.getExtras().kind === "glazing" && item.getExtras().floor_m === 0);
		const positions = primitive.getAttribute("POSITION");
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]);
			if (point[2] > 2) point[2] = 3.4;
			positions.setElement(index, point);
		}
		primitive.setExtras({ ...primitive.getExtras(), floor_m: 3.3 });
	});
	assert.ok(crossing.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
});

test("accepts a complete immutable opaque brick facade and exposes deterministic gate metrics", async () => {
	const valid = await validate();
	assert.equal(valid.accepted, true);
	assert.deepEqual(valid.codes, []);
	assert.equal(valid.metrics.canonical_surface_match, 1);
	assert.ok(valid.metrics.opaque_wall_coverage > 0.7 && valid.metrics.opaque_wall_coverage <= 1);
	assert.equal(valid.metrics.minimum_reveal_depth_m, 0.22);
	assert.ok(valid.metrics.corner_max_gap_m <= 1e-5);
	assert.ok(valid.metrics.floor_alignment_max_error_m <= 1e-5);
	assert.equal(valid.metrics.facade_orientation_coverage, 1);
});

test("clips opaque union coverage to canonical MASS facade extents", async () => {
	const baseline = await validate();
	const expanded = await validate((document) => {
		for (const primitive of details(document)) {
			if (!["brick-cladding", "corner-return"].includes(primitive.getExtras().kind)) continue;
			const axis = ["front", "back"].includes(primitive.getExtras().view) ? 0 : 1;
			const minimum = axis === 0 ? -4 : -2, maximum = axis === 0 ? 4 : 2;
			const positions = primitive.getAttribute("POSITION");
			for (let index = 0; index < positions.getCount(); index++) {
				const point = positions.getElement(index, [0, 0, 0]);
				if (Math.abs(point[axis] - minimum) <= 1e-5) point[axis] -= 0.12;
				if (Math.abs(point[axis] - maximum) <= 1e-5) point[axis] += 0.12;
				positions.setElement(index, point);
			}
		}
	});
	assert.ok(expanded.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
	assert.ok(baseline.metrics.opaque_wall_coverage > 0.7);
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
	const malformedPbr = await validate((document) => {
		const texture = document.getRoot().listMaterials().find((material: any) => material.getName() === "brick").getBaseColorTexture();
		const bytes = pngHeaderOnly();
		texture.setImage(bytes).setMimeType("image/png").setExtras({ ...texture.getExtras(), sha256: sha256(bytes) });
	});
	assert.ok(malformedPbr.codes.includes("PBR_MATERIAL_INVALID"));
	const substitutedPbr = await validate(async (document) => {
		const texture = document.getRoot().listMaterials().find((material: any) => material.getName() === "brick").getBaseColorTexture();
		const bytes = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: "#ff0000" } }).png().toBuffer();
		texture.setImage(bytes).setMimeType("image/png").setExtras({ ...texture.getExtras(), sha256: sha256(bytes) });
	});
	assert.ok(substitutedPbr.codes.includes("PBR_MATERIAL_INVALID"));
});

test("derives opaque coverage from persisted areas and rejects malformed typed primitive shapes", async () => {
	const coverage = await validate((document) => {
		for (const primitive of details(document)) {
			const kind = primitive.getExtras().kind;
			if (kind !== "brick-cladding" && kind !== "glazing") continue;
			const positions = primitive.getAttribute("POSITION");
			const points = Array.from({ length: positions.getCount() }, (_, index) => positions.getElement(index, [0, 0, 0]));
			const centroid = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
			const scale = kind === "brick-cladding" ? 0.01 : 4;
			for (let index = 0; index < points.length; index++) positions.setElement(index, points[index].map((value, axis) => centroid[axis] + (value - centroid[axis]) * scale));
		}
	});
	assert.ok(coverage.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));

	const malformed = await validate((document) => {
		const primitive = details(document)[0];
		primitive.getIndices().setArray(new Uint16Array([0, 1, 2]));
	});
	assert.ok(malformed.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
});

test("rejects duplicate and partially overlapping opaque facade projections", async () => {
	const duplicated = await validate((document) => {
		const mesh = document.getRoot().listMeshes().find((item: any) => item.getName() === "facade-details");
		const bricks = mesh.listPrimitives().filter((primitive: any) => primitive.getExtras().kind === "brick-cladding");
		for (const primitive of bricks) {
			const positions = primitive.getAttribute("POSITION");
			const points = Array.from({ length: positions.getCount() }, (_, index) => positions.getElement(index, [0, 0, 0]));
			const centroid = [0, 1, 2].map((axis) => points.reduce((sum: number, point: number[]) => sum + point[axis], 0) / points.length);
			for (let index = 0; index < points.length; index++) positions.setElement(index, points[index].map((value: number, axis: number) => centroid[axis] + (value - centroid[axis]) * 0.1));
		}
		const template = bricks[0];
		for (let index = 0; index < 1000; index++) {
			mesh.addPrimitive(document.createPrimitive()
				.setAttribute("POSITION", template.getAttribute("POSITION"))
				.setIndices(template.getIndices()).setMaterial(template.getMaterial())
				.setExtras({ ...template.getExtras(), slot: `duplicate-${index}` }));
		}
	});
	assert.ok(duplicated.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));

	const partial = await validate((document) => {
		const root = document.getRoot();
		const mesh = root.listMeshes().find((item: any) => item.getName() === "facade-details");
		const template = mesh.listPrimitives().find((primitive: any) => primitive.getExtras().kind === "brick-cladding" && primitive.getExtras().view === "front");
		const original = template.getAttribute("POSITION");
		const shifted = new Float32Array(original.getArray());
		for (let index = 0; index < shifted.length; index += 3) shifted[index] += 0.01;
		const positions = document.createAccessor("partial-overlap", root.listBuffers()[0]).setType("VEC3").setArray(shifted);
		mesh.addPrimitive(document.createPrimitive().setAttribute("POSITION", positions)
			.setIndices(template.getIndices()).setMaterial(template.getMaterial())
			.setExtras({ ...template.getExtras(), slot: "partial-overlap" }));
	});
	assert.ok(partial.codes.includes("FACADE_PRIMITIVE_SHAPE_INVALID"));
});

test("rejects negative-zero grammar metrics before allocating detail records", async () => {
	const report = await validate(undefined, { ...grammar, corner_datum_m: -0 });
	assert.ok(report.codes.includes("FACADE_GRAMMAR_INVALID"));
	assert.equal("detail_component_distances_m" in report.metrics, false);
	const excessiveFloors = await validate(undefined, {
		...grammar, floor_elevations_m: Array.from({ length: 66 }, (_, index) => index * 3.3),
	});
	assert.ok(excessiveFloors.codes.includes("FACADE_GRAMMAR_INVALID"));
	assert.equal("detail_component_distances_m" in excessiveFloors.metrics, false);
});

test("enforces artifact and primitive budgets before expensive facade record allocation", async () => {
	const oversized = await fixture();
	const bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
	await writeFile(oversized.artifact.path, bytes);
	oversized.artifact.sha256 = sha256(bytes);
	const artifactReport = await validateEnrichment({ sourceMesh, artifact: oversized.artifact, grammar, requiredDrawings: oversized.drawings, facadeSegmentAuthority });
	assert.ok(artifactReport.codes.includes("ARTIFACT_BUDGET_EXCEEDED"));
	assert.equal("primitive_count" in artifactReport.metrics, false);

	const primitiveReport = await validate((document) => {
		const mesh = document.getRoot().listMeshes().find((item: any) => item.getName() === "facade-details");
		const template = mesh.listPrimitives()[0];
		for (let index = mesh.listPrimitives().length; index <= 5000; index++) {
			mesh.addPrimitive(document.createPrimitive()
				.setAttribute("POSITION", template.getAttribute("POSITION"))
				.setIndices(template.getIndices()).setMaterial(template.getMaterial())
				.setExtras({ ...template.getExtras(), slot: `budget-${index}` }));
		}
	});
	assert.ok(primitiveReport.codes.includes("ARTIFACT_BUDGET_EXCEEDED"));
	assert.equal("detail_component_distances_m" in primitiveReport.metrics, false);

	const accessorReport = await validate((document) => {
		const root = document.getRoot();
		const buffer = root.listBuffers()[0];
		for (let index = root.listAccessors().length; index <= 15002; index++) {
			document.createAccessor(`budget-accessor-${index}`, buffer).setType("SCALAR").setArray(new Float32Array([index]));
		}
	});
	assert.ok(accessorReport.codes.includes("ARTIFACT_BUDGET_EXCEEDED"));
	assert.equal("detail_component_distances_m" in accessorReport.metrics, false);
});
