import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { redactSecrets, sha256 } from "./core.mjs";
import { createPaidOperationLedger } from "./facade-agent/paid-operation-ledger.mjs";

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

function artifactBase(runDir) {
	return pathToFileURL(`${resolve(runDir)}${sep}`).href;
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

function presentationArtifact(outputDir, artifact, label) {
	if (!artifact?.path) return null;
	if (/^https?:\/\//i.test(artifact.path)) {
		return persistent({ path: artifact.path, ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}) });
	}
	return {
		path: runRelativePath(outputDir, artifact.path, label),
		...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
	};
}

export async function appendPresentationVersionMemory({ candidateId, outputDir, previousBaseline, report }, memoryFile) {
	if (report?.provider_calls !== 0) throw new Error("presentation report provider_calls must be explicitly zero");
	if (report?.credits_consumed !== 0) throw new Error("presentation report credits_consumed must be explicitly zero");
	const accepted = report?.validation?.accepted === true;
	const record = persistent({
		schema_version: "arr.elevation3d.presentation-version-memory.v1",
		candidate_id: assertSafePathSegment(candidateId, "candidate_id"),
		version_id: "rendered-pbr-v7-competition-daylight",
		output_directory: portableRelativePath(outputDir),
		previous_baseline: {
			version: previousBaseline?.version ?? "rendered-pbr-v6",
			limitation: previousBaseline?.limitation ?? "The previous presentation had washed highlights and weak material separation.",
		},
		style: {
			id: report?.render_style?.id ?? null,
			sha256: report?.render_style_sha256 ?? null,
		},
		result: {
			accepted,
			status: accepted ? "accepted" : "rejected",
			failure_codes: [...(report?.validation?.codes ?? [])],
			metrics: report?.validation?.metrics ?? {},
		},
		artifacts: Object.fromEntries(Object.entries(report?.artifacts ?? {})
			.map(([name, artifact]) => [name, presentationArtifact(outputDir, artifact, `presentation artifact ${name}`)])
			.filter(([, artifact]) => artifact !== null)),
		...(report?.canonical_selection ? { canonical_selection: report.canonical_selection } : {}),
		provider_calls: report.provider_calls,
		credits_consumed: report.credits_consumed,
	});
	await mkdir(dirname(memoryFile), { recursive: true });
	await appendFile(memoryFile, `${JSON.stringify(record)}\n`);
	return record;
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

async function readJsonFile(path) {
	return JSON.parse(await readFile(path, "utf8"));
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
	const version = { id: versionId, dir, metadata, failures: [], grammar: persistent(grammar), grammar_delta: grammarDelta, checkpoint: {} };
	run.versions.push(version);
	return version;
}

export async function recordVersionCheckpoint(run, version, patch) {
	if (!run.versions.includes(version)) throw new Error(`Version ${version.id} does not belong to run ${run.id}`);
	version.checkpoint = persistent({ ...version.checkpoint, ...patch });
	if (patch.validation) await writeJson(join(version.dir, "validation.json"), patch.validation);
	await writeJson(join(version.dir, "checkpoint.json"), {
		schema_version: "arr.elevation3d.version-checkpoint.v1",
		version_id: version.id,
		...version.checkpoint,
	});
	if (!version.metadata.checkpoint_path) {
		version.metadata = { ...version.metadata, checkpoint_path: "checkpoint.json" };
		await writeJson(join(version.dir, "version.json"), version.metadata);
	}
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
	await recordVersionCheckpoint(run, version, { validation });
	version.metadata = { ...version.metadata, status: "passed", validation_path: "validation.json" };
	version.validation = persistent(validation);
	await writeJson(join(version.dir, "version.json"), version.metadata);
}

export async function selectFinal(run, selection) {
	const final = persistent({
		schema_version: "arr.elevation3d.final-selection.v1",
		selected: selection.selected,
		reason: selection.reason,
		...(selection.delivery ? { delivery: normalizeDeliveryRecord(run, selection.delivery) } : {}),
		...(selection.delivery_failure ? { delivery_failure: normalizeDeliveryFailure(run, selection.delivery_failure) } : {}),
		...(selection.texturing ? { texturing: normalizeTexturingRecord(run, selection.texturing) } : {}),
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

function facadeArtifact(runDir, record, label) {
	if (!record) return null;
	const value = typeof record === "string" ? { path: record } : record;
	if (typeof value.path !== "string" || !value.path) return null;
	const absolute = isAbsolute(value.path) ? value.path : resolve(runDir, value.path);
	return {
		path: runRelativePath(runDir, absolute, label),
		...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
		...(typeof value.config_sha256 === "string" ? { config_sha256: value.config_sha256 } : {}),
	};
}

const FACADE_METRICS = new Set([
	"canonical_surface_match", "opaque_wall_coverage", "minimum_reveal_depth_m", "corner_max_gap_m",
	"floor_alignment_max_error_m", "facade_orientation_coverage", "maximum_bounds_excess_m",
	"base_vertex_count", "base_triangle_count", "base_sha256", "primitive_count", "detail_primitive_count",
	"materials", "drawing_dimensions", "segment_authority_match",
]);

function facadeMetrics(metrics) {
	return Object.fromEntries(Object.entries(metrics ?? {}).filter(([name]) => FACADE_METRICS.has(name)));
}

function facadeScore(score) {
	if (!score || typeof score !== "object") return null;
	return {
		status: score.status ?? null,
		score: Number.isFinite(score.score) ? score.score : null,
		components: persistent(score.components ?? score.breakdown?.components ?? {}),
		formula_version: score.formula_version ?? score.breakdown?.formula_version ?? null,
		...(typeof score.sha256 === "string" ? { sha256: score.sha256 } : {}),
	};
}

function facadeAttempt(runDir, version) {
	return {
		id: version.id,
		status: version.status,
		artifact: facadeArtifact(runDir, version.artifact, `${version.id} facade artifact`),
		validation: version.validation ? {
			accepted: version.validation.accepted === true,
			codes: [...(version.validation.codes ?? [])],
			retryable: version.validation.retryable === true,
			metrics: facadeMetrics(version.validation.metrics),
		} : null,
		validation_receipt: facadeArtifact(runDir, version.validation_receipt, `${version.id} validation receipt`),
		...(version.failure?.code ? { failure_code: version.failure.code } : {}),
	};
}

function facadeDelivery(runDir, delivery) {
	if (!delivery || typeof delivery !== "object") return null;
	const normalized = {
		manifest: facadeArtifact(runDir, delivery.manifest, "facade delivery manifest"),
		validation: facadeArtifact(runDir, delivery.validation, "facade delivery validation"),
		viewer: facadeArtifact(runDir, delivery.viewer, "facade delivery viewer"),
		browser_verification: facadeArtifact(runDir, delivery.browser_verification, "facade browser verification"),
	};
	if (delivery.views && typeof delivery.views === "object") {
		normalized.views = Object.fromEntries(Object.entries(delivery.views).map(([name, record]) => [
			name, facadeArtifact(runDir, record, `facade delivery ${name}`),
		]));
	}
	return normalized;
}

async function facadeCosts(runDir) {
	let summary;
	const ledgerRoot = join(runDir, "ledger");
	const ledgerPath = join(ledgerRoot, "paid-operations.json");
	try { await access(ledgerPath); summary = await createPaidOperationLedger(ledgerPath, { approvedRoot: ledgerRoot }).summary(); }
	catch (error) { if (error.code !== "ENOENT") throw error; return { total_usd: 0, image_usd: {}, grammar_usd: 0 }; }
	const operations = (summary?.operations ?? []).filter((operation) => operation?.status === "succeeded");
	const image = operations.filter((operation) => operation.kind === "image-generation");
	const grammar = operations.filter((operation) => operation.kind === "grammar-extraction");
	const imageUsd = {};
	for (const operation of image) imageUsd[operation.provider] = (imageUsd[operation.provider] ?? 0)
		+ (Number.isFinite(operation.actualUsd) ? operation.actualUsd : 0);
	return {
		total_usd: [...image, ...grammar].reduce((sum, operation) => sum + (Number.isFinite(operation.actualUsd) ? operation.actualUsd : 0), 0),
		image_usd: imageUsd,
		grammar_usd: grammar.reduce((sum, operation) => sum + (Number.isFinite(operation.actualUsd) ? operation.actualUsd : 0), 0),
	};
}

export async function appendFacadeAgentMemory(result, memoryRoot) {
	if (!result?.final) throw new Error("A final facade-agent result is required before appending memory");
	const runId = assertSafePathSegment(result.run_id, "run_id");
	const candidateId = assertSafePathSegment(result.candidate_id, "candidate_id");
	if (typeof result.brief_id !== "string" || !result.brief_id) throw new Error("brief_id is required");
	const runDir = resolve(result.run_dir);
	const providers = Object.fromEntries(Object.entries(result.providers ?? {}).map(([provider, state]) => [provider, {
		status: state?.status ?? null,
		request_fingerprint: state?.generation?.request_sha256 ?? null,
		proposal_sha256: state?.proposal?.sha256 ?? state?.generation?.artifact_sha256 ?? null,
		grammar_sha256: state?.grammar?.artifact_sha256 ?? null,
		grammar_artifact: facadeArtifact(runDir, state?.grammar, `${provider} grammar artifact`),
		attempts: (state?.versions ?? []).map((version) => facadeAttempt(runDir, version)),
		score: facadeScore(state?.score),
		...(state?.failure?.code ? { failure_code: state.failure.code } : {}),
	}]));
	const event = persistent({
		schema_version: "arr.elevation3d.facade-agent-memory.v1",
		run_id: runId,
		candidate_id: candidateId,
		brief_id: result.brief_id,
		artifact_base: "run_dir",
		input_sha256: result.input_sha256 ?? null,
		status: result.status ?? result.final.status,
		geometry_authority: "canonical-local-mass",
		retry_policy: "two-local-attempts-no-image-resubmit",
		image_submissions: Object.fromEntries(Object.entries(result.image_submissions?.by_provider ?? {}).map(([provider, count]) => [provider, count])),
		grammar_submissions: Object.fromEntries(Object.entries(result.providers ?? {}).map(([provider, state]) => [provider, state?.grammar?.status === "succeeded" ? 1 : 0])),
		costs: await facadeCosts(runDir),
		providers,
		delivery: facadeDelivery(runDir, result.selected_delivery ?? result.delivery?.memory_record),
		winner: result.final.status === "winner" ? {
			provider: result.final.selected_provider,
			version: result.final.selected_version,
			score_sha256: result.final.score_sha256 ?? null,
		} : null,
		fallback_reference: result.fallback_reference ? facadeArtifact(runDir, result.fallback_reference, "facade fallback") : null,
		final: {
			status: result.final.status,
			selected_provider: result.final.selected_provider ?? null,
			selected_version: result.final.selected_version ?? null,
			selected_glb_sha256: result.final.selected_glb_sha256 ?? null,
			score_sha256: result.final.score_sha256 ?? null,
			delivery_sha256: result.final.delivery_sha256 ?? null,
		},
	});
	await appendUniqueRunEvent(resolveDescendant(resolve(memoryRoot), "facade-agent-runs.jsonl"), event);
	return event;
}

function deliveryArtifact(run, record, label) {
	if (!record?.path) throw new Error(`${label} path is required`);
	return {
		path: runRelativePath(run.dir, record.path, label),
		...(record.sha256 ? { sha256: record.sha256 } : {}),
		...(record.config_sha256 ? { config_sha256: record.config_sha256 } : {}),
	};
}

function normalizeDeliveryRecord(run, delivery) {
	const viewNames = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
	if (Object.keys(delivery.views ?? {}).sort().join("|") !== [...viewNames].sort().join("|")) throw new Error("final delivery must record all eight views");
	return {
		schema_version: delivery.schema_version,
		manifest: deliveryArtifact(run, delivery.manifest, "delivery manifest"),
		validation: deliveryArtifact(run, delivery.validation, "delivery validation"),
		viewer: deliveryArtifact(run, delivery.viewer, "delivery viewer"),
		browser_verification: deliveryArtifact(run, delivery.browser_verification, "delivery browser verification"),
		views: Object.fromEntries(viewNames.map((name) => [name, deliveryArtifact(run, delivery.views[name], `delivery ${name}`)])),
	};
}

function normalizeDeliveryFailure(run, failure) {
	return {
		stage: "delivery",
		code: failure.code,
		path: runRelativePath(run.dir, failure.path, "delivery failure"),
	};
}

function normalizeTexturingRecord(run, texturing) {
	return redactSecrets({
		status: texturing.status,
		provider: texturing.provider,
		outputGlb: texturing.outputGlb ? runRelativePath(run.dir, texturing.outputGlb, "textured GLB") : null,
		outputSha256: texturing.outputSha256 ?? null,
		actualCredits: texturing.actualCredits ?? 0,
		geometryStatus: texturing.geometryStatus ?? null,
		materialStatus: texturing.materialStatus ?? null,
		transferStatus: texturing.transferStatus ?? null,
		renderStatus: texturing.renderStatus ?? null,
		fallbackPath: texturing.fallbackPath ? runRelativePath(run.dir, texturing.fallbackPath, "texturing fallback") : null,
		failureCode: texturing.failureCode ?? null,
		retryDecision: texturing.retryDecision ?? "no-auto-retry",
	});
}

function selectedOutputArtifacts(run, selectedVersion, selectedHistory) {
	const runDir = resolve(run.dir);
	if (!selectedVersion) {
		return {
			path_base: "run_dir",
			run_dir: runDir.replaceAll("\\", "/"),
			selected_glb: null,
			validation_report: null,
			drawing_provenance: null,
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
		drawing_provenance: selectedHistory?.artifacts?.drawing_provenance ?? null,
		drawings,
		...(run.final?.delivery ? { delivery: run.final.delivery } : {}),
	};
}

function artifactEntry(run, value, sha256, label) {
	const path = typeof value === "string" ? value : value?.path;
	if (!path) return null;
	return {
		...(typeof value === "object" && value?.metrics ? { metrics: value.metrics } : {}),
		path: runRelativePath(run.dir, path, label),
		sha256: sha256 ?? value?.sha256 ?? null,
	};
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
		let checkpoint = version.checkpoint ?? {};
		try { checkpoint = await readJsonFile(join(version.dir, "checkpoint.json")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		const validation = checkpoint.validation ?? version.validation;
		const validationArtifacts = validation?.artifacts ?? {};
		const checkpointGlb = checkpoint.enrichment?.artifact ?? null;
		const validationGlbPath = typeof validationArtifacts.glb === "string"
			? validationArtifacts.glb : validationArtifacts.glb?.path;
		const glb = validationGlbPath ? {
			...checkpointGlb,
			...(typeof validationArtifacts.glb === "object" ? validationArtifacts.glb : {}),
			path: validationGlbPath,
			sha256: validationArtifacts.glb_sha256 ?? validationArtifacts.glb?.sha256 ?? checkpointGlb?.sha256,
		} : checkpointGlb;
		const artifacts = {
			glb,
			glb_sha256: glb?.sha256,
			drawings: Object.keys(validationArtifacts.drawings ?? {}).length
				? validationArtifacts.drawings
				: checkpoint.render?.drawings ?? {},
			provenance: validationArtifacts.provenance ?? checkpoint.render?.provenance,
			provenance_sha256: validationArtifacts.provenance_sha256 ?? checkpoint.render?.provenance?.sha256,
		};
		const validationPath = join(version.dir, "validation.json");
		const validationSha = validation ? sha256(await readFile(validationPath)) : null;
		return persistent({
			id: version.id,
			status: version.metadata.status,
			artifacts: {
				glb: artifactEntry(run, artifacts.glb, artifacts.glb_sha256, `${version.id} GLB`),
				drawings: Object.fromEntries(Object.entries(artifacts.drawings ?? {}).map(([name, entry]) => [
					name,
					artifactEntry(run, entry, entry?.sha256, `${version.id} drawing ${name}`),
				])),
				provenance: artifactEntry(run, artifacts.provenance, artifacts.provenance_sha256, `${version.id} provenance`),
				drawing_provenance: artifactEntry(run, artifacts.provenance, artifacts.provenance_sha256, `${version.id} provenance`),
				validation_report: validation
					? { path: runRelativePath(run.dir, validationPath, `${version.id} validation`), sha256: validationSha }
					: null,
			},
			validation: validation ? {
				accepted: validation.accepted,
				codes: validation.codes ?? [],
				metrics: validation.metrics ?? {},
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
		artifact_base: artifactBase(run.dir),
		input_artifacts: run.metadata.artifacts,
		versions,
		final: run.final,
	});
	const selectedVersion = run.versions.find((version) => version.id === run.final.selected);
	const selectedHistory = versions.find((version) => version.id === run.final.selected);
	const candidateEvent = persistent({
		schema_version: "arr.elevation3d.candidate-run-memory.v2",
		run_id: runId,
		candidate_id: candidateId,
		artifact_base: artifactBase(run.dir),
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
		artifacts: selectedOutputArtifacts(run, selectedVersion, selectedHistory),
		final: run.final,
	});
	const root = resolve(memoryRoot);
	const runsRoot = resolveDescendant(root, "runs");
	await Promise.all([
		appendUniqueRunEvent(resolveDescendant(root, "unified-runs.jsonl"), event),
		appendUniqueRunEvent(resolveDescendant(runsRoot, `${candidateId}.jsonl`), candidateEvent),
	]);
}
