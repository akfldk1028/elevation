import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadCandidatePackage } from "../core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../enrichment.mjs";
import { validateEnrichment } from "../enrichment-validation.mjs";
import { deliverSelectedAllViews } from "../final-delivery.mjs";
import { renderUnifiedDrawings } from "../unified-render.mjs";
import { buildFacadeEvidencePack, verifyFacadeEvidencePack } from "./evidence.mjs";
import { extractFacadeGrammar } from "./grammar-agent.mjs";
import { createPaidOperationLedger } from "./paid-operation-ledger.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "./providers/gemini-image.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "./providers/openai-image.mjs";
import { scoreFacadeCandidate, selectFacadeWinner } from "./score.mjs";

function providerWithRequestBuilder(provider, buildRequest) {
	return Object.freeze({ preflight: provider.preflight, generate: provider.generate, buildRequest });
}

export async function createProductionFacadeAgentDependencies(config, options = {}) {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
	if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required for facade providers");
	const runDir = resolve(config.outputRoot, config.candidateId, config.runId);
	const ledgerRoot = join(runDir, "ledger");
	await mkdir(ledgerRoot, { recursive: true });
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid-operations.json"), { approvedRoot: ledgerRoot });
	const openai = createOpenAIProvider({ OPENAI_API_KEY: env.OPENAI_API_KEY }, { fetchImpl });
	const gemini = createGeminiProvider({ GEMINI_API_KEY: env.GEMINI_API_KEY }, { fetchImpl });
	const score = async (input) => scoreFacadeCandidate(input);
	score.select = selectFacadeWinner;
	return {
		ledger,
		providers: {
			"gpt-image-2": providerWithRequestBuilder(openai, buildOpenAIRequest),
			"nano-banana-pro": providerWithRequestBuilder(gemini, buildGeminiRequest),
		},
		loadCandidate: ({ datasetRoot, candidateId }) => loadCandidatePackage(datasetRoot, candidateId),
		buildEvidence: async ({ input, runDir: target, resume, manifestPath, signal }) => {
			if (resume) return verifyFacadeEvidencePack({ manifestPath, input });
			const built = await buildFacadeEvidencePack({ input, runDir: target, signal });
			return verifyFacadeEvidencePack({ manifestPath: built.manifestPath, input });
		},
		extractGrammar: (input) => extractFacadeGrammar({
			...input, fetchImpl,
			config: { ...input.config, openAIApiKey: env.OPENAI_API_KEY },
		}),
		build: async ({ provider, versionId, grammar, candidate, runDir: target }) => {
			const outputDir = join(target, "providers", provider, "artifacts");
			await mkdir(outputDir, { recursive: true });
			const scene = buildEnrichedScene({
				mesh: candidate.mesh, floorGuides: candidate.floor_guides,
				facadePlanes: candidate.facade_planes, grammar, safeFallback: false,
			});
			return writeEnrichedGlb(scene, join(outputDir, `${versionId}.glb`));
		},
		validate: async ({ provider, versionId, artifact, grammar, extractedGrammar, candidate, runDir: target, signal }) => {
			const drawings = await renderUnifiedDrawings({
				runDir: join(target, "providers", provider, "renders", versionId), glbPath: artifact.path,
				sourceMesh: candidate.mesh, cameras: candidate.cameras, signal,
			});
			return validateEnrichment({
				sourceMesh: candidate.mesh, artifact, grammar, extractedGrammar,
				requiredDrawings: drawings, safeFallback: false,
			});
		},
		renderDelivery: (input) => deliverSelectedAllViews(input),
		score,
	};
}
