import assert from "node:assert/strict";
import { test } from "node:test";
import {
	COMPETITION_DAYLIGHT_STYLE_ID,
	renderStyleHash,
	resolvePbrRenderStyle,
	viewPresentationPolicy,
} from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const expectedStyle = {
	id: "competition-daylight-v1",
	background: "#fafaf7",
	toneMapping: "aces-filmic",
	exposure: 0.94,
	environment: { type: "room-pmrem", intensity: 0.45 },
	hemisphere: { sky: "#ffffff", ground: "#d8d1c5", intensity: 0.8 },
	sun: {
		color: "#fff8ec",
		intensity: 1.9,
		position: [12, -8, 60],
		shadowMapSize: 2048,
		radius: 5,
		bias: -0.0002,
		normalBias: 0.02,
	},
	ground: { enabledFor: ["axon", "opposite-axon"], opacity: 0.12, padding: 0.16 },
	materialResponse: {
		concrete: { maxRoughnessDelta: -0.08 },
		glass: { maxEnvIntensity: 1.35, preserveTransparency: true },
		bronze: { maxMetalnessDelta: 0.08 },
		opaque: { maxRoughnessDelta: -0.04 },
	},
};

function assertDeeplyFrozen(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	assert.equal(Object.isFrozen(value), true);
	for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

function isInvalidStyle(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "PBR_RENDER_STYLE_INVALID";
}

test("resolves the approved competition daylight preset as an immutable value", () => {
	const style = resolvePbrRenderStyle();
	assert.equal(COMPETITION_DAYLIGHT_STYLE_ID, "competition-daylight-v1");
	assert.deepEqual(style, expectedStyle);
	assertDeeplyFrozen(style);
	assert.equal(renderStyleHash(style), "d56ddee36347d9d29580de3a4410998de9c23195d3cc3cea0edf7be6b16b40b6");
});

test("normalizes equivalent overrides to one deterministic SHA-256 identity", () => {
	const first = resolvePbrRenderStyle({
		sun: { intensity: 1.8, color: "#FFF8EC" },
		exposure: 0.98,
	});
	const second = resolvePbrRenderStyle({
		exposure: 0.98,
		sun: { color: "#fff8ec", intensity: 1.8 },
	});
	assert.deepEqual(first, second);
	assert.match(renderStyleHash(first), /^[a-f0-9]{64}$/);
	assert.equal(renderStyleHash(first), renderStyleHash(second));
});

test("rejects values that could create an invalid or unrecorded render state", () => {
	const invalidOverrides = [
		{ exposure: Number.NaN },
		{ unexpected: true },
		{ sun: { unexpected: true } },
		{ background: "white" },
		{ hemisphere: { sky: "#fffff" } },
		{ environment: { intensity: -0.01 } },
		{ hemisphere: { intensity: -1 } },
		{ sun: { intensity: -1 } },
		{ sun: { position: [24, -18] } },
		{ sun: { position: [24, Number.POSITIVE_INFINITY, 34] } },
		{ ground: { opacity: -0.01 } },
		{ ground: { opacity: 1.01 } },
	];
	for (const overrides of invalidOverrides) {
		assert.throws(() => resolvePbrRenderStyle(overrides), isInvalidStyle);
	}
});

test("enables the bounded ground/contact receiver only for the two axons", () => {
	const style = resolvePbrRenderStyle();
	for (const view of ["axon", "opposite-axon"]) {
		assert.deepEqual(viewPresentationPolicy(view, style), { ground: true, contactShadow: true });
	}
	for (const view of ["front", "back", "left", "right", "plan", "top"]) {
		assert.deepEqual(viewPresentationPolicy(view, style), { ground: false, contactShadow: false });
	}
	assert.throws(() => viewPresentationPolicy("perspective", style), isInvalidStyle);
});
