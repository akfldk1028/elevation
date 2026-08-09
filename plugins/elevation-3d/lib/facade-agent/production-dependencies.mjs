import { mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { dirname, join, resolve } from "node:path";

import { loadCandidatePackage } from "../core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../enrichment.mjs";
import { validateEnrichment } from "../enrichment-validation.mjs";
import { correctGrammar } from "../facade-grammar.mjs";
import { deliverSelectedAllViews } from "../final-delivery.mjs";
import { renderUnifiedDrawings } from "../unified-render.mjs";
import { buildFacadeEvidencePack, verifyFacadeEvidencePack } from "./evidence.mjs";
import { deliverFacadeFinalPresentation } from "./final-presentation.mjs";
import { verifyFacadeProposal } from "./grammar-agent.mjs";
import { createPaidOperationLedger } from "./paid-operation-ledger.mjs";
import { deriveFacadeSegmentsFromMass } from "./punched-facade.mjs";
import { createFacadeGrammarProviderRegistry } from "./routers/grammar-provider-registry.mjs";
import { createFacadeImageProviderRegistry } from "./routers/image-provider-registry.mjs";
import { rehydrateFacadeScoreResult, scoreFacadeCandidate, selectFacadeWinner } from "./score.mjs";

function geometryBoundGrammar(grammar, candidate) {
	const facadeAuthority = candidate.facade_segment_authority ?? candidate.facade_planes;
	return {
		...grammar,
		wall_opacity: "opaque",
		curtain_wall_allowed: false,
		floor_elevations_m: [...candidate.floor_guides.floor_guides_m],
		facade_lengths_m: { ...facadeAuthority.facade_lengths_m },
	};
}

export async function createProductionFacadeAgentDependencies(config, options = {}) {
	const presentationRenderer = options.presentationRenderer;
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl;
	if (typeof fetchImpl !== "function") throw new TypeError("An explicit fetch implementation is required for facade providers");
	const runDir = resolve(config.outputRoot, config.candidateId, config.runId);
	const ledgerRoot = join(runDir, "ledger");
	await mkdir(ledgerRoot, { recursive: true });
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid-operations.json"), { approvedRoot: ledgerRoot });
	const providers = createFacadeImageProviderRegistry(config, {
		env,
		fetchImpl,
		lookupImpl: options.lookupImpl ?? lookup,
		timeoutMs: options.timeoutMs,
		providerFactories: options.imageProviderFactories,
	});
	const grammarProvider = createFacadeGrammarProviderRegistry(config, {
		env,
		fetchImpl,
		timeoutMs: options.timeoutMs,
		providerFactories: options.grammarProviderFactories,
	});
	const score = async (input) => scoreFacadeCandidate(input);
	score.select = selectFacadeWinner;
	score.rehydrate = (value) => rehydrateFacadeScoreResult(value);
	return {
		ledger,
		providers,
		grammarProvider,
		loadCandidate: async ({ datasetRoot, candidateId }) => {
			const candidate = await loadCandidatePackage(datasetRoot, candidateId);
			if (!candidate.mesh?.vertices?.length || !candidate.mesh?.triangles?.length) return candidate;
			const facadeSegments = deriveFacadeSegmentsFromMass({ mesh: candidate.mesh });
			return { ...candidate, facade_segment_authority: facadeSegments };
		},
		buildEvidence: async ({ input, runDir: target, resume, manifestPath, signal }) => {
			if (resume) return verifyFacadeEvidencePack({ manifestPath, input });
			const built = await buildFacadeEvidencePack({ input, runDir: target, signal });
			return verifyFacadeEvidencePack({ manifestPath: built.manifestPath, input });
		},
		build: async ({ provider, versionId, grammar, candidate, runDir: target }) => {
			const outputDir = join(target, "providers", provider, "artifacts");
			await mkdir(outputDir, { recursive: true });
			const scene = buildEnrichedScene({
				mesh: candidate.mesh, floorGuides: candidate.floor_guides,
				facadePlanes: candidate.facade_segment_authority ?? candidate.facade_planes,
				grammar: geometryBoundGrammar(grammar, candidate), safeFallback: false,
			});
			return writeEnrichedGlb(scene, join(outputDir, `${versionId}.glb`));
		},
		validate: async ({ provider, versionId, artifact, grammar, extractedGrammar, candidate, runDir: target, signal }) => {
			const drawings = await renderUnifiedDrawings({
				runDir: dirname(artifact.path), glbPath: artifact.path,
				sourceMesh: candidate.mesh, cameras: candidate.cameras, signal,
			});
			return validateEnrichment({
				sourceMesh: candidate.mesh, artifact, grammar: geometryBoundGrammar(grammar, candidate), extractedGrammar,
				requiredDrawings: drawings, facadeSegmentAuthority: candidate.facade_segment_authority, safeFallback: false,
			});
		},
		correctGrammar: (grammar, failureCodes, candidate) => correctGrammar(geometryBoundGrammar(grammar, candidate), failureCodes),
		renderDelivery: (input) => deliverSelectedAllViews(input),
		renderPresentation: (input) => deliverFacadeFinalPresentation({
			...input,
			deps: presentationRenderer
				? { renderEmbeddedPbrViews: presentationRenderer }
				: undefined,
		}),
		score,
	};
}
