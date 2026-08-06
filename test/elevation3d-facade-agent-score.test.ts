import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../plugins/elevation-3d/lib/enrichment.mjs";
import { validateEnrichment } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";
import { normalizeFacadeGrammar } from "../plugins/elevation-3d/lib/facade-grammar.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { extractFacadeGrammar, verifyFacadeProposal } from "../plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs";
import { scoreFacadeCandidate, selectFacadeRecommendation, selectFacadeWinner } from "../plugins/elevation-3d/lib/facade-agent/score.mjs";
import { deriveFacadeSegmentsFromMass } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

const roots: string[] = [];
const surfaces = ["front", "right", "back", "left"];
const views = [...surfaces, "top", "axon", "opposite-axon"];
const passes = ["color", "depth", "normal", "edge", "surface-id"];
const drawingNames = ["plan", "front", "back", "left", "right", "top", "axon"];
const floorGuides = { floor_guides_m: [0, 3.3, 6.6] };
const facadePlanes = { facade_planes: [
	{ view: "front", origin: [-4, -2, 0], normal: [0, -1, 0], extent_m: [8, 6.6] },
	{ view: "right", origin: [4, -2, 0], normal: [1, 0, 0], extent_m: [4, 6.6] },
	{ view: "back", origin: [4, 2, 0], normal: [0, 1, 0], extent_m: [8, 6.6] },
	{ view: "left", origin: [-4, 2, 0], normal: [-1, 0, 0], extent_m: [4, 6.6] },
] };
const sourceMesh = {
	identity: { geometry_hash: "score-geometry" },
	vertices: [
		[-4, -2, 0], [4, -2, 0], [4, 2, 0], [-4, 2, 0],
		[-4, -2, 6.6], [4, -2, 6.6], [4, 2, 6.6], [-4, 2, 6.6],
	],
	triangles: [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
		[1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	],
};
const facadeSegmentAuthority = deriveFacadeSegmentsFromMass({ mesh: sourceMesh });
const grammarOutput = {
	system: "brick-punched-window-v1", surfaces,
	materials: ["brick", "precast", "window-frame", "glass"], corner_datum_m: 0,
	bay_width_m: 2.4, window_width_m: 1.2, window_height_m: 1.65, sill_height_m: 0.85,
	reveal_depth_m: 0.22, frame_width_m: 0.06, lintel_height_m: 0.18, sill_depth_m: 0.08,
	cladding_depth_m: 0.12, brick_module_m: [0.215, 0.065], confidence: 0.92,
	unresolved_surfaces: [],
};

let root: string;
let evidence: any;
const proposalAuthorities: Record<string, any> = {};
let sequence = 0;
let gptCandidate: any;
let nanoCandidate: any;
let persistedRender: any;

after(async () => Promise.all(roots.map((item) => rm(item, { recursive: true, force: true }))));

async function authorizedGenerate(provider: any, request: any) {
	let result: any;
	await createPaidOperationLedger(join(root, `proposal-ledger-${sequence++}.json`), { approvedRoot: root }).executeOnce({
		requestKey: request.fingerprint, provider: request.provider, kind: "image-generation", ceilingUsd: 1, estimateUsd: 0.1,
		operation: async (submission: any) => {
			result = await provider.generate({ request, submission });
			return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.1 };
		},
	});
	return result;
}

function grammarConfig(provider: string) {
	return {
		candidateId: "creative-020", grammarModel: "gpt-5.6", grammarBudgetUsd: 0.1,
		grammarEstimateUsd: 0.05, grammarTimeoutMs: 1_000, openAIApiKey: "sk-fixture",
		proposalProvider: provider,
	};
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "facade-score-production-"));
	roots.push(root);
	const evidenceRoot = join(root, "evidence");
	await mkdir(evidenceRoot);
	const pixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#eeeeee" } }).png().toBuffer();
	const proposalPixel = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#923f2d" } }).png().toBuffer();
	const sourceBytes = Buffer.from("score geometry authority");
	const sourcePath = join(root, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const artifacts: Record<string, any> = {};
	for (const pass of passes) {
		await mkdir(join(evidenceRoot, pass));
		for (const view of views) {
			await writeFile(join(evidenceRoot, pass, `${view}.png`), pixel);
			artifacts[`${pass}:${view}`] = { path: `${pass}/${view}.png`, sha256: sha256(pixel), width: 1, height: 1, mode: pass, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), pixel);
	const evidenceInput = {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "score-geometry" }, floor_guides: floorGuides,
		facade_planes: facadePlanes, facade_segment_authority: facadeSegmentAuthority, cameras: { views }, mesh: sourceMesh,
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1", candidate_id: "creative-020", geometry_hash: "score-geometry",
		geometry_content_sha256: sha256(stableJson({ vertices: sourceMesh.vertices, triangles: sourceMesh.triangles })),
		floor_guides_m: floorGuides.floor_guides_m, facade_planes_sha256: sha256(stableJson(facadeSegmentAuthority)),
		facade_segment_authority_sha256: facadeSegmentAuthority.sha256,
		geometry_signed_volume_orientation: facadeSegmentAuthority.source_signed_volume_orientation,
		cameras_sha256: sha256(stableJson(evidenceInput.cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }], artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(pixel), width: 1, height: 1 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	evidence = await verifyFacadeEvidencePack({ manifestPath, input: evidenceInput });

	for (const providerName of ["gpt-image-2", "nano-banana-pro"]) {
		const build = providerName === "gpt-image-2" ? buildOpenAIRequest : buildGeminiRequest;
		const provider = providerName === "gpt-image-2"
			? createOpenAIProvider({ OPENAI_API_KEY: "sk-fixture" }, { fetchImpl: async () => Response.json({ id: "gpt-fixture", data: [{ b64_json: proposalPixel.toString("base64") }] }), timeoutMs: 1_000 })
			: createGeminiProvider({ GEMINI_API_KEY: "gemini-fixture" }, { fetchImpl: async () => Response.json({
				responseId: "gemini-fixture", candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: proposalPixel.toString("base64") } }] } }],
			}), timeoutMs: 1_000 });
		const request = build({ evidence, brief: { brief_id: "brick-punched-window-v1", candidate_id: "creative-020" }, output: { width: 1536, height: 1024, format: "png" } });
		const result = await authorizedGenerate(provider, request);
		const proposalPath = join(root, `${providerName}.png`);
		await writeFile(proposalPath, result.bytes);
		proposalAuthorities[providerName] = await verifyFacadeProposal({
			proposalPath, providerResult: result, evidence, config: grammarConfig(providerName),
		});
	}
	gptCandidate = await realCandidate("gpt-image-2");
	nanoCandidate = await realCandidate("nano-banana-pro");
});

async function realCandidate(provider: string, confidence = 0.92) {
	const extractedGrammar = await extractFacadeGrammar({
		proposalPath: proposalAuthorities[provider], evidence, config: grammarConfig(provider),
		ledger: createPaidOperationLedger(join(root, `grammar-ledger-${sequence++}.json`), { approvedRoot: root }),
		fetchImpl: async () => Response.json({
			id: `grammar-${sequence}`, status: "completed",
			output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...grammarOutput, confidence }) }] }],
			usage: { cost_usd: 0.04 },
		}),
	});
	const grammar = normalizeFacadeGrammar({ approvedDesign: { facade_grammar: extractedGrammar }, floorGuides, facadePlanes });
	if (!persistedRender) {
		const candidateRoot = join(root, `candidate-${sequence++}`);
		await mkdir(join(candidateRoot, "viewer"), { recursive: true });
		await mkdir(join(candidateRoot, "drawings"), { recursive: true });
		const glbPath = join(candidateRoot, "facade.glb");
		const artifact = await writeEnrichedGlb(buildEnrichedScene({ mesh: sourceMesh, floorGuides, facadePlanes, grammar, safeFallback: false }), glbPath);
		const configPath = join(candidateRoot, "viewer", "config.json");
		const configBytes = Buffer.from(JSON.stringify({ strategies: { hunyuan: { glb: "../facade.glb" } } }));
		await writeFile(configPath, configBytes);
		const drawingBytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#999999" } }).png().toBuffer();
		const drawings: Record<string, string> = {};
		const entries: Record<string, any> = {};
		for (const name of drawingNames) {
			const path = join(candidateRoot, "drawings", `${name}.png`);
			await writeFile(path, drawingBytes); drawings[name] = path;
			entries[name] = { path, sha256: sha256(drawingBytes), width: 2, height: 3, glb_sha256: artifact.sha256, viewer_config_sha256: sha256(configBytes) };
		}
		await writeFile(join(candidateRoot, "drawing-provenance.json"), JSON.stringify({
			selected_glb: { path: glbPath, sha256: artifact.sha256 }, viewer_config: { path: configPath, sha256: sha256(configBytes) }, drawings: entries,
		}));
		persistedRender = { artifact, drawings };
	}
	const validation = await validateEnrichment({ sourceMesh, ...persistedRender, grammar, extractedGrammar, requiredDrawings: persistedRender.drawings, facadeSegmentAuthority });
	assert.equal(validation.accepted, true, JSON.stringify(validation.codes));
	return { provider, validation, grammar, extractedGrammar };
}

async function writeCanonical(path: string, value: any) {
	const bytes = Buffer.from(stableJson(value));
	await writeFile(path, bytes);
	return { path, sha256: sha256(bytes) };
}

test("rejects caller-crafted self-consistent reports and dummy artifacts before producing components", async () => {
	const fakeRoot = join(root, "crafted");
	await mkdir(fakeRoot);
	const glb = await writeCanonical(join(fakeRoot, "facade.glb"), { exact_mass: "dummy" });
	const report = await writeCanonical(join(fakeRoot, "validation.json"), { accepted: true, codes: [], metrics: { canonical_surface_match: 1 } });
	const rejected = await scoreFacadeCandidate({ provider: "gpt-image-2", artifacts: { glb, validationReport: report } } as any);
	assert.equal(rejected.accepted, false);
	assert.equal(rejected.reason, "VALIDATION_AUTHORITY_REQUIRED");
	assert.equal("components" in rejected, false);
});

test("scores a real persisted evidence, proposal, grammar, GLB, and render-validation flow", async () => {
	const scored = await scoreFacadeCandidate(gptCandidate);
	assert.equal(scored.accepted, true);
	assert.deepEqual(scored.components, { implementability: 91.4, multiview: 100, grammar: 92, visual: 100 });
	assert.equal(scored.score, 95.4);
	assert.equal(scored.formula_version, "arr.elevation3d.facade-score.v1");
	assert.equal(scored.serialized, stableJson(scored.breakdown));
	assert.equal(scored.sha256, sha256(scored.serialized));
	assert.match(scored.breakdown.bindings.glb_sha256, /^[a-f0-9]{64}$/);
	assert.match(scored.breakdown.bindings.geometry_content_sha256, /^[a-f0-9]{64}$/);
	assert.match(scored.breakdown.bindings.evidence_sha256, /^[a-f0-9]{64}$/);
	assert.match(scored.breakdown.bindings.cameras_sha256, /^[a-f0-9]{64}$/);
	assert.match(scored.breakdown.bindings.proposal_sha256, /^[a-f0-9]{64}$/);
	assert.match(scored.breakdown.bindings.render_sha256, /^[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(scored).includes(root), false);
});

test("rejects copied validation authorities, mismatched providers, and copied score results", async () => {
	assert.equal(Object.isFrozen(gptCandidate.extractedGrammar), true);
	assert.throws(() => { gptCandidate.extractedGrammar.confidence = 0.01; }, TypeError);
	const copiedValidation = await scoreFacadeCandidate({ provider: gptCandidate.provider, validation: { ...gptCandidate.validation } });
	assert.equal(copiedValidation.accepted, false);
	assert.equal(copiedValidation.reason, "VALIDATION_AUTHORITY_REQUIRED");
	const mismatch = await scoreFacadeCandidate({ provider: "nano-banana-pro", validation: gptCandidate.validation });
	assert.equal(mismatch.reason, "PROVIDER_BINDING_MISMATCH");
	const scored = await scoreFacadeCandidate(gptCandidate);
	assert.equal(selectFacadeWinner([{ ...scored }]).status, "no-winner");
	assert.equal(selectFacadeWinner([JSON.parse(JSON.stringify(scored))]).status, "no-winner");
	assert.equal(selectFacadeWinner([scored]).provider, "gpt-image-2");
});

test("does not issue score authority for caller-derived floor bands or facade lengths", async () => {
	const forgedGrammar = {
		...gptCandidate.grammar,
		floor_elevations_m: [0, 3, 6.6],
		facade_lengths_m: { ...gptCandidate.grammar.facade_lengths_m, front: 7.9 },
	};
	const validation = await validateEnrichment({
		sourceMesh, ...persistedRender, grammar: forgedGrammar, extractedGrammar: gptCandidate.extractedGrammar,
		requiredDrawings: persistedRender.drawings,
	});
	const rejected = await scoreFacadeCandidate({ provider: "gpt-image-2", validation });
	assert.equal(rejected.accepted, false);
	assert.equal(rejected.reason, "VALIDATION_AUTHORITY_REQUIRED");
	assert.equal("components" in rejected, false);
});

test("does not issue score authority when exact-MASS is not bound to the evidence geometry identity", async () => {
	const replacementSource = {
		...sourceMesh,
		vertices: sourceMesh.vertices.map((point) => [...point]),
		identity: { geometry_hash: sourceMesh.identity.geometry_hash },
	};
	replacementSource.vertices[0][0] += 0.1;
	const validation = await validateEnrichment({
		sourceMesh: replacementSource, ...persistedRender, grammar: gptCandidate.grammar,
		extractedGrammar: gptCandidate.extractedGrammar, requiredDrawings: persistedRender.drawings,
	});
	assert.equal(validation.accepted, false);
	assert.ok(validation.codes.includes("EVIDENCE_GEOMETRY_MISMATCH"));
	const rejected = await scoreFacadeCandidate({ provider: "gpt-image-2", validation });
	assert.equal(rejected.accepted, false);
	assert.equal(rejected.reason, "VALIDATION_AUTHORITY_REQUIRED");
	assert.equal("components" in rejected, false);
});

test("uses exact 35/35/20/10 weights and provider-neutral tolerance handling", async () => {
	const gpt = await scoreFacadeCandidate(gptCandidate);
	const nanoExact = await scoreFacadeCandidate(nanoCandidate);
	const exact = selectFacadeWinner([nanoExact, gpt], 0.5);
	assert.equal(exact.status, "human-review");
	assert.equal("provider" in exact, false);
	assert.deepEqual(exact.candidates.map((candidate: any) => candidate.provider), ["gpt-image-2", "nano-banana-pro"]);
	assert.equal(selectFacadeWinner([gpt, nanoExact], -0).status, "no-winner");
	assert.deepEqual(selectFacadeRecommendation([
		{ provider: "gpt-image-2", accepted: true, score: 95, cost: { actual_total_usd: 0.5 } },
		{ provider: "qwen-image-2", accepted: true, score: 92, cost: { actual_total_usd: 0.3 } },
	]), {
		status: "recommended", technical_winner: "gpt-image-2",
		recommended_default: "qwen-image-2", quality_fallback: "gpt-image-2",
	});
});
