import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets } from "./core.mjs";

function portableRelativePath(path) {
	const relativePath = isAbsolute(path) ? relative(process.cwd(), path) : path;
	return relativePath.replaceAll("\\", "/");
}

function omitBinary(value) {
	if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return "[OMITTED_BINARY]";
	}
	if (Array.isArray(value)) return value.map(omitBinary);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, omitBinary(item)]));
	}
	return value;
}

function persistent(value) {
	return redactSecrets(omitBinary(value));
}

function artifactReferences(input, approvedDesign) {
	const inputArtifacts = (input.artifacts ?? []).map(({ path, sha256 }) => ({
		path: portableRelativePath(path),
		sha256,
	}));
	return [
		...inputArtifacts,
		{ path: portableRelativePath(approvedDesign.image_path), sha256: approvedDesign.image_sha256 },
	];
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(persistent(value), null, 2)}\n`);
}

export async function createUnifiedRun({ input, approvedDesign, outputRoot, runId }) {
	const candidateId = input.candidate_id ?? input.candidate?.candidate_id;
	const dir = resolve(outputRoot, candidateId, runId);
	const metadata = {
		schema_version: "arr.elevation3d.unified-run.v1",
		run_id: runId,
		candidate_id: candidateId,
		identity: input.identity,
		artifacts: artifactReferences(input, approvedDesign),
	};
	await mkdir(join(dir, "versions"), { recursive: true });
	await writeJson(join(dir, "run.json"), metadata);
	return { id: runId, dir, metadata, versions: [], final: null };
}

export async function beginVersion(run, versionId, grammar) {
	const dir = join(run.dir, "versions", versionId);
	const metadata = {
		schema_version: "arr.elevation3d.version.v1",
		version_id: versionId,
		status: "started",
		grammar_path: "grammar.json",
	};
	await mkdir(dir, { recursive: true });
	await writeJson(join(dir, "version.json"), metadata);
	await writeJson(join(dir, "grammar.json"), { ...grammar, schema_version: "arr.facade-grammar.v1" });
	const version = { id: versionId, dir, metadata, failures: [] };
	run.versions.push(version);
	return version;
}

export async function recordVersionFailure(run, version, failure) {
	if (!run.versions.includes(version)) throw new Error(`Version ${version.id} does not belong to run ${run.id}`);
	const record = persistent({
		schema_version: "arr.elevation3d.version-failure.v1",
		version_id: version.id,
		stage: failure.stage,
		codes: [...failure.codes],
		evidence: failure.evidence ?? {},
		retryable: failure.retryable,
	});
	await writeJson(join(version.dir, "failure.json"), record);
	version.metadata = { ...version.metadata, status: "failed", failure_path: "failure.json" };
	await writeJson(join(version.dir, "version.json"), version.metadata);
	version.failures.push(record);
}

export async function selectFinal(run, selection) {
	const final = persistent({
		schema_version: "arr.elevation3d.final-selection.v1",
		selected: selection.selected,
		reason: selection.reason,
	});
	await writeJson(join(run.dir, "final.json"), final);
	run.final = final;
}

export async function appendRunMemory(run, memoryRoot) {
	if (!run.final) throw new Error("A final selection is required before appending run memory");
	const event = persistent({
		schema_version: "arr.elevation3d.run-memory.v1",
		run_id: run.id,
		candidate_id: run.metadata.candidate_id,
		artifacts: run.metadata.artifacts,
		versions: run.versions.flatMap((version) => version.failures.map((failure) => ({
			id: version.id,
			stage: failure.stage,
			codes: failure.codes,
			retryable: failure.retryable,
			evidence: failure.evidence,
		}))),
		final: run.final,
	});
	await mkdir(resolve(memoryRoot), { recursive: true });
	await appendFile(join(resolve(memoryRoot), "unified-runs.jsonl"), `${JSON.stringify(event)}\n`);
}
