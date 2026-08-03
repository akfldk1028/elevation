import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runElevation3d } from "../plugins/elevation-3d/lib/unified-flow.mjs";

const temporaryRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(path: string, value: unknown) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-flow-"));
	temporaryRoots.push(root);
	const candidateId = "creative-013";
	const candidateRoot = join(root, "dataset", "candidates", candidateId);
	const massRoot = join(candidateRoot, "mass");
	const researchRoot = join(massRoot, "elevation-research");
	const mesh = {
		identity: { geometry_hash: "geometry-sha256" },
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
	const top = {
		projection: "orthographic",
		projected_bounds_m: [[-2, -1], [2, 1]],
		projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] },
	};
	const cameras = {
		views: {
			front: { ...top, projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
			right: { ...top, projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
			back: { ...top, projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
			left: { ...top, projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
			top,
			axon: { ...top, projection_axes: { depth: [0.6, -0.6, 0.5], horizontal: [0.7, 0.7, 0], vertical: [-0.35, 0.35, 0.85] } },
		},
	};
	const floorGuides = { floor_guides_m: [0, 3] };
	const facadePlanes = {
		facade_planes: [
			{ view: "front", origin: [-2, -1, 0], normal: [0, -1, 0], extent_m: [4, 3] },
			{ view: "right", origin: [2, -1, 0], normal: [1, 0, 0], extent_m: [2, 3] },
			{ view: "back", origin: [2, 1, 0], normal: [0, 1, 0], extent_m: [4, 3] },
			{ view: "left", origin: [-2, 1, 0], normal: [-1, 0, 0], extent_m: [2, 3] },
		],
	};
	await writeJson(join(candidateRoot, "candidate.json"), { candidate_id: candidateId });
	await writeJson(join(massRoot, "manifest.json"), {
		identity: { candidate_id: candidateId, geometry_hash: "geometry-sha256" },
		artifacts: {},
	});
	await writeJson(join(massRoot, "mesh", "indexed-mesh.json"), mesh);
	await writeJson(join(researchRoot, "camera-poses.json"), cameras);
	await writeJson(join(researchRoot, "floor-guides.json"), floorGuides);
	await writeJson(join(researchRoot, "facade-planes.json"), facadePlanes);
	await writeJson(join(researchRoot, "surface-normals.json"), { surface_normals: [] });

	const assetRoot = join(root, "memory", "elevation-3d", "assets", candidateId);
	const approvedImage = join(assetRoot, "approved.png");
	const imageBytes = Buffer.from("approved facade image");
	await mkdir(assetRoot, { recursive: true });
	await writeFile(approvedImage, imageBytes);
	await writeJson(join(assetRoot, "approved-design-v1.json"), {
		image_path: "approved.png",
		image_sha256: createHash("sha256").update(imageBytes).digest("hex"),
		facade_grammar: {
			bay_width_m: 2,
			frame_depth_m: 0.18,
			mullion_depth_m: 0.08,
			glazing_recess_m: 0.12,
			parapet_height_m: 0.35,
		},
	});
	return {
		root,
		candidateId,
		datasetRoot: join(root, "dataset"),
		outputRoot: join(root, "output"),
		mesh,
	};
}

function acceptedDeps(sourceMesh: Awaited<ReturnType<typeof fixture>>["mesh"]) {
	return {
		enrich: async ({ outputPath }: { outputPath: string }) => ({
			path: outputPath,
			sha256: "a".repeat(64),
			base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
			bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
		}),
		render: async ({ runDir }: { runDir: string }) => Object.fromEntries(
			["plan", "front", "back", "left", "right", "top", "axon"].map((name) => [name, join(runDir, `${name}.png`)]),
		),
		validate: async () => ({ accepted: true, codes: [], metrics: {}, artifacts: {} }),
	};
}

function validationDeps(
	sourceMesh: Awaited<ReturnType<typeof fixture>>["mesh"],
	failures: Record<string, string[]>,
) {
	const enrichCalls: Array<{ versionId: string; safeFallback: boolean }> = [];
	const validateCalls: string[] = [];
	return {
		enrichCalls,
		validateCalls,
		enrich: async ({ outputPath, versionId, safeFallback }: {
			outputPath: string;
			versionId: string;
			safeFallback: boolean;
		}) => {
			enrichCalls.push({ versionId, safeFallback });
			return {
				path: outputPath,
				sha256: "a".repeat(64),
				base_primitive: { positions: sourceMesh.vertices, indices: sourceMesh.triangles },
				bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
			};
		},
		render: async ({ runDir }: { runDir: string }) => Object.fromEntries(
			["plan", "front", "back", "left", "right", "top", "axon"].map((name) => [name, join(runDir, `${name}.png`)]),
		),
		validate: async ({ versionId }: { versionId: string }) => {
			validateCalls.push(versionId);
			const codes = failures[versionId] ?? [];
			return { accepted: codes.length === 0, codes, metrics: { version_id: versionId }, artifacts: {} };
		},
	};
}

async function readJson(path: string) {
	return JSON.parse(await readFile(path, "utf8"));
}

test("selects v001 when enrichment and all gates pass", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "success",
		deps: acceptedDeps(input.mesh),
	});

	assert.equal(result.selected_version, "v001");
	assert.equal(result.attempts, 1);
	assert.equal(result.fallback, false);
	assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "v001");
	assert.equal((await readJson(join(result.run_dir, "versions", "v001", "version.json"))).status, "passed");
	assert.deepEqual(await readJson(join(result.run_dir, "versions", "v001", "validation.json")), {
		accepted: true,
		codes: [],
		metrics: {},
		artifacts: {},
	});
});

test("applies exactly one bounded correction and selects v002", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, { v001: ["DETAIL_BOUNDS_EXCEEDED"] });
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "retry",
		deps,
	});

	assert.equal(result.selected_version, "v002");
	assert.equal(result.attempts, 2);
	assert.equal(result.fallback, false);
	assert.deepEqual(deps.validateCalls, ["v001", "v002"]);
	assert.deepEqual((await readJson(join(result.run_dir, "versions", "v001", "failure.json"))).codes, [
		"DETAIL_BOUNDS_EXCEEDED",
	]);
	const corrected = await readJson(join(result.run_dir, "versions", "v002", "grammar.json"));
	assert.equal(corrected.frame_depth_m, 0.09);
	assert.equal(corrected.mullion_depth_m, 0.04);
	assert.equal((await readJson(join(result.run_dir, "versions", "v002", "version.json"))).status, "passed");
});

test("quarantines both failures and selects a rendered and validated exact-mass fallback", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, {
		v001: ["DETAIL_BOUNDS_EXCEEDED"],
		v002: ["PRIMITIVE_BUDGET_EXCEEDED"],
	});
	const result = await runElevation3d({
		candidateId: input.candidateId,
		datasetRoot: input.datasetRoot,
		outputRoot: input.outputRoot,
		runId: "fallback",
		deps,
	});

	assert.equal(result.selected_version, "fallback");
	assert.equal(result.attempts, 2);
	assert.equal(result.fallback, true);
	assert.deepEqual(deps.validateCalls, ["v001", "v002", "fallback"]);
	assert.deepEqual(deps.enrichCalls, [
		{ versionId: "v001", safeFallback: false },
		{ versionId: "v002", safeFallback: false },
		{ versionId: "fallback", safeFallback: true },
	]);
	assert.equal((await readJson(join(result.run_dir, "versions", "v001", "failure.json"))).codes.length > 0, true);
	assert.equal((await readJson(join(result.run_dir, "versions", "v002", "failure.json"))).codes.length > 0, true);
	assert.equal((await readJson(join(result.run_dir, "final.json"))).selected, "fallback");
	assert.equal((await readJson(join(result.run_dir, "versions", "fallback", "version.json"))).status, "passed");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
	assert.equal(JSON.parse(memoryLines[0]).final.selected, "fallback");
});

test("blocks a non-correctable validation code without launching v002 or fallback", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const deps = validationDeps(input.mesh, { v001: ["BASE_GEOMETRY_CHANGED"] });
	const runDir = join(input.outputRoot, input.candidateId, "base-corruption");

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "base-corruption",
			deps,
		}),
		(error: Error & { code?: string; retryable?: boolean }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.equal(error.retryable, false);
			assert.match(error.message, /BASE_GEOMETRY_CHANGED/);
			return true;
		},
	);
	assert.deepEqual(deps.validateCalls, ["v001"]);
	assert.deepEqual(deps.enrichCalls, [{ versionId: "v001", safeFallback: false }]);
	assert.equal((await readJson(join(runDir, "final.json"))).selected, "blocked");
	const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
		.trim().split(/\r?\n/);
	assert.equal(memoryLines.length, 1);
	assert.equal(JSON.parse(memoryLines[0]).final.selected, "blocked");
});

for (const failureStage of ["enrich", "render", "validate"] as const) {
	test(`blocks an unexpected ${failureStage} exception after v001 and preserves its cause`, async () => {
		const input = await fixture();
		process.chdir(input.root);
		const calls: string[] = [];
		const fault = Object.assign(new Error(`${failureStage} programming fault`), { code: "EACCES" });
		const deps = {
			enrich: async ({ outputPath, versionId }: { outputPath: string; versionId: string }) => {
				calls.push(`enrich:${versionId}`);
				if (failureStage === "enrich") throw fault;
				return {
					path: outputPath,
					sha256: "a".repeat(64),
					base_primitive: { positions: input.mesh.vertices, indices: input.mesh.triangles },
					bounds: { min: [-2.18, -1.18, 0], max: [2.18, 1.18, 3] },
				};
			},
			render: async ({ runDir, versionId }: { runDir: string; versionId: string }) => {
				calls.push(`render:${versionId}`);
				if (failureStage === "render") throw fault;
				return Object.fromEntries(
					["plan", "front", "back", "left", "right", "top", "axon"]
						.map((name) => [name, join(runDir, `${name}.png`)]),
				);
			},
			validate: async ({ versionId }: { versionId: string }) => {
				calls.push(`validate:${versionId}`);
				if (failureStage === "validate") throw fault;
				return { accepted: true, codes: [], metrics: {}, artifacts: {} };
			},
		};
		const runId = `throw-${failureStage}`;
		const runDir = join(input.outputRoot, input.candidateId, runId);

		await assert.rejects(
			() => runElevation3d({
				candidateId: input.candidateId,
				datasetRoot: input.datasetRoot,
				outputRoot: input.outputRoot,
				runId,
				deps,
			}),
			(error: Error & { cause?: unknown; code?: string }) => {
				assert.equal(error.code, "RUN_BLOCKED");
				assert.equal(error.cause, fault);
				return true;
			},
		);
		const expectedCalls = failureStage === "enrich"
			? ["enrich:v001"]
			: failureStage === "render"
				? ["enrich:v001", "render:v001"]
				: ["enrich:v001", "render:v001", "validate:v001"];
		assert.deepEqual(calls, expectedCalls);
		const failure = await readJson(join(runDir, "versions", "v001", "failure.json"));
		assert.equal(failure.stage, failureStage);
		assert.deepEqual(failure.codes, [{ enrich: "ENRICHMENT_FAILED", render: "RENDER_FAILED", validate: "VALIDATION_FAILED" }[failureStage]]);
		assert.equal(failure.retryable, false);
		assert.equal((await readJson(join(runDir, "final.json"))).selected, "blocked");
		const memoryLines = (await readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl"), "utf8"))
			.trim().split(/\r?\n/);
		assert.equal(memoryLines.length, 1);
	});
}

test("blocks an untrusted approved-image hash without attempting or falling back", async () => {
	const input = await fixture();
	process.chdir(input.root);
	const metadataPath = join(input.root, "memory", "elevation-3d", "assets", input.candidateId, "approved-design-v1.json");
	const metadata = await readJson(metadataPath);
	await writeJson(metadataPath, { ...metadata, image_sha256: "0".repeat(64) });
	const deps = validationDeps(input.mesh, {});

	await assert.rejects(
		() => runElevation3d({
			candidateId: input.candidateId,
			datasetRoot: input.datasetRoot,
			outputRoot: input.outputRoot,
			runId: "blocked",
			deps,
		}),
		(error: Error & { code?: string; retryable?: boolean }) => {
			assert.equal(error.code, "RUN_BLOCKED");
			assert.equal(error.retryable, false);
			assert.match(error.message, /approved image hash mismatch/i);
			return true;
		},
	);
	assert.deepEqual(deps.enrichCalls, []);
	await assert.rejects(() => readFile(join(input.root, "memory", "elevation-3d", "unified-runs.jsonl")), /ENOENT/);
});
