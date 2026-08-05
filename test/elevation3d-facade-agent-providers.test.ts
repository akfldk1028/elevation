import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { buildRequest as buildOpenAIRequest, createProvider as createOpenAIProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";
import { buildRequest as buildGeminiRequest, createProvider as createGeminiProvider } from "../plugins/elevation-3d/lib/facade-agent/providers/gemini-image.mjs";

const PNG = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 7, g: 8, b: 9 } } }).png().toBuffer();
const EVIDENCE = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
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
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];

function evidence() {
	return VERIFIED_EVIDENCE;
}

async function verifiedEvidenceFixture(root: string) {
	const evidenceRoot = join(root, "evidence");
	await mkdir(evidenceRoot);
	const fixturePng = EVIDENCE;
	const sourceBytes = Buffer.from("geometry authority fixture");
	const sourcePath = join(root, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const artifacts: Record<string, any> = {};
	for (const mode of PASS_NAMES) {
		await mkdir(join(evidenceRoot, mode));
		for (const view of VIEW_NAMES) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), fixturePng);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(fixturePng), width: 1, height: 1, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), fixturePng);
	const input = {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" },
		floor_guides: { floor_guides_m: [0, 3] }, facade_planes: { planes: [] }, cameras: { views: [] },
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1", candidate_id: "creative-020",
		geometry_hash: input.identity.geometry_hash, floor_guides_m: input.floor_guides.floor_guides_m,
		facade_planes_sha256: sha256(stableJson(input.facade_planes)), cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }],
		artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(fixturePng), width: 1, height: 1 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	return { verified: await verifyFacadeEvidencePack({ manifestPath, input }), fixturePng };
}

const PROVIDER_FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "facade-provider-authorized-fixtures-"));
const { verified: VERIFIED_EVIDENCE } = await verifiedEvidenceFixture(PROVIDER_FIXTURE_ROOT);
let authorizedSequence = 0;
after(async () => rm(PROVIDER_FIXTURE_ROOT, { recursive: true, force: true }));

async function authorizedGenerate(provider: any, request: any, input: any = {}) {
	let generated: any;
	let failure: any;
	const ledger = createPaidOperationLedger(join(PROVIDER_FIXTURE_ROOT, `authorized-${authorizedSequence++}.json`), { approvedRoot: PROVIDER_FIXTURE_ROOT });
	await ledger.executeOnce({
		requestKey: request.fingerprint, provider: request.provider, kind: "image-generation",
		ceilingUsd: 1, estimateUsd: 0.2,
		operation: async (submission: any) => {
			try { generated = await provider.generate({ ...input, request, submission }); }
			catch (error) { failure = error; }
			return {
				remoteId: generated?.remoteId ?? "fixture-captured-provider-failure",
				artifactSha256: generated ? sha256(generated.bytes) : "f".repeat(64),
				actualUsd: 0.2,
			};
		},
	});
	if (failure) throw failure;
	return generated;
}

function openAISuccess(secret = "sk-openai-secret") {
	const calls: any[] = [];
	const provider = createOpenAIProvider({ OPENAI_API_KEY: secret }, {
		fetchImpl: async (url: string, init: any) => {
			const wireRequest = new Request(url, init);
			calls.push({ url, ...init, wireContentType: wireRequest.headers.get("content-type"), wireBytes: Buffer.from(await wireRequest.arrayBuffer()) });
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
	const result = await authorizedGenerate(provider, request);

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
	assert.match(calls[0].wireContentType, /^multipart\/form-data; boundary=/);
	const multipartText = calls[0].wireBytes.toString("latin1");
	assert.match(multipartText, /Content-Disposition: form-data; name="model"/);
	assert.match(multipartText, /Content-Disposition: form-data; name="image"; filename="evidence.png"/);
	assert.match(multipartText, /Content-Type: image\/png/);
	assert.notEqual(calls[0].wireBytes.indexOf(EVIDENCE), -1);
	assert.equal(calls[0].url.includes("sk-openai-secret"), false);
	assert.doesNotMatch(await new Response(calls[0].body).text(), /sk-openai-secret/);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.bytes.equals(PNG), true);
	assert.equal(result.remoteId, "openai-image-fixture-id");
	assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7 });
	assert.doesNotMatch(JSON.stringify(result.rawMeta), /sk-openai-secret|iVBOR/);
});

test("direct generation cannot bypass the paid-operation ledger or default to global fetch", async () => {
	for (const [create, env, build] of [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		let calls = 0;
		const provider = create(env, { fetchImpl: async () => { calls += 1; return Response.json({}); } });
		await assert.rejects(() => provider.generate({ request: build({ evidence: evidence(), brief: BRIEF, output: OUTPUT }) }),
			(error: any) => error.code === "PROVIDER_SUBMISSION_UNAUTHORIZED");
		assert.equal(calls, 0);
		assert.throws(() => create(env, {}), /fetchImpl is required/);
	}
});

test("a ledger-issued submission capability is request-bound and consumable exactly once", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-capability-"));
	try {
		const { calls, provider } = openAISuccess();
		const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		let issuedCapability: any;
		let generated: any;
		await createPaidOperationLedger(join(root, "paid.json"), { approvedRoot: root }).executeOnce({
			requestKey: request.fingerprint, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async (submission: any) => {
				issuedCapability = submission;
				generated = await provider.generate({ request, submission });
				return { remoteId: generated.remoteId, artifactSha256: sha256(generated.bytes), actualUsd: 0.2 };
			},
		});
		assert.equal(generated.bytes.equals(PNG), true);
		await assert.rejects(() => provider.generate({ request, submission: issuedCapability }),
			(error: any) => error.code === "PROVIDER_SUBMISSION_UNAUTHORIZED");
		assert.equal(calls.length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Gemini sends the fixed Nano Banana Pro JSON contract with identical semantics and decodes one PNG", async () => {
	const openAIRequest = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const request = buildGeminiRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const { calls, provider } = geminiSuccess();
	const result = await authorizedGenerate(provider, request);

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
	assert.throws(() => provider.preflight({ request, model: "gpt-image-1", ceilingUsd: 1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_MODEL_NOT_ALLOWED");
	assert.throws(() => provider.preflight({ request, ceilingUsd: 0.1, estimateUsd: 0.2 }),
		(error: any) => error.code === "PROVIDER_BUDGET_EXCEEDED");
	assert.throws(() => buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: { prompt_padding: "P".repeat(32 * 1024 * 1024) } }),
		(error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
	assert.equal(calls, 0);
});

test("preflight limits the complete outbound payload, including prompt and Gemini base64 expansion", () => {
	const baseGeminiRequest = buildGeminiRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
	const openAI = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, { fetchImpl: async () => { throw new Error("must not fetch"); } });
	const gemini = createGeminiProvider({ GEMINI_API_KEY: "gemini-secret" }, { fetchImpl: async () => { throw new Error("must not fetch"); } });
	const hugeOutput = { prompt_padding: "P".repeat(32 * 1024 * 1024) };
	for (const [provider, build] of [[openAI, buildOpenAIRequest], [gemini, buildGeminiRequest]] as const) {
		assert.throws(() => build({ evidence: evidence(), brief: BRIEF, output: hugeOutput }),
			(error: any) => error.code === "PROVIDER_REQUEST_TOO_LARGE");
	}
	assert.throws(() => gemini.preflight({
		request: { ...baseGeminiRequest, evidenceBytes: EVIDENCE, evidenceSha256: sha256(EVIDENCE) },
		ceilingUsd: 1, estimateUsd: 0.2,
	}), (error: any) => error.code === "PROVIDER_REQUEST_UNAUTHORIZED");
});

test("request builders bind a PNG contact sheet to its evidence-manifest hash", () => {
	for (const build of [buildOpenAIRequest, buildGeminiRequest]) {
		const notPng = Buffer.from("not a PNG contact sheet");
		assert.throws(() => build({
			evidence: { contactSheetBytes: notPng, manifest: { contact_sheet: { sha256: sha256(notPng) } } },
			brief: BRIEF, output: OUTPUT,
		}), (error: any) => error.code === "PROVIDER_EVIDENCE_UNVERIFIED");
		assert.throws(() => build({
			evidence: { contactSheetBytes: EVIDENCE, manifest: { contact_sheet: { sha256: "0".repeat(64) } } },
			brief: BRIEF, output: OUTPUT,
		}), (error: any) => error.code === "PROVIDER_EVIDENCE_UNVERIFIED");
	}
});

test("request builders accept only immutable evidence authorized by the verifier", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-evidence-authority-"));
	try {
		const { verified, fixturePng } = await verifiedEvidenceFixture(root);
		for (const build of [buildOpenAIRequest, buildGeminiRequest]) {
			const request = build({ evidence: verified, brief: BRIEF, output: OUTPUT });
			assert.deepEqual(request.evidenceBytes, fixturePng);
			assert.equal(request.evidenceManifestSha256, verified.manifestSha256);
			assert.throws(() => build({ evidence: { contactSheetBytes: EVIDENCE, manifestSha256: verified.manifestSha256 }, brief: BRIEF, output: OUTPUT }),
				(error: any) => error.code === "PROVIDER_EVIDENCE_UNVERIFIED");
			assert.throws(() => build({ evidence: { ...verified, manifestSha256: "0".repeat(64) }, brief: BRIEF, output: OUTPUT }),
				(error: any) => error.code === "PROVIDER_EVIDENCE_UNVERIFIED");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a copied request cannot spend a valid ledger submission capability", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-request-authority-"));
	try {
		const { verified } = await verifiedEvidenceFixture(root);
		for (const [name, create, env, build] of [
			["openai", createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
			["gemini", createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
		] as const) {
			let calls = 0;
			const provider = create(env, { fetchImpl: async () => { calls += 1; return Response.json({}); } });
			const request = build({ evidence: verified, brief: BRIEF, output: OUTPUT });
			await assert.rejects(() => createPaidOperationLedger(join(root, `${name}.json`), { approvedRoot: root }).executeOnce({
				requestKey: request.fingerprint, provider: request.provider, kind: "image-generation",
				ceilingUsd: 1, estimateUsd: 0.2,
				operation: async (submission: any) => {
					const result = await provider.generate({ request: { ...request }, submission });
					return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.2 };
				},
			}), (error: any) => error.code === "PROVIDER_REQUEST_UNAUTHORIZED");
			assert.equal(calls, 0);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("exported boundaries reject hostile getters, proxies, and inherited inputs without leaking trap secrets", async () => {
	const marker = "ULTRAPRIVATE_GETTER_8675309";
	for (const [create, env, build] of [
		[createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		[createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		const provider = create(env, { fetchImpl: async () => { throw new Error("transport must not run"); } });
		let getterReads = 0;
		const accessorInput = Object.defineProperty({}, "evidence", { enumerable: true, get() {
			getterReads += 1;
			throw new Error(marker);
		} });
		for (const invoke of [
			async () => build(accessorInput as any),
			async () => provider.preflight(accessorInput),
			async () => provider.generate(accessorInput),
		]) {
			await assert.rejects(invoke, (error: any) => {
				assert.equal(error.code, "PROVIDER_BOUNDARY_INVALID");
				assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(marker));
				return true;
			});
		}
		assert.equal(getterReads, 0);
		let nestedGetterReads = 0;
		const nestedBrief = Object.defineProperty({}, "summary", { enumerable: true, get() {
			nestedGetterReads += 1;
			throw new Error(marker);
		} });
		await assert.rejects(async () => build({ evidence: evidence(), brief: nestedBrief, output: OUTPUT }),
			(error: any) => error.code === "PROVIDER_BOUNDARY_INVALID" && !String(error.stack).includes(marker));
		assert.equal(nestedGetterReads, 0);
		await assert.rejects(async () => build({ evidence: evidence(), brief: Object.create({ summary: marker }), output: OUTPUT }),
			(error: any) => error.code === "PROVIDER_BOUNDARY_INVALID" && !String(error.stack).includes(marker));
		const sparse: any[] = [];
		sparse[100_000] = "sparse";
		await assert.rejects(async () => build({ evidence: evidence(), brief: BRIEF, output: { sparse } }),
			(error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
		let tooDeep: any = { value: "leaf" };
		for (let depth = 0; depth < 70; depth += 1) tooDeep = { child: tooDeep };
		await assert.rejects(async () => build({ evidence: evidence(), brief: BRIEF, output: tooDeep }),
			(error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
		let sharedDag: any = { value: "leaf" };
		for (let depth = 0; depth < 10; depth += 1) sharedDag = { left: sharedDag, right: sharedDag };
		await assert.rejects(async () => build({ evidence: evidence(), brief: BRIEF, output: sharedDag }),
			(error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");

		const hostileProxy = new Proxy({}, { getPrototypeOf() { throw new Error(marker); } });
		await assert.rejects(async () => build(hostileProxy as any), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID" && !String(error.stack).includes(marker));
		assert.throws(() => provider.preflight(hostileProxy), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID" && !String(error.stack).includes(marker));
		await assert.rejects(() => provider.generate(hostileProxy), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID" && !String(error.stack).includes(marker));

		const inherited = Object.create({ request: {} });
		await assert.rejects(async () => build(inherited), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
		assert.throws(() => provider.preflight(inherited), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");
		await assert.rejects(() => provider.generate(inherited), (error: any) => error.code === "PROVIDER_BOUNDARY_INVALID");

		let signalTransportCalls = 0;
		const signalProvider = create(env, { fetchImpl: async () => { signalTransportCalls += 1; return Response.json({}); } });
		const request = build({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		const hostileSignal = new Proxy(new AbortController().signal, { get() { throw new Error(marker); } });
		await assert.rejects(() => createPaidOperationLedger(join(PROVIDER_FIXTURE_ROOT, `hostile-signal-${authorizedSequence++}.json`), { approvedRoot: PROVIDER_FIXTURE_ROOT }).executeOnce({
			requestKey: request.fingerprint, provider: request.provider, kind: "image-generation", ceilingUsd: 1, estimateUsd: 0.2,
			operation: async (submission: any) => {
				const result = await signalProvider.generate({ request, submission, signal: hostileSignal });
				return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.2 };
			},
		}), (error: any) => {
			assert.equal(error.code, "PROVIDER_BOUNDARY_INVALID");
			assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(marker));
			return true;
		});
		assert.equal(signalTransportCalls, 0);
	}
});

test("401 and 429 responses normalize to stable redacted codes", async () => {
	for (const [name, create, env, build] of [
		["openai", createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest],
		["gemini", createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest],
	] as const) {
		for (const [status, code] of [[401, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"]] as const) {
			const provider = create(env, { fetchImpl: async () => Response.json({ error: { message: `Authorization: Bearer ${Object.values(env)[0]}` } }, { status }) });
			await assert.rejects(() => authorizedGenerate(provider, build({ evidence: evidence(), brief: BRIEF, output: OUTPUT })), (error: any) => {
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
			await assert.rejects(() => authorizedGenerate(provider, build({ evidence: evidence(), brief: BRIEF, output: OUTPUT })),
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
		await assert.rejects(() => authorizedGenerate(create(env, { fetchImpl, timeoutMs: 10 }), request),
			(error: any) => error.code === "PROVIDER_TIMEOUT");
		const controller = new AbortController();
		controller.abort(new DOMException("cancelled", "AbortError"));
		await assert.rejects(() => authorizedGenerate(create(env, { fetchImpl, timeoutMs: 1_000 }), request, { signal: controller.signal }),
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
			authorizedGenerate(create(env, { fetchImpl: bodyStallsUntilAbort, timeoutMs: 10 }), request),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("adapter deadline was not enforced during body consumption")), 100)),
		]), (error: any) => error.code === "PROVIDER_TIMEOUT");

		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("cancel body", "AbortError")), 10);
		await assert.rejects(Promise.race([
			authorizedGenerate(create(env, { fetchImpl: bodyStallsUntilAbort, timeoutMs: 1_000 }), request, { signal: controller.signal }),
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
		await assert.rejects(() => authorizedGenerate(create(env, { fetchImpl }), build({ evidence: evidence(), brief: BRIEF, output: OUTPUT })), (error: any) => {
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
		await assert.rejects(() => authorizedGenerate(createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
			fetchImpl: async () => Response.json(openAIResponse),
		}), buildOpenAIRequest(requestArgs)), (error: any) => error.code === code);
		await assert.rejects(() => authorizedGenerate(createGeminiProvider({ GEMINI_API_KEY: "gemini-secret" }, {
			fetchImpl: async () => Response.json(geminiResponse),
		}), buildGeminiRequest(requestArgs)), (error: any) => error.code === code);
	}
});

test("signature-only truncated images are rejected after full decode for both providers", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-full-decode-"));
	try {
		const { verified } = await verifiedEvidenceFixture(root);
		const signatureOnlyPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64");
		const cases: any[] = [
			["openai", createOpenAIProvider, { OPENAI_API_KEY: "sk-openai-secret" }, buildOpenAIRequest,
				async () => Response.json({ id: "truncated-openai", data: [{ b64_json: signatureOnlyPng }] })],
			["gemini", createGeminiProvider, { GEMINI_API_KEY: "gemini-secret" }, buildGeminiRequest,
				async () => Response.json({ responseId: "truncated-gemini", candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: signatureOnlyPng } }] } }] })],
		];
		for (const [name, create, env, build, fetchImpl] of cases) {
			const request = build({ evidence: verified, brief: BRIEF, output: OUTPUT });
			const provider = create(env, { fetchImpl });
			await assert.rejects(() => createPaidOperationLedger(join(root, `${name}.json`), { approvedRoot: root }).executeOnce({
				requestKey: request.fingerprint, provider: request.provider, kind: "image-generation",
				ceilingUsd: 1, estimateUsd: 0.2,
				operation: async (submission: any) => {
					const result = await provider.generate({ request, submission });
					return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.2 };
				},
			}), (error: any) => error.code === "PROVIDER_RESPONSE_INVALID");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("decoded images larger than 32 MiB are rejected before allocation", async () => {
	const oversizedBase64 = "A".repeat(Math.ceil((32 * 1024 * 1024 + 1) / 3) * 4);
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
		fetchImpl: async () => Response.json({ id: "oversized", data: [{ b64_json: oversizedBase64 }] }),
	});
	await assert.rejects(() => authorizedGenerate(provider, buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT })),
		(error: any) => error.code === "PROVIDER_RESPONSE_TOO_LARGE");
});

test("near-limit malformed base64 normalizes without a regular-expression stack failure", async () => {
	const encodedLength = Math.floor((32 * 1024 * 1024) / 3) * 4;
	const malformedBase64 = `${"A".repeat(encodedLength - 1)}%`;
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-openai-secret" }, {
		fetchImpl: async () => Response.json({ id: "malformed-near-limit", data: [{ b64_json: malformedBase64 }] }),
	});
	await assert.rejects(() => authorizedGenerate(provider, buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT })),
		(error: any) => error.code === "PROVIDER_RESPONSE_INVALID");
});

test("the crash-safe ledger submits one successful provider request", async () => {
	const root = await mkdtemp(join(tmpdir(), "facade-provider-ledger-"));
	try {
		const { calls, provider } = openAISuccess();
		const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		const ledger = createPaidOperationLedger(join(root, "paid.json"), { approvedRoot: root });
		const input = {
			requestKey: request.fingerprint, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async (submission: any) => {
				const result = await provider.generate({ request, submission });
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
		const request = buildOpenAIRequest({ evidence: evidence(), brief: BRIEF, output: OUTPUT });
		await assert.rejects(() => ledger.executeOnce({
			requestKey: request.fingerprint, provider: "gpt-image-2", kind: "image-generation",
			ceilingUsd: 1, estimateUsd: 0.2,
			operation: async (submission: any) => {
				const result = await provider.generate({ request, submission });
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
