import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { createFacadeImageEditRequest } from "../plugins/elevation-3d/lib/facade-agent/image-providers/contract.mjs";
import { downloadVerifiedProviderImage } from "../plugins/elevation-3d/lib/facade-agent/image-providers/download.mjs";
import { buildFacadeArchitecturalPrompt, FACADE_PROHIBITED_CHANGES } from "../plugins/elevation-3d/lib/facade-agent/image-providers/prompt.mjs";
import {
	ALIBABA_QWEN_POLICY,
	createProvider,
} from "../plugins/elevation-3d/lib/facade-agent/image-providers/providers/alibaba/adapter.mjs";
import { serializeAlibabaRequest } from "../plugins/elevation-3d/lib/facade-agent/image-providers/providers/alibaba/request.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";

const EVIDENCE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNg5+AEAAAyABna+TCwAAAAAElFTkSuQmCC", "base64");
const OUTPUT_PNG = await sharp({ create: { width: 1536, height: 1536, channels: 3, background: "#934e38" } }).png().toBuffer();
const FIXTURE_ROOT = join(process.cwd(), "test", "fixtures", "facade-agent", "providers", "alibaba");
const SIGNED_URL = "https://images.example.com/signed/qwen-output.png?Expires=1785988800&Signature=must-not-persist";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

async function fixture(name: string) {
	return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8"));
}

function request(overrides: Record<string, unknown> = {}) {
	const prompt = buildFacadeArchitecturalPrompt({ candidateId: "creative-020", briefId: "brick-punched-window-v1", evidenceManifestSha256: "a".repeat(64) });
	return createFacadeImageEditRequest({
		provider: "qwen-image-2",
		model: "qwen-image-2.0",
		candidate: { id: "creative-020" },
		brief: { id: "brick-punched-window-v1", revision: "1" },
		evidence: { manifestSha256: "a".repeat(64), pngBytes: EVIDENCE },
		prompt: { revision: prompt.revision, text: prompt.prompt, sha256: prompt.sha256 },
		output: { width: 1536, height: 1536, format: "png", count: 1 },
		prohibitedChanges: FACADE_PROHIBITED_CHANGES,
		estimateUsd: 0.035,
		ceilingUsd: 0.05,
		...overrides,
	});
}

async function authorizedGenerate(provider: any, providerRequest = request()) {
	const root = await mkdtemp(join(tmpdir(), "facade-alibaba-"));
	let result: any;
	let failure: any;
	try {
		await createPaidOperationLedger(join(root, "ledger.json"), { approvedRoot: root }).executeOnce({
			requestKey: providerRequest.fingerprint, provider: "qwen-image-2", kind: "image-generation",
			ceilingUsd: 0.05, estimateUsd: 0.035,
			operation: async (submission: any) => {
				try { result = await provider.generate({ request: providerRequest, submission }); }
				catch (error) { failure = error; }
				return { remoteId: result?.remoteId ?? "alibaba-failure-fixture", artifactSha256: result?.sha256 ?? "f".repeat(64), actualUsd: result?.actualUsd ?? 0.035 };
			},
		});
		if (failure) throw failure;
		return result;
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("serializes the exact Qwen Image 2 edit request", () => {
	const value: any = request();
	assert.deepEqual(serializeAlibabaRequest(value), {
		model: "qwen-image-2.0",
		input: { messages: [{ role: "user", content: [
			{ image: `data:image/png;base64,${EVIDENCE.toString("base64")}` },
			{ text: value.prompt.text },
		] }] },
		parameters: {
			n: 1,
			negative_prompt: value.prohibitedChanges.join("; "),
			prompt_extend: false,
			watermark: false,
			size: "1536*1536",
		},
	});
});

test("downloads only bounded public HTTPS PNGs without forwarding authorization", async () => {
	const calls: any[] = [];
	const value: any = await downloadVerifiedProviderImage({
		url: SIGNED_URL,
		lookupImpl: PUBLIC_LOOKUP,
		fetchImpl: async (url: string, init: any) => { calls.push({ url, init }); return new Response(OUTPUT_PNG, { headers: { "content-type": "image/png" } }); },
		timeoutMs: 1_000,
		maxBytes: 16 * 1024 * 1024,
		maxRedirects: 2,
	});
	assert.equal(value.bytes.equals(OUTPUT_PNG), true);
	assert.deepEqual({ width: value.width, height: value.height }, { width: 1536, height: 1536 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.redirect, "manual");
	assert.equal(Object.keys(calls[0].init.headers).some((key) => /authorization/i.test(key)), false);
});

test("rejects unsafe literal, DNS-resolved, mixed, redirected, and credential-bearing download URLs", async () => {
	const noFetch = async () => { throw new Error("fetch must not run"); };
	for (const url of [
		"http://images.example.com/output.png",
		"https://user:password@images.example.com/output.png",
		"https://images.example.com/output.png#fragment",
		"https://127.0.0.1/output.png",
		"https://[::1]/output.png",
	]) {
		await assert.rejects(() => downloadVerifiedProviderImage({ url, lookupImpl: PUBLIC_LOOKUP, fetchImpl: noFetch }), (error: any) => error.code === "PROVIDER_DOWNLOAD_URL_UNSAFE");
	}
	await assert.rejects(() => downloadVerifiedProviderImage({ url: SIGNED_URL, lookupImpl: async () => [{ address: "10.0.0.1", family: 4 }], fetchImpl: noFetch }), (error: any) => error.code === "PROVIDER_DOWNLOAD_URL_UNSAFE");
	await assert.rejects(() => downloadVerifiedProviderImage({ url: SIGNED_URL, lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }], fetchImpl: noFetch }), (error: any) => error.code === "PROVIDER_DOWNLOAD_URL_UNSAFE");
	let redirects = 0;
	await assert.rejects(() => downloadVerifiedProviderImage({
		url: SIGNED_URL, lookupImpl: PUBLIC_LOOKUP,
		fetchImpl: async () => { redirects += 1; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private.png" } }); },
		maxRedirects: 2,
	}), (error: any) => error.code === "PROVIDER_DOWNLOAD_URL_UNSAFE");
	assert.equal(redirects, 1);
});

test("preflight fixes the Singapore workspace endpoint, model, output, and budget without network", () => {
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return Response.json({}); };
	const provider = createProvider({ DASHSCOPE_API_KEY: "dashscope-secret", DASHSCOPE_WORKSPACE_ID: "workspace-123" }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP });
	assert.deepEqual(provider.preflight({ request: request(), estimateUsd: 0.035, ceilingUsd: 0.05 }), {
		provider: "qwen-image-2", model: "qwen-image-2.0", requestBytes: EVIDENCE.length, ceilingUsd: 0.05,
	});
	assert.throws(() => createProvider({ DASHSCOPE_WORKSPACE_ID: "workspace-123" }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }).preflight({ request: request(), estimateUsd: 0.035, ceilingUsd: 0.05 }), (error: any) => error.code === "PROVIDER_CREDENTIALS_MISSING");
	const invalidWorkspace = createProvider({ DASHSCOPE_API_KEY: "secret", DASHSCOPE_WORKSPACE_ID: "bad.workspace" }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP });
	assert.throws(() => invalidWorkspace.preflight({ request: request(), estimateUsd: 0.035, ceilingUsd: 0.05 }), (error: any) => error.code === "PROVIDER_WORKSPACE_INVALID");
	assert.throws(() => provider.preflight({ request: request({ model: "qwen-image-2.0-pro" }), estimateUsd: 0.035, ceilingUsd: 0.05 }), (error: any) => error.code === "PROVIDER_MODEL_NOT_ALLOWED");
	assert.equal(calls, 0);
});

test("submits once, immediately downloads the signed URL, and exposes only its hash", async () => {
	const payload = await fixture("success.json");
	const calls: any[] = [];
	const provider = createProvider({ DASHSCOPE_API_KEY: "dashscope-secret", DASHSCOPE_WORKSPACE_ID: "workspace-123" }, {
		lookupImpl: PUBLIC_LOOKUP,
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, init });
			if (url === ALIBABA_QWEN_POLICY.endpoint("workspace-123")) return Response.json(payload, { headers: { "x-request-id": "alibaba-header-request" } });
			if (url === SIGNED_URL) return new Response(OUTPUT_PNG, { headers: { "content-type": "image/png" } });
			throw new Error("unexpected URL");
		},
		timeoutMs: 1_000,
	});
	const result = await authorizedGenerate(provider);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, ALIBABA_QWEN_POLICY.endpoint("workspace-123"));
	assert.equal(calls[0].init.headers.Authorization, "Bearer dashscope-secret");
	assert.deepEqual(JSON.parse(calls[0].init.body), serializeAlibabaRequest(request()));
	assert.equal(calls[1].url, SIGNED_URL);
	assert.equal(result.bytes.equals(OUTPUT_PNG), true);
	assert.equal(result.remoteId, "alibaba-header-request");
	assert.equal(Object.keys(result).includes("remoteId"), false);
	assert.doesNotMatch(JSON.stringify(result), /must-not-persist|alibaba-header-request|dashscope-secret/);
});

test("rejects malformed Qwen result cardinality and redacts HTTP failures", async () => {
	for (const payload of [
		{ output: { choices: [] } },
		{ output: { choices: [{ message: { content: [{ image: SIGNED_URL }, { image: SIGNED_URL }] } }] } },
	]) {
		const provider = createProvider({ DASHSCOPE_API_KEY: "secret", DASHSCOPE_WORKSPACE_ID: "workspace-123" }, { lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => Response.json(payload) });
		await assert.rejects(() => authorizedGenerate(provider), (error: any) => new Set(["PROVIDER_IMAGE_MISSING", "PROVIDER_IMAGE_COUNT_INVALID"]).has(error.code));
	}
	const errorPayload = await fixture("error.json");
	const provider = createProvider({ DASHSCOPE_API_KEY: "dashscope-secret", DASHSCOPE_WORKSPACE_ID: "workspace-123" }, { lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => Response.json(errorPayload, { status: 429 }) });
	await assert.rejects(() => authorizedGenerate(provider), (error: any) => error.code === "PROVIDER_RATE_LIMITED" && !/must-not-leak|dashscope-secret|alibaba-error-fixture/.test(`${error.message} ${JSON.stringify(error)}`));
});
