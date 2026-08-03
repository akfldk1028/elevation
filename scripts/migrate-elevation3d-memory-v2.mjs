import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const globalPath = "memory/elevation-3d/unified-runs.jsonl";
const candidatePath = "memory/elevation-3d/runs/creative-013.jsonl";
const parseLines = async (path) => (await readFile(path, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const globals = await parseLines(globalPath);
const candidates = await parseLines(candidatePath);
const candidatesByRun = new Map(candidates.map((event) => [event.run_id, event]));

async function hash(path) {
	try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
	catch { return null; }
}

async function selectedArtifacts(event, versionId) {
	const base = event.artifacts?.run_dir;
	const artifact = event.artifacts ?? {};
	const resolvePath = (path) => !path ? null : isAbsolute(path) ? path : join(base, path);
	const glbPath = resolvePath(artifact.selected_glb);
	const drawings = Object.fromEntries(await Promise.all(Object.entries(artifact.drawings ?? {}).map(async ([name, path]) => [
		name, { path, sha256: await hash(resolvePath(path)) },
	])));
	return {
		glb: glbPath ? { path: artifact.selected_glb, sha256: await hash(glbPath) } : null,
		drawings,
		validation_report: artifact.validation_report ? {
			path: artifact.validation_report,
			sha256: await hash(resolvePath(artifact.validation_report)),
		} : null,
	};
}

function correction(id, index) {
	return {
		applied: id === "v002",
		summary: id === "v002" ? "bounded facade grammar correction attempted" : "none",
		grammar_delta: index === 0 ? {} : {},
	};
}

for (const globalEvent of globals) {
	if (globalEvent.schema_version.endsWith(".v2")) continue;
	const candidateEvent = candidatesByRun.get(globalEvent.run_id);
	const failed = (globalEvent.versions ?? []).map((entry, index) => ({
		id: entry.id,
		status: "failed",
		artifacts: { glb: null, drawings: {}, validation_report: null },
		validation: entry.stage === "validate" ? {
			accepted: false, codes: entry.codes ?? [], metrics: entry.evidence?.metrics ?? {},
		} : null,
		failure: {
			reason: `${entry.stage}: ${(entry.codes ?? []).join(", ")}`,
			error_class: entry.stage === "validate" ? "ValidationRejection" : null,
			error_code: entry.codes?.[0] ?? null,
			stage: entry.stage, codes: entry.codes ?? [], retryable: entry.retryable ?? false,
		},
		correction: correction(entry.id, index),
	}));
	if (candidateEvent?.selected_version && !["blocked", "cancelled"].includes(candidateEvent.selected_version)) {
		failed.push({
			id: candidateEvent.selected_version,
			status: "passed",
			artifacts: await selectedArtifacts(candidateEvent, candidateEvent.selected_version),
			validation: { accepted: true, codes: [], metrics: candidateEvent.metrics ?? {} },
			failure: null,
			correction: correction(candidateEvent.selected_version, failed.length),
		});
	}
	globalEvent.schema_version = "arr.elevation3d.run-memory.v2";
	globalEvent.input_artifacts = globalEvent.artifacts;
	delete globalEvent.artifacts;
	globalEvent.versions = failed;
	if (candidateEvent) {
		candidateEvent.schema_version = "arr.elevation3d.candidate-run-memory.v2";
		candidateEvent.versions = failed;
	}
}

await writeFile(globalPath, `${globals.map(JSON.stringify).join("\n")}\n`);
await writeFile(candidatePath, `${candidates.map(JSON.stringify).join("\n")}\n`);
