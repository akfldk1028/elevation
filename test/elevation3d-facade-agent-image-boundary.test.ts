import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import {
	createFacadeImageEditRequest,
	readVerifiedFacadeImageEditRequestAuthority,
	readVerifiedFacadeImageEditResultAuthority,
	verifyFacadeImageEditResult,
} from "../plugins/elevation-3d/lib/facade-agent/image-providers/contract.mjs";
import { decodeBoundedProviderImage } from "../plugins/elevation-3d/lib/facade-agent/image-providers/image-codec.mjs";
import { cloneBoundedPlainData } from "../plugins/elevation-3d/lib/facade-agent/image-providers/response-boundary.mjs";
import { fetchWithProviderDeadline } from "../plugins/elevation-3d/lib/facade-agent/image-providers/transport.mjs";

const HASH_A = "a".repeat(64);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const promptText = "Preserve exact geometry.";

function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

async function png(width = 2, height = 2) {
	return sharp({ create: { width, height, channels: 4, background: { r: 120, g: 60, b: 30, alpha: 1 } } }).png().toBuffer();
}

async function validRequest(overrides: Record<string, unknown> = {}) {
	const evidenceBytes = await png();
	return {
		provider: "gpt-image-2",
		model: "gpt-image-2",
		candidate: { id: "creative-020" },
		brief: { id: "brick-punched-window-v1", revision: "1" },
		evidence: { manifestSha256: HASH_A, pngBytes: evidenceBytes },
		prompt: { revision: "facade-architectural-edit-v1", text: promptText, sha256: sha256(promptText) },
		output: { width: 1536, height: 1536, format: "png", count: 1 },
		prohibitedChanges: ["curtain wall", "extra floors"],
		estimateUsd: 0.2,
		ceilingUsd: 0.5,
		...overrides,
	};
}

test("creates a hash-bound immutable one-image request without retaining mutable input bytes", async () => {
	const input: any = await validRequest();
	const originalFirstByte = input.evidence.pngBytes[0];
	const request: any = createFacadeImageEditRequest(input);

	input.evidence.pngBytes[0] = 0;
	input.candidate.id = "changed";

	assert.equal(request.candidate.id, "creative-020");
	assert.equal(Buffer.from(request.evidence.pngBase64, "base64")[0], originalFirstByte);
	assert.match(request.fingerprint, /^[a-f0-9]{64}$/);
	assert.ok(Object.isFrozen(request));
	assert.ok(Object.isFrozen(request.output));
	assert.throws(() => request.output.count = 2, TypeError);
});

test("rejects non-one-image requests, invalid hashes, and estimates above the ceiling", async () => {
	const countInput = await validRequest();
	const hashInput = await validRequest();
	const budgetInput = await validRequest();
	assert.throws(() => createFacadeImageEditRequest({ ...countInput, output: { width: 1536, height: 1536, format: "png", count: 2 } }), (error: any) => error.code === "PROVIDER_OUTPUT_INVALID");
	assert.throws(() => createFacadeImageEditRequest({ ...hashInput, evidence: { manifestSha256: "bad", pngBytes: hashInput.evidence.pngBytes } }), (error: any) => error.code === "PROVIDER_EVIDENCE_INVALID");
	assert.throws(() => createFacadeImageEditRequest({ ...budgetInput, estimateUsd: 0.51 }), (error: any) => error.code === "PROVIDER_BUDGET_EXCEEDED");
});

test("rejects accessors, cycles, dangerous keys, and excessive response depth", () => {
	const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { return "must-not-run"; } });
	assert.throws(() => cloneBoundedPlainData(accessor), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
	const cycle: any = {}; cycle.self = cycle;
	assert.throws(() => cloneBoundedPlainData(cycle), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
	const dangerous = Object.create(null); dangerous.constructor = "bad";
	assert.throws(() => cloneBoundedPlainData(dangerous), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
	let deep: any = "leaf";
	for (let index = 0; index < 34; index += 1) deep = { child: deep };
	assert.throws(() => cloneBoundedPlainData(deep), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
});

test("fully decodes a PNG and rejects a truncated or non-PNG payload", async () => {
	const bytes = await png(3, 4);
	const decoded: any = await decodeBoundedProviderImage({ bytes });
	assert.deepEqual({ width: decoded.width, height: decoded.height, channels: decoded.channels, mimeType: decoded.mimeType }, { width: 3, height: 4, channels: 4, mimeType: "image/png" });
	assert.match(decoded.sha256, /^[a-f0-9]{64}$/);
	await assert.rejects(() => decodeBoundedProviderImage({ bytes: bytes.subarray(0, 20) }), (error: any) => error.code === "PROVIDER_IMAGE_INVALID");
	await assert.rejects(() => decodeBoundedProviderImage({ bytes: Buffer.from("not png") }), (error: any) => error.code === "PROVIDER_IMAGE_INVALID");
});

test("normalizes verified result metadata and redacts secrets and reusable identifiers", async () => {
	const bytes = await png();
	const result: any = await verifyFacadeImageEditResult({
		provider: "gpt-image-2",
		resolvedModel: "gpt-image-2-2026-07-01",
		requestFingerprint: HASH_A,
		bytes,
		remoteId: "request-reusable-123",
		usage: { image_count: 1, authorization: "Bearer secret-value", nested: { api_key: "sk-secret-value" } },
		actualUsd: 0.21,
	});
	assert.equal(result.bytes.equals(bytes), true);
	assert.equal(result.remoteId, undefined);
	assert.match(result.remoteIdHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(result.usage, { image_count: 1, authorization: "[REDACTED]", nested: { api_key: "[REDACTED]" } });
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.usage));
});

test("grants request and result authority only to original untampered objects", async () => {
	const request: any = createFacadeImageEditRequest(await validRequest());
	assert.deepEqual(readVerifiedFacadeImageEditRequestAuthority(request), {
		provider: "gpt-image-2",
		model: "gpt-image-2",
		candidateId: "creative-020",
		evidenceManifestSha256: HASH_A,
		fingerprint: request.fingerprint,
	});
	assert.equal(readVerifiedFacadeImageEditRequestAuthority({ ...request }), null);

	const result: any = await verifyFacadeImageEditResult({
		provider: "gpt-image-2", resolvedModel: "gpt-image-2-2026-07-01",
		requestFingerprint: request.fingerprint, bytes: await png(), remoteId: "request-123",
	});
	assert.equal(readVerifiedFacadeImageEditResultAuthority(result)?.proposalSha256, result.sha256);
	assert.equal(readVerifiedFacadeImageEditResultAuthority({ ...result }), null);
	result.bytes[0] = 0;
	assert.equal(readVerifiedFacadeImageEditResultAuthority(result), null);
});

test("rejects an oversized encoded image before decode", async () => {
	const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
	PNG_SIGNATURE.copy(oversized);
	await assert.rejects(() => decodeBoundedProviderImage({ bytes: oversized }), (error: any) => error.code === "PROVIDER_IMAGE_TOO_LARGE");
});

test("rejects oversized evidence before encoding the common request", async () => {
	const input: any = await validRequest();
	input.evidence.pngBytes = Buffer.alloc(32 * 1024 * 1024 + 1);
	PNG_SIGNATURE.copy(input.evidence.pngBytes);
	assert.throws(() => createFacadeImageEditRequest(input), (error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
});

test("performs one fetch and maps timeout and caller abort without retrying", async () => {
	let calls = 0;
	const success = await fetchWithProviderDeadline({
		fetchImpl: async () => { calls += 1; return new Response("ok"); },
		url: "https://provider.example/v1/images",
		init: { method: "POST" },
		timeoutMs: 100,
	});
	assert.equal(await success.text(), "ok");
	assert.equal(calls, 1);

	await assert.rejects(() => fetchWithProviderDeadline({
		fetchImpl: async (_url: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
		url: "https://provider.example/v1/images",
		init: { method: "POST" },
		timeoutMs: 5,
	}), (error: any) => error.code === "PROVIDER_TIMEOUT");

	const controller = new AbortController(); controller.abort();
	await assert.rejects(() => fetchWithProviderDeadline({
		fetchImpl: async () => new Response("unreachable"),
		url: "https://provider.example/v1/images",
		init: { method: "POST" },
		signal: controller.signal,
		timeoutMs: 100,
	}), (error: any) => error.code === "PROVIDER_ABORTED" && error.definitiveNonSubmission === true);
});
