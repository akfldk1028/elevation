import { createHash } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeSegment(value, label) {
	if (typeof value !== "string" || !SAFE_PATH_SEGMENT.test(value) || value.includes("..")) {
		throw new Error(`${label} must be a safe path segment`);
	}
	return value;
}

function descendant(root, target, label) {
	const relativePath = relative(resolve(root), resolve(target));
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} must remain below ${resolve(root)}`);
	}
	return resolve(target);
}

function parseJsonl(bytes, label) {
	return bytes.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
		try { return JSON.parse(line); }
		catch (error) { throw new Error(`${label}:${index + 1}: ${error.message}`); }
	});
}

function serializeJsonl(rows) {
	return Buffer.from(`${rows.map(JSON.stringify).join("\n")}\n`);
}

async function fileArtifact(runDir, relativePath, required) {
	const path = descendant(runDir, join(runDir, ...relativePath.split("/")), "evidence artifact");
	let bytes;
	try { bytes = await readFile(path); }
	catch (error) {
		if (!required && error.code === "ENOENT") return null;
		throw error;
	}
	return { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function prepareEvent(event, runDir) {
	const selected = event.selected_version ?? event.final?.selected;
	const versions = [];
	let selectedProvenance = null;
	for (const version of event.versions ?? []) {
		const versionId = safeSegment(version.id, "version_id");
		const path = `versions/${versionId}/drawing-provenance.json`;
		const provenance = await fileArtifact(runDir, path, versionId === selected);
		if (versionId === selected) selectedProvenance = provenance;
		versions.push({
			...version,
			artifacts: {
				...(version.artifacts ?? {}),
				...(provenance ? { drawing_provenance: provenance } : {}),
			},
		});
	}
	if (selected && !["blocked", "cancelled"].includes(selected) && !selectedProvenance) {
		throw new Error(`Selected version ${selected} has no drawing provenance`);
	}
	return {
		...event,
		artifact_base: pathToFileURL(`${runDir}${sep}`).href,
		versions,
		...(event.artifacts ? {
			artifacts: {
				...event.artifacts,
				path_base: "run_dir",
				run_dir: runDir.replaceAll("\\", "/"),
				drawing_provenance: selectedProvenance,
			},
		} : {}),
	};
}

async function prepareWrite(path, bytes) {
	const current = await readFile(path);
	if (current.equals(bytes)) return null;
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	const handle = await open(temp, "wx");
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	return { path, temp };
}

const memoryRoot = resolve(process.env.ELEVATION3D_MEMORY_ROOT ?? "memory/elevation-3d");
const runDir = resolve(process.env.ELEVATION3D_EVIDENCE_RUN_DIR ?? "");
const runId = safeSegment(process.env.ELEVATION3D_EVIDENCE_RUN_ID, "run_id");
const candidateId = safeSegment(process.env.ELEVATION3D_EVIDENCE_CANDIDATE_ID, "candidate_id");
if (!(await stat(runDir)).isDirectory()) throw new Error(`Evidence run directory is not a directory: ${runDir}`);

const globalPath = descendant(memoryRoot, join(memoryRoot, "unified-runs.jsonl"), "global memory path");
const candidatePath = descendant(memoryRoot, join(memoryRoot, "runs", `${candidateId}.jsonl`), "candidate memory path");
const sources = await Promise.all([readFile(globalPath), readFile(candidatePath)]);
const rowSets = [parseJsonl(sources[0], globalPath), parseJsonl(sources[1], candidatePath)];
for (const [index, rows] of rowSets.entries()) {
	const matches = rows.filter((event) => event.run_id === runId);
	if (matches.length !== 1) throw new Error(`${index === 0 ? "global" : "candidate"} memory must contain exactly one ${runId} event`);
	if (matches[0].candidate_id !== candidateId) throw new Error(`run ${runId} has conflicting candidate identity`);
	if (!matches[0].schema_version?.endsWith(".v2")) throw new Error(`run ${runId} must use a v2 memory schema`);
}

const outputs = [];
for (const rows of rowSets) {
	const updated = [];
	for (const event of rows) updated.push(event.run_id === runId ? await prepareEvent(event, runDir) : event);
	outputs.push(serializeJsonl(updated));
}

const prepared = [];
try {
	for (const [index, path] of [globalPath, candidatePath].entries()) {
		const item = await prepareWrite(path, outputs[index]);
		if (item) prepared.push(item);
	}
	for (const { path, temp } of prepared) await rename(temp, path);
} finally {
	await Promise.all(prepared.map(({ temp }) => rm(temp, { force: true })));
}
