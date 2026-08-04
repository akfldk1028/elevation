import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadCandidatePackage, redactSecrets, sha256 } from "./core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "./enrichment.mjs";
import { validateEnrichment } from "./enrichment-validation.mjs";
import { correctGrammar, normalizeFacadeGrammar, resolveApprovedDesign } from "./facade-grammar.mjs";
import { deliverSelectedAllViews } from "./final-delivery.mjs";
import {
	appendRunMemory,
	assertSafePathSegment,
	beginVersion,
	createUnifiedRun,
	recordVersionFailure,
	recordVersionSuccess,
	recordVersionCancelled,
	recordVersionCheckpoint,
	selectFinal,
} from "./run-memory.mjs";
import { renderUnifiedDrawings } from "./unified-render.mjs";
import { deliverTexturedGlb } from "./texturing/delivery.mjs";
import { renderEmbeddedPbrViews } from "./texturing/render-validator.mjs";

async function enrichVersion({ sourceMesh, floorGuides, facadePlanes, grammar, safeFallback, outputPath }) {
	const scene = buildEnrichedScene({
		mesh: sourceMesh,
		floorGuides,
		facadePlanes,
		grammar,
		safeFallback,
	});
	return executeDefaultStage("enrich", () => writeEnrichedGlb(scene, outputPath));
}

async function renderVersion(args) {
	return executeDefaultStage("render", () => renderUnifiedDrawings(args));
}

async function validateVersion(args) {
	return executeDefaultStage("validate", () => validateEnrichment(args));
}

const STAGE_FAILURE_CODES = {
	enrich: "ENRICHMENT_FAILED",
	render: "RENDER_FAILED",
	validate: "VALIDATION_FAILED",
};
const GENERATED_STAGE_CODE_PAIRS = Object.freeze({
	enrich: Object.freeze(["GLB_EXPORT_FAILED"]),
	render: Object.freeze(["DRAWING_RENDER_FAILED"]),
	validate: Object.freeze(["VALIDATION_IO_FAILED"]),
});
const FILESYSTEM_OPERATIONAL_CODES = Object.freeze([
	"EACCES", "EBUSY", "EDQUOT", "EFBIG", "EIO", "EMFILE", "ENFILE",
	"ENOENT", "ENOMEM", "ENOSPC", "EPERM", "EROFS",
]);
const RENDER_OPERATIONAL_ERROR_NAMES = Object.freeze([
	"BrowserError", "NetworkError", "ProtocolError", "TargetCloseError", "TimeoutError",
]);
const REQUIRED_SOURCE_VIEWS = ["front", "right", "back", "left", "top", "axon"];
const RETRYABLE_VALIDATION_CODES = new Set([
	"ARTIFACT_HASH_MISMATCH",
	"ARTIFACT_MISSING",
	"BASE_GEOMETRY_CHANGED",
	"BASE_PRIMITIVE_MISSING",
	"DETAIL_COMPONENT_BRIDGE",
	"DETAIL_COMPONENT_UNATTACHED",
	"DETAIL_COVERAGE_MISSING",
	"DETAIL_BOUNDS_EXCEEDED",
	"DRAWING_INVALID",
	"DRAWING_MISSING",
	"DRAWING_PROVENANCE_MISMATCH",
	"DRAWING_PROVENANCE_MISSING",
	"FLOOR_GUIDE_COVERAGE_MISSING",
	"GLB_INVALID",
	"MATERIAL_SET_INVALID",
	"NEW_STOREY_DETECTED",
	"PRIMITIVE_BUDGET_EXCEEDED",
]);

function isAllowedGeneratedStageCode(stage, code) {
	return Object.hasOwn(GENERATED_STAGE_CODE_PAIRS, stage)
		&& GENERATED_STAGE_CODE_PAIRS[stage].includes(code);
}

function defaultStageCode(stage, error) {
	const filesystemFailure = FILESYSTEM_OPERATIONAL_CODES.includes(error?.code)
		&& typeof error?.syscall === "string"
		&& error?.name !== "AssertionError";
	if (stage === "enrich" && filesystemFailure) return "GLB_EXPORT_FAILED";
	if (stage === "render" && (
		filesystemFailure || RENDER_OPERATIONAL_ERROR_NAMES.includes(error?.name)
	)) return "DRAWING_RENDER_FAILED";
	if (stage === "validate" && filesystemFailure) return "VALIDATION_IO_FAILED";
	return null;
}

export async function executeDefaultStage(stage, operation) {
	if (!Object.hasOwn(GENERATED_STAGE_CODE_PAIRS, stage)) throw new TypeError(`Unknown generated stage: ${stage}`);
	try {
		return await operation();
	} catch (error) {
		const code = defaultStageCode(stage, error);
		if (!code) throw error;
		throw new GeneratedStageError({
			stage,
			code,
			message: `${stage} operational failure`,
			cause: error,
			evidence: { system_code: error?.code, system_name: error?.name },
		});
	}
}

export class GeneratedStageError extends Error {
	constructor({ stage, code, message, cause, evidence }) {
		if (!isAllowedGeneratedStageCode(stage, code)) {
			throw new TypeError(`Generated stage/code pair is not allowed: ${stage}/${code}`);
		}
		super(message ?? `${stage} failed: ${code}`, { cause });
		this.name = "GeneratedStageError";
		Object.defineProperties(this, {
			stage: { value: stage, enumerable: true },
			code: { value: code, enumerable: true },
		});
		this.evidence = evidence ?? {};
	}
}

export class BlockedRunError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "BlockedRunError";
		this.code = "RUN_BLOCKED";
		this.retryable = false;
		this.stage = options.stage ?? "input";
	}
}

function thrownFailure(error, stage) {
	const generatedFailure = error instanceof GeneratedStageError
		&& error.stage === stage
		&& isAllowedGeneratedStageCode(error.stage, error.code);
	return {
		stage,
		codes: [generatedFailure ? error.code : STAGE_FAILURE_CODES[stage]],
		reason: error instanceof Error ? error.message : String(error),
		error_class: error?.name ?? null,
		error_code: generatedFailure ? error.code : error?.code ?? null,
		evidence: error?.evidence ?? { message: error instanceof Error ? error.message : String(error) },
		retryable: generatedFailure,
	};
}

function rejectedValidation(report) {
	const codes = Array.isArray(report?.codes) && report.codes.length ? [...report.codes] : [STAGE_FAILURE_CODES.validate];
	return {
		stage: "validate",
		codes,
		reason: `validation rejected: ${codes.join(", ")}`,
		error_class: "ValidationRejection",
		error_code: codes[0],
		evidence: { metrics: report?.metrics ?? {}, artifacts: report?.artifacts ?? {} },
		retryable: codes.every((code) => RETRYABLE_VALIDATION_CODES.has(code)),
	};
}

function assertTrustedCandidateInput(input) {
	const views = input?.cameras?.views;
	const missingViews = REQUIRED_SOURCE_VIEWS.filter((name) => !views?.[name]);
	if (missingViews.length) throw new Error(`Trusted camera package is missing: ${missingViews.join(", ")}`);
}

function versionFailure(failure, safeFallback) {
	return safeFallback ? { ...failure, retryable: false } : failure;
}

function isAbort(error, signal) {
	return signal?.aborted || error?.name === "AbortError";
}

function throwIfAborted(signal) {
	signal?.throwIfAborted();
}

async function hashedArtifact(path) {
	if (typeof path !== "string" || !path) return null;
	try { return { path, sha256: sha256(await readFile(path)) }; }
	catch { return null; }
}

async function renderCheckpoint(version, drawings) {
	const entries = (await Promise.all(Object.entries(drawings ?? {}).map(async ([name, value]) => {
		const path = typeof value === "string" ? value : value?.path;
		const artifact = await hashedArtifact(path);
		return artifact ? [name, { ...artifact, ...(typeof value === "object" ? value : {}) }] : null;
	}))).filter(Boolean);
	return {
		drawings: Object.fromEntries(entries),
		provenance: await hashedArtifact(join(version.dir, "drawing-provenance.json")),
	};
}

async function runVersion({
	run, versionId, grammar, safeFallback, input, enrich, render, validate, signal,
	renderLifecycle, renderProgressObserver,
}) {
	throwIfAborted(signal);
	const version = await beginVersion(run, versionId, grammar);
	throwIfAborted(signal);
	let artifact;
	try {
		version.active_stage = "enrich";
		artifact = await enrich({
			sourceMesh: input.mesh,
			floorGuides: input.floor_guides,
			facadePlanes: input.facade_planes,
			grammar,
			safeFallback,
			outputPath: resolve(version.dir, safeFallback ? "exact-mass.glb" : "enriched.glb"),
			versionId,
			runDir: version.dir,
			signal,
		});
		await recordVersionCheckpoint(run, version, { enrichment: {
			artifact: { path: artifact.path, sha256: artifact.sha256, metrics: artifact.metrics ?? {} },
		} });
		throwIfAborted(signal);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		const failure = versionFailure(thrownFailure(error, "enrich"), safeFallback);
		await recordVersionFailure(run, version, failure);
		return { version, failure, cause: error?.cause ?? error };
	}

	let drawings;
	try {
		version.active_stage = "render";
		drawings = await render({
			runDir: version.dir,
			glbPath: artifact.path,
			sourceMesh: input.mesh,
			cameras: input.cameras,
			versionId,
			safeFallback,
			signal,
			lifecycle: renderLifecycle,
			onProgress: async (event) => {
				await recordVersionCheckpoint(run, version, { render: event.render });
				await renderProgressObserver?.(event);
			},
		});
		await recordVersionCheckpoint(run, version, { render: await renderCheckpoint(version, drawings) });
		throwIfAborted(signal);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		const failure = versionFailure(thrownFailure(error, "render"), safeFallback);
		await recordVersionFailure(run, version, failure);
		return { version, failure, cause: error?.cause ?? error };
	}

	let report;
	try {
		version.active_stage = "validate";
		report = await validate({
			sourceMesh: input.mesh,
			artifact,
			grammar,
			requiredDrawings: drawings,
			versionId,
			safeFallback,
			signal,
		});
		await recordVersionCheckpoint(run, version, { validation: report });
		throwIfAborted(signal);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		const failure = versionFailure(thrownFailure(error, "validate"), safeFallback);
		await recordVersionFailure(run, version, failure);
		return { version, failure, cause: error?.cause ?? error };
	}
	if (!report?.accepted) {
		const failure = versionFailure(rejectedValidation(report), safeFallback);
		await recordVersionFailure(run, version, failure);
		return { version, failure };
	}
	await recordVersionSuccess(run, version, report);
	version.active_stage = null;
	return { version, artifact, drawings, report };
}

function blockedFromFailure(failure, cause) {
	return new BlockedRunError(
		`Run blocked at ${failure.stage}: ${failure.codes.join(", ")}`,
		{ stage: failure.stage, cause },
	);
}

async function terminateBlocked(run, memoryRoot, failure, cause) {
	await selectFinal(run, {
		selected: "blocked",
		reason: `${failure.stage}: ${failure.codes.join(", ")}`,
	});
	await appendRunMemory(run, memoryRoot);
	throw blockedFromFailure(failure, cause);
}

async function terminateCancelled(run, memoryRoot, error) {
	const active = run.versions.findLast((version) => version.metadata.status === "started");
	if (active) await recordVersionCancelled(run, active, {
		stage: active.active_stage ?? "unknown",
		reason: error instanceof Error ? error.message : "operation cancelled",
	});
	await selectFinal(run, { selected: "cancelled", reason: "operation cancelled" });
	await appendRunMemory(run, memoryRoot);
	throw error;
}

async function finalizeEnrichedSuccess({
	run, versionResult, attempts, input, candidateId, signal, deliver, memoryRoot, lifecycle,
	texturing, textureDeliver, renderTextured, texturingLifecycle,
}) {
	let delivery;
	let texturingResult = null;
	try {
		delivery = await deliver({
			runDir: run.dir,
			candidateId,
			artifact: versionResult.artifact,
			input,
			signal,
			lifecycle,
		});
		throwIfAborted(signal);
		if (texturing?.enabled === true) {
			try {
				const referenceImage = texturing.referenceImage;
				texturingResult = await textureDeliver({
				acceptedGlb: versionResult.artifact.path,
				referenceImage,
				resultDir: join(run.dir, "texturing", versionResult.version.id),
				runRoot: run.dir,
				proceduralDelivery: delivery.run_dir,
				provider: "tripo",
				providerOptions: { apiKey: process.env.TRIPO_API_KEY },
				confirmLive: texturing.confirmLive === true,
				maxCredits: texturing.maxCredits ?? 15,
				seed: texturing.seed ?? 13013,
				dryRun: texturing.dryRun === true,
				signal,
				env: process.env,
				});
				if (["accepted", "review"].includes(texturingResult.status) && texturingResult.outputGlb) {
					const viewerConfig = JSON.parse(await readFile(join(delivery.run_dir, "viewer", "config.json"), "utf8"));
					texturingResult.render = await renderTextured({
					glbPath: texturingResult.outputGlb,
					runDir: join(run.dir, "texturing", versionResult.version.id, "rendered-pbr"),
					candidateId,
					cameras: viewerConfig.cameras.views,
					baselineRunDir: delivery.run_dir,
					signal,
					lifecycle: texturingLifecycle,
					});
					if (texturingResult.render?.validation?.accepted !== true) {
						texturingResult = {
							...texturingResult,
							status: "rejected",
							failure: {
								code: "TEXTURED_RENDER_REJECTED",
								message: "Embedded-PBR eight-view validation rejected the textured delivery",
								details: texturingResult.render?.validation,
							},
						};
					}
				}
			} catch (error) {
				if (isAbort(error, signal)) throw error;
				texturingResult = {
					status: "rejected",
					proceduralDelivery: delivery.run_dir,
					failure: redactSecrets({
						code: error?.code ?? "OPTIONAL_TEXTURING_FAILED",
						message: error instanceof Error ? error.message : String(error),
					}),
				};
			}
		}
		await selectFinal(run, {
			selected: versionResult.version.id,
			reason: texturingResult ? "enrichment and procedural delivery passed; optional texturing recorded" : "enrichment, validation, and all-view delivery passed",
			delivery: delivery.memory_record,
			...(texturingResult ? { texturing: redactSecrets({
				status: texturingResult.status,
				provider: "tripo",
				outputGlb: texturingResult.outputGlb ?? null,
				outputSha256: texturingResult.outputSha256 ?? null,
				actualCredits: texturingResult.actualCredits ?? 0,
				geometryStatus: texturingResult.geometry?.accepted ? "accepted" : texturingResult.failure ? "rejected" : null,
				materialStatus: texturingResult.material?.status ?? null,
				transferStatus: texturingResult.transfer?.status ?? null,
				renderStatus: texturingResult.render?.validation?.status ?? null,
				fallbackPath: delivery.run_dir,
				failureCode: texturingResult.failure?.code ?? null,
				retryDecision: "no-auto-retry",
			}) } : {}),
		});
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		const code = typeof error?.code === "string" ? error.code : "FINAL_DELIVERY_FAILED";
		const failurePath = join(run.dir, "delivery-failure.json");
		const failure = redactSecrets({
			schema_version: "arr.elevation3d.delivery-failure.v1",
			stage: "delivery",
			code,
			message: error instanceof Error ? error.message : String(error),
			evidence: error?.evidence ?? {},
		});
		await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
		await selectFinal(run, {
			selected: "blocked",
			reason: `delivery: ${code}`,
			delivery_failure: { path: failurePath, code, stage: "delivery" },
		});
		await appendRunMemory(run, memoryRoot);
		throw error;
	}
	await appendRunMemory(run, memoryRoot);
	return {
		selected_version: versionResult.version.id,
		attempts,
		fallback: false,
		run_dir: run.dir,
		artifact: versionResult.artifact,
		drawings: versionResult.drawings,
		validation: versionResult.report,
		delivery,
		texturing: texturingResult,
	};
}

export async function runElevation3d({
	candidateId,
	datasetRoot,
	outputRoot,
	approvedImage,
	texturing,
	runId,
	signal,
	deps = {},
}) {
	throwIfAborted(signal);
	const memoryRoot = resolve("memory/elevation-3d");
	const resolvedRunId = runId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	let input;
	let approvedDesign;
	try {
		assertSafePathSegment(candidateId, "candidate_id");
		assertSafePathSegment(resolvedRunId, "run_id");
		input = await loadCandidatePackage(datasetRoot, candidateId);
		assertTrustedCandidateInput(input);
		approvedDesign = await resolveApprovedDesign({ candidateId, approvedImage, memoryRoot });
		throwIfAborted(signal);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		throw new BlockedRunError(error instanceof Error ? error.message : String(error), {
			cause: error,
			stage: "input",
		});
	}
	const grammar = normalizeFacadeGrammar({
		approvedDesign,
		floorGuides: input.floor_guides,
		facadePlanes: input.facade_planes,
	});
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId: resolvedRunId });
	const enrich = deps.enrich ?? enrichVersion;
	const render = deps.render ?? renderVersion;
	const validate = deps.validate ?? validateVersion;
	const deliver = deps.deliver ?? deliverSelectedAllViews;
	const textureDeliver = deps.textureDeliver ?? deliverTexturedGlb;
	const renderTextured = deps.renderTextured ?? renderEmbeddedPbrViews;
	try {
	const first = await runVersion({
		run, versionId: "v001", grammar, safeFallback: false, input, enrich, render, validate, signal,
		renderLifecycle: deps.renderLifecycle, renderProgressObserver: deps.onRenderProgress,
	});
	if (!first.failure) {
		return await finalizeEnrichedSuccess({ run, versionResult: first, attempts: 1, input, candidateId, signal, deliver, memoryRoot, lifecycle: deps.deliveryLifecycle, texturing, textureDeliver, renderTextured, texturingLifecycle: deps.texturingLifecycle });
	}
	if (!first.failure.retryable) await terminateBlocked(run, memoryRoot, first.failure, first.cause);

	const correctedGrammar = correctGrammar(grammar, first.failure.codes);
	const second = await runVersion({
		run, versionId: "v002", grammar: correctedGrammar, safeFallback: false, input, enrich, render, validate, signal,
		renderLifecycle: deps.renderLifecycle, renderProgressObserver: deps.onRenderProgress,
	});
	if (!second.failure) {
		return await finalizeEnrichedSuccess({ run, versionResult: second, attempts: 2, input, candidateId, signal, deliver, memoryRoot, lifecycle: deps.deliveryLifecycle, texturing, textureDeliver, renderTextured, texturingLifecycle: deps.texturingLifecycle });
	}
	if (!second.failure.retryable) await terminateBlocked(run, memoryRoot, second.failure, second.cause);

	const fallback = await runVersion({
		run, versionId: "fallback", grammar: correctedGrammar, safeFallback: true, input, enrich, render, validate, signal,
		renderLifecycle: deps.renderLifecycle, renderProgressObserver: deps.onRenderProgress,
	});
	if (fallback.failure) await terminateBlocked(
		run, memoryRoot, { ...fallback.failure, retryable: false }, fallback.cause,
	);
	await selectFinal(run, { selected: "fallback", reason: "two generated versions failed; exact mass passed all gates" });
	await appendRunMemory(run, memoryRoot);
	return {
		selected_version: "fallback",
		attempts: 2,
		fallback: true,
		run_dir: run.dir,
		artifact: fallback.artifact,
		drawings: fallback.drawings,
		validation: fallback.report,
		delivery: null,
		delivery_status: "not_applicable_fallback",
	};
	} catch (error) {
		if (isAbort(error, signal)) await terminateCancelled(run, memoryRoot, signal?.reason ?? error);
		throw error;
	}
}
