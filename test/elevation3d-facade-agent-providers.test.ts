import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const EVIDENCE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n74AAAAASUVORK5CYII=", "base64");
const BRIEF = Object.freeze({
	brief_id: "brick-punched-window-v1",
	candidate_id: "creative-020",
	summary_ko: "brick punched window facade",
	materials: ["red brick", "dark metal"],
	window_rhythm: "regular punched openings",
	ground_floor: "recessed entrance",
	roof: "flat parapet",
	negative_constraints: ["curtain wall", "changed massing"],
});
const OUTPUT = Object.freeze({ width: 1536, height: 1024, format: "png" });

function evidence() {
	return {
		contactSheetBytes: EVIDENCE,
		manifestSha256: "a".repeat(64),
		manifest: { candidate_id: "creative-020", contact_sheet: { sha256: sha256(EVIDENCE) } },
	};
}

function openAISuccess(secret = "sk-openai-secret") {
	const calls: any[] = [];
	const provider = createOpenAIProvider({ OPENAI_API_KEY: secret }, {
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, ...init });
			return Response.json({
				id: "openai-image-fixture-id",
				created: 123,
				data: [{ b64_json: PNG.toString("base64") }],
				usage: { input_tokens: 11, output_tokens: 7 },
			});
		},
		timeoutMs: 1_000,
	});
	return { calls, provider };
}

function geminiSuccess(secret = "gemini-secret") {
	const calls: any[] = [];
	const provider = createGeminiProvider({ GEMINI_API_KEY: secret }, {
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, ...init });
			return Response.json({
				responseId: "gemini-image-fixture-id",
				modelVersion: "gemini-3-pro-image",
				candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: {
					mimeType: "image/png", data: PNG.toString("base64"),
				} }] } }],
				usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
			});
		},
		timeoutMs: 1_000,
	});
	return { calls, provider };
}

test("OpenAI sends the fixed GPT Image 2 multipart edit contract and decodes one PNG", async () => {
	const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const { calls, provider } = openAISuccess();
	const result = await provider.generate({ request });

	assert.deepEqual(calls.map((call) => call.method), ["POST"]);
	assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
	assert.equal(calls[0].headers.Authorization, "Bearer sk-openai-secret");
	assert.equal(calls[0].body.get("model"), "gpt-image-2");
	assert.equal(calls[0].body.get("quality"), "high");
	assert.equal(calls[0].body.get("n"), "1");
	assert.equal(calls[0].body.get("prompt"), request.prompt);
	assert.match(request.prompt, /creative-020/);
	assert.match(request.prompt, /brick-punched-window-v1/);
	assert.match(request.prompt, /NO CURTAIN WALL/);
	assert.deepEqual(Buffer.from(await calls[0].body.get("image").arrayBuffer()), EVIDENCE);
	assert.equal(calls[0].body.get("image").name, "evidence.png");
	assert.equal(calls[0].url.includes("sk-openai-secret"), false);
	assert.doesNotMatch(await new Response(calls[0].body).text(), /sk-openai-secret/);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.bytes.equals(PNG), true);
	assert.equal(result.remoteId, "openai-image-fixture-id");
	assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7 });
	assert.doesNotMatch(JSON.stringify(result.rawMeta), /sk-openai-secret|iVBOR/);
});

test("Gemini sends the fixed Nano Banana Pro JSON contract with identical semantics and decodes one PNG", async () => {
	const openAIRequest = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const request = buildGeminiRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const { calls, provider } = geminiSuccess();
	const result = await provider.generate({ request });

	assert.equal(request.prompt, openAIRequest.prompt);
	assert.deepEqual(calls.map((call) => call.method), ["POST"]);
	assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent");
	assert.equal(calls[0].headers["x-goog-api-key"], "gemini-secret");
	assert.equal(calls[0].url.includes("gemini-secret"), false);
	const body = JSON.parse(calls[0].body);
	assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
	assert.equal(body.contents[0].parts[0].text, request.prompt);
	assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/png");
	assert.deepEqual(Buffer.from(body.contents[0].parts[1].inlineData.data, "base64"), EVIDENCE);
	assert.doesNotMatch(calls[0].body, /gemini-secret/);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.bytes.equals(PNG), true);
	assert.equal(result.remoteId, "gemini-image-fixture-id");
	assert.deepEqual(result.usage, { promptTokenCount: 11, candidatesTokenCount: 7 });
	assert.doesNotMatch(JSON.stringify(result.rawMeta), /gemini-secret|iVBOR/);
});

test("preflight rejects credentials, models, request size, and budget ceiling without transport", () => {
	let calls = 0;
	const noFetch = async () => { calls += 1; throw new Error("must not fetch"); };
	const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	assert.throws(() => createOpenAIProvider({}, { fetchImpl: noFetch }).preflight({ request, ceilingUsd: 1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_CREDENTIALS_MISSING");
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, { fetchImpl: noFetch });
	assert.throws(() => provider.preflight({ request: { ...request, model: "gpt-image-1" }, ceilingUsd: 1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_MODEL_NOT_ALLOWED");
	assert.throws(() => provider.preflight({ request, ceilingUsd: 0.1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_BUDGET_EXCEEDED");
	assert.throws(() => provider.preflight({ request: { ...request, evidenceBytes: Buffer.alloc(32 * 1024 * 1024 + 1) }, ceilingUsd: 1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
	assert.equal(calls, 0);
});

test("preflight limits the complete outbound payload, including prompt and Gemini base64 expansion", () => {
	const baseOpenAIRequest = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const baseGeminiRequest = buildGeminiRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const openAI = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, { fetchImpl: async () => { throw new Error("must not fetch"); } });
	const gemini = createGeminiProvider({ GEMINI_API_KEY: "gemini-secret" }, { fetchImpl: async () => { throw new Error("must not fetch"); } });
	const hugePrompt = "P".repeat(32 * 1024 * 1024);
	for (const [provider, request] of [[openAI, baseOpenAIRequest], [gemini, baseGeminiRequest]] as const) {
		assert.throws(() => provider.preflight({ request: { ...request, prompt: hugePrompt }, ceilingUsd: 1, estimateUsd: 0.2 }),
			(error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
	}
	const largeEvidence = Buffer.alloc(25 * 1024 * 1024);
	EVIDENCE.subarray(0, 8).copy(largeEvidence);
	assert.throws(() => gemini.preflight({
		request: { ...baseGeminiRequest, evidenceBytes: largeEvidence, evidenceSha256: sha256(largeEvidence) },
		ceilingUsd: 1, estimateUsd: 0.2,
	}), (error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
});

test("request builders bind a PNG contact sheet to its evidence-manifest hash", () => {
	for (const build of [buildOpenAIRequest, buildGeminiRequest]) {
		const notPng = Buffer.from("not a PNG contact sheet");
		assert.throws(() => build({
			evidence: { contactSheetBytes: notPng, manifest: { contact_sheet: { sha256: sha256(notPng) } } },
			brief: BRIEF, output: OUTPUT,
		}), (error: any) => error.code === "PROVIDER_EVIDENCE_INVALID");
		assert.throws(() => build({
			evidence: { contactSheetBytes: EVIDENCE, manifest: { contact_sheet: { sha256: "0".repeat(64) } } },
			brief: BRIEF, output: OUTPUT,
		}), (error: any) => error.code === "PROVIDER_EVIDENCE_MISMATCH");
	}
});

test("401 and 429 responses normalize to stable redacted codes", async () => {
	for (const [name, create, env, build] of [
		["openai", createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		["gemini", createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		for (const [status, code] of [[401, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"]] as const) {
			const provider = create(env, { fetchImpl: async () => Response.json({ error: { message: `Authorization: Bearer ${Object.values(env)[0]}` } }, { status }) });
			await assert.rejects(() => provider.generate({ request: build({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }), (error: any) => {
				assert.equal(error.code, code, `${name} ${status}`);
				assert.equal(error.status, status);
				assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /sk-openai-secret|gemini-secret/);
				return true;
			});
		}
	}
});

test("non-JSON HTTP failures retain status-based stable codes", async () => {
	for (const [create, env, build] of [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		for (const [status, code] of [[401, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"], [503, "PROVIDER_SERVER_ERROR"]] as const) {
			const provider = create(env, { fetchImpl: async () => new Response("<html>not JSON</html>", { status }) });
			await assert.rejects(() => provider.generate({ request: build({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }),
				(error: any) => error.code === code && error.status === status);
		}
	}
});

test("caller abort and provider deadline normalize separately", async () => {
	for (const [create, env, build] of [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		const fetchImpl = async (_url: string, init: any) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		});
		const request = build({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		await assert.rejects(() => create(env, { fetchImpl, timeoutMs: 10 }).generate({ request }),
			(error: any) => error.code === "PROVIDER_TIMEOUT");
		const controller = new AbortController();
		controller.abort(new DOMException("cancelled", "AbortError"));
		await assert.rejects(() => create(env, { fetchImpl, timeoutMs: 1_000 }).generate({ request, signal: controller.signal }),
			(error: any) => error.code === "PROVIDER_ABORTED");
	}
});

test("deadline and caller abort remain active while the response body is being consumed", async () => {
	for (const [create, env, build] of [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		const bodyStallsUntilAbort = async (_url: string, init: any) => ({
			ok: true, status: 200, headers: new Headers(),
			json: async () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
		});
		const request = build({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		await assert.rejects(Promise.race([
			create(env, { fetchImpl: bodyStallsUntilAbort, timeoutMs: 10 }).generate({ request }),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("adapter deadline was not enforced during body consumption")), 100)),
		]), (error: any) => error.code === "PROVIDER_TIMEOUT");

		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("cancel body", "AbortError")), 10);
		await assert.rejects(Promise.race([
			create(env, { fetchImpl: bodyStallsUntilAbort, timeoutMs: 1_000 }).generate({ request, signal: controller.signal }),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("caller abort was not enforced during body consumption")), 100)),
		]), (error: any) => error.code === "PROVIDER_ABORTED");
	}
});

test("moderation blocks normalize without exposing provider payloads", async () => {
	const cases: any[] = [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest,
			async () => Response.json({ error: { code: "moderation_blocked", message: "sk-openai-secret" } }, { status: 400 })],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest,
			async () => Response.json({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "gemini-secret" }, candidates: [] })],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest,
			async () => Response.json({ responseId: "policy-block", candidates: [{ finishReason: "PROHIBITED_CONTENT", content: { parts: [] } }] })],
	];
	for (const [create, env, build, fetchImpl] of cases) {
		await assert.rejects(() => create(env, { fetchImpl }).generate({ request: build({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }), (error: any) => {
			assert.equal(error.code, "PROVIDER_MODERATION_BLOCKED");
			assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /sk-openai-secret|gemini-secret/);
			return true;
		});
	}
});

test("malformed base64, missing images, two images, and invalid signatures use stable response codes", async () => {
	const vectors = [
		["PROVIDER_RESPONSE_INVALID", { id: "x", data: [{ b64_json: "%%%" }] }, { responseId: "x", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "%%%" } }] } }] }],
		["PROVIDER_IMAGE_MISSING", { id: "x", data: [] }, { responseId: "x", candidates: [{ content: { parts: [{ text: "none" }] } }] }],
		["PROVIDER_IMAGE_COUNT_INVALID", { id: "x", data: [{ b64_json: PNG.toString("base64") }, { url: "https://fixture.invalid/unexpected.png" }] }, { responseId: "x", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] }],
		["PROVIDER_RESPONSE_INVALID", { id: "x", data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }, { responseId: "x", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("not an image").toString("base64") } }] } }] }],
	] as const;
	for (const [code, openAIResponse, geminiResponse] of vectors) {
		const requestArgs = { evidence: evidence(), brief: BRIEF, output: OUTPUT };
		await assert.rejects(() => createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
			fetchImpl: async () => Response.json(openAIResponse),
		}).generate({ request: buildOpenAIRequest(requestArgs) }), (error: any) => error.code === code);
		await assert.rejects(() => createGeminiProvider({ GEMINI_API_KEY: "gemini-secret" }, {
			fetchImpl: async () => Response.json(geminiResponse),
		}).generate({ request: buildGeminiRequest(requestArgs) }), (error: any) => error.code === code);
	}
});

test("decoded images larger than 32 MiB are rejected before allocation", async () => {
	const oversizedBase64 = "A".repeat(Math.ceil((32 * 1024 * 1024 + 1) / 3) * 4);
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
		fetchImpl: async () => Response.json({ id: "oversized", data: [{ b64_json: oversizedBase64 }] }),
	});
	await assert.rejects(() => provider.generate({ request: buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }),
		(error: any) => error.code === "PROVIDER_RESPONSE_TOO_LARGE");
});

test("near-limit malformed base64 normalizes without a regular-expression stack failure", async () => {
	const encodedLength = Math.floor((32 * 1024 * 1024) / 3) * 4;
	const malformedBase64 = `${"A".repeat(encodedLength - 1)}%`;
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
		fetchImpl: async () => Response.json({ id: "malformed-near-limit", data: [{ b64_json: malformedBase64 }] }),
	});
	await assert.rejects(() => provider.generate({ request: buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }),
		(error: any) => error.code === "PROVIDER_RESPONSE_INVALID");
});

test("the crash-safe ledger submits one successful provider request", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-ledger-"));
	try {
		const { calls, provider } = openAISuccess();
		const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		const ledger = createPaidOperationLedger(join(root, "paid.json"), { approvedRoot: root });
		const input = {
			requestKey: "b".repeat(64), provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				const result = await provider.generate({ request });
				return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.2 };
			},
		};
		const first = await ledger.executeOnce(input);
		const second = await ledger.executeOnce(input);
		assert.deepEqual(second, first);
		assert.equal(calls.length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("provider request IDs remain private on failures and are retained by the ledger for reconciliation", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-ledger-"));
	try {
		let calls = 0;
		const remoteId = "private-openai-request-id";
		const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
			fetchImpl: async () => {
				calls += 1;
				return new Response("<html>upstream failure</html>", { status: 500, headers: { "x-request-id": remoteId } });
			},
		});
		const ledgerPath = join(root, "paid.json");
		const ledger = createPaidOperationLedger(ledgerPath, { approvedRoot: root });
		await assert.rejects(() => ledger.executeOnce({
			requestKey: "c".repeat(64), provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async () => {
				const result = await provider.generate({ request: buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) });
				return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.2 };
			},
		}), (error: any) => {
			assert.equal(error.code, "PROVIDER_SERVER_ERROR");
			assert.equal(Object.hasOwn(error, "remoteId"), false);
			assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(remoteId));
			return true;
		});
		assert.equal(calls, 1);
		assert.equal((await readFile(ledgerPath, "utf8")).includes(remoteId), true);
		assert.equal(JSON.stringify(await ledger.summary()).includes(remoteId), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
