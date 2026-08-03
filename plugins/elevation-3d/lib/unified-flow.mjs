import { resolve } from "node:path";

import { loadCandidatePackage } from "./core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "./enrichment.mjs";
import { validateEnrichment } from "./enrichment-validation.mjs";
import { correctGrammar, normalizeFacadeGrammar, resolveApprovedDesign } from "./facade-grammar.mjs";
import {
	appendRunMemory,
	beginVersion,
	createUnifiedRun,
	recordVersionFailure,
	selectFinal,
} from "./run-memory.mjs";
import { renderUnifiedDrawings } from "./unified-render.mjs";

async function enrichVersion({ sourceMesh, floorGuides, facadePlanes, grammar, safeFallback, outputPath }) {
	const scene = buildEnrichedScene({
		mesh: sourceMesh,
		floorGuides,
		facadePlanes,
		grammar,
		safeFallback,
	});
	return writeEnrichedGlb(scene, outputPath);
}

const STAGE_FAILURE_CODES = {
	enrich: "ENRICHMENT_FAILED",
	render: "RENDER_FAILED",
	validate: "VALIDATION_FAILED",
};

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
	return {
		stage: error?.stage ?? stage,
		codes: Array.isArray(error?.codes) && error.codes.length
			? [...error.codes]
			: [error?.code ?? STAGE_FAILURE_CODES[stage]],
		evidence: error?.evidence ?? { message: error instanceof Error ? error.message : String(error) },
		retryable: error?.retryable !== false,
	};
}

function rejectedValidation(report) {
	return {
		stage: "validate",
		codes: Array.isArray(report?.codes) && report.codes.length ? [...report.codes] : [STAGE_FAILURE_CODES.validate],
		evidence: { metrics: report?.metrics ?? {}, artifacts: report?.artifacts ?? {} },
		retryable: report?.retryable !== false,
	};
}

async function runVersion({ run, versionId, grammar, safeFallback, input, enrich, render, validate }) {
	const version = await beginVersion(run, versionId, grammar);
	let artifact;
	try {
		artifact = await enrich({
			sourceMesh: input.mesh,
			floorGuides: input.floor_guides,
			facadePlanes: input.facade_planes,
			grammar,
			safeFallback,
			outputPath: resolve(version.dir, safeFallback ? "exact-mass.glb" : "enriched.glb"),
			versionId,
			runDir: version.dir,
		});
	} catch (error) {
		const failure = thrownFailure(error, "enrich");
		await recordVersionFailure(run, version, failure);
		return { version, failure };
	}

	let drawings;
	try {
		drawings = await render({
			runDir: version.dir,
			glbPath: artifact.path,
			sourceMesh: input.mesh,
			cameras: input.cameras,
			versionId,
			safeFallback,
		});
	} catch (error) {
		const failure = thrownFailure(error, "render");
		await recordVersionFailure(run, version, failure);
		return { version, failure };
	}

	let report;
	try {
		report = await validate({
			sourceMesh: input.mesh,
			artifact,
			grammar,
			requiredDrawings: drawings,
			versionId,
			safeFallback,
		});
	} catch (error) {
		const failure = thrownFailure(error, "validate");
		await recordVersionFailure(run, version, failure);
		return { version, failure };
	}
	if (!report?.accepted) {
		const failure = rejectedValidation(report);
		await recordVersionFailure(run, version, failure);
		return { version, failure };
	}
	return { version, artifact, drawings, report };
}

function blockedFromFailure(failure) {
	return new BlockedRunError(
		`Run blocked at ${failure.stage}: ${failure.codes.join(", ")}`,
		{ stage: failure.stage },
	);
}

export async function runElevation3d({
	candidateId,
	datasetRoot,
	outputRoot,
	approvedImage,
	runId,
	deps = {},
}) {
	const memoryRoot = resolve("memory/elevation-3d");
	let input;
	let approvedDesign;
	try {
		input = await loadCandidatePackage(datasetRoot, candidateId);
		approvedDesign = await resolveApprovedDesign({ candidateId, approvedImage, memoryRoot });
	} catch (error) {
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
	const run = await createUnifiedRun({ input, approvedDesign, outputRoot, runId });
	const enrich = deps.enrich ?? enrichVersion;
	const render = deps.render ?? renderUnifiedDrawings;
	const validate = deps.validate ?? validateEnrichment;
	const first = await runVersion({
		run, versionId: "v001", grammar, safeFallback: false, input, enrich, render, validate,
	});
	if (!first.failure) {
		await selectFinal(run, { selected: first.version.id, reason: "enrichment and all gates passed" });
		await appendRunMemory(run, memoryRoot);
		return {
			selected_version: first.version.id,
			attempts: 1,
			fallback: false,
			run_dir: run.dir,
			artifact: first.artifact,
			drawings: first.drawings,
			validation: first.report,
		};
	}
	if (!first.failure.retryable) throw blockedFromFailure(first.failure);

	const correctedGrammar = correctGrammar(grammar, first.failure.codes);
	const second = await runVersion({
		run, versionId: "v002", grammar: correctedGrammar, safeFallback: false, input, enrich, render, validate,
	});
	if (!second.failure) {
		await selectFinal(run, { selected: second.version.id, reason: "bounded correction passed all gates" });
		await appendRunMemory(run, memoryRoot);
		return {
			selected_version: second.version.id,
			attempts: 2,
			fallback: false,
			run_dir: run.dir,
			artifact: second.artifact,
			drawings: second.drawings,
			validation: second.report,
		};
	}
	if (!second.failure.retryable) throw blockedFromFailure(second.failure);

	const fallback = await runVersion({
		run, versionId: "fallback", grammar: correctedGrammar, safeFallback: true, input, enrich, render, validate,
	});
	if (fallback.failure) throw blockedFromFailure({ ...fallback.failure, retryable: false });
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
	};
}
