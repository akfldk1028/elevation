import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { FacadeProviderError } from "../plugins/elevation-3d/lib/facade-agent/provider.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { buildFacadeArtifactClosure } from "../plugins/elevation-3d/lib/facade-agent/artifact-closure.mjs";
import { cameraContractHash, deriveExpectedCameraContract, presentationCameraPresets, technicalCameraAuthorityFromGlb } from "../plugins/elevation-3d/lib/camera-authority.mjs";
import { createFacadeFixtureTransport } from "../plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs";
import { normalizeFacadeGrammarResult } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs";
import { createProvider as createOpenAIGrammarProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/openai/adapter.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs";
import {
	consumePaidOperationSubmissionCapability,
	createPaidOperationLedger,
} from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import {
	readFacadeAgentStatus,
	runFacadeAgent,
	runFacadeStage,
} from "../plugins/elevation-3d/lib/facade-agent/harness.mjs";
import { deriveDeliveryCameras } from "../plugins/elevation-3d/lib/final-delivery.mjs";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const PROVIDERS = ["gpt-image-2", "nano-banana-pro"] as const;
const EVIDENCE_SHA = "e".repeat(64);
const HARNESS_CANDIDATE = {
	candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" },
	mesh: { vertices: [[0, 0, 0], [10, 0, 0], [0, 8, 12]], triangles: [[0, 1, 2]] },
	cameras: { identity: { source: "fixture" }, views: {
		front: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 12]], projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] } },
		right: { projection: "orthographic", projected_bounds_m: [[0, 0], [8, 12]], projection_axes: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] } },
		back: { projection: "orthographic", projected_bounds_m: [[-10, 0], [0, 12]], projection_axes: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] } },
		left: { projection: "orthographic", projected_bounds_m: [[-8, 0], [0, 12]], projection_axes: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] } },
		top: { projection: "orthographic", projected_bounds_m: [[0, 0], [10, 8]], projection_axes: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] } },
	} },
};
const HARNESS_BUILDING_BOUNDS = { center: [5, 4, 6], radius: Math.max(Math.hypot(10, 8, 12) * 0.75, 1) };
const GLB_DOCUMENT = new Document();
const GLB_BUFFER = GLB_DOCUMENT.createBuffer();
const GLB_POSITIONS = GLB_DOCUMENT.createAccessor("positions", GLB_BUFFER).setType("VEC3").setArray(new Float32Array(HARNESS_CANDIDATE.mesh.vertices.flat()));
const GLB_INDICES = GLB_DOCUMENT.createAccessor("indices", GLB_BUFFER).setType("SCALAR").setArray(new Uint16Array(HARNESS_CANDIDATE.mesh.triangles.flat()));
const GLB_PRIMITIVE = GLB_DOCUMENT.createPrimitive().setAttribute("POSITION", GLB_POSITIONS).setIndices(GLB_INDICES);
GLB_DOCUMENT.createScene("Scene").addChild(GLB_DOCUMENT.createNode("exact-mass").setMesh(GLB_DOCUMENT.createMesh("exact-mass").addPrimitive(GLB_PRIMITIVE)));
const GLB_BYTES = Buffer.from(await new NodeIO().writeBinary(GLB_DOCUMENT));
const REPLACEMENT_GLB_DOCUMENT = new Document();
REPLACEMENT_GLB_DOCUMENT.createScene("Replacement");
const REPLACEMENT_GLB_BYTES = Buffer.from(await new NodeIO().writeBinary(REPLACEMENT_GLB_DOCUMENT));
const PROVIDER_PNG = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 7, g: 8, b: 9 } } }).png().toBuffer();
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PRESENTATION_VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];

async function fixturePng(seed: number) {
	return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: seed, g: seed + 1, b: seed + 2 } } }).png().toBuffer();
}

async function writeArtifact(path: string, bytes: Buffer | string) {
	const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, value);
	return { path, sha256: sha256(value) };
}

async function exists(path: string) {
	try { return (await stat(path)).isFile(); }
	catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

async function writeDurableTechnicalDelivery(deliveryRoot: string, artifact: any) {
	await mkdir(deliveryRoot, { recursive: true });
	const selected = join(deliveryRoot, "enriched.glb");
	await copyFile(artifact.path, selected);
	const technicalCameras = (await technicalCameraAuthorityFromGlb({
		bytes: await readFile(selected), cameras: deriveDeliveryCameras(HARNESS_CANDIDATE),
	})).cameras;
	const views: Record<string, any> = {}, memoryViews: Record<string, any> = {};
	for (const [index, name] of PRESENTATION_VIEW_NAMES.entries()) {
		const camera = technicalCameras[name];
		const image = await writeArtifact(join(deliveryRoot, "views", name, `${name}.png`), await fixturePng(10 + index));
		const manifest = await writeArtifact(join(deliveryRoot, "views", name, `${name}-manifest.json`), JSON.stringify({
			schema_version: ["axon", "opposite-axon"].includes(name) ? "arr.elevation3d.competition-axon.v1"
				: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1",
			...(["plan", "top"].includes(name) ? { mode: name } : { view: name }), selected_glb_sha256: artifact.sha256, camera,
			width: 2, height: 2, content_bounds_px: { min_x: 0, min_y: 0, max_x: 2, max_y: 2 },
			...(["plan", "top"].includes(name) ? { selected_glb: { path: selected, sha256: artifact.sha256 }, cut: name === "plan"
				? { enabled: true, elevation_m: 1.2, plane_world: [0, 0, 1, -1.2] } : { enabled: false, elevation_m: null, plane_world: null } } : {}),
		}));
		const validation = await writeArtifact(join(deliveryRoot, "views", name, `${name}-validation.json`), JSON.stringify({ accepted: true, codes: [] }));
		views[name] = {
			path: `views/${name}/${name}.png`, sha256: image.sha256, width: 2, height: 2,
			selected_glb_sha256: artifact.sha256, camera, validation: { accepted: true, codes: [] },
			manifest: { path: `views/${name}/${name}-manifest.json`, sha256: manifest.sha256 },
			validation_report: { path: `views/${name}/${name}-validation.json`, sha256: validation.sha256 },
		};
		memoryViews[name] = { image, manifest, validation, selected_glb_sha256: artifact.sha256 };
	}
	const viewer = Object.fromEntries(await Promise.all([
		["html", "index.html", "<html>technical viewer</html>"],
		["app", "app.js", "globalThis.technical=true;"],
		["config", "config.json", JSON.stringify({ views: PRESENTATION_VIEW_NAMES })],
	].map(async ([key, name, bytes]) => [key, await writeArtifact(join(deliveryRoot, "viewer", name), bytes)])));
	const screenshots = {
		initial: await writeArtifact(join(deliveryRoot, "browser-verification", "viewer-initial.png"), await fixturePng(30)),
		interacted: await writeArtifact(join(deliveryRoot, "browser-verification", "viewer-interacted.png"), await fixturePng(31)),
	};
	const browserCameras = presentationCameraPresets(technicalCameras);
	const browserValue = {
		schema_version: "arr.elevation3d.browser-verification.v1", screenshots, screenshot_artifacts: screenshots,
		console_errors: [], blocked_external_requests: [], glb_load_count: 1, activated_views: [...PRESENTATION_VIEW_NAMES],
		camera_presets: Object.fromEntries(PRESENTATION_VIEW_NAMES.map((name) => [name, deriveExpectedCameraContract({ name, preset: browserCameras[name], buildingBounds: HARNESS_BUILDING_BOUNDS })])),
		camera_building_bounds: Object.fromEntries(PRESENTATION_VIEW_NAMES.map((name) => [name, HARNESS_BUILDING_BOUNDS])),
		material_stability: { transparent_depth_writers: 0, facade_detail_meshes: 8, polygon_offset_facade_details: 8, deterministic_render_order: true },
		settled_frames_identical: true, settled_frame_hashes: ["c".repeat(64), "c".repeat(64), "c".repeat(64)],
	};
	const browser = await writeArtifact(join(deliveryRoot, "browser-verification", "browser-verification.json"), JSON.stringify(browserValue));
	const validation = await writeArtifact(join(deliveryRoot, "validation.json"), JSON.stringify({ schema_version: "arr.elevation3d.all-views-validation.v1", accepted: true, codes: [] }));
	const manifestValue = {
		schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: artifact.sha256 },
		views, verified_evidence: { viewer: Object.fromEntries(Object.entries(viewer).map(([key, ref]: [string, any]) => [key, { path: `viewer/${ref.path.split(/[\\/]/).at(-1)}`, sha256: ref.sha256 }])) },
		validation: { accepted: true, codes: [] },
	};
	const manifest = await writeArtifact(join(deliveryRoot, "all-views-manifest.json"), JSON.stringify(manifestValue));
	return {
		schema_version: "arr.elevation3d.final-delivery.v1", run_dir: deliveryRoot, manifest: manifestValue,
		validation: { accepted: true, codes: [] }, views,
		memory_record: {
			schema_version: "arr.elevation3d.final-delivery-memory.v1",
			selected_glb: { path: selected, sha256: artifact.sha256 }, manifest, validation, viewer,
			browser_verification: { ...browser, screenshots }, views: memoryViews,
		},
	};
}

async function writeDurablePresentation({ runDir, presentationRoot, provider, candidateId, candidateSha256, selectedVersion, artifact, validationReceipt, technicalDelivery, input }: any) {
	await mkdir(presentationRoot, { recursive: true });
	const textured = join(presentationRoot, "textured.glb");
	await copyFile(artifact.path, textured);
	const presentationCameras = presentationCameraPresets(deriveDeliveryCameras(input));
	const cameraAuthority = {
		schema_version: "arr.elevation3d.presentation-camera-authority.v1",
		views: presentationCameras,
		sha256: cameraContractHash(presentationCameras),
	};
	const viewer = Object.fromEntries(await Promise.all([
		["html", "index.html", "<html>presentation viewer</html>"],
		["app", "app.js", "globalThis.presentation=true;"],
		["config", "config.json", JSON.stringify({ views: PRESENTATION_VIEW_NAMES })],
	].map(async ([key, name, bytes]) => [key, await writeArtifact(join(presentationRoot, "viewer", name), bytes)])));
	const views: Record<string, any> = {}, artifacts: Record<string, any> = {};
	for (const [index, name] of PRESENTATION_VIEW_NAMES.entries()) {
		const image = await writeArtifact(join(presentationRoot, "views", name, `${name}.png`), await fixturePng(50 + index));
		const mask = await writeArtifact(join(presentationRoot, "views", name, `${name}-semantic-roles.png`), await fixturePng(70 + index));
		const expected = deriveExpectedCameraContract({ name, preset: presentationCameras[name], buildingBounds: HARNESS_BUILDING_BOUNDS });
		views[name] = {
			path: image.path, sha256: image.sha256, semanticRoleMaskPath: mask.path, semanticRoleMaskSha256: mask.sha256,
			selectedGlbSha256: artifact.sha256,
			cameraEvidence: {
				building_bounds: HARNESS_BUILDING_BOUNDS, expected, actual: structuredClone(expected),
				expected_hash: cameraContractHash(expected), actual_hash: cameraContractHash(expected),
			},
		};
		artifacts[`view_${name}`] = image; artifacts[`semantic_role_mask_${name}`] = mask;
	}
	for (const [key, name] of [
		["render_style", "render-style.json"], ["presentation_evidence", "presentation-evidence.json"],
		["semantic_role_evidence", "semantic-role-evidence.json"], ["baseline_comparison", "baseline-comparison.json"],
	] as const) artifacts[key] = await writeArtifact(join(presentationRoot, name), JSON.stringify({ schema_version: `fixture.${key}.v1` }));
	artifacts.contact_sheet = await writeArtifact(join(presentationRoot, "contact-sheet.png"), await fixturePng(90));
	const render = {
		schema_version: "arr.elevation3d.embedded-pbr-render.v2", selected_glb: { path: artifact.path, sha256: artifact.sha256 },
		browser_loaded_glb: { path: textured, sha256: artifact.sha256 }, views, viewer, artifacts,
		material_mode: "embedded-pbr", render_style: { id: "competition-daylight-v1" },
		pbr_evidence: { material_count: 4, base_color_maps: 2, normal_maps: 2, metallic_roughness_maps: 2 },
		validation: { accepted: true, codes: [] }, provider_calls: 0, credits_consumed: 0,
		canonical_selection: {
			provider, candidate_id: candidateId, candidate_sha256: candidateSha256, selected_glb_sha256: artifact.sha256,
			facade_validation_receipt_sha256: validationReceipt.sha256, camera_authority_sha256: cameraAuthority.sha256,
		},
		camera_authority: cameraAuthority,
	};
	const wrapperValue = {
		schema_version: "arr.elevation3d.facade-final-presentation.v1", selected_glb: { path: artifact.path, sha256: artifact.sha256 },
		render, memory_record: { presentation: null },
	};
	const presentation = await writeArtifact(join(presentationRoot, "final-presentation.json"), `${JSON.stringify(wrapperValue, null, 2)}\n`);
	await writeArtifact(join(presentationRoot, "render-validation.json"), JSON.stringify(render));
	const closure = await buildFacadeArtifactClosure({
		runDir, closurePath: join(presentationRoot, "artifact-closure.json"), provider, candidateId, candidateSha256, selectedVersion,
		selectedGlb: artifact, validationReceipt, cameraAuthority, technicalDelivery, presentationRoot, render, presentationManifest: presentation,
	});
	return {
		...wrapperValue,
		memory_record: {
			presentation, artifact_closure: closure.ref, selected_glb: { path: artifact.path, sha256: artifact.sha256 },
			contact_sheet: artifacts.contact_sheet,
			views: Object.fromEntries(PRESENTATION_VIEW_NAMES.map((name) => [name, { ...artifacts[`view_${name}`], selected_glb_sha256: artifact.sha256 }])),
		},
	};
}

async function verifiedEvidenceFixture(root: string) {
	const evidenceRoot = join(root, "verified-evidence");
	await mkdir(evidenceRoot, { recursive: true });
	const sourceBytes = Buffer.from("geometry authority fixture");
	const sourcePath = join(root, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const artifacts: Record<string, any> = {};
	for (const mode of PASS_NAMES) {
		await mkdir(join(evidenceRoot, mode), { recursive: true });
		for (const view of VIEW_NAMES) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), PROVIDER_PNG);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(PROVIDER_PNG), width: 1, height: 1, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), PROVIDER_PNG);
	const input = {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" },
		floor_guides: { floor_guides_m: [0, 3] }, facade_planes: { planes: [] }, cameras: { views: [] },
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1", candidate_id: "creative-020",
		geometry_hash: input.identity.geometry_hash, floor_guides_m: input.floor_guides.floor_guides_m,
		facade_planes_sha256: sha256(stableJson(input.facade_planes)), cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }], artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(PROVIDER_PNG), width: 1, height: 1 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	return verifyFacadeEvidencePack({ manifestPath, input });
}

function grammar() {
	return {
		system: "brick-punched-window-v1",
		surfaces: ["front", "right", "back", "left"],
		materials: ["brick", "precast", "window-frame", "glass"],
		corner_datum_m: 0,
		bay_width_m: 2.4,
		window_width_m: 1.4,
		window_height_m: 1.8,
		sill_height_m: 0.8,
		reveal_depth_m: 0.2,
		frame_width_m: 0.06,
		lintel_height_m: 0.15,
		sill_depth_m: 0.1,
		cladding_depth_m: 0.1,
		brick_module_m: [0.22, 0.07],
		confidence: 0.92,
		unresolved_surfaces: [],
		floor_elevations_m: [0, 3, 6],
		facade_lengths_m: { front: 8, right: 6, back: 8, left: 6 },
	};
}

function fixtureGrammarResult(input: any, actualUsd = 0, grammarCandidate = grammar()) {
	assert.equal(consumePaidOperationSubmissionCapability(input.submission, {
		requestKey: input.request.fingerprint,
		provider: "byteplus-seed-mini",
		kind: "grammar-extraction",
	}), true);
	return normalizeFacadeGrammarResult({
		request: input.request,
		provider: "byteplus-seed-mini",
		resolvedModel: "seed-2-0-mini-260428",
		transport: "fixture",
		grammarCandidate,
		remoteId: `grammar-${input.provider}`,
		actualUsd,
		usage: { fixture: true },
	});
}

async function fixture(overrides: any = {}) {
	const selectedProviders = overrides.providers ?? [...PROVIDERS];
	const root = await mkdtemp(join(tmpdir(), "elevation3d-harness-"));
	roots.push(root);
	const outputRoot = join(root, "output");
	await mkdir(outputRoot, { recursive: true });
	const runId = overrides.runId ?? "facade-harness-001";
	const runDir = join(outputRoot, "creative-020", runId);
	const ledgerRoot = join(root, "ledger");
	await mkdir(ledgerRoot, { recursive: true });
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
	const calls: any = { preflight: [], generate: [], request: [], grammar: [], build: [], validate: [], delivery: [], presentation: [], score: [] };
	const validations = overrides.validations ?? {};
	const scores = overrides.scores ?? { "gpt-image-2": 91, "nano-banana-pro": 95 };
	const scoreAuthorities = new WeakSet<object>();

	const score: any = async ({ provider, validation }: any) => {
		calls.score.push(provider);
		if (validation?.accepted !== true) return Object.freeze({ status: "rejected", accepted: false, provider });
		const result = Object.freeze({ status: "scored", accepted: true, provider, score: scores[provider], sha256: sha256(`${provider}:${scores[provider]}`) });
		scoreAuthorities.add(result);
		return result;
	};
	score.rehydrate = (value: any) => { scoreAuthorities.add(value); return value; };
	score.select = (candidates: any[], tolerance = 0.5) => {
		const authorized = candidates.filter((candidate) => scoreAuthorities.has(candidate) && candidate.accepted === true)
			.sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
		if (!authorized.length) return { status: "no-winner", candidates: [] };
		const review = authorized.filter((candidate) => authorized[0].score - candidate.score <= tolerance);
		if (review.length > 1) return { status: "human-review", candidates: review, tolerance };
		return { status: "winner", provider: authorized[0].provider, candidate: authorized[0], score: authorized[0].score };
	};

	const providers = Object.fromEntries(selectedProviders.map((provider: string) => [provider, createFacadeFixtureTransport({
		preflight({ request, ceilingUsd, estimateUsd }: any) {
			calls.preflight.push({ provider, fingerprint: request.fingerprint, ceilingUsd, estimateUsd });
			return { provider, model: provider, requestBytes: 1, ceilingUsd, estimateUsd, fixture: true };
		},
		buildRequest({ evidence, brief }: any) {
			calls.request.push({ provider, evidenceSha: evidence.manifestSha256, briefId: brief.id });
			return {
				provider,
				fingerprint: sha256(stableJson({ provider, evidenceSha: evidence.manifestSha256, briefId: brief.id })),
				evidenceSha: evidence.manifestSha256,
				briefId: brief.id,
			};
		},
		async generate({ request, submission }: any) {
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider, kind: "image-generation",
			}), true);
			calls.generate.push(provider);
			if (overrides.generateFailure?.provider === provider) throw overrides.generateFailure.error;
			const bytes = PROVIDER_PNG;
			return { bytes, mimeType: "image/png", remoteId: `fixture-${provider}`, usage: { fixture: true }, actualUsd: overrides.imageCosts?.[provider] ?? 0 };
		},
	})]));
	const grammarProvider = createFacadeFixtureTransport({
		id: "byteplus-seed-mini",
		model: "seed-2-0-mini-260428",
		preflight({ ceilingUsd, estimateUsd }: any) {
			calls.preflight.push({ provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428", ceilingUsd, estimateUsd });
			return { provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428", transport: "fixture", ceilingUsd, estimateUsd };
		},
		async extract(input: any) {
			calls.grammar.push(input.provider);
			if (overrides.grammarFailure) throw overrides.grammarFailure;
			return fixtureGrammarResult(input, overrides.grammarCosts?.[input.provider] ?? 0, overrides.grammarCandidate ?? grammar());
		},
	});

	const deps: any = {
		loadCandidate: async () => structuredClone(HARNESS_CANDIDATE),
		buildEvidence: async ({ runDir: target }: any) => ({
			manifest: { candidate_id: "creative-020" }, manifestPath: join(target, "evidence", "manifest.json"),
			manifestSha256: EVIDENCE_SHA, contactSheetBytes: Buffer.from("fixture-evidence"),
		}),
		providers,
		grammarProvider,
		build: overrides.build ?? (async ({ provider, versionId, grammar: value, runDir: target }: any) => {
			calls.build.push({ provider, versionId, windowHeight: value.window_height_m });
			const directory = join(target, "fixture-artifacts", provider);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${versionId}.glb`);
			const bytes = GLB_BYTES;
			await writeFile(path, bytes);
			return { artifact: { path, sha256: sha256(bytes) } };
		}),
		validate: async ({ provider, versionId, artifact }: any) => {
			calls.validate.push({ provider, versionId });
			if (overrides.validate) return overrides.validate({ provider, versionId, artifact });
			const scripted = validations[provider]?.[versionId];
			if (scripted instanceof Error) throw scripted;
			return scripted ?? { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } };
		},
		renderDelivery: async ({ provider, artifact, deliveryRoot }: any) => {
			calls.delivery.push({ provider, artifact });
			return writeDurableTechnicalDelivery(deliveryRoot, artifact);
		},
		renderPresentation: async (input: any) => {
			const { provider, artifact, presentationRoot, technicalDelivery } = input;
			calls.presentation.push({ provider, artifact, presentationRoot, technicalDelivery });
			if (overrides.presentationFailure) throw overrides.presentationFailure;
			return writeDurablePresentation(input);
		},
		score,
		ledger,
		lifecycle: overrides.lifecycle,
	};

	return {
		root, runDir, calls, deps,
		config: {
			candidateId: "creative-020", datasetRoot: root, outputRoot, runId,
			providers: [...selectedProviders], briefId: "brick-punched-window-v1", confirmLive: false,
			imageBudgetUsd: Object.fromEntries(selectedProviders.map((provider: string) => [provider, 1])), grammarBudgetUsd: 1,
			grammarProvider: "byteplus-seed-mini", maxLocalAttempts: 2,
		},
	};
}

async function rewriteJson(path: string, value: any) {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	await writeFile(path, bytes);
	return sha256(bytes);
}

async function rewriteWinnerAsLegacy(value: any, { preserveFinalDigest = false } = {}) {
	const runPath = join(value.runDir, "run.json");
	const run = JSON.parse(await readFile(runPath, "utf8"));
	delete run.presentation_execution;
	delete run.presentation_receipt;
	if (!preserveFinalDigest) delete run.final.presentation_sha256;
	await rm(join(value.runDir, "final-presentation"), { recursive: true, force: true });
	run.final_manifest.sha256 = await rewriteJson(join(value.runDir, "final.json"), run.final);
	await rewriteJson(runPath, run);
	return run;
}

function recoveryDependencies(value: any, overrides: any = {}) {
	const calls = {
		candidate: 0,
		presentation: 0,
		paid: { image: 0, grammar: 0 },
		pipeline: { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 },
	};
	const deps = {
		...value.deps,
		providers: Object.fromEntries(Object.entries(value.deps.providers).map(([provider, entry]: [string, any]) => [provider, {
			...entry,
			async generate(input: any) { calls.paid.image += 1; return entry.generate(input); },
		}])),
		grammarProvider: {
			...value.deps.grammarProvider,
			async extract(input: any) { calls.paid.grammar += 1; return value.deps.grammarProvider.extract(input); },
		},
		async loadCandidate(input: any) {
			calls.candidate += 1;
			return overrides.loadCandidate ? overrides.loadCandidate(input) : value.deps.loadCandidate(input);
		},
		async buildEvidence(input: any) { calls.pipeline.evidence += 1; return value.deps.buildEvidence(input); },
		async build(input: any) { calls.pipeline.build += 1; return value.deps.build(input); },
		async validate(input: any) { calls.pipeline.validate += 1; return value.deps.validate(input); },
		async score(input: any) { calls.pipeline.score += 1; return value.deps.score(input); },
		async renderDelivery(input: any) { calls.pipeline.delivery += 1; return value.deps.renderDelivery(input); },
		async renderPresentation(input: any) {
			calls.presentation += 1;
			return overrides.renderPresentation ? overrides.renderPresentation(input) : value.deps.renderPresentation(input);
		},
		...(overrides.lifecycle ? { lifecycle: overrides.lifecycle } : {}),
	};
	return { calls, deps };
}

async function rewriteAsOrphanPresentationReceipt(value: any) {
	const runPath = join(value.runDir, "run.json");
	const run = JSON.parse(await readFile(runPath, "utf8"));
	const succeeded = run.presentation_execution;
	run.status = "running";
	run.final = null;
	run.delivery = null;
	run.presentation_execution = {
		status: "returned",
		provider: succeeded.provider,
		selected_version: succeeded.selected_version,
		selected_glb_sha256: succeeded.selected_glb_sha256,
		candidate_sha256: succeeded.candidate_sha256,
	};
	delete run.presentation_receipt;
	delete run.final_manifest;
	delete run.evaluation_manifest;
	delete run.comparison_memory;
	delete run.stage_manifests.compare;
	await rewriteJson(runPath, run);
	return run;
}

function assertZeroRecoveryCalls(calls: any) {
	assert.equal(calls.candidate, 0);
	assert.equal(calls.presentation, 0);
	assert.deepEqual(calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
}

async function rewriteProviderState(value: any, provider: string, mutate: (state: any) => Promise<void> | void) {
	const runPath = join(value.runDir, "run.json");
	const run = JSON.parse(await readFile(runPath, "utf8"));
	const statePath = join(value.runDir, run.provider_manifests[provider].path);
	const state = JSON.parse(await readFile(statePath, "utf8"));
	await mutate(state);
	const stateSha256 = await rewriteJson(statePath, state);
	run.providers[provider] = state;
	run.provider_manifests[provider] = { ...run.provider_manifests[provider], sha256: stateSha256, status: state.status };
	await rewriteJson(runPath, run);
	return { run, state };
}

async function rewriteGrammarAsLegacy(value: any, provider: string, providerSchema = "arr.elevation3d.facade-agent-provider.v1") {
	return rewriteProviderState(value, provider, async (state) => {
		const grammar = state.grammar;
		const receiptPath = state.grammar_receipt?.path;
		const stagePath = join(value.runDir, state.stage_manifests.grammar.path);
		const stage = JSON.parse(await readFile(stagePath, "utf8"));
		const legacyInput = {
			provider,
			proposal_sha256: grammar.proposal_sha256,
			evidence_sha256: grammar.identity.evidenceSha256,
		};
		const legacyOutput = { grammar_sha256: grammar.artifact_sha256, grammar_path: grammar.path };
		delete stage.input;
		stage.input_sha256 = sha256(stableJson(legacyInput));
		stage.output = legacyOutput;
		stage.output_sha256 = sha256(stableJson(legacyOutput));
		const stageSha256 = await rewriteJson(stagePath, stage);
		state.schema_version = providerSchema;
		state.grammar = {
			status: "succeeded",
			proposal_sha256: grammar.proposal_sha256,
			artifact_sha256: grammar.artifact_sha256,
			path: grammar.path,
			cost_receipt: grammar.cost_receipt,
			...(grammar.authority ? { authority: grammar.authority } : {}),
		};
		state.stage_manifests.grammar = {
			...state.stage_manifests.grammar,
			sha256: stageSha256,
			output_sha256: stage.output_sha256,
		};
		delete state.grammar_receipt;
		if (receiptPath) await rm(join(value.runDir, receiptPath));
	});
}

test("persists a redacted three-provider cost and practical-equivalence recommendation", async () => {
	const providers = ["gpt-image-2", "seedream-5-pro", "qwen-image-2"];
	const value = await fixture({
		runId: "three-provider-recommendation", providers,
		scores: { "gpt-image-2": 95, "seedream-5-pro": 93, "qwen-image-2": 92 },
		imageCosts: { "gpt-image-2": 0.4, "seedream-5-pro": 0.08, "qwen-image-2": 0.02 },
		grammarCosts: { "gpt-image-2": 0.1, "seedream-5-pro": 0.02, "qwen-image-2": 0.03 },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.generate, providers);
	assert.deepEqual(value.calls.grammar, providers);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), providers);
	assert.ok(providers.every((provider) => result.providers[provider].delivery?.status === "succeeded"));
	assert.equal(result.final.technical_winner, "gpt-image-2");
	assert.equal(result.final.recommended_default, "qwen-image-2");
	assert.equal(result.final.quality_fallback, "gpt-image-2");
	assert.equal(result.final.cost.actual_total_usd, 0.65);
	assert.equal(result.providers["gpt-image-2"].generation.transport, "fixture");
	assert.equal(result.providers["gpt-image-2"].grammar.transport, "fixture");
	assert.deepEqual(result.comparison_memory.selected_providers, providers);
	assert.equal(result.comparison_memory.recommended_default, "qwen-image-2");
	assert.match(result.evaluation_manifest.path, /^evaluation\/evaluation\.json$/);
	const report = JSON.parse(await readFile(join(value.runDir, result.evaluation_manifest.path), "utf8"));
	assert.deepEqual(Object.keys(report.providers), [...providers].sort());
	assert.equal(report.providers["qwen-image-2"].cost.actual_total_usd, 0.05);
	const serialized = JSON.stringify(report);
	for (const provider of providers) {
		assert.equal(serialized.includes(`fixture-${provider}`), false);
		assert.equal(serialized.includes(`grammar-${provider}`), false);
	}
	assert.equal(/https?:|token|secret/i.test(serialized), false);
});

test("status fails closed when the persisted evaluation report is tampered", async () => {
	const value = await fixture({ runId: "tampered-evaluation-report" });
	const result = await runFacadeAgent(value.config, value.deps);
	await writeFile(join(value.runDir, result.evaluation_manifest.path), "{}\n");
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("isolates one failed provider without fallback or duplicate submissions", async () => {
	const providers = ["gpt-image-2", "seedream-5-pro", "qwen-image-2"];
	const value = await fixture({
		runId: "isolated-provider-failure", providers,
		scores: { "gpt-image-2": 95, "qwen-image-2": 94 },
		generateFailure: {
			provider: "seedream-5-pro",
			error: new FacadeProviderError("PROVIDER_AUTH_FAILED", "credential rejected", {
				provider: "seedream-5-pro", stage: "generate", definitiveNonSubmission: true,
			}),
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.generate, providers);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "qwen-image-2"]);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), ["gpt-image-2", "qwen-image-2"]);
	assert.deepEqual(result.image_submissions.by_provider, {
		"gpt-image-2": 1, "seedream-5-pro": 0, "qwen-image-2": 1,
	});
	assert.equal(result.providers["seedream-5-pro"].failure.code, "PROVIDER_AUTH_FAILED");
	assert.equal(result.final.technical_winner, "gpt-image-2");
});

test("submits each image and grammar exactly once, applies only v002 locally, and delivers only the authorized winner", async () => {
	const value = await fixture({
		validations: {
			"gpt-image-2": {
				v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true },
				v002: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true },
			},
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);

	assert.deepEqual(value.calls.generate, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.request, [...PROVIDERS, ...PROVIDERS].map((provider) => ({ provider, evidenceSha: EVIDENCE_SHA, briefId: "brick-punched-window-v1" })));
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.ok(value.calls.build[1].windowHeight < value.calls.build[0].windowHeight);
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
	assert.equal(result.final.selected_provider, "nano-banana-pro");
	assert.equal(value.calls.delivery.length, 1);
	assert.equal(value.calls.delivery[0].provider, "nano-banana-pro");
	assert.equal(value.calls.delivery[0].artifact.sha256, result.final.selected_glb_sha256);

	const persisted = await readFacadeAgentStatus(value.runDir);
	assert.deepEqual(persisted, result);
	assert.match(await readFile(join(value.runDir, "run.json"), "utf8"), /"input_sha256"/);
	for (const provider of PROVIDERS) {
		const proposalSha256 = result.providers[provider].proposal.sha256;
		const identity = {
			provider: "byteplus-seed-mini",
			model: "seed-2-0-mini-260428",
			proposalProvider: provider,
			proposalSha256,
			evidenceSha256: EVIDENCE_SHA,
		};
		assert.deepEqual(result.providers[provider].grammar.identity, identity);
		const grammarStage = JSON.parse(await readFile(join(value.runDir, "providers", provider, "stages", "grammar.json"), "utf8"));
		assert.deepEqual(grammarStage.input, {
			provider,
			grammar_provider: identity.provider,
			grammar_model: identity.model,
			proposal_sha256: proposalSha256,
			evidence_sha256: EVIDENCE_SHA,
		});
		const receipt = JSON.parse(await readFile(join(value.runDir, result.providers[provider].grammar_receipt.path), "utf8"));
		assert.equal(receipt.schema_version, "arr.elevation3d.facade-grammar-receipt.v1");
		assert.deepEqual(receipt.identity, identity);
		assert.equal(receipt.result.provider, identity.provider);
		assert.equal(receipt.result.model, identity.model);
		assert.equal(receipt.result.transport, "fixture");
		assert.equal(receipt.artifact.sha256, result.providers[provider].grammar.artifact_sha256);
	}
	assert.match(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "validate-v002.json"), "utf8"), /"previous"/);
	const v002Build = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "stages", "build-v002.json"), "utf8"));
	assert.equal(v002Build.previous.stage, "validate");
	assert.equal(v002Build.previous.status, "succeeded");
	const v002Grammar = await readFile(join(value.runDir, "providers", "gpt-image-2", "grammar-v002.json"), "utf8");
	const correction = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "correction-v002.json"), "utf8"));
	assert.equal(correction.schema_version, "arr.elevation3d.facade-correction.v1");
	assert.equal(correction.input_grammar_sha256, result.providers["gpt-image-2"].versions[0].grammar_sha256);
	assert.equal(correction.output_grammar_sha256, sha256(stableJson(JSON.parse(v002Grammar))));
	assert.deepEqual(correction.correction_codes, ["WINDOW_CROSSES_FLOOR_BAND"]);
	assert.deepEqual(correction.changed_fields, ["window_height_m"]);
	assert.equal(v002Build.input_sha256.length, 64);
});

test("missing or tampered v002 grammar artifacts fail closed before v002 build on resume", async (context) => {
	for (const mode of ["missing", "tampered"] as const) await context.test(mode, async () => {
		let crash = true;
		const value = await fixture({
			runId: `v002-artifact-${mode}`,
			validations: { "gpt-image-2": { v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true } } },
			lifecycle: { onTransition(event: any) {
				if (crash && event.stage === "correction" && event.status === "succeeded") {
					crash = false;
					throw new Error("crash after correction persistence");
				}
			} },
		});
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), /correction persistence/);
		const path = join(value.runDir, "providers", "gpt-image-2", "grammar-v002.json");
		if (mode === "missing") await rm(path);
		else await writeFile(path, `${JSON.stringify({ ...grammar(), window_height_m: 0.9 }, null, 2)}\n`);
		const before = value.calls.build.length;
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
		assert.equal(value.calls.build.length, before);
	});
});

test("runFacadeStage stops after the requested durable stage", async () => {
	const value = await fixture({ runId: "single-stage-generate" });
	const result = await runFacadeStage("generate", value.config, value.deps);
	assert.deepEqual(value.calls.generate, ["gpt-image-2", "nano-banana-pro"]);
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(result.stage_manifests.generate.status, "succeeded");
	await assert.rejects(() => runFacadeStage("not-a-stage", value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_STAGE_INVALID");
});

test("build stage cannot invent v002 before v001 validation authorizes a correction", async () => {
	const value = await fixture({ runId: "single-stage-build" });
	const result = await runFacadeStage("build", value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001"]);
	assert.deepEqual(result.providers["nano-banana-pro"].versions.map((version: any) => version.id), ["v001"]);
});

test("refuses an unconfirmed non-fixture transport before any paid callback", async () => {
	const value = await fixture({ runId: "unconfirmed-live" });
	value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "live" };
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "LIVE_CONFIRMATION_REQUIRED");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("preflight and evidence build verified request evidence and capability receipts without paid callbacks", async () => {
	for (const stage of ["preflight", "evidence"] as const) {
		const value = await fixture({ runId: `unconfirmed-local-${stage}` });
		assert.equal(value.deps.providers["nano-banana-pro"].transport, "fixture");
		assert.equal(value.deps.grammarProvider.transport, "fixture");
		value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "live" };
		const result = await runFacadeStage(stage, value.config, value.deps);
		assert.equal(result.stage_manifests[stage].status, "succeeded");
		assert.deepEqual(value.calls.generate, []);
		assert.deepEqual(value.calls.grammar, []);
		assert.equal(value.calls.preflight.length, 3);
		assert.equal(result.preflight_receipt.receipt_sha256.length, 64);
		const receipt = JSON.parse(await readFile(join(value.runDir, result.preflight_receipt.path), "utf8"));
		assert.equal(receipt.evidence_sha256, EVIDENCE_SHA);
		assert.equal(receipt.budget.run.ceiling_usd, 3);
		assert.equal(receipt.budget.grammar.ceiling_usd, 1);
		assert.equal(Object.keys(receipt.requests).length, 2);
		assert.deepEqual(receipt.capabilities["grammar:byteplus-seed-mini"], {
			available: true, provider: "byteplus-seed-mini", model: "seed-2-0-mini-260428",
			transport: "fixture", ceilingUsd: 1, estimateUsd: 1,
		});
	}
});

test("preflight fails deterministically on a missing non-network capability before fetch or ledger work", async () => {
	const value = await fixture({ runId: "missing-preflight-capability" });
	value.deps.providers["gpt-image-2"] = { generate: value.deps.providers["gpt-image-2"].generate, buildRequest: value.deps.providers["gpt-image-2"].buildRequest };
	await assert.rejects(() => runFacadeStage("preflight", value.config, value.deps), (error: any) => error.code === "PREFLIGHT_CAPABILITY_MISSING");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("a caller-set fixture label cannot authorize an unconfirmed transport", async () => {
	const value = await fixture({ runId: "forged-fixture-label" });
	value.deps.providers["gpt-image-2"] = { ...value.deps.providers["gpt-image-2"], transport: "fixture" };
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "LIVE_CONFIRMATION_REQUIRED");
	assert.deepEqual(value.calls.generate, []);
});

test("grammar provider receives a provider-bound capability consumable only once", async () => {
	const value = await fixture({ runId: "grammar-capability-once" });
	value.deps.grammarProvider = createFacadeFixtureTransport({
		id: "byteplus-seed-mini",
		model: "seed-2-0-mini-260428",
		preflight: value.deps.grammarProvider.preflight,
		async extract(input: any) {
			const expected = {
				requestKey: input.request.fingerprint,
				provider: "byteplus-seed-mini",
				kind: "grammar-extraction",
			};
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), true);
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), false);
			return normalizeFacadeGrammarResult({
				request: input.request, provider: expected.provider, resolvedModel: "seed-2-0-mini-260428",
				transport: "fixture", grammarCandidate: grammar(), remoteId: `grammar-${input.provider}`, actualUsd: 0,
			});
		},
	});

	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "winner");
});

test("OpenAI and BytePlus grammar routes receive the same unconsumed ledger submission capability", async () => {
	const value = await fixture({ runId: "openai-common-grammar-capability", providers: ["gpt-image-2"] });
	value.config.grammarProvider = "openai-gpt-5.6";
	value.deps.grammarProvider = createFacadeFixtureTransport({
		id: "openai-gpt-5.6",
		model: "gpt-5.6",
		async extract(input: any) {
			const expected = { requestKey: input.request.fingerprint, provider: "openai-gpt-5.6", kind: "grammar-extraction" };
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), true);
			assert.equal(consumePaidOperationSubmissionCapability(input.submission, expected), false);
			return normalizeFacadeGrammarResult({
				request: input.request, provider: expected.provider, resolvedModel: "gpt-5.6",
				transport: "fixture", grammarCandidate: grammar(), remoteId: "openai-common-capability", actualUsd: 0,
			});
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "winner");
});

test("selected grammar adapter errors never fall back or retry", async () => {
	const value = await fixture({
		runId: "grammar-no-fallback", providers: ["gpt-image-2"],
		grammarFailure: new FacadeProviderError("SUBMISSION_UNCERTAIN", "BytePlus outcome is uncertain", {
			provider: "byteplus-seed-mini", stage: "grammar",
		}),
	});
	let openAICalls = 0;
	value.deps.extractGrammar = async () => { openAICalls += 1; throw new Error("OpenAI fallback must not run"); };

	const first = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	assert.equal(openAICalls, 0);
	assert.equal(first.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	assert.equal(openAICalls, 0);
	assert.equal(resumed.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");
});

test("a submitting grammar stage without a receipt resumes uncertain with zero adapter calls", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-submitting-resume", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "submitting") {
				crash = false;
				throw new Error("crash before grammar adapter");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash before grammar adapter/);
	assert.deepEqual(value.calls.grammar, []);
	const persisted = JSON.parse(await readFile(join(value.runDir, "providers", "gpt-image-2", "state.json"), "utf8"));
	assert.equal(persisted.grammar.status, "submitting");
	assert.equal(persisted.grammar_receipt, undefined);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(resumed.providers["gpt-image-2"].failure.code, "SUBMISSION_UNCERTAIN");
});

test("a persisted legacy v1 grammar result remains readable and resumes without another adapter call", async () => {
	const { floor_elevations_m: _floors, facade_lengths_m: _lengths, ...canonicalGrammar } = grammar();
	const value = await fixture({
		runId: "legacy-v1-grammar-resume", providers: ["gpt-image-2"], grammarCandidate: canonicalGrammar,
	});
	const verifiedEvidence = await verifiedEvidenceFixture(value.runDir);
	value.deps.buildEvidence = async () => verifiedEvidence;
	await runFacadeStage("grammar", value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	await rewriteGrammarAsLegacy(value, "gpt-image-2");
	const beforeStatus = await readFile(join(value.runDir, "run.json"), "utf8");
	const providerStatePath = join(value.runDir, "providers", "gpt-image-2", "state.json");
	const beforeProviderStatus = await readFile(providerStatePath, "utf8");

	const status = await readFacadeAgentStatus(value.runDir);
	assert.equal(status.providers["gpt-image-2"].grammar.status, "succeeded");
	assert.equal(await readFile(join(value.runDir, "run.json"), "utf8"), beforeStatus);
	assert.equal(await readFile(providerStatePath, "utf8"), beforeProviderStatus);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("a new provider-state schema cannot downgrade missing grammar receipt into legacy compatibility", async () => {
	const value = await fixture({ runId: "new-schema-missing-grammar-receipt", providers: ["gpt-image-2"] });
	await runFacadeStage("grammar", value.config, value.deps);
	await rewriteGrammarAsLegacy(value, "gpt-image-2", "arr.elevation3d.facade-agent-provider.v2");

	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("a crash at grammar returned observes a hash-bound receipt and resumes without another adapter call", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-returned-durable", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "returned") {
				crash = false;
				throw new Error("crash after grammar returned");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after grammar returned/);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);

	const status = await readFacadeAgentStatus(value.runDir);
	const persisted = status.providers["gpt-image-2"];
	assert.equal(persisted.grammar.status, "succeeded");
	const artifactBytes = await readFile(join(value.runDir, persisted.grammar.path));
	const receiptBytes = await readFile(join(value.runDir, persisted.grammar_receipt.path));
	const receipt = JSON.parse(receiptBytes.toString("utf8"));
	assert.equal(sha256(artifactBytes), persisted.grammar.artifact_sha256);
	assert.equal(receipt.artifact.sha256, persisted.grammar.artifact_sha256);
	assert.equal(sha256(receiptBytes), persisted.grammar_receipt.sha256);

	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
});

test("an abort before grammar submission remains a cancellation without an adapter call", async () => {
	const controller = new AbortController();
	const value = await fixture({
		runId: "grammar-pre-submission-abort", providers: ["gpt-image-2"],
		lifecycle: { onTransition(event: any) {
			if (event.stage === "generate" && event.status === "succeeded") controller.abort();
		} },
	});
	value.deps.signal = controller.signal;

	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "cancelled");
	assert.deepEqual(value.calls.grammar, []);
	assert.equal(result.providers["gpt-image-2"].failure.code, "FACADE_AGENT_CANCELLED");
});

test("a missing shared grammar ledger fails closed before any paid callback", async () => {
	const value = await fixture({ runId: "grammar-ledger-missing" });
	value.deps.ledger = { image: value.deps.ledger, grammar: {} };

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_LEDGER_AGGREGATE_UNAVAILABLE");
	assert.deepEqual(value.calls.generate, []);
	assert.deepEqual(value.calls.grammar, []);
});

test("a crash after grammar ledger success cannot repeat the grammar callback", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-returned-crash",
		lifecycle: {
			onTransition(event: any) {
				if (crash && event.stage === "grammar" && event.status === "returned") {
					crash = false;
					throw new Error("crash after grammar ledger success");
				}
			},
		},
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after grammar ledger success/);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2"]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.grammar, ["gpt-image-2", "nano-banana-pro"]);
	assert.equal(resumed.providers["gpt-image-2"].grammar.status, "succeeded");
	assert.equal(resumed.providers["gpt-image-2"].failure, null);
	assert.equal(resumed.final.status, "winner");
});

test("resume after canonical grammar persistence continues local work without paid calls", async () => {
	let crash = true;
	const value = await fixture({
		runId: "grammar-persisted-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "grammar" && event.status === "succeeded" && event.provider === "nano-banana-pro") {
				crash = false;
				throw new Error("crash after canonical grammar persistence");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /canonical grammar persistence/);
	assert.deepEqual(value.calls.generate, [...PROVIDERS]);
	assert.deepEqual(value.calls.grammar, [...PROVIDERS]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.deepEqual(value.calls.generate, [...PROVIDERS]);
	assert.deepEqual(value.calls.grammar, [...PROVIDERS]);
	assert.equal(value.calls.delivery.length, 2);
});

test("rejects false hashes and structurally invalid GLBs before validation or delivery", async (context) => {
	for (const scenario of ["false-hash", "invalid-glb"]) await context.test(scenario, async () => {
		const value = await fixture({
			runId: `bad-artifact-${scenario}`,
			async build({ provider, versionId, runDir }: any) {
				const directory = join(runDir, "bad-artifacts", provider);
				await mkdir(directory, { recursive: true });
				const path = join(directory, `${versionId}.glb`);
				const bytes = scenario === "false-hash" ? GLB_BYTES : Buffer.from("not-a-glb");
				await writeFile(path, bytes);
				return { artifact: { path, sha256: scenario === "false-hash" ? "f".repeat(64) : sha256(bytes) } };
			},
		});

		const result = await runFacadeAgent(value.config, value.deps);
		assert.deepEqual(value.calls.validate, []);
		assert.deepEqual(value.calls.delivery, []);
		assert.match(result.providers["gpt-image-2"].versions[0].failure.code, /FACADE_BUILD_ARTIFACT_(HASH_MISMATCH|INVALID)/);
	});
});

test("re-reads and re-hashes the canonical GLB immediately before validation", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-before-validation",
		lifecycle: {
			async onTransition(event: any) {
				if (event.stage === "build" && event.status === "succeeded") {
					const artifact = value.calls.build.at(-1);
					await writeFile(join(value.runDir, "fixture-artifacts", event.provider, `${event.version_id}.glb`), REPLACEMENT_GLB_BYTES);
					assert.ok(artifact);
				}
			},
		},
	});

	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.providers["gpt-image-2"].versions[0].failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("rejects a GLB path routed through a junction before validation", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-junction",
		async build({ provider, versionId, runDir }: any) {
			const outside = join(value.root, "outside-artifacts", provider);
			const links = join(runDir, "artifact-links");
			await mkdir(outside, { recursive: true });
			await mkdir(links, { recursive: true });
			const link = join(links, provider);
			await symlink(outside, link, "junction");
			const path = join(link, `${versionId}.glb`);
			await writeFile(join(outside, `${versionId}.glb`), GLB_BYTES);
			return { artifact: { path, sha256: sha256(GLB_BYTES) } };
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.validate, []);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.providers["gpt-image-2"].versions[0].failure.code, "FACADE_AGENT_PATH_UNSAFE");
});

test("re-hashes the selected GLB immediately before delivery", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-before-delivery",
		lifecycle: { async onTransition(event: any) {
			if (event.stage === "score-receipt" && event.status === "succeeded" && event.provider === "nano-banana-pro") {
				await writeFile(join(value.runDir, "fixture-artifacts", event.provider, "v001.glb"), REPLACEMENT_GLB_BYTES);
			}
		} },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.delivery.map((call: any) => call.provider), ["gpt-image-2"]);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
	assert.equal(result.providers["nano-banana-pro"].delivery.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("re-authorizes the GLB after the delivery checkpoint hook", async () => {
	let value: any;
	value = await fixture({
		runId: "artifact-replaced-in-delivery-hook",
		lifecycle: { async onTransition(event: any) {
			if (event.stage === "delivery" && event.status === "submitting") {
				await writeFile(join(value.runDir, "fixture-artifacts", event.provider, "v001.glb"), REPLACEMENT_GLB_BYTES);
			}
		} },
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(value.calls.delivery, []);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
});

test("validation receives only an immutable canonical artifact authority", async () => {
	let validations = 0;
	const value = await fixture({
		runId: "canonical-artifact-authority",
		validate({ artifact }: any) {
			validations += 1;
			assert.equal(Object.isFrozen(artifact), true);
			assert.equal(artifact.sha256, sha256(GLB_BYTES));
			assert.equal(artifact.size_bytes, GLB_BYTES.length);
			assert.equal(Object.getPrototypeOf(artifact), Object.prototype);
			return { accepted: true, codes: [], metrics: {}, artifacts: { glb: artifact.path, glb_sha256: artifact.sha256 } };
		},
	});
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(validations, 2);
	assert.equal(result.final.status, "winner");
});

test("resume after a rejected v001 validation receipt continues with v002 without revalidation", async () => {
	let crash = true;
	const value = await fixture({
		runId: "validation-receipt-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "validation-receipt" && event.status === "succeeded") {
				crash = false;
				throw new Error("crash after validation receipt");
			}
		} },
		validations: { "gpt-image-2": { v001: { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true }, v002: { accepted: true, codes: [] } } },
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after validation receipt/);
	assert.deepEqual(value.calls.validate, [{ provider: "gpt-image-2", versionId: "v001" }]);
	assert.deepEqual(value.calls.score, []);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.equal(value.calls.validate.filter((call: any) => call.provider === "gpt-image-2" && call.versionId === "v001").length, 1);
	assert.ok(value.calls.build.some((call: any) => call.provider === "gpt-image-2" && call.versionId === "v002"));
	assert.equal(value.calls.delivery.length, 2);
});

test("resume after a durable score receipt continues comparison and delivery without rescoring", async () => {
	let crash = true;
	const value = await fixture({
		runId: "score-receipt-crash",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "score-receipt" && event.status === "succeeded") {
				crash = false;
				throw new Error("crash after score receipt");
			}
		} },
	});

	await assert.rejects(() => runFacadeAgent(value.config, value.deps), /crash after score receipt/);
	assert.deepEqual(value.calls.validate, [{ provider: "gpt-image-2", versionId: "v001" }]);
	assert.deepEqual(value.calls.score, ["gpt-image-2"]);
	const resumed = await runFacadeAgent(value.config, value.deps);
	assert.equal(resumed.final.status, "winner");
	assert.equal(value.calls.score.filter((provider: string) => provider === "gpt-image-2").length, 1);
	assert.equal(value.calls.delivery.length, 2);
});

test("in-flight markers prevent callback replay before validation and score receipt publication", async (context) => {
	for (const boundary of ["validate", "score"]) await context.test(boundary, async () => {
		let crash = true;
		const value = await fixture({
			runId: `${boundary}-returned-before-receipt`,
			lifecycle: { onTransition(event: any) {
				if (crash && event.stage === boundary && event.status === "returned") {
					crash = false;
					throw new Error(`crash after ${boundary} returned`);
				}
			} },
		});
		await assert.rejects(() => runFacadeAgent(value.config, value.deps), new RegExp(`crash after ${boundary} returned`));
		const validateCount = value.calls.validate.length;
		const scoreCount = value.calls.score.length;
		const resumed = await runFacadeAgent(value.config, value.deps);
		assert.equal(resumed.final.status, "blocked");
		assert.equal(resumed.final.failure.code, "DURABLE_RECEIPT_RECONCILIATION_REQUIRED");
		assert.equal(value.calls.validate.length, validateCount);
		assert.equal(value.calls.score.length, scoreCount);
		assert.equal(value.calls.delivery.length, 0);
	});
});

test("terminal status rejects a missing durable receipt", async () => {
	const value = await fixture({ runId: "terminal-missing-receipt" });
	const result = await runFacadeAgent(value.config, value.deps);
	const ref = result.providers["gpt-image-2"].versions[0].validation_receipt;
	await rm(join(value.runDir, ref.path));
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("terminal status rejects a grammar artifact that no longer matches its receipt", async () => {
	const value = await fixture({ runId: "terminal-tampered-grammar" });
	const result = await runFacadeAgent(value.config, value.deps);
	await writeFile(join(value.runDir, result.providers["gpt-image-2"].grammar.path), "{}\n");
	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("preserves request identity through actual provider factories with mocked fetch", async () => {
	const value = await fixture({ runId: "actual-provider-request-identity" });
	const verifiedEvidence = await verifiedEvidenceFixture(value.runDir);
	const fetchCalls = { openai: 0, gemini: 0, grammar: 0 };
	const openai = createOpenAIProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.openai += 1;
			return Response.json({ id: "openai-fixture-id", data: [{ b64_json: PROVIDER_PNG.toString("base64") }], usage: { input_tokens: 1, output_tokens: 1 } });
		},
		timeoutMs: 1_000,
	});
	const gemini = createGeminiProvider({ GEMINI_API_KEY: "gemini-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.gemini += 1;
			return Response.json({
				responseId: "gemini-fixture-id", modelVersion: "gemini-3-pro-image",
				candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: PROVIDER_PNG.toString("base64") } }] } }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
			});
		},
		timeoutMs: 1_000,
	});
	value.deps.buildEvidence = async () => verifiedEvidence;
	value.deps.providers = {
		"gpt-image-2": Object.freeze({ buildRequest: buildOpenAIRequest, preflight: openai.preflight, generate: openai.generate }),
		"nano-banana-pro": Object.freeze({ buildRequest: buildGeminiRequest, preflight: gemini.preflight, generate: gemini.generate }),
	};
	const grammarProvider = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => {
			fetchCalls.grammar += 1;
			const { floor_elevations_m: _floors, facade_lengths_m: _lengths, ...value } = grammar();
			return Response.json({
				id: `grammar-${fetchCalls.grammar}`, status: "completed",
				output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
				usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.04 },
			});
		},
		timeoutMs: 1_000,
	});
	value.deps.grammarProvider = Object.freeze({
		id: "openai-gpt-5.6", model: "gpt-5.6", transport: "live",
		preflight: grammarProvider.preflight, extract: grammarProvider.extract,
	});
	value.config.grammarProvider = "openai-gpt-5.6";
	value.config.confirmLive = true;
	value.config.confirmedTotalUsd = 3;

	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(fetchCalls, { openai: 1, gemini: 1, grammar: 2 });
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
});

test("a crash after delivery returns persists uncertainty and never invokes delivery again", async () => {
	let crashed = false;
	const first = await fixture({ runId: "delivery-crash", lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "delivery" && event.status === "returned") {
				crashed = true;
				throw new Error("fixture crash after delivery returned");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.equal(first.calls.delivery.length, 1);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.equal(resumed.calls.delivery.length, 0);
	assert.equal(result.final.status, "delivery-failed");
	assert.equal(result.final.failure.code, "FINAL_DELIVERY_UNCERTAIN");
});

test("a crash after delivery success is checkpointed cannot repeat delivery before final selection", async () => {
	let crashed = false;
	const first = await fixture({ runId: "delivery-success-crash", lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "delivery" && event.status === "succeeded") {
				crashed = true;
				throw new Error("fixture crash after delivery success checkpoint");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.equal(first.calls.delivery.length, 1);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.equal(resumed.calls.delivery.length, 0);
	assert.equal(result.final.failure.code, "FINAL_DELIVERY_UNCERTAIN");
});

test("refuses to write manifests through a junction beneath the run directory", async (context) => {
	const value = await fixture({ runId: "junction-run" });
	const outside = join(value.root, "outside-stages");
	await mkdir(join(value.runDir, "providers", "gpt-image-2"), { recursive: true });
	await mkdir(outside);
	try { await symlink(outside, join(value.runDir, "providers", "gpt-image-2", "stages"), "junction"); }
	catch (error: any) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return context.skip("junction creation is unavailable");
		throw error;
	}
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), (error: any) => error.code === "FACADE_AGENT_PATH_UNSAFE");
	assert.deepEqual(value.calls.generate, []);
	await assert.rejects(() => readFile(join(outside, "generate-submitting.json")), (error: any) => error.code === "ENOENT");
});

test("ends after v002 rejection and produces no winner when both providers reject", async () => {
	const rejection = { accepted: false, codes: ["WINDOW_CROSSES_FLOOR_BAND"], retryable: true };
	const value = await fixture({ validations: {
		"gpt-image-2": { v001: rejection, v002: rejection },
		"nano-banana-pro": { v001: rejection, v002: rejection },
	} });
	const result = await runFacadeAgent(value.config, value.deps);
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.deepEqual(result.providers["nano-banana-pro"].versions.map((version: any) => version.id), ["v001", "v002"]);
	assert.equal(result.final.status, "no-winner");
	assert.equal(value.calls.delivery.length, 0);
	assert.equal(value.calls.generate.length, 2);
	assert.equal(value.calls.grammar.length, 2);
});

test("breaks an authorized technical tie by provider ID after rendering both accepted candidates", async () => {
	const value = await fixture({ scores: { "gpt-image-2": 90, "nano-banana-pro": 90 } });
	const result = await runFacadeAgent(value.config, value.deps);
	assert.equal(result.final.status, "winner");
	assert.equal(result.final.selected_provider, "gpt-image-2");
	assert.equal(result.final.technical_winner, "gpt-image-2");
	assert.equal(value.calls.delivery.length, 2);
});

test("persists one durable Task 1-shaped beauty presentation for the technical winner only", async () => {
	const value = await fixture({ runId: "winner-only-presentation" });
	const result = await runFacadeAgent(value.config, value.deps);

	assert.equal(result.final.status, "winner");
	assert.deepEqual(value.calls.presentation.map((call: any) => call.provider), [result.final.selected_provider]);
	assert.equal(result.presentation_execution.status, "succeeded");
	assert.equal(result.presentation_receipt.receipt_sha256, result.final.presentation_sha256);
	const receipt = JSON.parse(await readFile(join(value.runDir, result.presentation_receipt.path), "utf8"));
	assert.equal(receipt.technical_manifest.path.includes(":"), false);
	assert.equal(receipt.presentation_manifest.path.includes(":"), false);
	assert.deepEqual(receipt.technical_manifest, result.providers[result.final.selected_provider].delivery.memory_record.manifest);
});

test("recovers a legacy terminal winner through presentation only", async () => {
	const value = await fixture({ runId: "legacy-terminal-presentation-recovery" });
	await runFacadeAgent(value.config, value.deps);
	await rewriteWinnerAsLegacy(value);
	const recovery = recoveryDependencies(value);

	const recovered = await runFacadeAgent(value.config, recovery.deps);

	assert.equal(recovered.final.status, "winner");
	assert.equal(recovery.calls.presentation, 1);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("a valid terminal presentation receipt is idempotent zero work", async () => {
	const value = await fixture({ runId: "terminal-presentation-idempotent" });
	const persisted = await runFacadeAgent(value.config, value.deps);
	const recovery = recoveryDependencies(value);

	const resumed = await runFacadeAgent(value.config, recovery.deps);

	assert.deepEqual(resumed.presentation_receipt, persisted.presentation_receipt);
	assert.equal(recovery.calls.candidate, 0);
	assert.equal(recovery.calls.presentation, 0);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("a valid orphan presentation receipt zero-call finalizes after the post-receipt crash", async () => {
	let crash = true;
	const first = await fixture({
		runId: "presentation-orphan-receipt",
		lifecycle: { onTransition(event: any) {
			if (crash && event.stage === "presentation" && event.status === "receipt-persisted") {
				crash = false;
				throw new Error("crash after presentation receipt persisted");
			}
		} },
	});
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /crash after presentation receipt persisted/);
	const persisted = JSON.parse(await readFile(join(first.runDir, "run.json"), "utf8"));
	assert.equal(persisted.presentation_execution.status, "returned");
	assert.equal(persisted.presentation_receipt, undefined);
	assert.equal(await exists(join(first.runDir, "final-presentation/presentation-receipt.json")), true);

	const recovery = recoveryDependencies(first, { lifecycle: {} });
	const resumed = await runFacadeAgent(first.config, recovery.deps);

	assert.equal(resumed.final.status, "winner");
	assertZeroRecoveryCalls(recovery.calls);
});

test("an orphan presentation receipt rejects every mismatched authority without replay or mutation", async (context) => {
	const receiptMutations = [
		["provider", (receipt: any) => { receipt.provider = "other-provider"; }],
		["candidate id", (receipt: any) => { receipt.candidate_id = "other-candidate"; }],
		["candidate sha", (receipt: any) => { receipt.candidate_sha256 = "0".repeat(64); }],
		["version", (receipt: any) => { receipt.selected_version = "v999"; }],
		["GLB", (receipt: any) => { receipt.selected_glb_sha256 = "1".repeat(64); }],
		["presentation manifest", (receipt: any) => { receipt.presentation_manifest = structuredClone(receipt.technical_manifest); }],
		["technical manifest", (receipt: any) => { receipt.technical_manifest.sha256 = "2".repeat(64); }],
		["closure", (receipt: any) => { receipt.artifact_closure.sha256 = "3".repeat(64); }],
		["provider calls", (receipt: any) => { receipt.provider_calls = 1; }],
		["credits", (receipt: any) => { receipt.credits_consumed = 1; }],
	] as const;
	for (const [label, mutate] of receiptMutations) await context.test(label, async () => {
		const value = await fixture({ runId: `presentation-orphan-authority-${label.replaceAll(" ", "-")}` });
		await runFacadeAgent(value.config, value.deps);
		await rewriteAsOrphanPresentationReceipt(value);
		const receiptPath = join(value.runDir, "final-presentation/presentation-receipt.json");
		const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		mutate(receipt);
		await rewriteJson(receiptPath, receipt);
		const runPath = join(value.runDir, "run.json");
		const returnedBytes = await readFile(runPath);
		const orphanBytes = await readFile(receiptPath);
		const recovery = recoveryDependencies(value, { lifecycle: {} });

		await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.deepEqual(await readFile(runPath), returnedBytes);
		assert.deepEqual(await readFile(receiptPath), orphanBytes);
		assertZeroRecoveryCalls(recovery.calls);
	});
});

test("an orphan presentation receipt rejects every wrong checkpoint without replay or mutation", async (context) => {
	const wrongCheckpoints = ["prepared", "rendering", "failed", "uncertain", "succeeded"] as const;
	for (const status of wrongCheckpoints) await context.test(status, async () => {
		const value = await fixture({ runId: `presentation-orphan-checkpoint-${status}` });
		await runFacadeAgent(value.config, value.deps);
		const run = await rewriteAsOrphanPresentationReceipt(value);
		run.presentation_execution.status = status;
		const runPath = join(value.runDir, "run.json");
		await rewriteJson(runPath, run);
		const receiptPath = join(value.runDir, "final-presentation/presentation-receipt.json");
		const returnedBytes = await readFile(runPath);
		const orphanBytes = await readFile(receiptPath);
		const recovery = recoveryDependencies(value, { lifecycle: {} });

		await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.deepEqual(await readFile(runPath), returnedBytes);
		assert.deepEqual(await readFile(receiptPath), orphanBytes);
		assertZeroRecoveryCalls(recovery.calls);
	});
});

test("an invalid orphan presentation receipt fails closed without replay or mutation", async (context) => {
	for (const [label, mutate] of [
		["invalid JSON", async (path: string) => writeFile(path, "{invalid")],
		["path escape", async (path: string) => {
			const receipt = JSON.parse(await readFile(path, "utf8"));
			receipt.technical_manifest.path = "../outside.json";
			await rewriteJson(path, receipt);
		}],
	] as const) await context.test(label, async () => {
		const value = await fixture({ runId: `presentation-orphan-invalid-${label.replaceAll(" ", "-")}` });
		await runFacadeAgent(value.config, value.deps);
		await rewriteAsOrphanPresentationReceipt(value);
		const receiptPath = join(value.runDir, "final-presentation/presentation-receipt.json");
		await mutate(receiptPath);
		const runPath = join(value.runDir, "run.json");
		const returnedBytes = await readFile(runPath);
		const orphanBytes = await readFile(receiptPath);
		const recovery = recoveryDependencies(value, { lifecycle: {} });

		await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.deepEqual(await readFile(runPath), returnedBytes);
		assert.deepEqual(await readFile(receiptPath), orphanBytes);
		assertZeroRecoveryCalls(recovery.calls);
	});
});

test("an orphan presentation receipt cannot mutate its returned checkpoint before full state verification", async () => {
	const value = await fixture({ runId: "presentation-orphan-provider-state-tamper" });
	await runFacadeAgent(value.config, value.deps);
	const run = await rewriteAsOrphanPresentationReceipt(value);
	const provider = run.presentation_execution.provider;
	await writeFile(join(value.runDir, run.provider_manifests[provider].path), "{}\n");
	const runPath = join(value.runDir, "run.json");
	const receiptPath = join(value.runDir, "final-presentation/presentation-receipt.json");
	const returnedBytes = await readFile(runPath);
	const orphanBytes = await readFile(receiptPath);
	const recovery = recoveryDependencies(value, { lifecycle: {} });

	await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
	assert.deepEqual(await readFile(runPath), returnedBytes);
	assert.deepEqual(await readFile(receiptPath), orphanBytes);
	assertZeroRecoveryCalls(recovery.calls);
});

test("a winner retaining its final presentation digest cannot be mistaken for legacy state", async () => {
	const value = await fixture({ runId: "terminal-presentation-digest-without-receipt" });
	const persisted = await runFacadeAgent(value.config, value.deps);
	const completedDigest = persisted.final.presentation_sha256;
	await rewriteWinnerAsLegacy(value, { preserveFinalDigest: true });
	const recovery = recoveryDependencies(value);

	await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
	assert.equal(completedDigest.length, 64);
	assert.equal(recovery.calls.candidate, 0);
	assert.equal(recovery.calls.presentation, 0);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("terminal presentation recovery refuses in-flight or unreceipted success states", async (context) => {
	for (const status of ["submitting", "succeeded"] as const) await context.test(status, async () => {
		const value = await fixture({ runId: `terminal-presentation-${status}` });
		await runFacadeAgent(value.config, value.deps);
		const run = await rewriteWinnerAsLegacy(value);
		run.presentation_execution = { status, provider: run.final.selected_provider, selected_glb_sha256: run.final.selected_glb_sha256 };
		await rewriteJson(join(value.runDir, "run.json"), run);
		const recovery = recoveryDependencies(value);

		await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.equal(recovery.calls.presentation, 0);
		assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
		assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
	});
});

test("terminal presentation recovery rejects every replaced durable authority", async (context) => {
	for (const tamper of ["glb", "validation-receipt", "provider-manifest", "technical-manifest", "technical-state", "candidate"] as const) await context.test(tamper, async () => {
		const value = await fixture({ runId: `terminal-presentation-tamper-${tamper}` });
		await runFacadeAgent(value.config, value.deps);
		const run = await rewriteWinnerAsLegacy(value);
		const provider = run.final.selected_provider;
		const state = run.providers[provider];
		const version = state.versions.find((item: any) => item.id === run.final.selected_version);
		if (tamper === "glb") await writeFile(join(value.runDir, version.artifact.path), REPLACEMENT_GLB_BYTES);
		if (tamper === "validation-receipt") await writeFile(join(value.runDir, version.validation_receipt.path), "{}\n");
		if (tamper === "provider-manifest") await writeFile(join(value.runDir, run.provider_manifests[provider].path), "{}\n");
		if (tamper === "technical-manifest") await writeFile(join(value.runDir, state.delivery.memory_record.manifest.path), "{}\n");
		if (tamper === "technical-state") {
			run.delivery = { ...run.delivery, delivery_sha256: "0".repeat(64) };
			await rewriteJson(join(value.runDir, "run.json"), run);
		}
		const recovery = recoveryDependencies(value, tamper === "candidate" ? {
			loadCandidate: async () => ({ candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "replacement" } }),
		} : {});

		await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.equal(recovery.calls.presentation, 0);
		assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
		assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
	});
});

test("a pre-return local presentation failure is explicitly retryable from the same GLB", async () => {
	const value = await fixture({ runId: "terminal-presentation-local-retry" });
	await runFacadeAgent(value.config, value.deps);
	const legacy = await rewriteWinnerAsLegacy(value);
	const rejected = Object.assign(new Error("local renderer unavailable"), { code: "FACADE_PRESENTATION_RENDER_REJECTED" });
	const first = recoveryDependencies(value, { renderPresentation: async () => { throw rejected; } });

	const failed = await runFacadeAgent(value.config, first.deps);
	assert.deepEqual(failed.presentation_execution, {
		status: "failed", provider: legacy.final.selected_provider, selected_version: legacy.final.selected_version,
		candidate_sha256: legacy.preflight_receipt ? JSON.parse(await readFile(join(value.runDir, legacy.preflight_receipt.path), "utf8")).candidate_sha256 : undefined,
		selected_glb_sha256: legacy.final.selected_glb_sha256,
		retryable: true, failure: { code: "FACADE_PRESENTATION_RENDER_REJECTED", name: "Error", message: "local renderer unavailable" },
	});
	const second = recoveryDependencies(value);
	const recovered = await runFacadeAgent(value.config, second.deps);

	assert.equal(recovered.final.status, "winner");
	assert.equal(recovered.presentation_execution.status, "succeeded");
	assert.equal(first.calls.presentation, 1);
	assert.equal(second.calls.presentation, 1);
	assert.equal(recovered.final.selected_glb_sha256, legacy.final.selected_glb_sha256);
	assert.deepEqual(second.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(second.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("retryable presentation failure admission is bound to the terminal provider and GLB", async (context) => {
	for (const mutation of ["provider", "glb"] as const) await context.test(mutation, async () => {
		const value = await fixture({ runId: `terminal-presentation-retry-binding-${mutation}` });
		await runFacadeAgent(value.config, value.deps);
		const legacy = await rewriteWinnerAsLegacy(value);
		const rejected = Object.assign(new Error("local renderer unavailable"), { code: "FACADE_PRESENTATION_RENDER_REJECTED" });
		const first = recoveryDependencies(value, { renderPresentation: async () => { throw rejected; } });
		await runFacadeAgent(value.config, first.deps);
		const runPath = join(value.runDir, "run.json");
		const run = JSON.parse(await readFile(runPath, "utf8"));
		if (mutation === "provider") run.presentation_execution.provider = PROVIDERS.find((provider) => provider !== legacy.final.selected_provider);
		else run.presentation_execution.selected_glb_sha256 = "0".repeat(64);
		await rewriteJson(runPath, run);
		const second = recoveryDependencies(value);

		await assert.rejects(() => runFacadeAgent(value.config, second.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
		assert.equal(second.calls.candidate, 0);
		assert.equal(second.calls.presentation, 0);
		assert.deepEqual(second.calls.paid, { image: 0, grammar: 0 });
		assert.deepEqual(second.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
	});
});

test("a recovery checkpoint integrity failure is nonretryable even before renderer invocation", async () => {
	const value = await fixture({ runId: "terminal-presentation-integrity-nonretryable" });
	await runFacadeAgent(value.config, value.deps);
	const legacy = await rewriteWinnerAsLegacy(value);
	const provider = legacy.final.selected_provider;
	const version = legacy.providers[provider].versions.find((item: any) => item.id === legacy.final.selected_version);
	const glbPath = join(value.runDir, version.artifact.path);
	const first = recoveryDependencies(value, { lifecycle: { async onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "prepared") await writeFile(glbPath, REPLACEMENT_GLB_BYTES);
	} } });

	const failed = await runFacadeAgent(value.config, first.deps);
	assert.equal(failed.presentation_execution.status, "failed");
	assert.equal(failed.presentation_execution.retryable, false);
	assert.equal(failed.presentation_execution.failure.code, "FACADE_PRESENTATION_RECOVERY_UNSAFE");
	assert.equal(first.calls.presentation, 0);
	await writeFile(glbPath, GLB_BYTES);
	const second = recoveryDependencies(value);
	await assert.rejects(() => runFacadeAgent(value.config, second.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
	assert.equal(second.calls.candidate, 0);
	assert.equal(second.calls.presentation, 0);
	assert.deepEqual(second.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(second.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("a crash after local render return is uncertain and cannot auto-replay", async () => {
	const value = await fixture({ runId: "terminal-presentation-returned-crash" });
	await runFacadeAgent(value.config, value.deps);
	await rewriteWinnerAsLegacy(value);
	const crash = new Error("crash after render return");
	const first = recoveryDependencies(value, { lifecycle: { onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "returned") throw crash;
	} } });

	await assert.rejects(() => runFacadeAgent(value.config, first.deps), crash);
	const persisted = JSON.parse(await readFile(join(value.runDir, "run.json"), "utf8"));
	assert.equal(persisted.presentation_execution.status, "uncertain");
	assert.equal(persisted.presentation_receipt, undefined);
	const second = recoveryDependencies(value);
	await assert.rejects(() => runFacadeAgent(value.config, second.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
	assert.equal(first.calls.presentation, 1);
	assert.equal(second.calls.presentation, 0);
	assert.deepEqual(second.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(second.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("an initial-run crash after local render return is uncertain and cannot replay", async () => {
	const crash = new Error("initial crash after render return");
	const value = await fixture({ runId: "initial-presentation-returned-crash", lifecycle: { onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "returned") throw crash;
	} } });
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), crash);
	const persisted = JSON.parse(await readFile(join(value.runDir, "run.json"), "utf8"));
	assert.equal(persisted.presentation_execution.status, "uncertain");
	assert.equal(persisted.presentation_receipt, undefined);

	const recovery = recoveryDependencies(value, { lifecycle: {} });
	await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_PRESENTATION_RECOVERY_UNSAFE");
	assert.equal(recovery.calls.presentation, 0);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("an initial provider-and-GLB-bound local presentation failure retries without legacy state manufacture", async () => {
	const rejected = Object.assign(new Error("local renderer unavailable"), { code: "FACADE_PRESENTATION_RENDER_REJECTED" });
	const value = await fixture({ runId: "initial-presentation-local-retry", presentationFailure: rejected });
	const failed = await runFacadeAgent(value.config, value.deps);
	assert.equal(failed.final.status, "presentation-failed");
	assert.equal(failed.final.selected_version, "v001");
	assert.equal(failed.final.delivery_sha256.length, 64);
	assert.equal(failed.presentation_execution.status, "failed");
	assert.equal(failed.presentation_execution.retryable, true);

	const recovery = recoveryDependencies(value, { renderPresentation: writeDurablePresentation });
	const recovered = await runFacadeAgent(value.config, recovery.deps);
	assert.equal(recovered.final.status, "winner");
	assert.equal(recovery.calls.presentation, 1);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("an initial provider-and-GLB-bound artifact-closure failure retries locally", async () => {
	const rejected = Object.assign(new Error("local artifact closure incomplete"), { code: "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID" });
	const value = await fixture({ runId: "initial-presentation-closure-retry", presentationFailure: rejected });
	const failed = await runFacadeAgent(value.config, value.deps);
	assert.equal(failed.final.status, "presentation-failed");
	assert.equal(failed.presentation_execution.status, "failed");
	assert.equal(failed.presentation_execution.retryable, true);
	assert.equal(failed.presentation_execution.failure.code, "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID");

	const recovery = recoveryDependencies(value, { renderPresentation: writeDurablePresentation });
	const recovered = await runFacadeAgent(value.config, recovery.deps);
	assert.equal(recovered.final.status, "winner");
	assert.equal(recovery.calls.presentation, 1);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("a verified succeeded presentation receipt resumes with zero local, paid, or pipeline replay", async () => {
	const crash = new Error("crash after committed presentation receipt");
	const value = await fixture({ runId: "presentation-succeeded-receipt-resume", lifecycle: { onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "succeeded") throw crash;
	} } });
	await assert.rejects(() => runFacadeAgent(value.config, value.deps), crash);
	const committed = JSON.parse(await readFile(join(value.runDir, "run.json"), "utf8"));
	assert.equal(committed.presentation_execution.status, "succeeded");
	assert.equal(committed.presentation_execution.retryable, undefined);
	assert.equal(committed.presentation_receipt.receipt_sha256.length, 64);
	assert.notEqual(committed.status, "presentation-failed");

	const recovery = recoveryDependencies(value, { lifecycle: {} });
	const recovered = await runFacadeAgent(value.config, recovery.deps);
	assert.equal(recovered.final.status, "winner");
	assert.equal(recovery.calls.presentation, 0);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("a succeeded receipt committed during terminal recovery zero-call finalizes after notification failure", async () => {
	const value = await fixture({ runId: "terminal-recovery-succeeded-receipt-resume" });
	await runFacadeAgent(value.config, value.deps);
	await rewriteWinnerAsLegacy(value);
	const crash = new Error("terminal recovery notification failed");
	const first = recoveryDependencies(value, { lifecycle: { onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "succeeded") throw crash;
	} } });
	await assert.rejects(() => runFacadeAgent(value.config, first.deps), crash);
	const committed = JSON.parse(await readFile(join(value.runDir, "run.json"), "utf8"));
	assert.equal(committed.presentation_execution.status, "succeeded");
	assert.equal(committed.presentation_receipt.receipt_sha256.length, 64);

	const second = recoveryDependencies(value, { lifecycle: {} });
	const recovered = await runFacadeAgent(value.config, second.deps);
	assert.equal(recovered.final.status, "winner");
	assert.equal(recovered.final.presentation_sha256, committed.presentation_receipt.receipt_sha256);
	assert.equal(second.calls.presentation, 0);
	assert.deepEqual(second.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(second.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("status reads hash every closed technical and presentation leaf", async (context) => {
	for (const [mode, select] of [
		["delete technical detailed manifest", (closure: any) => closure.technical.views.front.manifest.path],
		["tamper presentation semantic mask", (closure: any) => closure.presentation.views.axon.semantic_role_mask.path],
	] as const) await context.test(mode, async () => {
		const value = await fixture({ runId: `closed-leaf-${mode.replaceAll(" ", "-")}` });
		const result = await runFacadeAgent(value.config, value.deps);
		const receipt = JSON.parse(await readFile(join(value.runDir, result.presentation_receipt.path), "utf8"));
		const closure = JSON.parse(await readFile(join(value.runDir, receipt.artifact_closure.path), "utf8"));
		const target = join(value.runDir, select(closure));
		if (mode.startsWith("delete")) await rm(target);
		else await writeFile(target, "tampered closed leaf");
		await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
	});
});

test("a tampered terminal presentation receipt fails closed without rerendering", async () => {
	const value = await fixture({ runId: "terminal-presentation-tampered-receipt" });
	const persisted = await runFacadeAgent(value.config, value.deps);
	await writeFile(join(value.runDir, persisted.presentation_receipt.path), "{}\n");
	const recovery = recoveryDependencies(value);

	await assert.rejects(() => runFacadeAgent(value.config, recovery.deps), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
	assert.equal(recovery.calls.presentation, 0);
	assert.deepEqual(recovery.calls.paid, { image: 0, grammar: 0 });
	assert.deepEqual(recovery.calls.pipeline, { evidence: 0, build: 0, validate: 0, score: 0, delivery: 0 });
});

test("rejects a receipt whose technical manifest is not the selected provider delivery manifest", async () => {
	const value = await fixture({ runId: "presentation-technical-manifest-binding" });
	const persisted = await runFacadeAgent(value.config, value.deps);
	const receiptPath = join(value.runDir, persisted.presentation_receipt.path);
	const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
	const alternatePath = join(value.runDir, "final-presentation", "alternate-technical-manifest.json");
	const alternate = { selected_glb: { sha256: persisted.final.selected_glb_sha256 } };
	const alternateBytes = Buffer.from(`${stableJson(alternate)}\n`);
	await writeFile(alternatePath, alternateBytes);
	receipt.technical_manifest = { path: "final-presentation/alternate-technical-manifest.json", sha256: sha256(alternateBytes) };
	const receiptSha256 = await rewriteJson(receiptPath, receipt);
	const runPath = join(value.runDir, "run.json");
	const run = JSON.parse(await readFile(runPath, "utf8"));
	run.presentation_receipt = {
		...run.presentation_receipt,
		sha256: receiptSha256,
		receipt_sha256: sha256(stableJson(receipt)),
	};
	run.presentation_execution.receipt_sha256 = run.presentation_receipt.receipt_sha256;
	run.final.presentation_sha256 = run.presentation_receipt.receipt_sha256;
	run.final_manifest.sha256 = await rewriteJson(join(value.runDir, "final.json"), run.final);
	await rewriteJson(runPath, run);

	await assert.rejects(() => readFacadeAgentStatus(value.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("does not trust a presentation report's activity claim or GLB bytes", async (context) => {
	await context.test("reported remote activity", async () => {
		const value = await fixture({ runId: "presentation-forged-activity" });
		value.deps.renderPresentation = async ({ provider, artifact, presentationRoot }: any) => {
			value.calls.presentation.push({ provider, artifact });
			await mkdir(presentationRoot, { recursive: true });
			const path = join(presentationRoot, "presentation.json");
			await writeFile(path, "{}\n");
			return {
				memory_record: { presentation: { path, sha256: sha256("{}\n") }, selected_glb: { sha256: artifact.sha256 } },
				render: { selected_glb: { sha256: artifact.sha256 }, provider_calls: 1, credits_consumed: 0 },
			};
		};
		const result = await runFacadeAgent(value.config, value.deps);
		assert.equal(result.final.status, "presentation-failed");
		assert.equal(result.final.failure.code, "FACADE_PRESENTATION_REMOTE_ACTIVITY");
	});

	await context.test("selected GLB mutation", async () => {
		const value = await fixture({ runId: "presentation-forged-glb-mutation" });
		value.deps.renderPresentation = async ({ provider, artifact, presentationRoot }: any) => {
			value.calls.presentation.push({ provider, artifact });
			await mkdir(presentationRoot, { recursive: true });
			const path = join(presentationRoot, "presentation.json");
			await writeFile(path, "{}\n");
			await writeFile(artifact.path, REPLACEMENT_GLB_BYTES);
			return {
				memory_record: { presentation: { path, sha256: sha256("{}\n") }, selected_glb: { sha256: artifact.sha256 } },
				render: { selected_glb: { sha256: artifact.sha256 }, provider_calls: 0, credits_consumed: 0 },
			};
		};
		const result = await runFacadeAgent(value.config, value.deps);
		assert.equal(result.final.status, "presentation-failed");
		assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
	});
});

test("a renderer rejection leaves technical delivery intact without a final winner", async () => {
	const value = await fixture({ runId: "presentation-renderer-rejection" });
	value.deps.renderPresentation = async ({ provider, artifact }: any) => {
		value.calls.presentation.push({ provider, artifact });
		throw Object.assign(new Error("local renderer rejected the presentation"), { code: "FACADE_PRESENTATION_RENDER_REJECTED" });
	};
	const result = await runFacadeAgent(value.config, value.deps);

	assert.equal(result.final.status, "presentation-failed");
	assert.equal(result.final.failure.code, "FACADE_PRESENTATION_RENDER_REJECTED");
	assert.equal(result.presentation_receipt, undefined);
	assert.equal(result.providers[result.final.selected_provider].delivery.status, "succeeded");
	assert.deepEqual(value.calls.presentation.map((call: any) => call.provider), ["nano-banana-pro"]);
});

test("an abort before or during presentation never writes a final winner", async (context) => {
	for (const timing of ["before", "during"] as const) await context.test(timing, async () => {
		const controller = new AbortController();
		const value = await fixture({ runId: `presentation-abort-${timing}`, lifecycle: { onTransition(event: any) {
			if (timing === "before" && event.stage === "presentation" && event.status === "prepared") controller.abort();
		} } });
		value.deps.signal = controller.signal;
		if (timing === "during") value.deps.renderPresentation = async ({ provider, artifact }: any) => {
			value.calls.presentation.push({ provider, artifact });
			controller.abort();
			throw controller.signal.reason;
		};
		const result = await runFacadeAgent(value.config, value.deps);

		assert.equal(result.final.status, "cancelled");
		assert.notEqual(result.final.status, "winner");
		assert.equal(result.presentation_receipt, undefined);
		assert.equal(value.calls.presentation.length, timing === "before" ? 0 : 1);
	});
});

test("a GLB changed at the presentation checkpoint fails before the local renderer", async () => {
	let value: any;
	value = await fixture({ runId: "presentation-tampered-glb", lifecycle: { async onTransition(event: any) {
		if (event.stage === "presentation" && event.status === "prepared") {
			await writeFile(join(value.runDir, "fixture-artifacts", event.provider, "v001.glb"), REPLACEMENT_GLB_BYTES);
		}
	} } });
	const result = await runFacadeAgent(value.config, value.deps);

	assert.equal(result.final.status, "presentation-failed");
	assert.equal(result.final.failure.code, "FACADE_BUILD_ARTIFACT_HASH_MISMATCH");
	assert.deepEqual(value.calls.presentation, []);
	assert.equal(result.providers["nano-banana-pro"].delivery.status, "succeeded");
});

test("rejects forged presentation reports and receipt tampering", async () => {
	const forged = await fixture({ runId: "forged-presentation-report" });
	forged.deps.renderPresentation = async ({ provider, artifact, presentationRoot }: any) => {
		forged.calls.presentation.push({ provider, artifact });
		await mkdir(presentationRoot, { recursive: true });
		const path = join(presentationRoot, "presentation.json");
		await writeFile(path, "{}\n");
		const presentation: any = { sha256: sha256("{}\n") };
		Object.defineProperty(presentation, "path", { get: () => path });
		return { memory_record: { presentation, selected_glb: { sha256: artifact.sha256 } } };
	};
	const rejected = await runFacadeAgent(forged.config, forged.deps);
	assert.equal(rejected.final.status, "presentation-failed");
	assert.equal(rejected.final.failure.code, "FACADE_PRESENTATION_RESULT_INVALID");

	const durable = await fixture({ runId: "tampered-presentation-receipt" });
	const persisted = await runFacadeAgent(durable.config, durable.deps);
	await writeFile(join(durable.runDir, persisted.presentation_receipt.path), "{}\n");
	await assert.rejects(() => readFacadeAgentStatus(durable.runDir), (error: any) => error.code === "FACADE_AGENT_STATE_UNCERTAIN");
});

test("transport, uncertain submission, geometry mismatch, unknown validation, and cancellation never create v002", async (context) => {
	const cases = [
		{
			name: "transport",
			options: { generateFailure: { provider: "gpt-image-2", error: new FacadeProviderError("PROVIDER_TRANSPORT_FAILED", "fixture transport secret=do-not-store", { provider: "gpt-image-2", stage: "generate", definitiveNonSubmission: true }) } },
			wantVersions: 0,
		},
		{
			name: "uncertain submission",
			options: { generateFailure: { provider: "gpt-image-2", error: new Error("socket ended after write secret=do-not-store") } },
			wantVersions: 0,
		},
		{
			name: "geometry mismatch",
			options: { validations: { "gpt-image-2": { v001: { accepted: false, codes: ["EVIDENCE_GEOMETRY_MISMATCH"], retryable: true } } } },
			wantVersions: 1,
		},
		{
			name: "unknown validation code",
			options: { validations: { "gpt-image-2": { v001: { accepted: false, codes: ["UNRECOGNIZED_FIXTURE_CODE"], retryable: true } } } },
			wantVersions: 1,
		},
		{
			name: "cancellation",
			options: { validations: { "gpt-image-2": { v001: Object.assign(new Error("stop now"), { name: "AbortError" }) } } },
			wantVersions: 1,
		},
	];
	for (const item of cases) await context.test(item.name, async () => {
		const value = await fixture({ ...item.options, runId: `prohibited-${item.name.replaceAll(" ", "-")}` });
		const result = await runFacadeAgent(value.config, value.deps);
		assert.equal(result.providers["gpt-image-2"].versions.length, item.wantVersions);
		assert.equal(result.providers["gpt-image-2"].versions.some((version: any) => version.id === "v002"), false);
		const persisted = await readFile(join(value.runDir, "run.json"), "utf8");
		assert.doesNotMatch(persisted, /do-not-store/);
	});
});

test("resume never resubmits a generation durably recorded as succeeded", async () => {
	let crashed = false;
	const first = await fixture({ lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "generate" && event.provider === "gpt-image-2" && event.status === "succeeded") {
				crashed = true;
				throw new Error("fixture crash after durable success");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.deepEqual(first.calls.generate, ["gpt-image-2"]);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.deepEqual(resumed.calls.generate, ["nano-banana-pro"]);
	assert.equal(result.image_submissions.total, 2);
	assert.equal(result.final.status, "winner");
});

test("resume never submits a generation durably recorded as submitting", async () => {
	let crashed = false;
	const first = await fixture({ lifecycle: {
		onTransition(event: any) {
			if (!crashed && event.stage === "generate" && event.provider === "gpt-image-2" && event.status === "submitting") {
				crashed = true;
				throw new Error("fixture crash before callback");
			}
		},
	} });
	await assert.rejects(() => runFacadeAgent(first.config, first.deps), /fixture crash/);
	assert.deepEqual(first.calls.generate, []);

	const resumed = await fixture({ runId: "unused" });
	resumed.config = first.config;
	resumed.deps.ledger = first.deps.ledger;
	const result = await runFacadeAgent(resumed.config, resumed.deps);
	assert.deepEqual(resumed.calls.generate, ["nano-banana-pro"]);
	assert.equal(result.providers["gpt-image-2"].status, "rejected");
	assert.equal(result.providers["gpt-image-2"].failure.code, "PAID_OPERATION_SUBMISSION_UNCERTAIN");
});
