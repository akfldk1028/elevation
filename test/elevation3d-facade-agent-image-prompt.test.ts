import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import { createFacadeImageEditRequest } from "../plugins/elevation-3d/lib/facade-agent/image-providers/contract.mjs";
import {
	buildFacadeArchitecturalPrompt,
	FACADE_IMAGE_PROMPT_REVISION,
	FACADE_PROHIBITED_CHANGES,
} from "../plugins/elevation-3d/lib/facade-agent/image-providers/prompt.mjs";

const EVIDENCE_HASH = "a".repeat(64);

function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

test("builds the exact provider-neutral architectural edit prompt", () => {
	const value = buildFacadeArchitecturalPrompt({
		candidateId: "creative-020",
		briefId: "brick-punched-window-v1",
		evidenceManifestSha256: EVIDENCE_HASH,
	});
	const expected = [
		"Goal:",
		"Create a competition-quality architectural facade concept that will be rebuilt as exact local 3D.",
		"",
		"Authority:",
		`Candidate creative-020, brief brick-punched-window-v1, and evidence manifest ${EVIDENCE_HASH} are binding.`,
		"The supplied contact sheet fixes the silhouette, footprint, height, storey count, facade planes, opening zones, and every camera.",
		"",
		"Material direction:",
		"Use warm red or red-brown masonry, deep punched windows, mineral mortar, restrained precast lintels and sills, dark durable metal frames, and realistic glazing.",
		"",
		"Composition:",
		"Preserve every panel and view in the supplied sheet and design one coherent facade system across all visible sides.",
		"",
		"Constraints:",
		"Change facade articulation and material appearance only.",
		"Do not create a curtain wall, extra floors, balconies, setbacks, projections, roof changes, landscaping, people, text, labels, logos, or camera changes.",
		"",
		"Output use:",
		"Produce a reference board for deterministic architectural grammar extraction, not a free-form marketing rendering.",
		"",
		"Critical preserve rules:",
		"Preserve the silhouette, footprint, height, storey count, facade planes, opening zones, every panel, every view, and every camera exactly.",
	].join("\n");

	assert.equal(FACADE_IMAGE_PROMPT_REVISION, "facade-architectural-edit-v1");
	assert.equal(value.prompt, expected);
	assert.equal(value.negativePrompt, "curtain wall; extra floors; balconies; setbacks; projections; roof changes; landscaping; people; text; labels; logos; camera changes");
	assert.equal(value.sha256, sha256(expected));
	assert.deepEqual(FACADE_PROHIBITED_CHANGES, [
		"curtain wall", "extra floors", "balconies", "setbacks", "projections", "roof changes",
		"landscaping", "people", "text", "labels", "logos", "camera changes",
	]);
	assert.ok(Object.isFrozen(value));
	assert.ok(Object.isFrozen(FACADE_PROHIBITED_CHANGES));
});

test("binds prompt, evidence, model, and output changes to different request fingerprints", async () => {
	const evidenceBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#804020" } }).png().toBuffer();
	const prompt = buildFacadeArchitecturalPrompt({ candidateId: "creative-020", briefId: "brick-punched-window-v1", evidenceManifestSha256: EVIDENCE_HASH });
	const base: any = {
		provider: "gpt-image-2", model: "gpt-image-2",
		candidate: { id: "creative-020" }, brief: { id: "brick-punched-window-v1", revision: "1" },
		evidence: { manifestSha256: EVIDENCE_HASH, pngBytes: evidenceBytes },
		prompt: { revision: prompt.revision, text: prompt.prompt, sha256: prompt.sha256 },
		output: { width: 1536, height: 1536, format: "png", count: 1 },
		prohibitedChanges: FACADE_PROHIBITED_CHANGES,
		estimateUsd: 0.2, ceilingUsd: 0.5,
	};
	const baseline: any = createFacadeImageEditRequest(base);
	const changedPromptText = `${prompt.prompt}!`;
	const variants = [
		{ ...base, prompt: { ...base.prompt, text: changedPromptText, sha256: sha256(changedPromptText) } },
		{ ...base, evidence: { ...base.evidence, manifestSha256: "b".repeat(64) } },
		{ ...base, model: "gpt-image-2-snapshot" },
		{ ...base, output: { ...base.output, width: 1024 } },
	];
	for (const variant of variants) assert.notEqual(createFacadeImageEditRequest(variant).fingerprint, baseline.fingerprint);
	assert.throws(() => createFacadeImageEditRequest({ ...base, apiKey: "sk-must-not-be-read" }), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
});
