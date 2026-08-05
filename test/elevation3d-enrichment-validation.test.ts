import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { validateEnrichment } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";
import { renderUnifiedDrawings } from "../plugins/elevation-3d/lib/unified-render.mjs";

const temporaryRoots: string[] = [];
after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

const sourceMesh = {
	vertices: [
		[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0],
		[-2, -1, 3], [2, -1, 3], [2, 1, 3], [-2, 1, 3],
	],
	triangles: [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
		[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	],
};
const grammar = {
	bay_width_m: 2, frame_depth_m: 0.18, mullion_depth_m: 0.08,
	glazing_recess_m: 0.12, floor_elevations_m: [0, 3], facade_lengths_m: { front: 4 }, primitive_budget: 1000,
};
const floorGuides = { floor_guides_m: [0, 3] };
const facadePlanes = { facade_planes: [{ view: "front", origin: [-2, -1, 0], normal: [0, -1, 0], extent_m: [4, 3] }] };
const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];

function pngStub(width = 2, height = 3) {
	const bytes = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

async function validPng(width = 2, height = 3) {
	return sharp({ create: { width, height, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
}

async function fixture({ fallback = false, mesh = sourceMesh, sceneGrammar = grammar, guides = floorGuides, planes = facadePlanes } = {}) {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-validation-"));
	temporaryRoots.push(root);
	const artifact = await writeEnrichedGlb(buildEnrichedScene({
		mesh, floorGuides: guides, facadePlanes: planes, grammar: sceneGrammar, safeFallback: fallback,
	}), join(root, fallback ? "exact-mass.glb" : "enriched.glb"));
	await mkdir(join(root, "viewer"), { recursive: true });
	await mkdir(join(root, "drawings", "hunyuan"), { recursive: true });
	const configPath = join(root, "viewer", "config.json");
	await writeFile(configPath, JSON.stringify({ strategies: { hunyuan: { glb: `../${fallback ? "exact-mass.glb" : "enriched.glb"}` } } }));
	const drawings: Record<string, string> = {};
	const drawingBytes = await validPng();
	for (const name of drawingNames) {
		drawings[name] = join(root, "drawings", "hunyuan", `${name}.png`);
		await writeFile(drawings[name], drawingBytes);
	}
	await writeProvenance(root, artifact.path, drawings, configPath);
	return { root, artifact, drawings, configPath };
}

async function writeProvenance(root: string, glbPath: string, drawings: Record<string, string>, configPath: string, overrides: any = {}) {
	const glbHash = sha256(await readFile(glbPath));
	const configHash = sha256(await readFile(configPath));
	const drawingEntries: Record<string, any> = {};
	for (const [name, path] of Object.entries(drawings)) {
		const bytes = await readFile(path);
		drawingEntries[name] = { path, sha256: sha256(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), glb_sha256: glbHash, viewer_config_sha256: configHash };
	}
	await writeFile(join(root, "drawing-provenance.json"), JSON.stringify({
		schema_version: "arr.elevation3d.drawing-provenance.v1",
		selected_glb: { path: glbPath, sha256: glbHash },
		viewer_config: { path: configPath, sha256: configHash },
		drawings: drawingEntries,
		...overrides,
	}, null, 2));
}

async function refreshArtifact(f: Awaited<ReturnType<typeof fixture>>) {
	f.artifact.sha256 = sha256(await readFile(f.artifact.path));
	await writeProvenance(f.root, f.artifact.path, f.drawings, f.configPath);
}

test("accepts parsed enriched GLB and provenance-bound PNG drawings", async () => {
	const f = await fixture();
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings });
	assert.equal(report.accepted, true);
	assert.deepEqual(report.codes, []);
	assert.deepEqual(report.metrics.materials, ["bronze", "concrete", "glass", "opaque"]);
	assert.equal(report.metrics.drawing_dimensions.front.width, 2);
	assert.equal(report.artifacts.glb_sha256, f.artifact.sha256);
	assert.equal(report.metrics.canonical_surface_match, 1);
});

test("rejects a facade artifact that omits required segment authority metadata", async () => {
	const f = await fixture();
	const facadeSegmentAuthority = {
		schema_version: "arr.elevation3d.facade-segments.v1",
		facade_planes: [{
			segment_id: "front-segment", view: "front", origin: [-2, -1, 0], normal: [0, -1, 0],
			extent_m: [4, 3], start_corner_id: "front-start", end_corner_id: "front-end",
		}],
	};
	const report = await validateEnrichment({
		sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, facadeSegmentAuthority,
	});
	assert.equal(report.metrics.segment_authority_match, false);
	assert.ok(report.codes.includes("FACADE_SEGMENT_AUTHORITY_MISMATCH"));
	assert.equal(report.accepted, false);
});

test("rejects missing, hash-mismatched, and corrupt GLB bytes with stable codes", async () => {
	const f = await fixture({ fallback: true });
	const mismatch = await validateEnrichment({ sourceMesh, artifact: { ...f.artifact, sha256: "0".repeat(64) }, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(mismatch.codes.includes("ARTIFACT_HASH_MISMATCH"));
	await writeFile(f.artifact.path, Buffer.from("not a glb"));
	f.artifact.sha256 = sha256(await readFile(f.artifact.path));
	const corrupt = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(corrupt.codes.includes("GLB_INVALID"));
	const missing = await validateEnrichment({ sourceMesh, artifact: { ...f.artifact, path: join(f.root, "missing.glb") }, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(missing.codes.includes("ARTIFACT_MISSING"));
});

test("detects actual base accessor mutation despite forged artifact metadata", async () => {
	const f = await fixture({ fallback: true });
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const positions = document.getRoot().listNodes().find((node) => node.getName() === "exact-mass")!.getMesh()!.listPrimitives()[0].getAttribute("POSITION")!;
	const changed = positions.getElement(0, [0, 0, 0]);
	changed[0] += 0.001;
	positions.setElement(0, changed);
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh, artifact: { ...f.artifact, base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles } }, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(report.codes.includes("BASE_GEOMETRY_CHANGED"));
});

test("rejects an index bridge between disconnected source components", async () => {
	const disconnected = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [3, 0, 0], [4, 0, 0], [3, 1, 0]], triangles: [[0, 1, 2], [3, 4, 5]] };
	const f = await fixture({ fallback: true, mesh: disconnected });
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const indices = document.getRoot().listNodes().find((node) => node.getName() === "exact-mass")!.getMesh()!.listPrimitives()[0].getIndices()!;
	const changed = indices.getArray();
	changed[3] = 2;
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh: disconnected, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(report.codes.includes("BASE_GEOMETRY_CHANGED"));
	assert.equal(report.metrics.source_base_components, 2);
	assert.equal(report.metrics.actual_base_components, 1);
});

test("derives detail bounds, material set, primitive budget, and floor coverage from GLB", async () => {
	const f = await fixture();
	const budget = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar: { ...grammar, primitive_budget: 1 }, requiredDrawings: f.drawings });
	assert.ok(budget.codes.includes("PRIMITIVE_BUDGET_EXCEEDED"));
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const detailNode = document.getRoot().listNodes().find((node) => node.getName() === "facade-details")!;
	detailNode.setTranslation([0, -1, 0]);
	detailNode.getMesh()!.listPrimitives().forEach((primitive, index) => primitive.setExtras(index === 0 ? { kind: "floor-band", elevation_m: 6, view: "front" } : {}));
	document.getRoot().listMaterials().find((material) => material.getName() === "bronze")!.setName("missing-bronze");
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings });
	assert.ok(report.codes.includes("DETAIL_BOUNDS_EXCEEDED"));
	assert.ok(report.codes.includes("MATERIAL_SET_INVALID"));
	assert.ok(report.codes.includes("FLOOR_GUIDE_COVERAGE_MISSING"));
	assert.ok(report.codes.includes("DETAIL_COVERAGE_MISSING"));
	assert.ok(report.codes.includes("NEW_STOREY_DETECTED"));
});

test("allows concrete-only material only for an explicit safe fallback", async () => {
	const f = await fixture({ fallback: true });
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: false });
	assert.ok(report.codes.includes("MATERIAL_SET_INVALID"));
});

test("rejects invalid drawings and missing or mismatched provenance", async () => {
	const f = await fixture({ fallback: true });
	await writeFile(f.drawings.front, Buffer.alloc(0));
	await rm(join(f.root, "drawing-provenance.json"));
	const missing = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(missing.codes.includes("DRAWING_INVALID"));
	assert.ok(missing.codes.includes("DRAWING_PROVENANCE_MISSING"));
	await writeFile(f.drawings.front, await validPng());
	await writeProvenance(f.root, f.artifact.path, f.drawings, f.configPath, { selected_glb: { path: f.artifact.path, sha256: "f".repeat(64) } });
	const mismatch = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(mismatch.codes.includes("DRAWING_PROVENANCE_MISMATCH"));
});

test("rejects a PNG with only a valid signature and IHDR stub", async () => {
	const f = await fixture({ fallback: true });
	await writeFile(f.drawings.front, pngStub());
	await writeProvenance(f.root, f.artifact.path, f.drawings, f.configPath);
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(report.codes.includes("DRAWING_INVALID"));
	assert.equal(report.accepted, false);
});

test("rejects configured and provenance GLB paths that are not the artifact file", async () => {
	const f = await fixture({ fallback: true });
	const otherGlb = join(f.root, "other.glb");
	await writeFile(otherGlb, "plain text masquerading as selected geometry");
	await writeFile(f.configPath, JSON.stringify({ strategies: { hunyuan: { glb: "../other.glb" } } }));
	await writeProvenance(f.root, f.artifact.path, f.drawings, f.configPath, {
		selected_glb: { path: otherGlb, sha256: f.artifact.sha256 },
	});
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings, safeFallback: true });
	assert.ok(report.codes.includes("DRAWING_PROVENANCE_MISMATCH"));
	assert.equal(report.accepted, false);
});

test("rejects floor-band vertices moved away from their declared elevation", async () => {
	const f = await fixture();
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const primitives = document.getRoot().listNodes().find((node) => node.getName() === "facade-details")!.getMesh()!.listPrimitives()
		.filter((item) => item.getExtras().kind === "floor-band" && item.getExtras().elevation_m === 0);
	for (const primitive of primitives) {
		const positions = primitive.getAttribute("POSITION")!;
		for (let index = 0; index < positions.getCount(); index++) {
			const point = positions.getElement(index, [0, 0, 0]);
			point[2] += 0.1;
			positions.setElement(index, point);
		}
	}
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings });
	assert.ok(report.codes.includes("FLOOR_GUIDE_COVERAGE_MISSING"));
	assert.equal(report.accepted, false);
});

test("rejects one detail primitive bridging two detached source components", async () => {
	const disconnected = {
		vertices: [
			[-4,-1,0],[-2,-1,0],[-2,1,0],[-4,1,0],[-4,-1,3],[-2,-1,3],[-2,1,3],[-4,1,3],
			[2,-1,0],[4,-1,0],[4,1,0],[2,1,0],[2,-1,3],[4,-1,3],[4,1,3],[2,1,3],
		],
		triangles: [
			[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],
			[8,10,9],[8,11,10],[12,13,14],[12,14,15],[8,9,13],[8,13,12],[9,10,14],[9,14,13],[10,11,15],[10,15,14],[11,8,12],[11,12,15],
		],
	};
	const disconnectedGrammar = { ...grammar, facade_lengths_m: { front: 8 } };
	const planes = { facade_planes: [{ view: "front", origin: [-4, -1, 0], normal: [0, -1, 0], extent_m: [8, 3] }] };
	const f = await fixture({ mesh: disconnected, sceneGrammar: disconnectedGrammar, planes });
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const primitive = document.getRoot().listNodes().find((node) => node.getName() === "facade-details")!.getMesh()!.listPrimitives()
		.find((item) => item.getExtras().kind === "floor-band" && item.getExtras().elevation_m === 0)!;
	const positions = primitive.getAttribute("POSITION")!;
	for (let index = 0; index < positions.getCount(); index++) {
		const point = positions.getElement(index, [0, 0, 0]);
		if (point[0] > -3) point[0] = 4;
		positions.setElement(index, point);
	}
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh: disconnected, artifact: f.artifact, grammar: disconnectedGrammar, requiredDrawings: f.drawings });
	assert.ok(report.codes.includes("DETAIL_COMPONENT_BRIDGE"));
	assert.equal(report.accepted, false);
});

test("rejects glazing moved inside a component AABB but away from its surface", async () => {
	const f = await fixture();
	const io = new NodeIO();
	const document = await io.read(f.artifact.path);
	const primitive = document.getRoot().listNodes().find((node) => node.getName() === "facade-details")!.getMesh()!.listPrimitives()
		.find((item) => item.getExtras().kind === "glazing")!;
	const positions = primitive.getAttribute("POSITION")!;
	const originalZ = Array.from({ length: positions.getCount() }, (_, index) => positions.getElement(index, [0, 0, 0])[2]);
	const minZ = Math.min(...originalZ);
	const spanZ = Math.max(...originalZ) - minZ;
	for (let index = 0; index < positions.getCount(); index++) {
		const point = positions.getElement(index, [0, 0, 0]);
		point[0] *= 0.2;
		point[1] += 1;
		point[2] = 1 + (point[2] - minZ) / spanZ;
		positions.setElement(index, point);
	}
	await io.write(f.artifact.path, document);
	await refreshArtifact(f);
	const report = await validateEnrichment({ sourceMesh, artifact: f.artifact, grammar, requiredDrawings: f.drawings });
	assert.ok(report.codes.includes("DETAIL_COMPONENT_UNATTACHED"));
	assert.equal(report.accepted, false);
});

test("renders provenance binding seven real drawings to one GLB and viewer config", async () => {
	const f = await fixture({ fallback: true });
	await rm(join(f.root, "drawing-provenance.json"));
	const top = { projection: "orthographic", projected_bounds_m: [[-2, -1], [2, 1]], projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] } };
	const cameras = { views: {
		front: { ...top, projected_bounds_m: [[-2, 0], [2, 3]], projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
		right: { ...top, projected_bounds_m: [[-1, 0], [1, 3]], projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
		back: { ...top, projected_bounds_m: [[-2, 0], [2, 3]], projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
		left: { ...top, projected_bounds_m: [[-1, 0], [1, 3]], projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } }, top,
		axon: { ...top, projected_bounds_m: [[-3, -1], [3, 4]], projection_axes: { depth: [0.6, -0.6, 0.5], horizontal: [0.7, 0.7, 0], vertical: [-0.35, 0.35, 0.85] } },
	} };
	const drawings = await renderUnifiedDrawings({ runDir: f.root, glbPath: f.artifact.path, sourceMesh, cameras });
	await Promise.all(Object.values(drawings).map((path) => stat(path)));
	const provenance = JSON.parse(await readFile(join(f.root, "drawing-provenance.json"), "utf8"));
	assert.equal(provenance.selected_glb.sha256, f.artifact.sha256);
	assert.deepEqual(Object.keys(provenance.drawings), drawingNames);
	assert.equal(provenance.drawings.plan.glb_sha256, provenance.drawings.top.glb_sha256);
	assert.notEqual(provenance.drawings.plan.sha256, provenance.drawings.top.sha256);
	const config = JSON.parse(await readFile(join(f.root, "viewer", "config.json"), "utf8"));
	assert.equal("mesh" in config, false);
});
