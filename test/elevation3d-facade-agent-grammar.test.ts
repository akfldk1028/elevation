import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import {
	extractFacadeGrammar,
	FACADE_GRAMMAR_SCHEMA,
	readVerifiedFacadeGrammarAuthority,
	rehydrateVerifiedFacadeGrammar,
	serializeVerifiedFacadeGrammarAuthority,
	verifyFacadeProposal,
} from "../plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs";
import {
	createFacadeGrammarRequest,
} from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/contract.mjs";
import {
	buildFacadeGrammarPrompt,
} from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/prompt.mjs";
import {
	createProvider as createOpenAIGrammarProvider,
} from "../plugins/elevation-3d/lib/facade-agent/providers/grammar/openai/adapter.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import {
	buildRequest as buildOpenAIRequest,
	createProvider as createOpenAIProvider,
} from "../plugins/elevation-3d/lib/facade-agent/providers/openai-image.mjs";

const SURFACES = ["front", "right", "back", "left"];
const VIEWS = [...SURFACES, "top", "axon", "opposite-axon"];
const PASSES = ["color", "depth", "normal", "edge", "surface-id"];
const root = await mkdtemp(join(tmpdir(), "facade-grammar-agent-fixture-"));
const proposalPath = join(root, "proposal.png");
const proposalBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#923f2d" } }).png().toBuffer();
await writeFile(proposalPath, proposalBytes);

async function verifiedEvidenceFixture(label = "primary", sourceText = "geometry authority fixture") {
	const fixtureRoot = join(root, label);
	await mkdir(fixtureRoot);
	const evidenceRoot = join(fixtureRoot, "evidence");
	await mkdir(evidenceRoot);
	const evidencePng = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#eeeeee" } }).png().toBuffer();
	const sourceBytes = Buffer.from(sourceText);
	const sourcePath = join(fixtureRoot, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const artifacts: Record<string, unknown> = {};
	for (const mode of PASSES) {
		await mkdir(join(evidenceRoot, mode));
		for (const view of VIEWS) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), evidencePng);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(evidencePng), width: 1, height: 1, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), evidencePng);
	const input = {
		candidate: { candidate_id: "creative-020" }, identity: { geometry_hash: "geometry-fixture" },
		floor_guides: { floor_guides_m: [0, 3.3, 6.6, 9.9] }, facade_planes: { facade_planes: [] }, cameras: { views: [] },
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1", candidate_id: "creative-020", geometry_hash: input.identity.geometry_hash,
		floor_guides_m: input.floor_guides.floor_guides_m,
		facade_planes_sha256: sha256(stableJson(input.facade_planes)), cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }], artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(evidencePng), width: 1, height: 1 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	return verifyFacadeEvidencePack({ manifestPath, input });
}

const evidence = await verifiedEvidenceFixture();
const otherEvidence = await verifiedEvidenceFixture("other", "different geometry authority fixture");
after(async () => rm(root, { recursive: true, force: true }));
let ledgerSequence = 0;

const grammar = Object.freeze({
	system: "brick-punched-window-v1",
	surfaces: SURFACES,
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

function responseFixture(value: unknown, overrides: Record<string, unknown> = {}) {
	return {
		id: "resp_facade_grammar_fixture",
		status: "completed",
		output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) }] }],
		usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.04 },
		...overrides,
	};
}

function config(overrides: Record<string, unknown> = {}) {
	return {
		candidateId: "creative-020", grammarModel: "gpt-5.6", grammarBudgetUsd: 0.1,
		grammarEstimateUsd: 0.05, grammarTimeoutMs: 1_000, openAIApiKey: "sk-fixture-secret",
		proposalProvider: "gpt-image-2",
		...overrides,
	};
}

function fixtureLedger() {
	const calls: any[] = [];
	const actual = createPaidOperationLedger(join(root, `paid-${ledgerSequence++}.json`), { approvedRoot: root });
	return {
		calls,
		async executeOnce(input: any) {
			calls.push(input);
			let operationError: any;
			const result = await actual.executeOnce({
				...input,
				operation: async (submission: any) => {
					try { return await input.operation(submission); }
					catch (error) {
						operationError = error;
						return { remoteId: `fixture-error-${ledgerSequence}`, artifactSha256: "f".repeat(64), actualUsd: 0 };
					}
				},
			});
			if (operationError) throw operationError;
			return result;
		},
	};
}

async function generatedProposalResult(sourceEvidence = evidence) {
	const request = buildOpenAIRequest({
		evidence: sourceEvidence,
		brief: { brief_id: "brick-punched-window-v1", candidate_id: "creative-020" },
		output: { width: 1536, height: 1024, format: "png" },
	});
	const provider = createOpenAIProvider({ OPENAI_API_KEY: "sk-provider-fixture" }, {
		fetchImpl: async () => Response.json({
			id: `proposal-result-${ledgerSequence}`,
			data: [{ b64_json: proposalBytes.toString("base64") }],
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		timeoutMs: 1_000,
	});
	let result: any;
	await createPaidOperationLedger(join(root, `proposal-paid-${ledgerSequence++}.json`), { approvedRoot: root }).executeOnce({
		requestKey: request.fingerprint,
		provider: request.provider,
		kind: "image-generation",
		ceilingUsd: 0.1,
		estimateUsd: 0.05,
		operation: async (submission: any) => {
			result = await provider.generate({ request, submission });
			return { remoteId: result.remoteId, artifactSha256: sha256(result.bytes), actualUsd: 0.05 };
		},
	});
	return result;
}

const proposalAuthority = await verifyFacadeProposal({
	proposalPath,
	providerResult: await generatedProposalResult(),
	evidence,
	config: config(),
});

function commonGrammarRequest(overrides: Record<string, unknown> = {}) {
	const prompt = buildFacadeGrammarPrompt({
		proposalSha256: sha256(proposalBytes),
		evidenceManifestSha256: evidence.manifestSha256,
		manifestText: `${stableJson(evidence.manifest)}\n`,
	});
	return createFacadeGrammarRequest({
		provider: "openai-gpt-5.6",
		model: "gpt-5.6",
		proposalSha256: sha256(proposalBytes),
		evidenceManifestSha256: evidence.manifestSha256,
		promptRevision: prompt.revision,
		prompt: prompt.prompt,
		promptSha256: prompt.sha256,
		imageBytes: proposalBytes,
		imageMimeType: "image/png",
		schema: FACADE_GRAMMAR_SCHEMA,
		ceilingUsd: 0.1,
		estimateUsd: 0.05,
		...overrides,
	});
}

function nestedPlainData(depth: number) {
	let value: any = { leaf: true };
	for (let index = 0; index < depth; index += 1) value = { child: value };
	return value;
}

test("creates one deeply frozen, hash-bound common grammar request and rejects unsafe boundary input", () => {
	const request = commonGrammarRequest();
	assert.equal(request.provider, "openai-gpt-5.6");
	assert.equal(request.model, "gpt-5.6");
	assert.equal(request.proposalSha256, sha256(proposalBytes));
	assert.equal(request.evidenceManifestSha256, evidence.manifestSha256);
	assert.equal(request.promptRevision, "facade-grammar-v2");
	assert.equal(request.promptSha256.length, 64);
	assert.equal(request.ceilingUsd, 0.1);
	assert.equal(request.estimateUsd, 0.05);
	assert.equal(Object.isFrozen(request), true);
	assert.equal(Object.isFrozen(request.schema), true);
	assert.equal(Object.isFrozen(request.schema.properties), true);
	assert.match(request.prompt, new RegExp(request.proposalSha256));
	assert.match(request.prompt, new RegExp(request.evidenceManifestSha256));

	for (const [name, overrides] of [
		["proposal hash", { proposalSha256: "a".repeat(63) }],
		["evidence hash", { evidenceManifestSha256: "b".repeat(65) }],
		["prompt binding", { prompt: "valid-looking but unbound prompt", promptSha256: sha256("valid-looking but unbound prompt") }],
		["prompt revision", { promptRevision: "facade-grammar-v1" }],
		["exotic schema", { schema: new Date() }],
		["media", { imageBytes: Buffer.from("GIF89a"), imageMimeType: "image/gif" }],
		["prompt size", { prompt: "x".repeat(256 * 1024), promptSha256: sha256("x".repeat(256 * 1024)) }],
		["image size", { imageBytes: Buffer.alloc(32 * 1024 * 1024 + 1), imageMimeType: "image/png" }],
		["budget", { estimateUsd: 0.11 }],
	] as const) {
		assert.throws(() => commonGrammarRequest(overrides), /hash|plain|media|image|prompt|budget|ceiling/i, name);
	}
	assert.throws(() => commonGrammarRequest({ schema: nestedPlainData(64) }), (error: any) => {
		assert.equal(error.code, "GRAMMAR_BOUNDARY_INVALID");
		assert.equal(error.definitiveNonSubmission, true);
		assert.doesNotMatch(`${error.name}\n${error.message}`, /RangeError|stack/i);
		return true;
	});
});

test("OpenAI grammar adapter preserves the pinned Responses compatibility contract", async () => {
	const calls: any[] = [];
	const provider = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture-secret" }, {
		timeoutMs: 1_000,
		fetchImpl: async (url: string, init: any) => {
			calls.push({ url, init, body: JSON.parse(init.body) });
			return Response.json(responseFixture(grammar));
		},
	});
	const request = commonGrammarRequest();
	assert.deepEqual(provider.preflight({ request }), {
		provider: "openai-gpt-5.6", model: "gpt-5.6", transport: "live",
		ceilingUsd: 0.1, estimateUsd: 0.05,
	});
	const result = await provider.extract({ request });
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.equal(call.url, "https://api.openai.com/v1/responses");
	assert.equal(call.body.model, "gpt-5.6");
	assert.equal(call.body.text.format.type, "json_schema");
	assert.equal(call.body.text.format.strict, true);
	assert.match(call.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
	assert.equal(result.provider, "openai-gpt-5.6");
	assert.equal(result.transport, "live");
	assert.equal(result.grammarCandidate, JSON.stringify(grammar));
});

test("OpenAI grammar result decoding preserves absent remote IDs and bounds nested usage", async () => {
	const request = commonGrammarRequest();
	const withoutRemote = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => Response.json(responseFixture(grammar, { id: undefined })),
	});
	assert.equal((await withoutRemote.extract({ request })).remoteId, null);

	const deeplyNestedUsage = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => Response.json(responseFixture(grammar, {
			id: "resp-depth-bound",
			usage: nestedPlainData(64),
		})),
	});
	await assert.rejects(() => deeplyNestedUsage.extract({ request }), (error: any) => {
		assert.equal(error.code, "GRAMMAR_RESPONSE_INVALID");
		assert.equal(error.definitiveNonSubmission, false);
		assert.doesNotMatch(`${error.name}\n${error.message}`, /RangeError|stack/i);
		return true;
	});
});

test("OpenAI grammar adapter rejects exotic constructor boundaries without exposing trap data", () => {
	const marker = "grammar-constructor-trap-secret";
	const hostileEnv = Object.defineProperty({}, "OPENAI_API_KEY", { enumerable: true, get() { throw new Error(marker); } });
	const hostileOptions = Object.defineProperty({}, "fetchImpl", { enumerable: true, get() { throw new Error(marker); } });
	for (const [env, options] of [[hostileEnv, {}], [{ OPENAI_API_KEY: "sk-fixture" }, hostileOptions]]) {
		assert.throws(() => createOpenAIGrammarProvider(env, options), (error: any) => {
			assert.equal(error.code, "GRAMMAR_BOUNDARY_INVALID");
			assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(marker));
			return true;
		});
	}
});

test("grammar prompt and adapter call boundaries reject accessors before transport", async () => {
	const marker = "grammar-call-trap-secret";
	const hostile = Object.defineProperty({}, "request", { enumerable: true, get() { throw new Error(marker); } });
	const hostilePrompt = Object.defineProperty({}, "proposalSha256", { enumerable: true, get() { throw new Error(marker); } });
	assert.throws(() => buildFacadeGrammarPrompt(hostilePrompt), (error: any) => {
		assert.equal(error.code, "GRAMMAR_BOUNDARY_INVALID");
		assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(marker));
		return true;
	});
	let fetchCalls = 0;
	const provider = createOpenAIGrammarProvider({ OPENAI_API_KEY: "sk-fixture" }, {
		fetchImpl: async () => { fetchCalls += 1; return Response.json(responseFixture(grammar)); },
	});
	for (const call of [() => provider.preflight(hostile), () => provider.extract(hostile)]) {
		await assert.rejects(async () => call(), (error: any) => {
			assert.equal(error.code, "GRAMMAR_BOUNDARY_INVALID");
			assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(marker));
			return true;
		});
	}
	assert.equal(fetchCalls, 0);
});

test("calls the pinned Responses structured-output contract and binds proposal and verified evidence hashes", async () => {
	const fetchCalls: any[] = [];
	const ledger = fixtureLedger();
	const extracted = await extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger,
		fetchImpl: async (url: string, init: any) => {
			fetchCalls.push({ url, init, body: JSON.parse(init.body) });
			return Response.json(responseFixture(grammar));
		},
	});

	assert.deepEqual(extracted, grammar);
	assert.equal(fetchCalls.length, 1);
	assert.equal(fetchCalls[0].url, "https://api.openai.com/v1/responses");
	assert.equal(fetchCalls[0].body.model, "gpt-5.6");
	assert.equal(fetchCalls[0].body.text.format.strict, true);
	assert.equal(fetchCalls[0].body.text.format.schema.additionalProperties, false);
	assert.deepEqual([...fetchCalls[0].body.text.format.schema.required].sort(), Object.keys(grammar).sort());
	assert.match(fetchCalls[0].body.input[0].content[0].text, new RegExp(evidence.manifestSha256));
	assert.match(fetchCalls[0].body.input[0].content[0].text, new RegExp(sha256(proposalBytes)));
	assert.match(fetchCalls[0].body.input[0].content[1].image_url, /^data:image\/png;base64,/);
	assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer sk-fixture-secret");
	assert.equal(ledger.calls.length, 1);
	assert.equal(ledger.calls[0].provider, "openai");
	assert.equal(ledger.calls[0].kind, "grammar-extraction");
	assert.equal(ledger.calls[0].requestKey.length, 64);
	assert.equal(ledger.calls[0].ceilingUsd, 0.1);
	assert.equal(ledger.calls[0].estimateUsd, 0.05);
	assert.doesNotMatch(stableJson({ extracted, ledger: ledger.calls.map(({ operation: _operation, ...call }) => call) }), /sk-fixture-secret|Authorization/i);
});

test("rehydrates a canonical persisted grammar only when every durable authority binding matches", async () => {
	const extracted = await extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger: fixtureLedger(),
		fetchImpl: async () => Response.json(responseFixture(grammar)),
	});
	const path = join(root, "rehydrate-grammar.json");
	const bytes = Buffer.from(`${JSON.stringify(extracted, null, 2)}\n`);
	await writeFile(path, bytes);
	const authority = serializeVerifiedFacadeGrammarAuthority(extracted);
	const copied = JSON.parse(bytes.toString("utf8"));
	assert.equal(readVerifiedFacadeGrammarAuthority(copied), null);
	const restored = await rehydrateVerifiedFacadeGrammar({
		path, artifactSha256: sha256(bytes), authority, evidence,
		provider: "gpt-image-2", proposalSha256: sha256(proposalBytes),
	});
	assert.equal(Object.isFrozen(restored), true);
	assert.equal(readVerifiedFacadeGrammarAuthority(restored)?.proposalSha256, sha256(proposalBytes));
	await assert.rejects(() => rehydrateVerifiedFacadeGrammar({
		path, artifactSha256: sha256(bytes), authority: { ...authority, camerasSha256: "f".repeat(64) }, evidence,
		provider: "gpt-image-2", proposalSha256: sha256(proposalBytes),
	}), (error: any) => error.code === "GRAMMAR_REHYDRATION_INVALID");
});

test("requires an unforgeable proposal authority bound to provider, candidate, evidence, path, and bytes", async () => {
	for (const [name, makeInput] of [
		["copied provider result", async () => ({ proposalPath, providerResult: { ...await generatedProposalResult() }, evidence, config: config() })],
		["provider mismatch", async () => ({ proposalPath, providerResult: await generatedProposalResult(), evidence, config: config({ proposalProvider: "nano-banana-pro" }) })],
		["candidate mismatch", async () => ({ proposalPath, providerResult: await generatedProposalResult(), evidence, config: config({ candidateId: "creative-999" }) })],
		["evidence mismatch", async () => ({ proposalPath, providerResult: await generatedProposalResult(), evidence: otherEvidence, config: config() })],
	] as const) {
		await assert.rejects(() => makeInput().then((input) => verifyFacadeProposal(input)), /verified proposal|provider|candidate|evidence/i, name);
	}

	const copiedPath = join(root, "copied-proposal.png");
	await writeFile(copiedPath, proposalBytes);
	for (const value of [proposalPath, { ...proposalAuthority }, { ...proposalAuthority, path: copiedPath }]) {
		let fetchCalls = 0;
		const ledger = fixtureLedger();
		await assert.rejects(() => extractFacadeGrammar({
			proposalPath: value, evidence, config: config(), ledger,
			fetchImpl: async () => { fetchCalls += 1; return Response.json(responseFixture(grammar)); },
		}), /verified proposal/i);
		assert.equal(fetchCalls, 0);
		assert.equal(ledger.calls.length, 0);
	}

	const changedBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000000" } }).png().toBuffer();
	await writeFile(proposalPath, changedBytes);
	try {
		let fetchCalls = 0;
		const ledger = fixtureLedger();
		await assert.rejects(() => extractFacadeGrammar({
			proposalPath: proposalAuthority, evidence, config: config(), ledger,
			fetchImpl: async () => { fetchCalls += 1; return Response.json(responseFixture(grammar)); },
		}), /proposal.*hash|verified proposal/i);
		assert.equal(fetchCalls, 0);
		assert.equal(ledger.calls.length, 0);
	} finally {
		await writeFile(proposalPath, proposalBytes);
	}
});

test("fails closed on malformed, ambiguous, unsafe, or geometry-changing structured output", async () => {
	const cases: Array<[string, unknown]> = [
		["unknown field", { ...grammar, raw_vertices: [[0, 0, 0]] }],
		["free-form code", { ...grammar, materials: ["brick", "precast", "window-frame", "```js"] }],
		["URL", { ...grammar, materials: ["brick", "precast", "window-frame", "https://evil.test/material"] }],
		["missing surface", { ...grammar, surfaces: ["front", "right", "left"] }],
		["duplicate surface", { ...grammar, surfaces: ["front", "right", "back", "back"] }],
		["unresolved surface", { ...grammar, unresolved_surfaces: ["back"] }],
		["low confidence", { ...grammar, confidence: 0.5 }],
		["curtain wall", { ...grammar, materials: ["brick", "precast", "window-frame", "curtain-wall"] }],
		["out of range", { ...grammar, reveal_depth_m: 99 }],
		["nonfinite", JSON.stringify(grammar).replace('"bay_width_m":2.4', '"bay_width_m":1e400')],
		["infeasible bay", { ...grammar, bay_width_m: 1.2, window_width_m: 1.2, frame_width_m: 0.08 }],
		["floor crossing", { ...grammar, sill_height_m: 1.1, window_height_m: 2.1, lintel_height_m: 0.2 }],
		["geometry instruction", { ...grammar, instruction: "change the massing and add a floor" }],
		["markdown prose", `Here is the grammar:\n\`\`\`json\n${JSON.stringify(grammar)}\n\`\`\``],
		["duplicate key", JSON.stringify(grammar).replace('"bay_width_m":2.4', '"bay_width_m":2.4,"bay_width_m":2.5')],
	];
	for (const [name, value] of cases) {
		let calls = 0;
		await assert.rejects(() => extractFacadeGrammar({
			proposalPath: proposalAuthority, evidence, config: config(), ledger: fixtureLedger(),
			fetchImpl: async () => { calls += 1; return Response.json(responseFixture(value)); },
		}), (error: any) => {
			assert.match(error.code ?? error.message, /GRAMMAR_(OUTPUT|RESPONSE)_INVALID/);
			assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /evil\.test|change the massing|raw_vertices/);
			return true;
		}, name);
		assert.equal(calls, 1, name);
	}
});

test("rejects wrong models, over-budget work, and unverified provenance before transport", async () => {
	for (const [name, changed] of [
		["model", { config: config({ grammarModel: "gpt-4.1" }) }],
		["budget", { config: config({ grammarBudgetUsd: 0.01 }) }],
		["evidence", { evidence: { ...evidence } }],
	] as const) {
		let calls = 0;
		const ledger = fixtureLedger();
		await assert.rejects(() => extractFacadeGrammar({
			proposalPath: proposalAuthority, evidence, config: config(), ledger,
			fetchImpl: async () => { calls += 1; return Response.json(responseFixture(grammar)); },
			...changed,
		}), /model|budget|verified evidence/i, name);
		assert.equal(calls, 0, name);
		assert.equal(ledger.calls.length, 0, name);
	}
});

test("rejects a hostile verified-manifest mutation without transport or secret leakage", async () => {
	const marker = "manifest-accessor-secret";
	const descriptor = Object.getOwnPropertyDescriptor(evidence.manifest, "candidate_id")!;
	Object.defineProperty(evidence.manifest, "candidate_id", { configurable: true, enumerable: true, get() { throw new Error(marker); } });
	let calls = 0;
	try {
		await assert.rejects(() => extractFacadeGrammar({
			proposalPath: proposalAuthority, evidence, config: config(), ledger: fixtureLedger(),
			fetchImpl: async () => { calls += 1; return Response.json(responseFixture(grammar)); },
		}), (error: any) => {
			assert.equal(error.code, "GRAMMAR_EVIDENCE_UNVERIFIED");
			assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(marker));
			return true;
		});
	} finally {
		Object.defineProperty(evidence.manifest, "candidate_id", descriptor);
	}
	assert.equal(calls, 0);
});

test("a forged ledger cannot authorize a grammar submission", async () => {
	let calls = 0;
	const forgedLedger = { executeOnce: (input: any) => input.operation(Object.freeze(Object.create(null))) };
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger: forgedLedger,
		fetchImpl: async () => { calls += 1; return Response.json(responseFixture(grammar)); },
	}), (error: any) => error.code === "GRAMMAR_SUBMISSION_UNAUTHORIZED");
	assert.equal(calls, 0);
});

test("a post-submission result failure leaves the real ledger uncertain and prevents another fetch", async () => {
	const ledger = createPaidOperationLedger(join(root, `post-submit-paid-${ledgerSequence++}.json`), { approvedRoot: root });
	let fetchCalls = 0;
	const extraction = (response: unknown) => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger,
		fetchImpl: async () => { fetchCalls += 1; return Response.json(response); },
	});
	await assert.rejects(() => extraction(responseFixture(grammar, {
		id: undefined,
		usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.11 },
	})), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(fetchCalls, 1);
	await assert.rejects(() => extraction(responseFixture(grammar)), (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(fetchCalls, 1, "the uncertain same-request reservation must prevent another fetch");
});

test("a post-submission result failure retains known remote provenance in the real ledger", async () => {
	const ledger = createPaidOperationLedger(join(root, `post-submit-remote-${ledgerSequence++}.json`), { approvedRoot: root });
	const remoteId = "resp-known-result-failure";
	let fetchCalls = 0;
	const extraction = () => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger,
		fetchImpl: async () => {
			fetchCalls += 1;
			return Response.json(responseFixture(grammar, {
				id: remoteId,
				usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.11 },
			}));
		},
	});
	await assert.rejects(extraction, (error: any) => error.code === "GRAMMAR_RESPONSE_INVALID");
	assert.equal((await ledger.summary()).operations[0].remoteIdHash, sha256(remoteId));
	await assert.rejects(extraction, (error: any) => error.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(fetchCalls, 1);
});

test("missing provider IDs use canonical grammar provenance independent of JSON formatting and key order", async () => {
	const variants = [
		JSON.stringify(grammar),
		JSON.stringify(Object.fromEntries(Object.entries(grammar).reverse())),
	];
	const remoteIdHashes = [];
	for (const [index, grammarText] of variants.entries()) {
		const ledger = createPaidOperationLedger(join(root, `canonical-remote-${index}-${ledgerSequence++}.json`), { approvedRoot: root });
		await extractFacadeGrammar({
			proposalPath: proposalAuthority, evidence, config: config(), ledger,
			fetchImpl: async () => Response.json(responseFixture(grammarText, { id: undefined })),
		});
		remoteIdHashes.push((await ledger.summary()).operations[0].remoteIdHash);
	}
	const canonicalRemoteId = `openai-${sha256(stableJson(grammar))}`;
	assert.deepEqual(remoteIdHashes, [sha256(canonicalRemoteId), sha256(canonicalRemoteId)]);
});

test("bounds response parsing and applies timeout and caller abort without retrying", async () => {
	let oversizedCalls = 0;
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger: fixtureLedger(),
		fetchImpl: async () => {
			oversizedCalls += 1;
			return new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } });
		},
	}), (error: any) => error.code === "GRAMMAR_RESPONSE_TOO_LARGE");
	assert.equal(oversizedCalls, 1);

	let timeoutCalls = 0;
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config({ grammarTimeoutMs: 10 }), ledger: fixtureLedger(),
		fetchImpl: async (_url: string, init: any) => new Promise((_resolve, reject) => {
			timeoutCalls += 1;
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		}),
	}), (error: any) => error.code === "GRAMMAR_TIMEOUT");
	assert.equal(timeoutCalls, 1);

	const controller = new AbortController();
	controller.abort(new DOMException("fixture abort", "AbortError"));
	let abortedCalls = 0;
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath: proposalAuthority, evidence, config: config(), ledger: fixtureLedger(), signal: controller.signal,
		fetchImpl: async () => { abortedCalls += 1; return Response.json(responseFixture(grammar)); },
	}), (error: any) => error.code === "GRAMMAR_ABORTED");
	assert.equal(abortedCalls, 0);
});
