import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEmbeddedPbrRender } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";

test("embedded PBR render validation requires one stable GLB across eight distinct views", () => {
	const names = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
	const selectedGlbSha256 = "a".repeat(64);
	const views = Object.fromEntries(names.map((name, index) => [name, {
		selectedGlbSha256,
		sha256: String(index).padStart(64, "0"),
		settledHashes: [String(index).padStart(64, "0"), String(index).padStart(64, "0")],
		foregroundFraction: 0.2,
	}]));
	assert.deepEqual(validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors: [], materialMode: "embedded-pbr" }), {
		accepted: true,
		status: "accepted",
		codes: [],
	});
	views.back.selectedGlbSha256 = "b".repeat(64);
	views.axon.settledHashes[1] = "f".repeat(64);
	assert.deepEqual(validateEmbeddedPbrRender({ views, selectedGlbSha256, consoleErrors: ["texture failed"], materialMode: "procedural-preview" }).codes.sort(), [
		"CONSOLE_ERROR",
		"MATERIAL_MODE_INVALID",
		"RENDER_UNSTABLE",
		"SELECTED_GLB_MISMATCH",
	].sort());
});
