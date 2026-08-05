import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
	appendPresentationVersionMemory,
	appendRunMemory,
	beginVersion,
	createUnifiedRun,
	recordVersionFailure,
	recordVersionSuccess,
	recordVersionCancelled,
	recordVersionCheckpoint,
	selectFinal,
} from "../plugins/elevation-3d/lib/run-memory.mjs";
import * as runMemory from "../plugins/elevation-3d/lib/run-memory.mjs";

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

test("persists one safe idempotent facade-agent comparison event with run-relative artifacts", async () => {
	const runRoot = await mkdtemp(join(tmpdir(), "elevation3d-facade-agent-memory-"));
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-facade-agent-memory-root-"));
	temporaryRoots.push(runRoot, memoryRoot);
	const runDir = join(runRoot, "creative-020", "fixture-comparison-001");
	await mkdir(join(runDir, "providers", "gpt-image-2", "artifacts"), { recursive: true });
	await mkdir(join(runDir, "delivery", "viewer"), { recursive: true });
	const credentialPrefix = String.fromCharCode(115, 107, 45);
	const result = {
		schema_version: "arr.elevation3d.facade-agent-run.v1",
		run_id: "fixture-comparison-001",
		candidate_id: "creative-020",
		brief_id: "brick-punched-window-v1",
		run_dir: runDir,
		input_sha256: "1".repeat(64),
		status: "winner",
		image_submissions: { total: 2, by_provider: { "gpt-image-2": 1, "nano-banana-pro": 1 } },
		providers: {
			"gpt-image-2": {
				status: "accepted",
				generation: { status: "succeeded", request_sha256: "2".repeat(64), artifact_sha256: "3".repeat(64), api_key: `${credentialPrefix}memory-must-drop` },
				grammar: { status: "succeeded", path: "providers/gpt-image-2/grammar.json", artifact_sha256: "4".repeat(64), actual_usd: 0.04 },
				versions: [{ id: "v001", status: "rejected", artifact: { path: "providers/gpt-image-2/artifacts/v001.glb", sha256: "5".repeat(64) }, validation: { accepted: false, codes: ["DETAIL_BOUNDS_EXCEEDED"], retryable: true, metrics: { maximum_bounds_excess_m: 0.2 } } }, { id: "v002", status: "accepted", artifact: { path: join(runDir, "providers", "gpt-image-2", "artifacts", "v002.glb"), sha256: "6".repeat(64) }, validation: { accepted: true, codes: [], retryable: false, metrics: { canonical_surface_match: 1, minimum_reveal_depth_m: 0.15, detail_primitive_count: 120 } } }],
				score: { status: "scored", score: 97.4, components: { implementability: 100, multiview: 100, grammar: 97, visual: 86 }, sha256: "7".repeat(64) },
			},
			"nano-banana-pro": {
				status: "accepted",
				generation: { status: "succeeded", request_sha256: "8".repeat(64), artifact_sha256: "9".repeat(64), signedUrl: "https://fixture.invalid/private" },
				grammar: { status: "succeeded", path: "providers/nano-banana-pro/grammar.json", artifact_sha256: "a".repeat(64), actual_usd: 0.04 },
				versions: [{ id: "v001", status: "accepted", artifact: { path: "providers/nano-banana-pro/artifacts/v001.glb", sha256: "b".repeat(64) }, validation: { accepted: true, codes: [], retryable: false, metrics: { canonical_surface_match: 1, minimum_reveal_depth_m: 0.2, detail_primitive_count: 110 } } }],
				score: { status: "scored", score: 94.8, components: { implementability: 100, multiview: 100, grammar: 90, visual: 83 }, sha256: "c".repeat(64) },
			},
		},
		selected_delivery: {
			manifest: { path: join(runDir, "delivery", "all-views-manifest.json"), sha256: "d".repeat(64) },
			validation: { path: join(runDir, "delivery", "all-views-validation.json"), sha256: "e".repeat(64) },
			viewer: { path: join(runDir, "delivery", "viewer", "index.html"), config_sha256: "f".repeat(64) },
			browser_verification: { path: join(runDir, "delivery", "browser-verification", "browser-verification.json"), sha256: "0".repeat(64) },
		},
		final: { status: "winner", selected_provider: "gpt-image-2", selected_version: "v002", selected_glb_sha256: "6".repeat(64), score_sha256: "7".repeat(64) },
	};

	assert.equal(typeof (runMemory as any).appendFacadeAgentMemory, "function", "facade-agent memory writer must exist");
	await Promise.all([
		(runMemory as any).appendFacadeAgentMemory(result, memoryRoot),
		(runMemory as any).appendFacadeAgentMemory(result, memoryRoot),
	]);
	const lines = (await readFile(join(memoryRoot, "facade-agent-runs.jsonl"), "utf8")).trim().split(/\r?\n/);
	assert.equal(lines.length, 1);
	const event = JSON.parse(lines[0]);
	assert.equal(event.schema_version, "arr.elevation3d.facade-agent-memory.v1");
	assert.equal(event.candidate_id, "creative-020");
	assert.equal(event.brief_id, "brick-punched-window-v1");
	assert.equal(event.image_submissions["gpt-image-2"], 1);
	assert.equal(event.image_submissions["nano-banana-pro"], 1);
	assert.equal(event.geometry_authority, "canonical-local-mass");
	assert.equal(event.retry_policy, "two-local-attempts-no-image-resubmit");
	assert.equal(event.providers["gpt-image-2"].attempts.length, 2);
	assert.equal(event.providers["gpt-image-2"].attempts[1].artifact.path, "providers/gpt-image-2/artifacts/v002.glb");
	assert.equal(event.delivery.viewer.path, "delivery/viewer/index.html");
	assert.equal(JSON.stringify(event).includes(credentialPrefix), false);
	assert.equal(JSON.stringify(event).includes("signedUrl"), false);
	assert.equal(JSON.stringify(event).includes(runRoot.replaceAll("\\", "/")), false);
});

test("normalizes a redacted presentation-only version memory record", async () => {
	const runRoot = await mkdtemp(join(tmpdir(), "elevation3d-presentation-memory-"));
	temporaryRoots.push(runRoot);
	const outputDir = join(runRoot, "rendered-pbr-v7-competition-daylight");
	await mkdir(outputDir, { recursive: true });
	const memoryFile = join(runRoot, "presentation-versions.jsonl");
	await appendPresentationVersionMemory({
		candidateId: "creative-013",
		outputDir,
		previousBaseline: {
			version: "rendered-pbr-v6",
			limitation: "Washed highlights at https://x.test/view?X-Amz-Signature=signed-secret",
		},
		report: {
			render_style: { id: "competition-daylight-v1", authorization: "Bearer style-secret" },
			render_style_sha256: "a".repeat(64),
			validation: { accepted: false, status: "rejected", codes: ["PRESENTATION_HIGHLIGHTS_CLIPPED"], metrics: { clipped: 2 } },
			provider_calls: 0,
			credits_consumed: 0,
			artifacts: {
				contact_sheet: { path: join(outputDir, "contact-sheet.png"), sha256: "b".repeat(64) },
				presentation_evidence: { path: "https://x.test/evidence?token=url-secret", sha256: "c".repeat(64) },
			},
		},
	}, memoryFile);

	const record = JSON.parse(await readFile(memoryFile, "utf8"));
	assert.equal(record.schema_version, "arr.elevation3d.presentation-version-memory.v1");
	assert.deepEqual(record.style, { id: "competition-daylight-v1", sha256: "a".repeat(64) });
	assert.equal(record.previous_baseline.version, "rendered-pbr-v6");
	assert.equal(record.previous_baseline.limitation.includes("signed-secret"), false);
	assert.deepEqual(record.result, {
		accepted: false, status: "rejected", failure_codes: ["PRESENTATION_HIGHLIGHTS_CLIPPED"], metrics: { clipped: 2 },
	});
	assert.deepEqual(record.artifacts.contact_sheet, { path: "contact-sheet.png", sha256: "b".repeat(64) });
	assert.equal(record.artifacts.presentation_evidence.path, "https://x.test/evidence");
	assert.equal(record.provider_calls, 0);
	assert.equal(record.credits_consumed, 0);
	assert.equal(JSON.stringify(record).includes("style-secret"), false);
	assert.equal(JSON.stringify(record).includes("url-secret"), false);
});

test("rejects missing or nonzero provider provenance instead of normalizing it to zero", async () => {
	const runRoot = await mkdtemp(join(tmpdir(), "elevation3d-presentation-provider-zero-"));
	temporaryRoots.push(runRoot);
	const outputDir = join(runRoot, "rendered-pbr-v7-competition-daylight");
	await mkdir(outputDir, { recursive: true });
	for (const counters of [
		{ credits_consumed: 0 },
		{ provider_calls: 0 },
		{ provider_calls: 1, credits_consumed: 0 },
		{ provider_calls: 0, credits_consumed: 0.1 },
	]) {
		await assert.rejects(() => appendPresentationVersionMemory({
			candidateId: "creative-013", outputDir, previousBaseline: {},
			report: { validation: { accepted: false, codes: [] }, ...counters },
		}, join(runRoot, `memory-${JSON.stringify(counters).replace(/\W/g, "-")}.jsonl`)), /provider_calls.*zero|credits_consumed.*zero/i);
	}
});

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
