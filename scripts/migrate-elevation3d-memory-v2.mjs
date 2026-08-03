import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const memoryRoot = resolve(process.env.ELEVATION3D_MEMORY_ROOT ?? "memory/elevation-3d");
const globalPath = join(memoryRoot, "unified-runs.jsonl");
const runsRoot = join(memoryRoot, "runs");
const failAfter = Number.parseInt(process.env.ELEVATION3D_MIGRATION_FAIL_AFTER_REPLACEMENTS ?? "", 10);

async function parseLines(path, optional = false) {
	try {
		const text = await readFile(path, "utf8");
		return text.trim() ? text.trim().split(/\r?\n/).map(JSON.parse) : [];
	} catch (error) {
		if (optional && error.code === "ENOENT") return [];
		throw error;
	}
}

async function hash(path) {
	try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
	catch { return null; }
}

async function selectedArtifacts(event) {
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
		provenance: null,
		validation_report: artifact.validation_report ? {
			path: artifact.validation_report,
			sha256: await hash(resolvePath(artifact.validation_report)),
		} : null,
	};
}

function correction(id, index) {
	return { applied: id === "v002", summary: id === "v002" ? "bounded facade grammar correction attempted" : "none", grammar_delta: index === 0 ? {} : {} };
}

async function legacyHistory(globalEvent, candidateEvent) {
	const failed = (globalEvent?.versions ?? []).map((entry, index) => ({
		id: entry.id,
		status: "failed",
		artifacts: { glb: null, drawings: {}, provenance: null, validation_report: null },
		validation: entry.stage === "validate" ? { accepted: false, codes: entry.codes ?? [], metrics: entry.evidence?.metrics ?? {} } : null,
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
			artifacts: await selectedArtifacts(candidateEvent),
			validation: { accepted: true, codes: [], metrics: candidateEvent.metrics ?? {} },
			failure: null,
			correction: correction(candidateEvent.selected_version, failed.length),
		});
	}
	return failed;
}

function isV2(event) {
	return typeof event?.schema_version === "string" && event.schema_version.endsWith(".v2");
}

function historyScore(versions) {
	return JSON.stringify(versions ?? []).replaceAll("null", "").length;
}

async function canonicalHistory(globalEvent, candidateEvent) {
	const globalV2 = isV2(globalEvent);
	const candidateV2 = isV2(candidateEvent);
	if (globalV2 && candidateV2) {
		return historyScore(candidateEvent.versions) > historyScore(globalEvent.versions)
			? candidateEvent.versions : globalEvent.versions;
	}
	if (globalV2) return globalEvent.versions ?? [];
	if (candidateV2) return candidateEvent.versions ?? [];
	return legacyHistory(globalEvent, candidateEvent);
}

function asGlobal(event, candidateEvent, versions) {
	const source = event ?? {
		run_id: candidateEvent.run_id, candidate_id: candidateEvent.candidate_id,
		artifacts: [], final: candidateEvent.final,
	};
	const migrated = { ...source, schema_version: "arr.elevation3d.run-memory.v2", versions };
	if (!("input_artifacts" in migrated)) migrated.input_artifacts = migrated.artifacts ?? [];
	delete migrated.artifacts;
	return migrated;
}

function asCandidate(event, globalEvent, versions) {
	const source = event ?? {
		run_id: globalEvent.run_id, candidate_id: globalEvent.candidate_id,
		selected_version: globalEvent.final?.selected,
		attempts: versions.filter((version) => version.id !== "fallback").length,
		metrics: versions.find((version) => version.id === globalEvent.final?.selected)?.validation?.metrics ?? {},
		failure_codes: [...new Set(versions.flatMap((version) => version.failure?.codes ?? []))],
		correction_applied: versions.some((version) => version.id === "v002"),
		correction: versions.some((version) => version.id === "v002") ? "bounded facade grammar correction attempted" : "none",
		fallback: globalEvent.final?.selected === "fallback", artifacts: {}, final: globalEvent.final,
	};
	return { ...source, schema_version: "arr.elevation3d.candidate-run-memory.v2", versions };
}

await mkdir(runsRoot, { recursive: true });
const candidateFiles = (await readdir(runsRoot, { withFileTypes: true }))
	.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
	.map((entry) => join(runsRoot, entry.name))
	.sort();
const globals = await parseLines(globalPath, true);
const candidatesByFile = new Map(await Promise.all(candidateFiles.map(async (path) => [path, await parseLines(path)])));
const globalByRun = new Map(globals.map((event) => [event.run_id, event]));
const candidateByRun = new Map([...candidatesByFile].flatMap(([path, events]) => events.map((event) => [event.run_id, { path, event }])));
const runIds = [...new Set([...globalByRun.keys(), ...candidateByRun.keys()])];
const migratedGlobalByRun = new Map();
const migratedCandidateByRun = new Map();

for (const runId of runIds) {
	const globalEvent = globalByRun.get(runId);
	const candidateRecord = candidateByRun.get(runId);
	const candidateEvent = candidateRecord?.event;
	const versions = await canonicalHistory(globalEvent, candidateEvent);
	const migratedGlobal = asGlobal(globalEvent, candidateEvent, versions);
	const candidatePath = candidateRecord?.path ?? join(runsRoot, `${migratedGlobal.candidate_id}.jsonl`);
	migratedGlobalByRun.set(runId, migratedGlobal);
	migratedCandidateByRun.set(runId, { path: candidatePath, event: asCandidate(candidateEvent, migratedGlobal, versions) });
}

const targetValues = new Map();
targetValues.set(globalPath, runIds.map((runId) => migratedGlobalByRun.get(runId)));
for (const path of new Set([...migratedCandidateByRun.values()].map((record) => record.path))) {
	const existingOrder = candidatesByFile.get(path)?.map((event) => event.run_id) ?? [];
	const added = runIds.filter((runId) => migratedCandidateByRun.get(runId).path === path && !existingOrder.includes(runId));
	targetValues.set(path, [...existingOrder, ...added].map((runId) => migratedCandidateByRun.get(runId).event));
}

const prepared = [];
try {
	for (const [target, values] of targetValues) {
		const bytes = `${values.map(JSON.stringify).join("\n")}\n`;
		for (const line of bytes.trim().split(/\r?\n/)) JSON.parse(line);
		try { if (await readFile(target, "utf8") === bytes) continue; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
		const handle = await open(temp, "wx");
		try { await handle.writeFile(bytes); await handle.sync(); }
		finally { await handle.close(); }
		prepared.push({ target, temp });
	}

	let replacements = 0;
	for (const { target, temp } of prepared) {
		try { await copyFile(target, `${target}.bak-v1`, constants.COPYFILE_EXCL); }
		catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error; }
		await rename(temp, target);
		replacements++;
		if (Number.isFinite(failAfter) && replacements === failAfter) throw new Error(`Injected migration failure after ${replacements} replacements`);
	}
} finally {
	await Promise.all(prepared.map(({ temp }) => rm(temp, { force: true })));
}
