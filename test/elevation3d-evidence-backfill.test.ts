import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const execute = promisify(execFile);
const roots: string[] = [];
const script = resolve("scripts/backfill-elevation3d-evidence-base.mjs");

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("backfill binds one global and candidate event to verified evidence byte-idempotently", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-evidence-backfill-"));
	roots.push(root);
	const memoryRoot = join(root, "memory", "elevation-3d");
	const runDir = join(root, "stable evidence", "creative-013", "retained-run");
	const provenancePath = join(runDir, "versions", "v001", "drawing-provenance.json");
	await mkdir(join(memoryRoot, "runs"), { recursive: true });
	await mkdir(join(runDir, "versions", "v001"), { recursive: true });
	const provenanceBytes = Buffer.from('{"schema_version":"arr.drawing-provenance.v1"}\n');
	await writeFile(provenancePath, provenanceBytes);
	const provenanceSha = createHash("sha256").update(provenanceBytes).digest("hex");
	const version = {
		id: "v001", status: "passed",
		artifacts: { glb: null, drawings: {}, provenance: null, validation_report: null },
		validation: { accepted: true, codes: [], metrics: {} }, failure: null,
		correction: { applied: false, summary: "none", grammar_delta: {} },
	};
	const globalEvent = {
		schema_version: "arr.elevation3d.run-memory.v2", run_id: "retained-run", candidate_id: "creative-013",
		input_artifacts: [], versions: [version], final: { selected: "v001", reason: "accepted" },
	};
	const candidateEvent = {
		schema_version: "arr.elevation3d.candidate-run-memory.v2", run_id: "retained-run", candidate_id: "creative-013",
		selected_version: "v001", versions: [version], artifacts: { path_base: "run_dir", run_dir: "stale" },
		final: globalEvent.final,
	};
	const globalPath = join(memoryRoot, "unified-runs.jsonl");
	const candidatePath = join(memoryRoot, "runs", "creative-013.jsonl");
	await writeFile(globalPath, `${JSON.stringify(globalEvent)}\n`);
	await writeFile(candidatePath, `${JSON.stringify(candidateEvent)}\n`);
	const env = {
		...process.env,
		ELEVATION3D_MEMORY_ROOT: memoryRoot,
		ELEVATION3D_EVIDENCE_RUN_DIR: runDir,
		ELEVATION3D_EVIDENCE_RUN_ID: "retained-run",
		ELEVATION3D_EVIDENCE_CANDIDATE_ID: "creative-013",
	};

	await execute(process.execPath, [script], { env });
	const first = await Promise.all([readFile(globalPath), readFile(candidatePath)]);
	await execute(process.execPath, [script], { env });
	assert.deepEqual(await Promise.all([readFile(globalPath), readFile(candidatePath)]), first);

	const [global, candidate] = first.map((bytes) => JSON.parse(bytes.toString("utf8")));
	assert.equal(fileURLToPath(global.artifact_base), `${resolve(runDir)}${sep}`);
	assert.equal(candidate.artifact_base, global.artifact_base);
	assert.equal(candidate.artifacts.run_dir, resolve(runDir).replaceAll("\\", "/"));
	for (const event of [global, candidate]) {
		assert.deepEqual(event.versions[0].artifacts.drawing_provenance, {
			path: "versions/v001/drawing-provenance.json", sha256: provenanceSha,
		});
	}
	assert.deepEqual(candidate.artifacts.drawing_provenance, {
		path: "versions/v001/drawing-provenance.json", sha256: provenanceSha,
	});
});
