import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
import { createProductionFacadeAgentDependencies } from "../plugins/elevation-3d/lib/facade-agent/production-dependencies.mjs";
import * as runMemory from "../plugins/elevation-3d/lib/run-memory.mjs";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const DATASET_ROOT = resolve("D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730");
const MASS_GEOMETRY_SHA256 = "86bb271ffc8e951ff75d813c98fdf4742bc5938970ecc30f4d49c291923dabe1";
const MASS_CONTENT_SHA256 = "c8373d6545d3773f7d474b08cde521a93b923a95dd52dcf1dc81f8a5ea190c0b";
const FACADE_SEGMENT_AUTHORITY_SHA256 = "3784872ef9066362896f52f170f0a1c1a9518b49d312c18504957966d3c0c4c4";
const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const REQUIRED_KINDS = ["brick-cladding", "window-reveal", "glazing", "precast-lintel", "precast-sill", "corner-return"];

const providerImages = {
	"gpt-image-2": await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 126, g: 58, b: 42 } } }).png().toBuffer(),
	"nano-banana-pro": await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 136, g: 72, b: 48 } } }).png().toBuffer(),
};

function grammar(confidence: number, overrides: Record<string, number> = {}) {
	return {
		system: "brick-punched-window-v1",
		surfaces: ["front", "right", "back", "left"],
		materials: ["brick", "precast", "window-frame", "glass"],
		corner_datum_m: 0,
		bay_width_m: 1.2,
		window_width_m: 0.8,
		window_height_m: 1.8,
		sill_height_m: 0.8,
		reveal_depth_m: 0.2,
		frame_width_m: 0.06,
		lintel_height_m: 0.15,
		sill_depth_m: 0.1,
		cladding_depth_m: 0.2,
		brick_module_m: [0.22, 0.07],
		confidence,
		unresolved_surfaces: [],
		...overrides,
	};
}

async function treeSnapshot(root: string) {
	const result: any[] = [];
	async function visit(directory: string, prefix = "") {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const relativePath = prefix ? `${prefix}/${name}` : name;
			const info = await stat(path);
			if (info.isDirectory()) await visit(path, relativePath);
			else result.push({ path: relativePath, size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(await readFile(path)) });
		}
	}
	await visit(root);
	return result;
}

function ioCapture() {
	let stdout = "", stderr = "";
	return {
		stdout: { write(value: any) { stdout += String(value); return true; } },
		stderr: { write(value: any) { stderr += String(value); return true; } },
		read: () => ({ stdout, stderr }),
	};
}

test("runs the complete creative-020 comparison fixture without network or paid resubmission", { timeout: 900_000 }, async (context) => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-facade-agent-e2e-"));
	roots.push(root);
	const outputRoot = join(root, "output");
	const memoryRoot = join(root, "memory");
	const runId = "creative-020-brick-fixture-v1";
	const runDir = join(outputRoot, "creative-020", runId);
	const fetchCounts = { "gpt-image-2": 0, "nano-banana-pro": 0, grammar: 0, unexpected: 0 };
	let selectedDelivery: any = null;
	let deliveryFailure: any = null;
	const grammarFixtures = [grammar(0.99, { cladding_depth_m: 0.25 }), grammar(0.85)];

	const fixtureFetch = async (url: string | URL, init?: RequestInit) => {
		const target = String(url);
		if (target.includes("/v1/images/edits")) {
			fetchCounts["gpt-image-2"] += 1;
			return Response.json({ id: "fixture-openai-image", data: [{ b64_json: providerImages["gpt-image-2"].toString("base64") }], usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.2 } });
		}
		if (target.includes(":generateContent")) {
			fetchCounts["nano-banana-pro"] += 1;
			return Response.json({
				responseId: "fixture-gemini-image", modelVersion: "gemini-3-pro-image",
				candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: providerImages["nano-banana-pro"].toString("base64") } }] } }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
			});
		}
		if (target.endsWith("/v1/responses")) {
			const fixture = grammarFixtures[fetchCounts.grammar];
			assert.ok(fixture, "exactly two grammar fixtures are authorized");
			fetchCounts.grammar += 1;
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "gpt-5.6");
			return Response.json({
				id: `fixture-grammar-${fetchCounts.grammar}`, status: "completed",
				output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: stableJson(fixture) }] }],
				usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.04 },
			});
		}
		fetchCounts.unexpected += 1;
		throw new Error(`fixture transport rejected URL: ${target}`);
	};

	const dependencyFactory = createFacadeAgentDependencyFactory(async (config: any) => {
		const production: any = await createProductionFacadeAgentDependencies(config, {
			env: { OPENAI_API_KEY: "fixture-openai-key", GEMINI_API_KEY: "fixture-gemini-key" },
			fetchImpl: fixtureFetch,
		});
		const renderDelivery = production.renderDelivery;
		return {
			...production,
			providers: Object.fromEntries(Object.entries(production.providers).map(([provider, adapter]) => [provider, createFacadeFixtureTransport(adapter as any)])),
			extractGrammar: createFacadeFixtureTransport(production.extractGrammar),
			renderDelivery: async (input: any) => {
				try {
					selectedDelivery = await renderDelivery(input);
					return selectedDelivery;
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
		"--providers", "gpt-image-2,nano-banana-pro",
		"--image-budget-gpt-image-2", "1", "--image-budget-nano-banana-pro", "1", "--grammar-budget", "1",
	];
	const runIo = ioCapture();
	const exitCode = await runFacadeAgentCli(args, { ...runIo, dependencyFactory } as any);
	assert.equal(exitCode, 0, `${runIo.read().stderr}\n${runIo.read().stdout}\n${deliveryFailure?.stack ?? deliveryFailure ?? ""}\nCAUSE: ${deliveryFailure?.cause?.stack ?? deliveryFailure?.cause ?? ""}`);
	assert.equal(JSON.parse(runIo.read().stdout).state, "accepted");
	const result = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));

	assert.deepEqual(fetchCounts, { "gpt-image-2": 1, "nano-banana-pro": 1, grammar: 2, unexpected: 0 });
	assert.equal(result.image_submissions.total, 2);
	assert.deepEqual(result.image_submissions.by_provider, { "gpt-image-2": 1, "nano-banana-pro": 1 });
	assert.deepEqual(result.providers["gpt-image-2"].versions.map((version: any) => [version.id, version.status]), [["v001", "rejected"], ["v002", "accepted"]]);
	assert.deepEqual(result.providers["gpt-image-2"].versions[0].validation.codes, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.equal(result.providers["gpt-image-2"].versions[0].validation.metrics.maximum_outward_depth_m, 0.25);
	assert.equal(result.providers["gpt-image-2"].versions[0].validation.metrics.allowed_outward_depth_m, 0.2);
	assert.equal(result.providers["gpt-image-2"].versions[1].validation.metrics.maximum_outward_depth_m, 0.1875);
	assert.equal(result.providers["gpt-image-2"].versions[1].validation.metrics.allowed_outward_depth_m, 0.2);
	assert.deepEqual(result.providers["nano-banana-pro"].versions.map((version: any) => [version.id, version.status]), [["v001", "accepted"]]);
	assert.equal(result.final.status, "winner");
	assert.equal(result.final.selected_provider, "gpt-image-2");
	assert.equal(result.final.selected_version, "v002");
	assert.deepEqual(result.providers["gpt-image-2"].score.components, { implementability: 85.3, multiview: 100, grammar: 99, visual: result.providers["gpt-image-2"].score.components.visual });
	assert.ok(result.providers["gpt-image-2"].score.score > result.providers["nano-banana-pro"].score.score);

	const evidence = JSON.parse(await readFile(join(runDir, "evidence", "evidence-manifest.json"), "utf8"));
	assert.equal(evidence.geometry_hash, MASS_GEOMETRY_SHA256);
	assert.equal(evidence.geometry_content_sha256, MASS_CONTENT_SHA256);
	assert.equal(evidence.geometry_signed_volume_orientation, 1);
	assert.equal(evidence.facade_segment_authority_sha256, FACADE_SEGMENT_AUTHORITY_SHA256);
	for (const provider of ["gpt-image-2", "nano-banana-pro"]) {
		const accepted = result.providers[provider].versions.find((version: any) => version.status === "accepted");
		assert.equal(accepted.validation.metrics.canonical_surface_match, 1);
		assert.ok(accepted.validation.metrics.minimum_reveal_depth_m >= 0.12);
		assert.deepEqual(accepted.validation.codes, []);
	}

	const selectedVersion = result.providers[result.final.selected_provider].versions.find((version: any) => version.id === result.final.selected_version);
	const selectedGlbPath = join(runDir, selectedVersion.artifact.path);
	assert.equal(sha256(await readFile(selectedGlbPath)), result.final.selected_glb_sha256);
	const document = await new NodeIO().read(selectedGlbPath);
	const kindCounts = Object.fromEntries(REQUIRED_KINDS.map((kind) => [kind, 0]));
	const segmentIds = new Set<string>();
	const floorIds = new Set<number>();
	for (const primitive of document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
		const kind = primitive.getExtras()?.kind;
		if (Object.hasOwn(kindCounts, kind)) kindCounts[kind] += 1;
		if (primitive.getExtras()?.segment_id) segmentIds.add(primitive.getExtras().segment_id);
		if (Number.isFinite(primitive.getExtras()?.floor_m)) floorIds.add(primitive.getExtras().floor_m);
	}
	for (const kind of REQUIRED_KINDS) assert.ok(kindCounts[kind] > 0, `${kind} must exist in the selected GLB`);
	assert.equal(segmentIds.size, 16);
	assert.deepEqual([...floorIds].sort((left, right) => left - right), [0, 3.3, 6.6, 9.9, 13.2]);
	assert.equal(selectedVersion.validation.metrics.segment_authority_match, true);
	assert.equal(result.providers["gpt-image-2"].versions[0].validation.metrics.base_sha256, selectedVersion.validation.metrics.base_sha256);
	const brick = document.getRoot().listMaterials().find((material) => material.getName() === "brick");
	assert.ok(brick);
	for (const texture of [brick!.getBaseColorTexture(), brick!.getMetallicRoughnessTexture(), brick!.getNormalTexture()]) {
		assert.ok(texture?.getImage());
		assert.deepEqual(texture!.getSize(), [2048, 2048]);
		const decoded = await sharp(texture!.getImage()!, { failOn: "error", limitInputPixels: 2048 * 2048 }).raw().toBuffer({ resolveWithObject: true });
		assert.equal(decoded.data.length, 2048 * 2048 * decoded.info.channels);
	}

	assert.ok(selectedDelivery);
	assert.equal(selectedDelivery.manifest.selected_glb.sha256, result.final.selected_glb_sha256);
	assert.deepEqual(Object.keys(selectedDelivery.views).sort(), [...VIEW_NAMES].sort());
	assert.equal(new Set(Object.values(selectedDelivery.views).map((view: any) => view.selected_glb_sha256)).size, 1);
	assert.deepEqual(selectedDelivery.browser_verification.console_errors, []);
	assert.deepEqual(selectedDelivery.browser_verification.blocked_external_requests, []);
	assert.equal(selectedDelivery.browser_verification.settled_frames_identical, true);
	assert.equal(new Set(selectedDelivery.browser_verification.settled_frame_hashes).size, 1);
	assert.equal(["front", "back", "left", "right"].every(
		(name) => selectedDelivery.views[name].validation.metrics.typed_facade_receipt_bound === true,
	), true);

	const beforeStatus = await treeSnapshot(runDir);
	const statusIo = ioCapture();
	assert.equal(await runFacadeAgentCli(["status", "--run-dir", runDir], { ...statusIo } as any), 0, statusIo.read().stderr);
	assert.equal(JSON.parse(statusIo.read().stdout).state, "accepted");
	assert.deepEqual(await treeSnapshot(runDir), beforeStatus);

	assert.equal(typeof (runMemory as any).appendFacadeAgentMemory, "function", "fixture result requires facade-agent memory integration");
	assert.ok(result.delivery.memory_record, "production run must persist its selected delivery memory record");
	await (runMemory as any).appendFacadeAgentMemory(result, memoryRoot);
	const memory = JSON.parse(await readFile(join(memoryRoot, "facade-agent-runs.jsonl"), "utf8"));
	assert.equal(memory.final.selected_glb_sha256, result.final.selected_glb_sha256);
	assert.deepEqual(memory.budget, result.budget);
	assert.deepEqual(memory.budget, {
		run_ceiling_usd: 3,
		image_ceiling_usd: { "gpt-image-2": 1, "nano-banana-pro": 1 },
		grammar_ceiling_usd: 1,
		grammar_per_call_ceiling_usd: { "gpt-image-2": 0.5, "nano-banana-pro": 0.5 },
	});
	assert.deepEqual(memory.providers["gpt-image-2"].score.components, result.providers["gpt-image-2"].score.components);
	assert.equal(Object.keys(memory.delivery.views).length, 8);
	assert.deepEqual(memory.costs, {
		total_usd: 1.28,
		image_usd: { "gpt-image-2": 0.2, "nano-banana-pro": 1 },
		grammar_usd: 0.08,
	});
	assert.equal(JSON.stringify(memory).includes("fixture-openai-key"), false);
	context.diagnostic(stableJson({
		selected_glb_sha256: result.final.selected_glb_sha256,
		selected_glb_size_bytes: selectedVersion.artifact.size_bytes,
		segment_count: segmentIds.size,
		detail_primitive_count: selectedVersion.validation.metrics.detail_primitive_count,
		kind_counts: kindCounts,
		fetch_counts: fetchCounts,
		delivery_view_count: Object.keys(selectedDelivery.views).length,
		blocked_external_requests: selectedDelivery.browser_verification.blocked_external_requests.length,
		costs: memory.costs,
	}));
});
