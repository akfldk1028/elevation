import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import {
	FacadeDesignContextError,
	buildFacadeDesignContext,
	readVerifiedFacadeDesignContextAuthority,
	withVerifiedFacadeDesignContext,
} from "../plugins/elevation-3d/lib/facade-agent/design/context.mjs";
import {
	FACADE_EVIDENCE_PASS_NAMES,
	FACADE_EVIDENCE_VIEW_NAMES,
} from "../plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { deriveFacadeSegmentsFromMass } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

const root = await mkdtemp(join(tmpdir(), "facade-design-context-"));
after(async () => rm(root, { recursive: true, force: true }));

const mesh = {
	vertices: [
		[-4, -2, 0], [4, -2, 0], [4, 2, 0], [-4, 2, 0],
		[-4, -2, 6.6], [4, -2, 6.6], [4, 2, 6.6], [-4, 2, 6.6],
	],
	triangles: [
		[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
		[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
		[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
	],
};
const facadeSegmentAuthority = deriveFacadeSegmentsFromMass({ mesh });
const floorGuides = { floor_guides_m: [0, 3.3, 6.6] };
const cameras = {
	views: {
		axon: { projection_axes: { depth: [0.5965499863, -0.5965499863, 0.5368949876] } },
	},
};
const sourceBytes = Buffer.from("facade-design-source-fixture");
const sourcePath = join(root, "source.bin");
await writeFile(sourcePath, sourceBytes);
const candidate = {
	candidate: { candidate_id: "creative-020" },
	identity: { candidate_id: "creative-020", geometry_hash: "geometry-fixture" },
	mesh,
	floor_guides: floorGuides,
	facade_segment_authority: facadeSegmentAuthority,
	cameras,
	artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
};

async function verifiedEvidenceFixture() {
	const evidenceRoot = join(root, "evidence");
	await mkdir(evidenceRoot);
	const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#8b3f2f" } }).png().toBuffer();
	const artifacts: Record<string, unknown> = {};
	for (const mode of FACADE_EVIDENCE_PASS_NAMES) {
		await mkdir(join(evidenceRoot, mode));
		for (const view of FACADE_EVIDENCE_VIEW_NAMES) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), png);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(png), width: 2, height: 2, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), png);
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1",
		candidate_id: "creative-020",
		geometry_hash: candidate.identity.geometry_hash,
		geometry_content_sha256: sha256(stableJson({ vertices: mesh.vertices, triangles: mesh.triangles })),
		floor_guides_m: [...floorGuides.floor_guides_m],
		facade_planes_sha256: sha256(stableJson(facadeSegmentAuthority)),
		facade_segment_authority_sha256: facadeSegmentAuthority.sha256,
		geometry_signed_volume_orientation: facadeSegmentAuthority.source_signed_volume_orientation,
		cameras_sha256: sha256(stableJson(cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }],
		artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(png), width: 2, height: 2 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	return { verified: await verifyFacadeEvidencePack({ manifestPath, input: candidate }), png };
}

const { verified: evidence, png } = await verifiedEvidenceFixture();
const runDir = join(root, "run");
await mkdir(runDir);
const document = new Document();
const scene = document.createScene("Scene");
scene.addChild(document.createNode("window-1").setExtras({
	kind: "window",
	segment_id: facadeSegmentAuthority.facade_planes[0].segment_id,
	local_bounds: { u0: 1, u1: 2, v0: 0.8, v1: 2.6, n0: -0.1, n1: 0.1 },
}));
const selectedGlbBytes = Buffer.from(await new NodeIO().writeBinary(document));
const selectedGlbPath = join(runDir, "selected.glb");
await writeFile(selectedGlbPath, selectedGlbBytes);
for (const name of ["front", "axon"]) await writeFile(join(runDir, `${name}.png`), png);

function input(overrides: Record<string, unknown> = {}) {
	return {
		runDir,
		candidate,
		evidence,
		selectedGlb: { path: "selected.glb", sha256: sha256(selectedGlbBytes) },
		technicalThumbnails: [
			{ view: "front", path: "front.png", sha256: sha256(png), width: 2, height: 2 },
			{ view: "axon", path: "axon.png", sha256: sha256(png), width: 2, height: 2 },
		],
		...overrides,
	};
}

function typedRejection(error: unknown) {
	return error instanceof FacadeDesignContextError && error.code === "FACADE_DESIGN_CONTEXT_INVALID";
}

test("builds a frozen model-safe context from verified geometry and artifact bytes", async () => {
	const context = await buildFacadeDesignContext(input());

	assert.equal(context.schema_version, "arr.elevation3d.facade-design-context.v1");
	assert.equal(context.source.candidate_id, "creative-020");
	assert.equal(context.source.selected_glb_sha256, sha256(selectedGlbBytes));
	assert.match(context.source.candidate_sha256, /^[a-f0-9]{64}$/);
	assert.match(context.source.context_sha256, /^[a-f0-9]{64}$/);
	assert.equal(context.facade_segments.length, 4);
	assert.deepEqual(context.storeys, [
		{ storey: 1, z_min: 0, z_max: 3.3 },
		{ storey: 2, z_min: 3.3, z_max: 6.6 },
	]);
	assert.equal(context.existing_openings[0].kind, "window");
	assert.equal(context.technical_thumbnails.length, 2);
	assert.equal(context.facade_segments.some((segment: any) => segment.visibility_score > 0), true);
	assert.equal(Object.isFrozen(context), true);
	assert.equal(Object.isFrozen(context.facade_segments[0]), true);
});

test("rejects escaped or stale artifacts before invoking the model handoff", async () => {
	let calls = 0;
	const handoff = () => { calls += 1; };
	await assert.rejects(() => withVerifiedFacadeDesignContext(input({
		selectedGlb: { path: "../selected.glb", sha256: sha256(selectedGlbBytes) },
	}), handoff), typedRejection);
	await assert.rejects(() => withVerifiedFacadeDesignContext(input({
		technicalThumbnails: [{ view: "front", path: "front.png", sha256: "f".repeat(64), width: 2, height: 2 }],
	}), handoff), typedRejection);
	assert.equal(calls, 0);
});

test("rejects missing segment authority and unbounded thumbnail evidence before handoff", async () => {
	let calls = 0;
	const handoff = () => { calls += 1; };
	await assert.rejects(() => withVerifiedFacadeDesignContext(input({
		candidate: { ...candidate, facade_segment_authority: undefined },
	}), handoff), typedRejection);
	await assert.rejects(() => withVerifiedFacadeDesignContext(input({
		technicalThumbnails: Array.from({ length: 5 }, (_, index) => ({
			view: `view-${index}`, path: "front.png", sha256: sha256(png), width: 2, height: 2,
		})),
	}), handoff), typedRejection);
	assert.equal(calls, 0);
});

test("invokes the model handoff exactly once only after context verification", async () => {
	let received: any;
	const result = await withVerifiedFacadeDesignContext(input(), (context) => {
		received = context;
		return "accepted";
	});

	assert.equal(result, "accepted");
	assert.equal(received.source.selected_glb_sha256, sha256(selectedGlbBytes));
});

test("rejects candidate mutation while asynchronous artifact verification is in progress", async () => {
	const mutableCandidate = structuredClone(candidate);
	const pending = buildFacadeDesignContext(input({ candidate: mutableCandidate }));
	mutableCandidate.floor_guides.floor_guides_m[1] = 3.2;

	await assert.rejects(() => pending, typedRejection);
});

test("binds the context hash to the exact selected GLB bytes", async () => {
	const alternateDocument = new Document();
	const alternateScene = alternateDocument.createScene("Alternate Scene");
	alternateScene.addChild(alternateDocument.createNode("window-1").setExtras({
		kind: "window",
		segment_id: facadeSegmentAuthority.facade_planes[0].segment_id,
		local_bounds: { u0: 1, u1: 2, v0: 0.8, v1: 2.6, n0: -0.1, n1: 0.1 },
	}));
	const alternateBytes = Buffer.from(await new NodeIO().writeBinary(alternateDocument));
	await writeFile(join(runDir, "alternate.glb"), alternateBytes);

	const original = await buildFacadeDesignContext(input());
	const alternate = await buildFacadeDesignContext(input({
		selectedGlb: { path: "alternate.glb", sha256: sha256(alternateBytes) },
	}));
	assert.notEqual(alternate.source.selected_glb_sha256, original.source.selected_glb_sha256);
	assert.notEqual(alternate.source.context_sha256, original.source.context_sha256);
});

test("exposes source authority only for the exact verified context capability", async () => {
	const context = await buildFacadeDesignContext(input());
	assert.deepEqual(readVerifiedFacadeDesignContextAuthority(context), context.source);
	assert.equal(readVerifiedFacadeDesignContextAuthority(structuredClone(context)), null);
	assert.equal(readVerifiedFacadeDesignContextAuthority({ ...context }), null);
});
