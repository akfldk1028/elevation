import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { FACADE_GRAMMAR_SCHEMA } from "../plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { createFacadeGrammarRequest } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs";
import { buildFacadeGrammarPrompt } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/prompt.mjs";
import { createProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/byteplus/adapter.mjs";

const PROVIDER = "byteplus-seed-mini";
const MODEL = "seed-2-0-mini-260428";
const ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3/responses";
const root = await mkdtemp(join(tmpdir(), "byteplus-facade-grammar-"));
const proposalBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const evidenceManifestSha256 = sha256("byteplus grammar evidence fixture");
const successFixture = JSON.parse(await readFile(new URL("./fixtures/facade-agent/grammar/byteplus/success.json", import.meta.url), "utf8"));
const errorFixture = JSON.parse(await readFile(new URL("./fixtures/facade-agent/grammar/byteplus/error.json", import.meta.url), "utf8"));
let ledgerSequence = 0;

after(async () => rm(root, { recursive: true, force: true }));

const grammar = Object.freeze({
	system: "brick-punched-window-v1",
	surfaces: ["front", "right", "back", "left"],
	materials: ["brick", "precast", "window-frame", "glass"],
	corner_datum_m: 0,
	bay_width_m: 2.4,
	window_width_m: 1.2,
	window_height_m: 1.65,
	sill_height_m: 0.85,
	reveal_depth_m: 0.22,
	frame_width_m: 0.06,
	lintel_height_m: 0.18,
	sill_depth_m: 0.08,
	cladding_depth_m: 0.12,
	brick_module_m: [0.215, 0.065],
	confidence: 0.92,
	unresolved_surfaces: [],
});

function request(overrides: Record<string, unknown> = {}) {
	const proposalSha256 = sha256(proposalBytes);
	const prompt = buildFacadeGrammarPrompt({
		proposalSha256,
		evidenceManifestSha256,
		manifestText: "{\"schema_version\":\"fixture\"}\n",
	});
	return createFacadeGrammarRequest({
		provider: PROVIDER,
		model: MODEL,
		proposalSha256,
		evidenceManifestSha256,
		promptRevision: prompt.revision,
		prompt: prompt.prompt,
		promptSha256: prompt.sha256,
		imageBytes: proposalBytes,
		imageMimeType: "image/png",
		schema: FACADE_GRAMMAR_SCHEMA,
		ceilingUsd: 0.01,
		estimateUsd: 0.008,
		...overrides,
	});
}

function successResponse(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	return Response.json({ ...structuredClone(successFixture), ...overrides }, { headers });
}

async function authorizedExtract(provider: ReturnType<typeof createProvider>, commonRequest = request(), signal?: AbortSignal) {
	let result: any;
	let operationError: any;
	await createPaidOperationLedger(join(root, `paid-${ledgerSequence++}.json`), { approvedRoot: root }).executeOnce({
		requestKey: commonRequest.fingerprint,
		provider: PROVIDER,
		kind: "grammar-extraction",
		ceilingUsd: commonRequest.ceilingUsd,
		estimateUsd: commonRequest.estimateUsd,
		operation: async (submission: object) => {
			try { result = await provider.extract({ request: commonRequest, submission, signal }); }
			catch (error) {
				operationError = error;
				return { remoteId: `captured-adapter-error-${ledgerSequence}`, artifactSha256: "f".repeat(64), actualUsd: 0 };
			}
			return { remoteId: result.remoteId, artifactSha256: "a".repeat(64), actualUsd: result.actualUsd };
		},
	});
	if (operationError) throw operationError;
	return result;
}

function assertFailure(error: any, code: string, definitiveNonSubmission: boolean) {
	assert.equal(error.code, code);
	assert.equal(error.provider, PROVIDER);
	assert.equal(error.stage, "grammar");
	assert.equal(error.definitiveNonSubmission, definitiveNonSubmission);
	assert.equal(Object.hasOwn(error, "remoteId"), false);
	return true;
}

test("BytePlus grammar uses the pinned Responses request vector and returns the common result", async () => {
	const calls: any[] = [];
	const provider = createProvider({ ARK_API_KEY: "byteplus-fixture-key" }, {
		timeoutMs: 1_000,
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, init, body: JSON.parse(init.body) });
			return successResponse({}, { "x-request-id": "byteplus-header-request" });
		},
	});
	const commonRequest = request();
	assert.deepEqual(provider.preflight({ request: commonRequest }), {
		provider: PROVIDER, model: MODEL, transport: "live", ceilingUsd: 0.01, estimateUsd: 0.008,
	});
	const result = await authorizedExtract(provider, commonRequest);
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.equal(call.url, ENDPOINT);
	assert.equal(call.body.model, MODEL);
	assert.equal(call.body.text.format.type, "json_schema");
	assert.equal(call.body.text.format.strict, true);
	assert.equal(call.body.input[0].content[0].type, "input_text");
	assert.match(call.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
	assert.equal(call.init.headers.Authorization, "Bearer byteplus-fixture-key");
	assert.equal(result.provider, PROVIDER);
	assert.equal(result.resolvedModel, MODEL);
	assert.equal(result.transport, "live");
	assert.equal(result.grammarCandidate, JSON.stringify(grammar));
	assert.equal(result.remoteId, "byteplus-header-request");
	assert.equal(result.actualUsd, 0.008);
	assert.deepEqual({ ...result.usage }, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
	assert.equal(Object.isFrozen(result), true);
});

test("BytePlus grammar rejects credentials, overrides, and invalid local input before transport", async () => {
	for (const [name, invoke, code] of [
		["missing credential", (fetchImpl: any) => createProvider({}, { fetchImpl }).preflight({ request: request() }), "AUTHENTICATION_FAILED"],
		["invalid credential", (fetchImpl: any) => createProvider({ ARK_API_KEY: "bad\nkey" }, { fetchImpl }).preflight({ request: request() }), "AUTHENTICATION_FAILED"],
		["wrong model", (fetchImpl: any) => createProvider({ ARK_API_KEY: "key" }, { fetchImpl }).preflight({ request: request({ model: "seed-other" }) }), "INVALID_PROVIDER_RESPONSE"],
		["endpoint override", (fetchImpl: any) => createProvider({ ARK_API_KEY: "key" }, { fetchImpl, endpoint: "https://attacker.invalid" } as any), "INVALID_PROVIDER_RESPONSE"],
		["model override", (fetchImpl: any) => createProvider({ ARK_API_KEY: "key" }, { fetchImpl, model: "seed-other" } as any), "INVALID_PROVIDER_RESPONSE"],
		["missing fetch", () => createProvider({ ARK_API_KEY: "key" }, {}).extract({ request: request(), submission: Object.freeze({}) }), "INVALID_PROVIDER_RESPONSE"],
	] as const) {
		let fetchCalls = 0;
		const fetchImpl = async () => { fetchCalls += 1; return successResponse(); };
		await assert.rejects(async () => invoke(fetchImpl), (error: any) => assertFailure(error, code, true), name);
		assert.equal(fetchCalls, 0, `${name} must not fetch`);
	}

	const controller = new AbortController();
	controller.abort(new DOMException("caller stopped", "AbortError"));
	let fetchCalls = 0;
	const provider = createProvider({ ARK_API_KEY: "key" }, { fetchImpl: async () => { fetchCalls += 1; return successResponse(); } });
	await assert.rejects(() => provider.extract({ request: request(), submission: Object.freeze({}), signal: controller.signal }),
		(error: any) => assertFailure(error, "REQUEST_TIMEOUT", true));
	assert.equal(fetchCalls, 0);
});

test("BytePlus grammar maps HTTP failures once without exposing provider payloads", async () => {
	for (const [status, payload, code] of [
		[401, { error: { code: "invalid_api_key" } }, "AUTHENTICATION_FAILED"],
		[429, { error: { code: "rate_limit_exceeded" } }, "RATE_LIMITED"],
		[400, errorFixture, "CONTENT_REJECTED"],
		[503, { error: { code: "service_unavailable" } }, "PROVIDER_UNAVAILABLE"],
	] as const) {
		let fetchCalls = 0;
		const provider = createProvider({ ARK_API_KEY: "byteplus-fixture-key" }, {
			fetchImpl: async () => { fetchCalls += 1; return Response.json(payload, { status }); },
		});
		await assert.rejects(() => authorizedExtract(provider), (error: any) => {
			assertFailure(error, code, false);
			assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,
				/byteplus-fixture-key|must-not-leak|X-Amz-Signature|byteplus-error-fixture/);
			return true;
		});
		assert.equal(fetchCalls, 1, `${status} must make exactly one attempt`);
	}
});

test("BytePlus grammar billed POST rejects redirects without forwarding its body or credential", async () => {
	const calls: any[] = [];
	const provider = createProvider({ ARK_API_KEY: "byteplus-redirect-secret" }, {
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, authorization: init.headers.Authorization, body: init.body });
			if (init.redirect === "error") throw new TypeError("redirect mode blocked the 308 response");
			calls.push({ url: "https://redirect-target.invalid/collect", authorization: init.headers.Authorization, body: init.body });
			return successResponse();
		},
	});
	await assert.rejects(() => authorizedExtract(provider),
		(error: any) => assertFailure(error, "SUBMISSION_UNCERTAIN", false));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, ENDPOINT);
});

test("BytePlus grammar treats timeout and in-flight caller abort as non-replayable one-shot failures", async () => {
	let timeoutCalls = 0;
	const timeoutProvider = createProvider({ ARK_API_KEY: "key" }, {
		timeoutMs: 10,
		fetchImpl: async (_url: string, init: any) => new Promise((_resolve, reject) => {
			timeoutCalls += 1;
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		}),
	});
	await assert.rejects(() => authorizedExtract(timeoutProvider),
		(error: any) => assertFailure(error, "REQUEST_TIMEOUT", false));
	assert.equal(timeoutCalls, 1);

	const controller = new AbortController();
	let abortCalls = 0;
	const abortProvider = createProvider({ ARK_API_KEY: "key" }, {
		fetchImpl: async (_url: string, init: any) => new Promise((_resolve, reject) => {
			abortCalls += 1;
			queueMicrotask(() => controller.abort(new DOMException("caller stopped", "AbortError")));
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		}),
	});
	await assert.rejects(() => authorizedExtract(abortProvider, request(), controller.signal),
		(error: any) => assertFailure(error, "SUBMISSION_UNCERTAIN", false));
	assert.equal(abortCalls, 1);
});

test("BytePlus grammar rejects malformed, duplicate-key, and invalid grammar responses after one fetch", async () => {
	const invalidGrammar = structuredClone(successFixture);
	invalidGrammar.output[0].content[0].text = JSON.stringify({ ...grammar, system: "curtain-wall" });
	const duplicateGrammar = structuredClone(successFixture);
	duplicateGrammar.output[0].content[0].text = "{\"system\":\"brick-punched-window-v1\",\"system\":\"curtain-wall\"}";
	for (const [name, response, code] of [
		["invalid JSON", new Response("{"), "INVALID_PROVIDER_RESPONSE"],
		["non-JSON whitespace", new Response(`\u00a0${JSON.stringify(successFixture)}`), "INVALID_PROVIDER_RESPONSE"],
		["duplicate outer keys", new Response('{"id":"first","id":"second"}'), "INVALID_PROVIDER_RESPONSE"],
		["duplicate grammar keys", Response.json(duplicateGrammar), "INVALID_PROVIDER_RESPONSE"],
		["invalid grammar", Response.json(invalidGrammar), "INVALID_GRAMMAR"],
	] as const) {
		let fetchCalls = 0;
		const provider = createProvider({ ARK_API_KEY: "key" }, {
			fetchImpl: async () => { fetchCalls += 1; return response; },
		});
		await assert.rejects(() => authorizedExtract(provider), (error: any) => assertFailure(error, code, false), name);
		assert.equal(fetchCalls, 1, `${name} must make exactly one attempt`);
	}
});

test("BytePlus grammar rejects reported cost above the fixed ceiling after one fetch", async () => {
	const overCost = structuredClone(successFixture);
	overCost.usage.cost_usd = 0.010001;
	let fetchCalls = 0;
	const provider = createProvider({ ARK_API_KEY: "key" }, {
		fetchImpl: async () => { fetchCalls += 1; return Response.json(overCost); },
	});
	await assert.rejects(() => authorizedExtract(provider),
		(error: any) => assertFailure(error, "INVALID_PROVIDER_RESPONSE", false));
	assert.equal(fetchCalls, 1);
});

test("BytePlus grammar cancels the response body before rejecting declared length overflow", async () => {
	let cancelled = false;
	const response = new Response(new ReadableStream({
		pull() {},
		cancel() { cancelled = true; },
	}), { headers: { "content-length": String(1024 * 1024 + 1) } });
	const provider = createProvider({ ARK_API_KEY: "key" }, { fetchImpl: async () => response });
	await assert.rejects(() => authorizedExtract(provider),
		(error: any) => assertFailure(error, "RESPONSE_TOO_LARGE", false));
	assert.equal(cancelled, true);
});

test("BytePlus grammar retains header provenance across every post-fetch response failure and blocks replay", async () => {
	for (const [name, expectedCode, timeoutMs, setup] of [
		["declared overflow", "RESPONSE_TOO_LARGE", 1_000, () => ({
			makeResponse: () => new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } }),
		})],
		["streamed overflow", "RESPONSE_TOO_LARGE", 1_000, () => ({
			makeResponse: () => new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(600 * 1024));
					controller.enqueue(new Uint8Array(600 * 1024));
					controller.close();
				},
			})),
		})],
		["missing body", "INVALID_PROVIDER_RESPONSE", 1_000, () => ({ makeResponse: () => new Response(null) })],
		["invalid body", "INVALID_PROVIDER_RESPONSE", 1_000, () => {
			return { makeResponse: () => {
				const response = new Response("{}");
				Object.defineProperty(response, "body", { value: { getReader: () => ({
					read: async () => ({ done: false, value: "not-bytes" }),
					releaseLock() {},
				}) } });
				return response;
			} };
		}],
		["malformed JSON", "INVALID_PROVIDER_RESPONSE", 1_000, () => ({ makeResponse: () => new Response("{") })],
		["duplicate JSON", "INVALID_PROVIDER_RESPONSE", 1_000, () => ({ makeResponse: () => new Response('{"id":"first","id":"second"}') })],
		["timeout after response", "REQUEST_TIMEOUT", 10, () => ({
			makeResponse: () => new Response(new ReadableStream({
				start(controller) { setTimeout(() => controller.close(), 40); },
			})),
		})],
		["caller abort after response", "SUBMISSION_UNCERTAIN", 1_000, () => {
			const caller = new AbortController();
			return {
				signal: caller.signal,
				makeResponse: () => new Response(new ReadableStream({
					start(controller) {
						setTimeout(() => caller.abort(new DOMException("caller stopped", "AbortError")), 0);
						setTimeout(() => controller.close(), 40);
					},
				})),
			};
		}],
	] as const) {
		const commonRequest = request();
		const remoteId = `byteplus-${name.replaceAll(" ", "-")}`;
		const ledger = createPaidOperationLedger(join(root, `provenance-${ledgerSequence++}.json`), { approvedRoot: root });
		let fetchCalls = 0;
		const prepared = setup();
		const provider = createProvider({ ARK_API_KEY: "key" }, {
			timeoutMs,
			fetchImpl: async () => {
				fetchCalls += 1;
				const response = prepared.makeResponse();
				response.headers.set("x-request-id", remoteId);
				return response;
			},
		});
		const execute = () => ledger.executeOnce({
			requestKey: commonRequest.fingerprint,
			provider: PROVIDER,
			kind: "grammar-extraction",
			ceilingUsd: commonRequest.ceilingUsd,
			estimateUsd: commonRequest.estimateUsd,
			operation: async (submission: object) => {
				const result = await provider.extract({ request: commonRequest, submission, signal: prepared.signal });
				return { remoteId: result.remoteId, artifactSha256: "c".repeat(64), actualUsd: result.actualUsd };
			},
		});
		await assert.rejects(execute, (error: any) => {
			assertFailure(error, expectedCode, false);
			assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(remoteId));
			return true;
		}, name);
		assert.equal((await ledger.summary()).operations[0].remoteIdHash, sha256(remoteId), name);
		await assert.rejects(execute, (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN", name);
		assert.equal(fetchCalls, 1, `${name} must not perform a replay fetch`);
	}
});

test("BytePlus grammar consumes a paid submission capability exactly once and never retries", async () => {
	const commonRequest = request();
	let fetchCalls = 0;
	const provider = createProvider({ ARK_API_KEY: "key" }, {
		fetchImpl: async () => { fetchCalls += 1; return successResponse(); },
	});
	await createPaidOperationLedger(join(root, `paid-${ledgerSequence++}.json`), { approvedRoot: root }).executeOnce({
		requestKey: commonRequest.fingerprint,
		provider: PROVIDER,
		kind: "grammar-extraction",
		ceilingUsd: commonRequest.ceilingUsd,
		estimateUsd: commonRequest.estimateUsd,
		operation: async (submission: object) => {
			const first = await provider.extract({ request: commonRequest, submission });
			await assert.rejects(() => provider.extract({ request: commonRequest, submission }),
				(error: any) => assertFailure(error, "SUBMISSION_UNCERTAIN", false));
			return { remoteId: first.remoteId, artifactSha256: "b".repeat(64), actualUsd: first.actualUsd };
		},
	});
	assert.equal(fetchCalls, 1);
});
