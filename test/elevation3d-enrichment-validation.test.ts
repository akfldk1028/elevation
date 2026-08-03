import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { validateEnrichment } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";
import { renderUnifiedDrawings } from "../plugins/elevation-3d/lib/unified-render.mjs";

const temporaryRoots: string[] = [];

after(async () => {
	await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

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

const grammar = { frame_depth_m: 0.18, mullion_depth_m: 0.08 };
const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];
const requiredDrawings = Object.fromEntries(drawingNames.map((name) => [name, `${name}.png`]));
const artifact = {
	path: "enriched.glb",
	sha256: "a".repeat(64),
	base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
	bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
};

test("accepts unchanged base geometry, bounded details, and all seven drawings", async () => {
	const report = await validateEnrichment({ sourceMesh, artifact, grammar, requiredDrawings });
	assert.equal(report.accepted, true);
	assert.deepEqual(report.codes, []);
	assert.equal(report.metrics.allowed_detail_excess_m, 0.19);
});

test("reports stable codes for displaced base and a missing top drawing", async () => {
	const displaced = {
		...artifact,
		base_primitive: {
			positions: artifact.base_primitive.positions.map((point, index) => index === 0 ? [point[0] + 0.001, point[1], point[2]] : point),
			indices: artifact.base_primitive.indices,
		},
	};
	const withoutTop = { ...requiredDrawings };
	delete withoutTop.top;
	const report = await validateEnrichment({ sourceMesh, artifact: displaced, grammar, requiredDrawings: withoutTop });
	assert.deepEqual(report.codes, ["BASE_GEOMETRY_CHANGED", "DRAWING_MISSING"]);
	assert.deepEqual(report.metrics.missing_drawings, ["top"]);
});

test("rejects artifact bounds beyond the authored detail envelope", async () => {
	const report = await validateEnrichment({
		sourceMesh,
		artifact: { ...artifact, bounds: { min: [-2.2, -1.18, 0], max: [2.18, 1.18, 3] } },
		grammar,
		requiredDrawings,
	});
	assert.deepEqual(report.codes, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.equal(report.metrics.maximum_bounds_excess_m, 0.2);
});

test("renders seven drawing keys from one relative GLB and source camera axes", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-unified-"));
	temporaryRoots.push(root);
	const glbPath = join(root, "selected.glb");
	const scene = buildEnrichedScene({
		mesh: sourceMesh,
		floorGuides: { floor_guides_m: [0, 3] },
		facadePlanes: { facade_planes: [] },
		grammar: { ...grammar, bay_width_m: 2, glazing_recess_m: 0.12 },
		safeFallback: true,
	});
	await writeEnrichedGlb(scene, glbPath);
	const top = {
		projection: "orthographic",
		projected_bounds_m: [[-2, -1], [2, 1]],
		projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] },
	};
	const cameras = {
		views: {
			front: { ...top, projected_bounds_m: [[-2, 0], [2, 3]], projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
			right: { ...top, projected_bounds_m: [[-1, 0], [1, 3]], projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
			back: { ...top, projected_bounds_m: [[-2, 0], [2, 3]], projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
			left: { ...top, projected_bounds_m: [[-1, 0], [1, 3]], projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
			top,
			axon: { ...top, projected_bounds_m: [[-3, -1], [3, 4]], projection_axes: { depth: [0.6, -0.6, 0.5], horizontal: [0.7, 0.7, 0], vertical: [-0.35, 0.35, 0.85] } },
		},
	};
	const drawings = await renderUnifiedDrawings({ runDir: root, glbPath, sourceMesh, cameras });
	assert.deepEqual(Object.keys(drawings), drawingNames);
	await Promise.all(Object.values(drawings).map((path) => stat(path)));
	const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8"));
	assert.deepEqual(config.strategies, { hunyuan: { glb: "../selected.glb" } });
	assert.deepEqual(config.cameras.views.plan.projection_axes, top.projection_axes);
	assert.equal(config.cameras.views.plan.rendering.material_mode, "line-oriented");
});
