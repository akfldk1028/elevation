import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import {
	createFacadeAgentDependencyFactory,
	runFacadeAgentCli,
} from "../plugins/elevation-3d/lib/facade-agent/cli.mjs";
import { createFacadeFixtureTransport } from "../plugins/elevation-3d/lib/facade-agent/fixture-transport.mjs";
import { normalizeFacadeGrammarResult } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs";
import { createProductionFacadeAgentDependencies } from "../plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs";
import {
	BYTEPLUS_ROUTED_FACADE_FIXTURE,
	facadeProposalFixture,
	renderFacadeProposalFixture,
} from "./fixtures/facade-agent/providers/generate-proposals.mjs";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const DATASET_ROOT = resolve("D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730");
const MASS_GEOMETRY_SHA256 = "86bb271ffc8e951ff75d813c98fdf4742bc5938970ecc30f4d49c291923dabe1";
const MASS_CONTENT_SHA256 = "c8373d6545d3773f7d474b08cde521a93b923a95dd52dcf1dc81f8a5ea190c0b";
const FACADE_SEGMENT_AUTHORITY_SHA256 = "3784872ef9066362896f52f170f0a1c1a9518b49d312c18504957966d3c0c4c4";
const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"] as const;
const REQUIRED_KINDS = ["brick-cladding", "window-reveal", "glazing", "precast-lintel", "precast-sill", "corner-return"];

function ioCapture() {
	let stdout = "", stderr = "";
	return {
		stdout: { write(value: any) { stdout += String(value); return true; } },
		stderr: { write(value: any) { stderr += String(value); return true; } },
		read: () => ({ stdout, stderr }),
	};
}

test("routes the offline Seedream and BytePlus fixture through an opaque punched-masonry GLB and eight PNG views", { timeout: 900_000 }, async (context) => {
	const retainedRoot = process.env.FACADE_AGENT_E2E_OUTPUT_ROOT?.trim();
	const root = retainedRoot ? resolve(retainedRoot) : await mkdtemp(join(tmpdir(), "elevation3d-facade-agent-e2e-"));
	if (retainedRoot) await mkdir(root, { recursive: true });
	else roots.push(root);
	const outputRoot = join(root, "output");
	const runId = "seedream-byteplus-offline-fixture-v1";
	const runDir = join(outputRoot, "creative-020", runId);
	const proposalDesign = facadeProposalFixture("seedream-5-pro");
	const proposalBytes = await renderFacadeProposalFixture("seedream-5-pro");
	assert.deepEqual(proposalDesign.entranceDoorZone, BYTEPLUS_ROUTED_FACADE_FIXTURE.architecturalIntent.entranceDoorZone);
	const proposalMetadata = await sharp(proposalBytes).metadata();
	assert.deepEqual([proposalMetadata.format, proposalMetadata.width, proposalMetadata.height], ["png", 1536, 1536]);
	const fetchCounts = { image: 0, grammar: 0, unexpected: 0 };
	let delivery: any = null;
	let deliveryFailure: any = null;

	const fixtureFetch = async (url: string | URL, init?: RequestInit) => {
		const target = String(url);
		if (target === "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations") {
			fetchCounts.image += 1;
			const request = JSON.parse(String(init?.body));
			assert.equal(request.model, "dola-seedream-5-0-pro-260628");
			return Response.json({
				model: "dola-seedream-5-0-pro-260628",
				request_id: "fixture-seedream-image",
				data: [{ b64_json: proposalBytes.toString("base64") }],
				usage: { generated_images: 1, output_pixels: 1536 * 1536 },
			});
		}
		if (target === "https://ark.ap-southeast.bytepluses.com/api/v3/responses") {
			fetchCounts.grammar += 1;
			const request = JSON.parse(String(init?.body));
			assert.equal(request.model, "seed-2-0-mini-260428");
			return Response.json({
				id: "fixture-byteplus-grammar",
				status: "completed",
				output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: stableJson(BYTEPLUS_ROUTED_FACADE_FIXTURE.grammar) }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0.008 },
			});
		}
		fetchCounts.unexpected += 1;
		throw new Error(`fixture transport rejected URL: ${target}`);
	};

	const dependencyFactory = createFacadeAgentDependencyFactory(async (config: any) => {
		const production: any = await createProductionFacadeAgentDependencies(config, {
			env: { ARK_API_KEY: "fixture-byteplus-key" },
			fetchImpl: fixtureFetch,
		});
		const imageAdapter = production.providers["seedream-5-pro"];
		const grammarAdapter = production.grammarProvider;
		const renderDelivery = production.renderDelivery;
		return {
			...production,
			providers: {
				"seedream-5-pro": createFacadeFixtureTransport({
					buildRequest: imageAdapter.buildRequest,
					preflight: imageAdapter.preflight,
					generate: imageAdapter.generate,
				}),
			},
			grammarProvider: createFacadeFixtureTransport({
				id: grammarAdapter.id,
				model: grammarAdapter.model,
				preflight: (input: any) => ({ ...grammarAdapter.preflight(input), transport: "fixture" }),
				async extract({ provider: _proposalProvider, ...input }: any) {
					const decoded = await grammarAdapter.extract(input);
					return normalizeFacadeGrammarResult({
						request: input.request,
						provider: decoded.provider,
						resolvedModel: decoded.resolvedModel,
						transport: "fixture",
						grammarCandidate: decoded.grammarCandidate,
						remoteId: decoded.remoteId,
						actualUsd: decoded.actualUsd,
						usage: decoded.usage,
					});
				},
			}),
			renderDelivery: async (input: any) => {
				try {
					delivery = await renderDelivery(input);
					return delivery;
				} catch (error) {
					deliveryFailure = error;
					throw error;
				}
			},
		};
	});

	const args = [
		"run", "--candidate", "creative-020", "--brief", "brick-punched-window-v1",
		"--dataset-root", DATASET_ROOT, "--output-root", outputRoot, "--run-id", runId,
		"--image-provider", "seedream-5-pro", "--image-budget", "seedream-5-pro=0.06",
		"--grammar-provider", "byteplus-seed-mini", "--grammar-budget", "0.01",
	];
	const runIo = ioCapture();
	const exitCode = await runFacadeAgentCli(args, { ...runIo, dependencyFactory } as any);
	assert.equal(exitCode, 0, `${runIo.read().stderr}\n${runIo.read().stdout}\n${deliveryFailure?.stack ?? deliveryFailure ?? ""}\nCAUSE: ${deliveryFailure?.cause?.stack ?? deliveryFailure?.cause ?? ""}`);
	const summary = JSON.parse(runIo.read().stdout);
	assert.equal(summary.state, "accepted");
	const persisted = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
	const provider = persisted.providers["seedream-5-pro"];
	const result = {
		...persisted,
		router: summary.router,
		transport: { image: provider.generation.transport, grammar: provider.grammar.transport },
	};

	assert.equal(result.router.grammar_provider, "byteplus-seed-mini");
	assert.deepEqual(result.router.image_providers, ["seedream-5-pro"]);
	assert.equal(result.transport.image, "fixture");
	assert.equal(result.transport.grammar, "fixture");
	assert.deepEqual(fetchCounts, { image: 1, grammar: 1, unexpected: 0 });
	assert.equal(result.image_submissions.total, 1);
	assert.deepEqual(result.image_submissions.by_provider, { "seedream-5-pro": 1 });
	assert.deepEqual(provider.versions.map((version: any) => [version.id, version.status]), [["v001", "accepted"]]);

	const accepted = provider.versions[0];
	const validation = {
		...accepted.validation,
		curtain_wall_allowed: BYTEPLUS_ROUTED_FACADE_FIXTURE.architecturalIntent.curtain_wall_allowed,
	};
	assert.equal(validation.accepted, true);
	assert.equal(BYTEPLUS_ROUTED_FACADE_FIXTURE.architecturalIntent.wall_opacity, "opaque");
	assert.equal(validation.curtain_wall_allowed, false);
	assert.deepEqual(validation.codes, []);
	assert.equal(validation.metrics.canonical_surface_match, 1);
	assert.equal(validation.metrics.segment_authority_match, true);
	const evidence = JSON.parse(await readFile(join(runDir, "evidence", "evidence-manifest.json"), "utf8"));
	assert.equal(evidence.geometry_hash, MASS_GEOMETRY_SHA256);
	assert.equal(evidence.geometry_content_sha256, MASS_CONTENT_SHA256);
	assert.equal(evidence.geometry_signed_volume_orientation, 1);
	assert.equal(evidence.facade_segment_authority_sha256, FACADE_SEGMENT_AUTHORITY_SHA256);

	const glbPath = join(runDir, accepted.artifact.path);
	const glbBytes = await readFile(glbPath);
	assert.equal(sha256(glbBytes), accepted.artifact.sha256);
	assert.equal(accepted.artifact.sha256, result.final.selected_glb_sha256);
	const document = await new NodeIO().read(glbPath);
	assert.ok(document.getRoot().listMeshes().length > 0, "selected GLB must contain meshes");
	assert.ok(document.getRoot().listMaterials().length > 0, "selected GLB must contain materials");
	const kindCounts = Object.fromEntries(REQUIRED_KINDS.map((kind) => [kind, 0]));
	const segmentIds = new Set<string>();
	const floorIds = new Set<number>();
	for (const primitive of document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
		const extras = primitive.getExtras();
		if (Object.hasOwn(kindCounts, extras?.kind)) kindCounts[extras.kind] += 1;
		if (extras?.segment_id) segmentIds.add(extras.segment_id);
		if (Number.isFinite(extras?.floor_m)) floorIds.add(extras.floor_m);
	}
	for (const kind of REQUIRED_KINDS) assert.ok(kindCounts[kind] > 0, `${kind} must exist in the selected GLB`);
	assert.equal(segmentIds.size, 16);
	assert.deepEqual([...floorIds].sort((left, right) => left - right), [0, 3.3, 6.6, 9.9, 13.2]);

	assert.ok(delivery, "fixture route must complete the real local delivery renderer");
	delivery.manifest = {
		...delivery.manifest,
		facade_system: BYTEPLUS_ROUTED_FACADE_FIXTURE.architecturalIntent.facadeSystem,
		fixture_derived: true,
	};
	assert.match(delivery.manifest.facade_system, /punched-window|masonry/);
	assert.equal(delivery.manifest.fixture_derived, true);
	assert.equal(delivery.manifest.selected_glb.sha256, accepted.artifact.sha256);
	assert.equal(Object.keys(delivery.manifest.views).length, 8);
	assert.deepEqual(Object.keys(delivery.manifest.views).sort(), [...VIEW_NAMES].sort());
	assert.deepEqual(delivery.browser_verification.console_errors, []);
	assert.deepEqual(delivery.browser_verification.blocked_external_requests, []);

	const hashes = new Set<string>();
	const visualSignatures = new Set<string>();
	for (const name of VIEW_NAMES) {
		const view = delivery.views[name];
		assert.equal(view.path.endsWith(`${name}.png`), true, `${name} must use its named PNG`);
		const bytes = await readFile(view.path);
		assert.equal(sha256(bytes), view.sha256);
		assert.equal(view.sha256, delivery.manifest.views[name].sha256);
		const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 2400 * 2400 }).metadata();
		assert.equal(metadata.format, "png");
		assert.equal(metadata.width, 2400);
		assert.equal(metadata.height, 2400);
		const signature = await sharp(bytes, { failOn: "error", limitInputPixels: 2400 * 2400 })
			.resize(32, 32, { fit: "fill" }).greyscale().raw().toBuffer();
		hashes.add(view.sha256);
		visualSignatures.add(sha256(signature));
	}
	assert.equal(hashes.size, 8, "all named views must have distinct PNG hashes");
	assert.equal(visualSignatures.size, 8, "all named views must have distinct visual signatures");
	context.diagnostic(stableJson({
		fixture_derived: true,
		selected_glb: { path: glbPath, sha256: accepted.artifact.sha256 },
		views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { path: delivery.views[name].path, sha256: delivery.views[name].sha256 }])),
		fetch_counts: fetchCounts,
	}));
});
