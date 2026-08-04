import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TEXTURING_STATES,
	TexturingError,
	assertTexturingRequest,
} from "../plugins/elevation-3d/lib/texturing/contract.mjs";

const validRequest = {
	acceptedGlb: "C:/runs/accepted.glb",
	referenceImage: "C:/runs/reference.png",
	resultDir: "C:/runs/textured",
	provider: "tripo",
	textureQuality: "standard",
	seed: 13013,
	maxCredits: 15,
};

test("texturing request accepts the one approved standard Tripo configuration", () => {
	const normalized = assertTexturingRequest(validRequest);
	assert.deepEqual(normalized, validRequest);
	assert.equal(TEXTURING_STATES.includes("texture_submitted"), true);
	assert.equal(TEXTURING_STATES.includes("accepted"), true);
});

test("texturing request rejects an automatic high-cost quality escalation", () => {
	assert.throws(
		() => assertTexturingRequest({ ...validRequest, textureQuality: "detailed" }),
		(error: unknown) => error instanceof TexturingError && error.code === "TEXTURE_QUALITY_NOT_ALLOWED",
	);
});

test("texturing request rejects missing inputs, fractional seeds, and excessive credit caps", () => {
	assert.throws(
		() => assertTexturingRequest({ ...validRequest, acceptedGlb: "" }),
		(error: unknown) => error instanceof TexturingError && error.code === "INVALID_TEXTURING_REQUEST",
	);
	assert.throws(
		() => assertTexturingRequest({ ...validRequest, seed: 13.5 }),
		(error: unknown) => error instanceof TexturingError && error.code === "INVALID_TEXTURE_SEED",
	);
	assert.throws(
		() => assertTexturingRequest({ ...validRequest, maxCredits: 16 }),
		(error: unknown) => error instanceof TexturingError && error.code === "CREDIT_CAP_EXCEEDED",
	);
});
