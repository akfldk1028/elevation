import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
	appendRunMemory,
	beginVersion,
	createUnifiedRun,
	recordVersionFailure,
	recordVersionSuccess,
	recordVersionCancelled,
	recordVersionCheckpoint,
	selectFinal,
} from "../plugins/elevation-3d/lib/run-memory.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const input = {
	candidate_id: "creative-013",
	identity: { geometry_hash: "geometry-sha256" },
	artifacts: [
		{ path: "mass/mesh/indexed-mesh.json", sha256: "mesh-sha256", bytes: Buffer.from("binary") },
	],
};
const approvedDesign = {
	image_path: "memory/elevation-3d/assets/creative-013/approved-detailed-isometric-v1.png",
	image_sha256: "image-sha256",
};
const grammar = {
	bay_width_m: 2.25,
};

test("creates immutable run metadata and v001 directories", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-memory-"));
	temporaryRoots.push(outputRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-1" });
	const originalRunJson = await readFile(join(run.dir, "run.json"), "utf8");
	const version = await beginVersion(run, "v001", grammar);

	assert.equal(version.id, "v001");
	const persistedRun = JSON.parse(await readFile(join(run.dir, "run.json"), "utf8"));
	assert.equal(persistedRun.schema_version, "arr.elevation3d.unified-run.v1");
	assert.equal(persistedRun.candidate_id, "creative-013");
	assert.equal(await readFile(join(run.dir, "run.json"), "utf8"), originalRunJson);
	assert.equal(JSON.stringify(persistedRun).includes("binary"), false);
	assert.deepEqual(persistedRun.artifacts, [
		{ path: "mass/mesh/indexed-mesh.json", sha256: "mesh-sha256" },
		{ path: "memory/elevation-3d/assets/creative-013/approved-detailed-isometric-v1.png", sha256: "image-sha256" },
	]);
	assert.equal(JSON.parse(await readFile(join(version.dir, "version.json"), "utf8")).schema_version, "arr.elevation3d.version.v1");
	assert.equal(JSON.parse(await readFile(join(version.dir, "grammar.json"), "utf8")).schema_version, "arr.facade-grammar.v1");
});

test("rejects a run ID collision without replacing initial metadata", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-collision-"));
	temporaryRoots.push(outputRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "same-run" });
	const initial = await readFile(join(run.dir, "run.json"), "utf8");

	await assert.rejects(
		() => createUnifiedRun({
			input: { ...input, identity: { geometry_hash: "replacement-hash" } },
			approvedDesign,
			outputRoot,
			runId: "same-run",
		}),
		/already exists/i,
	);
	assert.equal(await readFile(join(run.dir, "run.json"), "utf8"), initial);
});

test("rejects unsafe candidate and run path segments before creating a run", async () => {
	const cases = [
		{ candidateId: "../escaped-candidate", runId: "safe-run", escaped: "escaped-candidate" },
		{ candidateId: "creative/013", runId: "safe-run", escaped: "creative" },
		{ candidateId: "creative\\013", runId: "safe-run", escaped: "creative" },
		{ candidateId: "C:escape", runId: "safe-run", escaped: "C:escape" },
		{ candidateId: "", runId: "safe-run", escaped: "safe-run" },
		{ candidateId: "creative-013", runId: "../escaped-run", escaped: "escaped-run" },
		{ candidateId: "creative-013", runId: "run/escape", escaped: "creative-013" },
		{ candidateId: "creative-013", runId: "run\\escape", escaped: "creative-013" },
		{ candidateId: "creative-013", runId: "C:escape", escaped: "creative-013" },
		{ candidateId: "creative-013", runId: "bad\u0000run", escaped: "creative-013" },
	];
	for (const [index, item] of cases.entries()) {
		const root = await mkdtemp(join(tmpdir(), `elevation3d-boundary-${index}-`));
		temporaryRoots.push(root);
		const outputRoot = join(root, "output");
		await assert.rejects(
			() => createUnifiedRun({
				input: { ...input, candidate_id: item.candidateId },
				approvedDesign,
				outputRoot,
				runId: item.runId,
			}),
			/safe path segment/i,
		);
		await assert.rejects(() => access(join(root, item.escaped)), /ENOENT/);
	}
});

test("accepts the production candidate and timestamp-style run IDs", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-safe-ids-"));
	temporaryRoots.push(outputRoot);
	const run = await createUnifiedRun({
		input,
		approvedDesign,
		outputRoot,
		runId: "20260803T120000-deadbeef",
	});
	assert.match(run.dir, /creative-013[\\/]20260803T120000-deadbeef$/);
});

test("rejects a forged unsafe candidate before writing candidate memory", async () => {
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-memory-boundary-"));
	temporaryRoots.push(memoryRoot);
	const forgedRun = {
		id: "safe-run",
		dir: join(memoryRoot, "run"),
		metadata: { candidate_id: "../outside", artifacts: [] },
		versions: [],
		final: { selected: "blocked", reason: "rejected" },
	};
	await assert.rejects(() => appendRunMemory(forgedRun, memoryRoot), /safe path segment/i);
	await assert.rejects(() => access(join(memoryRoot, "outside.jsonl")), /ENOENT/);
});

test("rejects a forged unsafe run ID before writing global or candidate memory", async () => {
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-id-memory-boundary-"));
	temporaryRoots.push(memoryRoot);
	const forgedRun = {
		id: "../outside",
		dir: join(memoryRoot, "run"),
		metadata: { candidate_id: "creative-013", artifacts: [] },
		versions: [],
		final: { selected: "blocked", reason: "rejected" },
	};
	await assert.rejects(() => appendRunMemory(forgedRun, memoryRoot), /safe path segment/i);
	await assert.rejects(() => access(join(memoryRoot, "unified-runs.jsonl")), /ENOENT/);
	await assert.rejects(() => access(join(memoryRoot, "runs", "creative-013.jsonl")), /ENOENT/);
});

test("transitions an accepted version from started to passed", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-success-"));
	temporaryRoots.push(outputRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-passed" });
	const version = await beginVersion(run, "v001", grammar);

	await recordVersionSuccess(run, version, { accepted: true, codes: [], metrics: { exact_base: true }, artifacts: {} });

	const persisted = JSON.parse(await readFile(join(version.dir, "version.json"), "utf8"));
	assert.equal(persisted.status, "passed");
	assert.equal(persisted.validation_path, "validation.json");
	assert.equal(JSON.parse(await readFile(join(version.dir, "validation.json"), "utf8")).metrics.exact_base, true);
	assert.equal(version.metadata.status, "passed");
});

test("records each version failure and appends one redacted final memory event", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-failures-"));
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-durable-memory-"));
	temporaryRoots.push(outputRoot, memoryRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-2" });
	const v1 = await beginVersion(run, "v001", grammar);
	const v2 = await beginVersion(run, "v002", { bay_width_m: 2 });

	await recordVersionFailure(run, v1, {
		stage: "validate",
		codes: ["DETAIL_BOUNDS_EXCEEDED"],
		reason: "Authorization: Bearer reason-secret was rejected",
		error_class: "ValidationError",
		error_code: "E_DETAIL",
		evidence: {
			message: "signed https://x.test/file?X-Amz-Signature=url-secret",
			metrics: { invalid_pixels: 3 },
			response: {
				authorization: "Bearer secret",
				credentials: { password: "password-value", cookie: "cookie-value" },
			},
			session: "session-value",
		},
		retryable: true,
	});
	await recordVersionFailure(run, v2, {
		stage: "validate",
		codes: ["MISSING_COMPONENT"],
		evidence: {},
		retryable: false,
	});
	const fallback = await beginVersion(run, "fallback", grammar);
	await recordVersionSuccess(run, fallback, {
		accepted: true,
		codes: [],
		metrics: {},
		artifacts: {
			glb: join(fallback.dir, "exact-mass.glb"),
			drawings: Object.fromEntries(
				["plan", "front", "back", "left", "right", "top", "axon"]
					.map((name) => [name, join(fallback.dir, "drawings", `${name}.png`)]),
			),
		},
	});
	await selectFinal(run, { selected: "fallback", reason: "two generated versions failed" });
	await Promise.all([appendRunMemory(run, memoryRoot), appendRunMemory(run, memoryRoot)]);

	const firstFailure = JSON.parse(await readFile(join(v1.dir, "failure.json"), "utf8"));
	const secondFailure = JSON.parse(await readFile(join(v2.dir, "failure.json"), "utf8"));
	const firstVersion = JSON.parse(await readFile(join(v1.dir, "version.json"), "utf8"));
	assert.equal(firstFailure.schema_version, "arr.elevation3d.version-failure.v1");
	assert.deepEqual(firstFailure.codes, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.deepEqual(secondFailure.codes, ["MISSING_COMPONENT"]);
	assert.equal(firstVersion.status, "failed");
	assert.equal(firstVersion.failure_path, "failure.json");
	assert.equal(JSON.stringify(firstFailure).includes("secret"), false);
	assert.deepEqual(firstFailure.evidence, {
		message: "signed https://x.test/file",
		metrics: { invalid_pixels: 3 },
	});
	assert.equal(firstFailure.reason.includes("reason-secret"), false);
	assert.equal(firstFailure.error_class, "ValidationError");
	assert.equal(firstFailure.error_code, "E_DETAIL");

	const final = JSON.parse(await readFile(join(run.dir, "final.json"), "utf8"));
	assert.equal(final.schema_version, "arr.elevation3d.final-selection.v1");
	assert.equal(final.selected, "fallback");

	const memoryFile = join(memoryRoot, "unified-runs.jsonl");
	const lines = (await readFile(memoryFile, "utf8")).trim().split("\n");
	assert.equal(lines.length, 1);
	const event = JSON.parse(lines[0]);
	assert.equal(event.schema_version, "arr.elevation3d.run-memory.v2");
	assert.deepEqual(event.versions.map((version: { id: string }) => version.id), ["v001", "v002", "fallback"]);
	assert.deepEqual(event.versions.map((version: { status: string }) => version.status), ["failed", "failed", "passed"]);
	assert.deepEqual(event.versions.slice(0, 2).map((version: any) => version.failure.codes), [
		["DETAIL_BOUNDS_EXCEEDED"],
		["MISSING_COMPONENT"],
	]);
	assert.equal(event.versions[2].validation.accepted, true);
	assert.equal(event.versions[2].artifacts.glb.path, "versions/fallback/exact-mass.glb");
	assert.deepEqual(event.versions[1].correction.grammar_delta, { bay_width_m: { from: 2.25, to: 2 } });
	assert.equal(JSON.stringify(event).includes("secret"), false);
	for (const credential of ["password-value", "cookie-value", "session-value"]) {
		assert.equal(JSON.stringify(event).includes(credential), false);
	}

	const candidateLines = (await readFile(join(memoryRoot, "runs", "creative-013.jsonl"), "utf8")).trim().split("\n");
	assert.equal(candidateLines.length, 1);
	const candidateEvent = JSON.parse(candidateLines[0]);
	assert.equal(candidateEvent.schema_version, "arr.elevation3d.candidate-run-memory.v2");
	assert.deepEqual(candidateEvent.versions, event.versions);
	assert.equal(candidateEvent.selected_version, "fallback");
	assert.equal(candidateEvent.attempts, 2);
	assert.equal(candidateEvent.correction_applied, true);
	assert.equal(candidateEvent.fallback, true);
	assert.deepEqual(candidateEvent.failure_codes, ["DETAIL_BOUNDS_EXCEEDED", "MISSING_COMPONENT"]);
});

test("persists one cancelled attempted version with a safe failure summary", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-cancelled-"));
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-memory-cancelled-"));
	temporaryRoots.push(outputRoot, memoryRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-cancelled" });
	const version = await beginVersion(run, "v001", grammar);
	await recordVersionCancelled(run, version, { stage: "render", reason: "Bearer cancel-secret" });
	await selectFinal(run, { selected: "cancelled", reason: "Bearer final-secret" });
	await appendRunMemory(run, memoryRoot);
	const event = JSON.parse(await readFile(join(memoryRoot, "unified-runs.jsonl"), "utf8"));
	assert.deepEqual(event.versions.map((item: any) => item.status), ["cancelled"]);
	assert.equal(JSON.stringify(event).includes("cancel-secret"), false);
	assert.equal(JSON.stringify(event).includes("final-secret"), false);
});

test("builds terminal history from the persisted checkpoint after in-memory state is lost", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-checkpoint-reload-"));
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-memory-checkpoint-reload-"));
	temporaryRoots.push(outputRoot, memoryRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "checkpoint-reload" });
	const version = await beginVersion(run, "v001", grammar);
	await recordVersionCheckpoint(run, version, {
		enrichment: { artifact: { path: join(version.dir, "enriched.glb"), sha256: "persisted-glb-sha", metrics: { bytes: 42 } } },
	});
	version.checkpoint = {};
	await recordVersionFailure(run, version, { stage: "render", codes: ["RENDER_FAILED"], retryable: false });
	await selectFinal(run, { selected: "blocked", reason: "render failed" });
	await appendRunMemory(run, memoryRoot);
	const event = JSON.parse(await readFile(join(memoryRoot, "unified-runs.jsonl"), "utf8"));
	assert.deepEqual(event.versions[0].artifacts.glb, {
		metrics: { bytes: 42 }, path: "versions/v001/enriched.glb", sha256: "persisted-glb-sha",
	});
});

for (const scenario of [
	{ selected: "v001", failed: [], attempts: 1, correction: false, fallback: false },
	{ selected: "v002", failed: ["v001"], attempts: 2, correction: true, fallback: false },
	{ selected: "fallback", failed: ["v001", "v002"], attempts: 2, correction: true, fallback: true },
] as const) {
	test(`persists exact selected output artifacts for ${scenario.selected}`, async () => {
		const outputRoot = await mkdtemp(join(tmpdir(), `elevation3d-${scenario.selected}-output-`));
		const memoryRoot = await mkdtemp(join(tmpdir(), `elevation3d-${scenario.selected}-memory-`));
		temporaryRoots.push(outputRoot, memoryRoot);
		const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: `selected-${scenario.selected}` });
		for (const versionId of scenario.failed) {
			const version = await beginVersion(run, versionId, grammar);
			await recordVersionFailure(run, version, {
				stage: "validate",
				codes: [`${versionId.toUpperCase()}_FAILED`],
				evidence: {},
				retryable: true,
			});
		}
		const selected = await beginVersion(run, scenario.selected, grammar);
		const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];
		const glbName = scenario.selected === "fallback" ? "exact-mass.glb" : "enriched.glb";
		await recordVersionSuccess(run, selected, {
			accepted: true,
			codes: [],
			metrics: { selected_version: scenario.selected },
			artifacts: {
				glb: join(selected.dir, glbName),
				glb_sha256: `${scenario.selected}-glb-sha256`,
				provenance: {
					path: join(selected.dir, "drawing-provenance.json"),
					sha256: `${scenario.selected}-provenance-sha256`,
				},
				drawings: Object.fromEntries(drawingNames.map((name) => {
					const path = join(selected.dir, "drawings", `${name}.png`);
					return [name, scenario.selected === "v001" ? { path, sha256: `${name}-sha256`, width: 2, height: 3 } : path];
				})),
			},
		});
		await selectFinal(run, { selected: scenario.selected, reason: "accepted" });
		await appendRunMemory(run, memoryRoot);

		const event = JSON.parse(await readFile(join(memoryRoot, "runs", "creative-013.jsonl"), "utf8"));
		const globalEvent = JSON.parse(await readFile(join(memoryRoot, "unified-runs.jsonl"), "utf8"));
		assert.equal(fileURLToPath(event.artifact_base), `${resolve(run.dir)}${sep}`);
		assert.equal(globalEvent.artifact_base, event.artifact_base);
		assert.equal(event.selected_version, scenario.selected);
		assert.equal(event.attempts, scenario.attempts);
		assert.equal(event.correction_applied, scenario.correction);
		assert.equal(event.fallback, scenario.fallback);
		assert.deepEqual(event.metrics, { selected_version: scenario.selected });
		assert.deepEqual(event.failure_codes, scenario.failed.map((version) => `${version.toUpperCase()}_FAILED`));
		const selectedHistory = event.versions.find((version: any) => version.id === scenario.selected);
		assert.equal(selectedHistory.status, "passed");
		assert.equal(selectedHistory.artifacts.glb.sha256, `${scenario.selected}-glb-sha256`);
		assert.deepEqual(selectedHistory.artifacts.drawing_provenance, {
			path: `versions/${scenario.selected}/drawing-provenance.json`,
			sha256: `${scenario.selected}-provenance-sha256`,
		});
		assert.match(selectedHistory.artifacts.validation_report.sha256, /^[a-f0-9]{64}$/);
		assert.deepEqual(event.artifacts, {
			path_base: "run_dir",
			run_dir: run.dir.replaceAll("\\", "/"),
			selected_glb: `versions/${scenario.selected}/${glbName}`,
			validation_report: `versions/${scenario.selected}/validation.json`,
			drawing_provenance: {
				path: `versions/${scenario.selected}/drawing-provenance.json`,
				sha256: `${scenario.selected}-provenance-sha256`,
			},
			drawings: Object.fromEntries(drawingNames.map((name) => [name, `versions/${scenario.selected}/drawings/${name}.png`])),
		});
	});
}
