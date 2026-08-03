import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const execute = promisify(execFile);
const roots: string[] = [];
const script = resolve("scripts/migrate-elevation3d-memory-v2.mjs");

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const final = { schema_version: "arr.elevation3d.final-selection.v1", selected: "v001", reason: "accepted" };

function legacyGlobal(candidate: string) {
	return {
		schema_version: "arr.elevation3d.run-memory.v1",
		run_id: `${candidate}-run`, candidate_id: candidate, artifacts: [], versions: [], final,
	};
}

function legacyCandidate(candidate: string, runDir: string) {
	return {
		schema_version: "arr.elevation3d.candidate-run-memory.v1",
		run_id: `${candidate}-run`, candidate_id: candidate, selected_version: "v001",
		attempts: 1, metrics: { candidate }, failure_codes: [], correction_applied: false,
		correction: "none", fallback: false,
		artifacts: {
			path_base: "run_dir", run_dir: runDir, selected_glb: "versions/v001/enriched.glb",
			validation_report: "versions/v001/validation.json", drawings: {},
		},
		final,
	};
}

async function jsonl(path: string, values: unknown[]) {
	await writeFile(path, `${values.map(JSON.stringify).join("\n")}\n`);
}

async function snapshotFiles(root: string) {
	const snapshot = new Map<string, Buffer>();
	async function walk(directory: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else snapshot.set(relative(root, path), await readFile(path));
		}
	}
	await walk(root);
	return snapshot;
}

async function assertRejectedWithoutWrites(root: string, memoryRoot: string) {
	const before = await snapshotFiles(root);
	await assert.rejects(() => execute(process.execPath, [script], {
		env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot },
	}));
	assert.deepEqual(await snapshotFiles(root), before);
}

test("migration discovers candidates, repairs an interrupted mixed-state run, and reruns byte-identically", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-migration-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	const runsRoot = join(memoryRoot, "runs");
	await mkdir(runsRoot, { recursive: true });
	const candidates = ["alpha", "beta"];
	const globals = candidates.map(legacyGlobal);
	for (const candidate of candidates) {
		const runDir = join(root, "results", candidate, `${candidate}-run`);
		await mkdir(join(runDir, "versions", "v001"), { recursive: true });
		await writeFile(join(runDir, "versions", "v001", "enriched.glb"), Buffer.from(`${candidate}-glb`));
		await writeFile(join(runDir, "versions", "v001", "validation.json"), JSON.stringify({ accepted: true }));
		await jsonl(join(runsRoot, `${candidate}.jsonl`), [legacyCandidate(candidate, runDir)]);
	}
	// One side is already v2: rerun must still reconcile its v1 candidate counterpart.
	globals[0] = {
		...globals[0], schema_version: "arr.elevation3d.run-memory.v2", input_artifacts: [],
		versions: [{ id: "v001", status: "passed", artifacts: { glb: null, drawings: {}, provenance: null, validation_report: null }, validation: { accepted: true, codes: [], metrics: { candidate: "alpha" } }, failure: null, correction: { applied: false, summary: "none", grammar_delta: {} } }],
	};
	delete (globals[0] as any).artifacts;
	await jsonl(join(memoryRoot, "unified-runs.jsonl"), globals);

	await assert.rejects(() => execute(process.execPath, [script], {
		env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot, ELEVATION3D_MIGRATION_FAIL_AFTER_REPLACEMENTS: "1" },
	}));
	const backup = JSON.parse((await readFile(`${join(memoryRoot, "unified-runs.jsonl")}.bak-v1`, "utf8")).trim().split(/\r?\n/)[0]);
	assert.equal(backup.schema_version, "arr.elevation3d.run-memory.v2");
	await execute(process.execPath, [script], { env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot } });

	const paths = [join(memoryRoot, "unified-runs.jsonl"), ...candidates.map((candidate) => join(runsRoot, `${candidate}.jsonl`))];
	const parsed = await Promise.all(paths.map(async (path) => (await readFile(path, "utf8")).trim().split(/\r?\n/).map(JSON.parse)));
	assert.deepEqual(parsed[0].map((event) => event.candidate_id).sort(), candidates);
	assert.equal(parsed.flat().every((event) => event.schema_version.endsWith(".v2")), true);
	for (const candidate of candidates) {
		const globalEvent = parsed[0].find((event) => event.candidate_id === candidate);
		const candidateEvent = parsed[candidates.indexOf(candidate) + 1][0];
		assert.deepEqual(candidateEvent.versions, globalEvent.versions);
	}

	const once = await Promise.all(paths.map((path) => readFile(path)));
	await execute(process.execPath, [script], { env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot } });
	const twice = await Promise.all(paths.map((path) => readFile(path)));
	assert.deepEqual(twice, once);
});

test("migration rejects a traversal candidate before touching an outside sentinel", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-traversal-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	await mkdir(join(memoryRoot, "runs"), { recursive: true });
	const outside = join(root, "outside-sentinel.jsonl");
	const sentinel = Buffer.from("outside must remain unchanged\n");
	await writeFile(outside, sentinel);
	await jsonl(join(memoryRoot, "unified-runs.jsonl"), [{
		...legacyGlobal("../../../outside-sentinel"), run_id: "unsafe-global-only",
	}]);
	await assert.rejects(() => execute(process.execPath, [script], {
		env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot },
	}));
	assert.deepEqual(await readFile(outside), sentinel);
	await assert.rejects(() => readFile(`${outside}.bak-v1`), /ENOENT/);
});

test("migration rejects unsafe or mismatched discovered candidate file associations", async () => {
	for (const scenario of [
		{ filename: ".unsafe.jsonl", eventCandidate: "alpha", runId: "alpha-run" },
		{ filename: "beta.jsonl", eventCandidate: "alpha", runId: "alpha-run" },
		{ filename: "beta.jsonl", eventCandidate: "beta", runId: "alpha-run" },
	]) {
		const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-stem-"));
		roots.push(root);
		const memoryRoot = join(root, "memory", "elevation-3d");
		const runsRoot = join(memoryRoot, "runs");
		await mkdir(runsRoot, { recursive: true });
		await jsonl(join(memoryRoot, "unified-runs.jsonl"), [legacyGlobal("alpha")]);
		const candidatePath = join(runsRoot, scenario.filename);
		await jsonl(candidatePath, [{
			...legacyCandidate(scenario.eventCandidate, join(root, "results")), run_id: scenario.runId,
		}]);
		const before = await readFile(candidatePath);
		await assert.rejects(() => execute(process.execPath, [script], {
			env: { ...process.env, ELEVATION3D_MEMORY_ROOT: memoryRoot },
		}));
		assert.deepEqual(await readFile(candidatePath), before);
	}
});

test("migration rejects duplicate global run IDs without writing any file", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-duplicate-global-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	await mkdir(join(memoryRoot, "runs"), { recursive: true });
	await writeFile(join(root, "outside-sentinel"), "must remain unchanged\n");
	await jsonl(join(memoryRoot, "unified-runs.jsonl"), [legacyGlobal("alpha"), legacyGlobal("alpha")]);

	await assertRejectedWithoutWrites(root, memoryRoot);
});

test("migration rejects a run ID found in two candidate files without writing any file", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-duplicate-candidates-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	const runsRoot = join(memoryRoot, "runs");
	await mkdir(runsRoot, { recursive: true });
	await writeFile(join(root, "outside-sentinel"), "must remain unchanged\n");
	await jsonl(join(runsRoot, "alpha.jsonl"), [legacyCandidate("alpha", join(root, "alpha-results"))]);
	await jsonl(join(runsRoot, "beta.jsonl"), [{
		...legacyCandidate("beta", join(root, "beta-results")), run_id: "alpha-run",
	}]);

	await assertRejectedWithoutWrites(root, memoryRoot);
});

test("migration rejects a duplicate run ID within one candidate file without writing any file", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-memory-duplicate-candidate-row-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	const runsRoot = join(memoryRoot, "runs");
	await mkdir(runsRoot, { recursive: true });
	await writeFile(join(root, "outside-sentinel"), "must remain unchanged\n");
	const duplicate = legacyCandidate("alpha", join(root, "alpha-results"));
	await jsonl(join(runsRoot, "alpha.jsonl"), [duplicate, duplicate]);

	await assertRejectedWithoutWrites(root, memoryRoot);
});
