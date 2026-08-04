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
	ground: { enabledFor: ["axon", "opposite-axon"], opacity: 0.14, padding: 0.16 },
	materialResponse: {
		concrete: { maxRoughnessDelta: -0.08, tintMultiplier: "#fff4e6" },
		glass: { maxEnvIntensity: 1.35, preserveTransparency: true, tintMultiplier: "#a8c0cc" },
		bronze: { maxMetalnessDelta: 0.08, tintMultiplier: "#8a5a32" },
		opaque: { maxRoughnessDelta: -0.04, tintMultiplier: "#454b52" },
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
	assert.equal(renderStyleHash(style), "32abca17944b862d950b9ebd227a026de24aad04a51b5be103926f09754c1532");
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

test("rejects extreme finite daylight values outside the approved operating envelope", () => {
	const invalidOverrides = [
		{ exposure: 0 },
		{ exposure: 3.01 },
		{ environment: { intensity: 10.01 } },
		{ hemisphere: { intensity: 10.01 } },
		{ sun: { intensity: 10.01 } },
		{ sun: { position: [1000.01, 0, 1] } },
		{ sun: { position: [0, -1000.01, 1] } },
		{ sun: { position: [0, 0, 0] } },
		{ sun: { shadowMapSize: 128 } },
		{ sun: { shadowMapSize: 512 + 256 } },
		{ sun: { shadowMapSize: 8192 } },
		{ sun: { radius: 20.01 } },
		{ sun: { bias: -0.1001 } },
		{ sun: { bias: 0.1001 } },
		{ sun: { normalBias: 1.01 } },
		{ ground: { opacity: 0.5001 } },
		{ ground: { padding: 1.01 } },
		{ materialResponse: { concrete: { maxRoughnessDelta: -1.01 } } },
		{ materialResponse: { opaque: { maxRoughnessDelta: 1.01 } } },
		{ materialResponse: { bronze: { maxMetalnessDelta: 1.01 } } },
		{ materialResponse: { glass: { maxEnvIntensity: 5.01 } } },
		{ materialResponse: { bronze: { tintMultiplier: "bronze" } } },
		{ materialResponse: { opaque: { tintMultiplier: "#12345g" } } },
	];
	for (const overrides of invalidOverrides) {
		assert.throws(() => resolvePbrRenderStyle(overrides), isInvalidStyle, JSON.stringify(overrides));
	}
});

test("accepts every inclusive daylight style boundary", () => {
	for (const overrides of [
		{ exposure: 3 },
		{ environment: { intensity: 10 } },
		{ hemisphere: { intensity: 10 } },
		{ sun: { intensity: 10, position: [-1000, 1000, 1], shadowMapSize: 4096, radius: 20, bias: -0.1, normalBias: 1 } },
		{ sun: { bias: 0.1, shadowMapSize: 256 } },
		{ ground: { opacity: 0.5, padding: 1 } },
		{ materialResponse: { concrete: { maxRoughnessDelta: -1 }, opaque: { maxRoughnessDelta: 1 }, bronze: { maxMetalnessDelta: -1 }, glass: { maxEnvIntensity: 5 } } },
	]) assert.doesNotThrow(() => resolvePbrRenderStyle(overrides));
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
