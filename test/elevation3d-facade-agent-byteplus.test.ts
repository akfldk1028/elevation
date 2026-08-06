import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { createFacadeImageEditRequest } from "../plugins/elevation-3d/lib/facade-agent/image-providers/contract.mjs";
import { buildFacadeArchitecturalPrompt, FACADE_PROHIBITED_CHANGES } from "../plugins/elevation-3d/lib/facade-agent/image-providers/prompt.mjs";
import {
	BYTEPLUS_SEEDREAM_POLICY,
	createProvider,
} from "../plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus/adapter.mjs";
import { serializeBytePlusRequest } from "../plugins/elevation-3d/lib/facade-agent/image-providers/providers/byteplus/request.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNg5+AEAAAyABna+TCwAAAAAElFTkSuQmCC", "base64");
const OUTPUT_PNG = await sharp({ create: { width: 1536, height: 1536, channels: 3, background: "#8b4935" } }).png().toBuffer();
const FIXTURE_ROOT = join(process.cwd(), "test", "fixtures", "facade-agent", "providers", "byteplus");

async function fixture(name: string) {
	return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8"));
}

function request(overrides: Record<string, unknown> = {}) {
	const prompt = buildFacadeArchitecturalPrompt({ candidateId: "creative-020", briefId: "brick-punched-window-v1", evidenceManifestSha256: "a".repeat(64) });
	return createFacadeImageEditRequest({
		provider: "seedream-5-pro",
		model: "dola-seedream-5-0-pro-260628",
		candidate: { id: "creative-020" },
		brief: { id: "brick-punched-window-v1", revision: "1" },
		evidence: { manifestSha256: "a".repeat(64), pngBytes: PNG },
		prompt: { revision: prompt.revision, text: prompt.prompt, sha256: prompt.sha256 },
		output: { width: 1536, height: 1536, format: "png", count: 1 },
		prohibitedChanges: FACADE_PROHIBITED_CHANGES,
		estimateUsd: 0.045,
		ceilingUsd: 0.10,
		...overrides,
	});
}

async function authorizedGenerate(provider: any, providerRequest: any) {
	const root = await mkdtemp(join(tmpdir(), "facade-byteplus-"));
	let result: any;
	let failure: any;
	try {
		await createPaidOperationLedger(join(root, "ledger.json"), { approvedRoot: root }).executeOnce({
			requestKey: providerRequest.fingerprint,
			provider: "seedream-5-pro",
			kind: "image-generation",
			ceilingUsd: 0.10,
			estimateUsd: 0.045,
			operation: async (submission: any) => {
				try { result = await provider.generate({ request: providerRequest, submission }); }
				catch (error) { failure = error; }
				return { remoteId: result?.remoteId ?? "byteplus-failure-fixture", artifactSha256: result?.sha256 ?? "f".repeat(64), actualUsd: result?.actualUsd ?? 0.045 };
			},
		});
		if (failure) throw failure;
		return result;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("serializes the exact one-image Seedream request", () => {
	const body = serializeBytePlusRequest(request());
	assert.deepEqual(body, {
		model: "dola-seedream-5-0-pro-260628",
		prompt: request().prompt.text,
		image: `data:image/png;base64,${PNG.toString("base64")}`,
		size: "1536x1536",
		output_format: "png",
		response_format: "b64_json",
		watermark: false,
	});
	assert.equal("sequential_image_generation" in body, false);
	assert.equal("prompt_extend" in body, false);
});

test("preflight enforces credentials, fixed policy, output, and budget without transport", () => {
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return Response.json({}); };
	const provider = createProvider({ ARK_API_KEY: "ark-secret" }, { fetchImpl });
	assert.deepEqual(provider.preflight({ request: request(), estimateUsd: 0.045, ceilingUsd: 0.10 }), {
		provider: "seedream-5-pro", model: "dola-seedream-5-0-pro-260628", requestBytes: PNG.length, ceilingUsd: 0.10,
	});
	assert.throws(() => createProvider({}, { fetchImpl }).preflight({ request: request(), estimateUsd: 0.045, ceilingUsd: 0.10 }), (error: any) => error.code === "PROVIDER_CREDENTIALS_MISSING");
	assert.throws(() => provider.preflight({ request: request({ model: "seedream-unpinned" }), estimateUsd: 0.045, ceilingUsd: 0.10 }), (error: any) => error.code === "PROVIDER_MODEL_NOT_ALLOWED");
	assert.throws(() => provider.preflight({ request: request({ output: { width: 1024, height: 1024, format: "png", count: 1 } }), estimateUsd: 0.045, ceilingUsd: 0.10 }), (error: any) => error.code === "PROVIDER_OUTPUT_INVALID");
	assert.throws(() => provider.preflight({ request: request(), estimateUsd: 0.11, ceilingUsd: 0.10 }), (error: any) => error.code === "PROVIDER_BUDGET_INVALID");
	const oversized: any = { request: request(), estimateUsd: 0.045, ceilingUsd: 0.10 };
	for (let index = 0; index < 4_097; index += 1) oversized[`extra_${index}`] = index;
	assert.throws(() => provider.preflight(oversized), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
	assert.equal(calls, 0);
});

test("submits once to the allowlisted BytePlus endpoint and returns a verified redacted PNG", async () => {
	const calls: any[] = [];
	const payload = await fixture("success.json");
	payload.data[0].b64_json = OUTPUT_PNG.toString("base64");
	const provider = createProvider({ ARK_API_KEY: "ark-secret-value" }, {
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, init, body: JSON.parse(init.body) });
			return Response.json(payload, { headers: { "x-request-id": "byteplus-header-request" } });
		},
		timeoutMs: 1_000,
	});
	const result = await authorizedGenerate(provider, request());
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, BYTEPLUS_SEEDREAM_POLICY.endpoint);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.Authorization, "Bearer ark-secret-value");
	assert.deepEqual(calls[0].body, serializeBytePlusRequest(request()));
	assert.equal(result.bytes.equals(OUTPUT_PNG), true);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.width, 1536);
	assert.equal(result.height, 1536);
	assert.equal(result.actualUsd, 0.045);
	assert.equal(result.remoteId, "byteplus-header-request");
	assert.equal(Object.keys(result).includes("remoteId"), false);
	assert.doesNotMatch(JSON.stringify(result), /byteplus-header-request/);
	assert.doesNotMatch(JSON.stringify(result.rawMeta), /ark-secret-value|byteplus-header-request|iVBOR/);
});

test("normalizes BytePlus HTTP failures without exposing response secrets", async () => {
	const payload = await fixture("error.json");
	for (const [status, code] of [[401, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"], [500, "PROVIDER_SERVER_ERROR"]] as const) {
		const provider = createProvider({ ARK_API_KEY: "ark-secret-value" }, { fetchImpl: async () => Response.json(payload, { status }) });
		await assert.rejects(() => authorizedGenerate(provider, request()), (error: any) => {
			assert.equal(error.code, code);
			assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /ark-secret-value|must-not-leak|byteplus-error-fixture/);
			return true;
		});
	}
});

test("rejects missing, duplicate, malformed, and timed-out BytePlus images without retry", async () => {
	for (const [payload, code] of [
		[{ data: [] }, "PROVIDER_IMAGE_MISSING"],
		[{ data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] }, "PROVIDER_IMAGE_COUNT_INVALID"],
		[{ data: [{ b64_json: "not-base64" }] }, "PROVIDER_RESPONSE_INVALID"],
		[{ data: [{ b64_json: PNG.subarray(0, 20).toString("base64") }] }, "PROVIDER_IMAGE_INVALID"],
		[{ data: [{ b64_json: PNG.toString("base64") }] }, "PROVIDER_OUTPUT_INVALID"],
	] as const) {
		const provider = createProvider({ ARK_API_KEY: "ark-secret" }, { fetchImpl: async () => Response.json(payload) });
		await assert.rejects(() => authorizedGenerate(provider, request()), (error: any) => error.code === code);
	}
	let calls = 0;
	const provider = createProvider({ ARK_API_KEY: "ark-secret" }, {
		fetchImpl: async (_url: string, init: any) => {
			calls += 1;
			return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		},
		timeoutMs: 5,
	});
	await assert.rejects(() => authorizedGenerate(provider, request()), (error: any) => error.code === "PROVIDER_TIMEOUT");
	assert.equal(calls, 1);

	const success = await fixture("success.json");
	success.data[0].b64_json = OUTPUT_PNG.toString("base64");
	const encoded = new TextEncoder().encode(JSON.stringify(success));
	const slowBodyProvider = createProvider({ ARK_API_KEY: "ark-secret" }, {
		fetchImpl: async () => new Response(new ReadableStream({
			start(controller) {
				setTimeout(() => { controller.enqueue(encoded); controller.close(); }, 20);
			},
		})),
		timeoutMs: 5,
	});
	await assert.rejects(() => authorizedGenerate(slowBodyProvider, request()), (error: any) => error.code === "PROVIDER_TIMEOUT");
});
