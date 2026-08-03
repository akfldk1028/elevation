import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	correctGrammar,
	normalizeFacadeGrammar,
	resolveApprovedDesign,
} from "../plugins/elevation-3d/lib/facade-grammar.mjs";

const temporaryRoots: string[] = [];

after(async () => {
	await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(data: Uint8Array) {
	return createHash("sha256").update(data).digest("hex");
}

test("resolves the candidate-approved image and verifies its recorded SHA-256", async () => {
	const design = await resolveApprovedDesign({
		candidateId: "creative-013",
		memoryRoot: resolve("memory/elevation-3d"),
	});
	assert.match(design.image_path, /approved-detailed-isometric-v1\.png$/);
	assert.equal(design.image_sha256, sha256(await readFile(design.image_path)));
});

test("rejects an explicit image whose hash differs from approved metadata", async () => {
	const memoryRoot = await mkdtemp(join(tmpdir(), "elevation-3d-approved-design-"));
	temporaryRoots.push(memoryRoot);
	const assetRoot = join(memoryRoot, "assets", "creative-013");
	await mkdir(assetRoot, { recursive: true });
	const approvedImage = join(assetRoot, "approved.png");
	const changedImage = join(memoryRoot, "changed.png");
	const approvedBytes = Buffer.from("approved image");
	await writeFile(approvedImage, approvedBytes);
	await writeFile(changedImage, "changed image");
	await writeFile(join(assetRoot, "approved-design-v1.json"), JSON.stringify({
		candidate_id: "creative-013",
		image_path: "approved.png",
		image_sha256: sha256(approvedBytes),
		facade_grammar: {},
	}));

	await assert.rejects(
		() => resolveApprovedDesign({ candidateId: "creative-013", approvedImage: changedImage, memoryRoot }),
		/approved image hash mismatch/,
	);
});

test("normalizes approved grammar against MASS floor guides and facade extents", () => {
	const approvedDesign = {
		facade_grammar: {
			material_palette: { solid: "concrete", transparent: "glass", accent: "bronze" },
			bay_width_m: 0.5,
			frame_depth_m: 0.4,
			mullion_depth_m: 0.01,
			glazing_recess_m: 0.25,
			parapet_height_m: 0.1,
		},
	};
	const grammar = normalizeFacadeGrammar({
		approvedDesign,
		floorGuides: { floor_guides_m: [0, 3.3, 6.6, 9.9] },
		facadePlanes: {
			facade_planes: [
				{ view: "front", extent_m: [24.361488, 9.9] },
				{ view: "right", extent_m: [12.234058, 9.9] },
			],
		},
	});

	assert.deepEqual(grammar.floor_elevations_m, [0, 3.3, 6.6, 9.9]);
	assert.deepEqual(grammar.facade_lengths_m, { front: 24.361488, right: 12.234058 });
	assert.deepEqual(grammar.material_palette, { solid: "concrete", transparent: "glass", accent: "bronze" });
	assert.equal(grammar.bay_width_m, 0.9);
	assert.equal(grammar.frame_depth_m, 0.25);
	assert.equal(grammar.mullion_depth_m, 0.03);
	assert.equal(grammar.glazing_recess_m, 0.2);
	assert.equal(grammar.parapet_height_m, 0.15);
});

const grammar = {
	bay_width_m: 1.5,
	frame_depth_m: 0.18,
	mullion_depth_m: 0.08,
	glazing_recess_m: 0.12,
	parapet_height_m: 0.35,
};

test("halves detail depths after an outward-bounds failure", () => {
	const corrected = correctGrammar(grammar, ["DETAIL_BOUNDS_EXCEEDED"]);
	assert.equal(corrected.frame_depth_m, grammar.frame_depth_m / 2);
	assert.equal(corrected.mullion_depth_m, grammar.mullion_depth_m / 2);
});

test("sets deterministic bay width after a primitive-budget failure", () => {
	for (const bayWidth of [1, 1.5, 2.5]) {
		assert.equal(
			correctGrammar({ ...grammar, bay_width_m: bayWidth }, ["PRIMITIVE_BUDGET_EXCEEDED"]).bay_width_m,
			2.25,
		);
	}
});

test("keeps repeated corrections within approved grammar limits", () => {
	const corrected = correctGrammar(
		{ ...grammar, bay_width_m: 2.5, frame_depth_m: 0.06, mullion_depth_m: 0.04 },
		["DETAIL_BOUNDS_EXCEEDED", "PRIMITIVE_BUDGET_EXCEEDED"],
	);
	assert.equal(corrected.bay_width_m, 2.25);
	assert.equal(corrected.frame_depth_m, 0.05);
	assert.equal(corrected.mullion_depth_m, 0.03);
});
