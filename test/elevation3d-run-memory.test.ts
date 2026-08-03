import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
	appendRunMemory,
	beginVersion,
	createUnifiedRun,
	recordVersionFailure,
	recordVersionSuccess,
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

test("transitions an accepted version from started to passed", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-success-"));
	temporaryRoots.push(outputRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-passed" });
	const version = await beginVersion(run, "v001", grammar);

	await recordVersionSuccess(run, version);

	const persisted = JSON.parse(await readFile(join(version.dir, "version.json"), "utf8"));
	assert.equal(persisted.status, "passed");
	assert.equal(version.metadata.status, "passed");
});

test("records each version failure and appends one redacted final memory event", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "elevation3d-run-failures-"));
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation3d-durable-memory-"));
	temporaryRoots.push(outputRoot, memoryRoot);
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: "run-2" });
	const v1 = await beginVersion(run, "v001", grammar);
	const v2 = await beginVersion(run, "v002", grammar);

	await recordVersionFailure(run, v1, {
		stage: "validate",
		codes: ["DETAIL_BOUNDS_EXCEEDED"],
		evidence: {
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
		response: {
			authorization: "[REDACTED]",
			credentials: { password: "[REDACTED]", cookie: "[REDACTED]" },
		},
		session: "[REDACTED]",
	});

	const final = JSON.parse(await readFile(join(run.dir, "final.json"), "utf8"));
	assert.equal(final.schema_version, "arr.elevation3d.final-selection.v1");
	assert.equal(final.selected, "fallback");

	const memoryFile = join(memoryRoot, "unified-runs.jsonl");
	const lines = (await readFile(memoryFile, "utf8")).trim().split("\n");
	assert.equal(lines.length, 1);
	const event = JSON.parse(lines[0]);
	assert.equal(event.schema_version, "arr.elevation3d.run-memory.v1");
	assert.deepEqual(event.versions.map((version: { id: string }) => version.id), ["v001", "v002"]);
	assert.deepEqual(event.versions.map((version: { codes: string[] }) => version.codes), [
		["DETAIL_BOUNDS_EXCEEDED"],
		["MISSING_COMPONENT"],
	]);
	assert.equal(JSON.stringify(event).includes("secret"), false);
	for (const credential of ["password-value", "cookie-value", "session-value"]) {
		assert.equal(JSON.stringify(event).includes(credential), false);
	}
});
