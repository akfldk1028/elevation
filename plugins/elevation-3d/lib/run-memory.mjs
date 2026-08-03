import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets, sha256 } from "./core.mjs";

const memoryAppendQueues = new Map();
const DRAWING_NAMES = ["plan", "front", "back", "left", "right", "top", "axon"];
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafePathSegment(value, label) {
	if (typeof value !== "string" || !SAFE_PATH_SEGMENT.test(value) || value.includes("..")) {
		throw new Error(`${label} must be a safe path segment`);
	}
	return value;
}

function resolveDescendant(root, ...segments) {
	const base = resolve(root);
	const target = resolve(base, ...segments);
	const relativePath = relative(base, target);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error(`Resolved path must remain below ${base}`);
	}
	return target;
}

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

function redactAdditionalCredentials(value) {
	if (Array.isArray(value)) return value.map(redactAdditionalCredentials);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [
		key,
		/(password|passwd|cookie|session(?:[_-]?id)?)/i.test(key)
			? "[REDACTED]"
			: redactAdditionalCredentials(item),
	]));
}

function persistent(value) {
	return redactSecrets(redactAdditionalCredentials(omitBinary(value)));
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

async function writeJson(path, value, options) {
	await writeFile(path, `${JSON.stringify(persistent(value), null, 2)}\n`, options);
}

export async function createUnifiedRun({ input, approvedDesign, outputRoot, runId }) {
	const candidateId = assertSafePathSegment(input.candidate_id ?? input.candidate?.candidate_id, "candidate_id");
	assertSafePathSegment(runId, "run_id");
	const dir = resolveDescendant(outputRoot, candidateId, runId);
	const metadata = {
		schema_version: "arr.elevation3d.unified-run.v1",
		run_id: runId,
		candidate_id: candidateId,
		identity: input.identity,
		artifacts: artifactReferences(input, approvedDesign),
	};
	await mkdir(dir, { recursive: true });
	await writeJson(join(dir, "run.json"), metadata, { flag: "wx" });
	await mkdir(join(dir, "versions"), { recursive: true });
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
	const previousGrammar = run.versions.at(-1)?.grammar ?? {};
	const grammarDelta = Object.fromEntries([...new Set([...Object.keys(previousGrammar), ...Object.keys(grammar)])]
		.filter((key) => previousGrammar[key] !== grammar[key])
		.map((key) => [key, { from: previousGrammar[key] ?? null, to: grammar[key] ?? null }]));
	const version = { id: versionId, dir, metadata, failures: [], grammar: persistent(grammar), grammar_delta: grammarDelta };
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
		reason: failure.reason ?? failure.evidence?.message ?? failure.codes?.join(", ") ?? "version failed",
		error_class: failure.error_class ?? null,
		error_code: failure.error_code ?? null,
		evidence: Object.fromEntries(Object.entries(failure.evidence ?? {})
			.filter(([key]) => ["message", "metrics", "artifacts", "system_code", "system_name"].includes(key))),
		retryable: failure.retryable,
	});
	await writeJson(join(version.dir, "failure.json"), record);
	version.metadata = { ...version.metadata, status: "failed", failure_path: "failure.json" };
	await writeJson(join(version.dir, "version.json"), version.metadata);
	version.failures.push(record);
}

export async function recordVersionCancelled(run, version, cancellation = {}) {
	if (!run.versions.includes(version)) throw new Error(`Version ${version.id} does not belong to run ${run.id}`);
	if (version.metadata.status !== "started") return;
	const record = persistent({
		schema_version: "arr.elevation3d.version-cancellation.v1",
		version_id: version.id,
		stage: cancellation.stage ?? "unknown",
		reason: cancellation.reason ?? "operation cancelled",
	});
	await writeJson(join(version.dir, "cancellation.json"), record);
	version.cancellation = record;
	version.metadata = { ...version.metadata, status: "cancelled", cancellation_path: "cancellation.json" };
	await writeJson(join(version.dir, "version.json"), version.metadata);
}

export async function recordVersionSuccess(run, version, validation) {
	if (!run.versions.includes(version)) throw new Error(`Version ${version.id} does not belong to run ${run.id}`);
	if (version.metadata.status !== "started") {
		throw new Error(`Version ${version.id} cannot pass from status ${version.metadata.status}`);
	}
	await writeJson(join(version.dir, "validation.json"), validation);
	version.metadata = { ...version.metadata, status: "passed", validation_path: "validation.json" };
	version.validation = persistent(validation);
	await writeJson(join(version.dir, "version.json"), version.metadata);
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

async function appendUniqueRunEvent(memoryFile, event) {
	const previousAppend = memoryAppendQueues.get(memoryFile) ?? Promise.resolve();
	const currentAppend = previousAppend.catch(() => {}).then(async () => {
		await mkdir(dirname(memoryFile), { recursive: true });
		let previous = "";
		try {
			previous = await readFile(memoryFile, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const alreadyAppended = previous.split(/\r?\n/)
			.filter(Boolean)
			.some((line) => JSON.parse(line).run_id === event.run_id);
		if (!alreadyAppended) await appendFile(memoryFile, `${JSON.stringify(event)}\n`);
	});
	memoryAppendQueues.set(memoryFile, currentAppend);
	try {
		await currentAppend;
	} finally {
		if (memoryAppendQueues.get(memoryFile) === currentAppend) memoryAppendQueues.delete(memoryFile);
	}
}

function runRelativePath(runDir, path, label) {
	const absoluteRunDir = resolve(runDir);
	const absolutePath = resolve(path);
	const relativePath = relative(absoluteRunDir, absolutePath);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error(`${label} must remain within the run directory`);
	}
	return relativePath.replaceAll("\\", "/");
}

function selectedOutputArtifacts(run, selectedVersion) {
	const runDir = resolve(run.dir);
	if (!selectedVersion) {
		return {
			path_base: "run_dir",
			run_dir: runDir.replaceAll("\\", "/"),
			selected_glb: null,
			validation_report: null,
			drawings: {},
		};
	}
	const validationArtifacts = selectedVersion.validation?.artifacts;
	if (!validationArtifacts?.glb) throw new Error(`Selected version ${selectedVersion.id} has no GLB artifact`);
	const drawings = Object.fromEntries(DRAWING_NAMES.map((name) => {
		const entry = validationArtifacts.drawings?.[name];
		const path = typeof entry === "string" ? entry : entry?.path;
		if (typeof path !== "string" || !path) throw new Error(`Selected version ${selectedVersion.id} is missing drawing ${name}`);
		return [name, runRelativePath(runDir, path, `drawing ${name}`)];
	}));
	return {
		path_base: "run_dir",
		run_dir: runDir.replaceAll("\\", "/"),
		selected_glb: runRelativePath(runDir, validationArtifacts.glb, "selected GLB"),
		validation_report: runRelativePath(runDir, join(selectedVersion.dir, "validation.json"), "validation report"),
		drawings,
	};
}

function artifactEntry(run, value, sha256, label) {
	const path = typeof value === "string" ? value : value?.path;
	if (!path) return null;
	return { path: runRelativePath(run.dir, path, label), sha256: sha256 ?? value?.sha256 ?? null };
}

function correctionSummary(version) {
	if (version.id !== "v002") return "none";
	const changes = Object.entries(version.grammar_delta).map(([key, change]) =>
		`${key}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
	return changes.length ? changes.join("; ") : "no grammar field changed";
}

async function versionHistory(run) {
	return Promise.all(run.versions.map(async (version, index) => {
		const failure = version.failures.at(-1);
		const artifacts = version.validation?.artifacts ?? {};
		const validationPath = join(version.dir, "validation.json");
		const validationSha = version.validation ? sha256(await readFile(validationPath)) : null;
		return persistent({
			id: version.id,
			status: version.metadata.status,
			artifacts: {
				glb: artifactEntry(run, artifacts.glb, artifacts.glb_sha256, `${version.id} GLB`),
				drawings: Object.fromEntries(Object.entries(artifacts.drawings ?? {}).map(([name, entry]) => [
					name,
					artifactEntry(run, entry, entry?.sha256, `${version.id} drawing ${name}`),
				])),
				validation_report: version.validation
					? { path: runRelativePath(run.dir, validationPath, `${version.id} validation`), sha256: validationSha }
					: null,
			},
			validation: version.validation ? {
				accepted: version.validation.accepted,
				codes: version.validation.codes ?? [],
				metrics: version.validation.metrics ?? {},
			} : null,
			failure: failure ? {
				reason: failure.reason,
				error_class: failure.error_class,
				error_code: failure.error_code,
				stage: failure.stage,
				codes: failure.codes,
				retryable: failure.retryable,
			} : version.cancellation ? {
				reason: version.cancellation.reason,
				stage: version.cancellation.stage,
				retryable: false,
			} : null,
			correction: {
				applied: version.id === "v002",
				summary: correctionSummary(version),
				grammar_delta: index === 0 ? {} : version.grammar_delta,
			},
		});
	}));
}

export async function appendRunMemory(run, memoryRoot) {
	if (!run.final) throw new Error("A final selection is required before appending run memory");
	const runId = assertSafePathSegment(run.id, "run_id");
	const candidateId = assertSafePathSegment(run.metadata.candidate_id, "candidate_id");
	const versions = await versionHistory(run);
	const event = persistent({
		schema_version: "arr.elevation3d.run-memory.v2",
		run_id: runId,
		candidate_id: candidateId,
		input_artifacts: run.metadata.artifacts,
		versions,
		final: run.final,
	});
	const selectedVersion = run.versions.find((version) => version.id === run.final.selected);
	const candidateEvent = persistent({
		schema_version: "arr.elevation3d.candidate-run-memory.v2",
		run_id: runId,
		candidate_id: candidateId,
		selected_version: run.final.selected,
		versions,
		attempts: run.versions.filter((version) => version.id !== "fallback").length,
		metrics: selectedVersion?.validation?.metrics ?? {},
		failure_codes: [...new Set(run.versions.flatMap((version) => version.failures.flatMap((failure) => failure.codes)))],
		correction_applied: run.versions.some((version) => version.id === "v002"),
		correction: run.versions.some((version) => version.id === "v002")
			? "bounded facade grammar correction attempted"
			: "none",
		fallback: run.final.selected === "fallback",
		artifacts: selectedOutputArtifacts(run, selectedVersion),
		final: run.final,
	});
	const root = resolve(memoryRoot);
	const runsRoot = resolveDescendant(root, "runs");
	await Promise.all([
		appendUniqueRunEvent(resolveDescendant(root, "unified-runs.jsonl"), event),
		appendUniqueRunEvent(resolveDescendant(runsRoot, `${candidateId}.jsonl`), candidateEvent),
	]);
}
