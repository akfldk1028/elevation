import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { verifyFacadeEvidencePack } from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { extractFacadeGrammar } from "../plugins/elevation-3d/lib/facade-agent/grammar-agent.mjs";
import { createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";

const SURFACES = ["front", "right", "back", "left"];
const VIEWS = [...SURFACES, "top", "axon", "opposite-axon"];
const PASSES = ["color", "depth", "normal", "edge", "surface-id"];
const root = await mkdtemp(join(tmpdir(), "facade-grammar-agent-fixture-"));
const proposalPath = join(root, "proposal.png");
const proposalBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#923f2d" } }).png().toBuffer();
await writeFile(proposalPath, proposalBytes);

async function verifiedEvidenceFixture() {
	const evidenceRoot = join(root, "evidence");
	await mkdir(evidenceRoot);
	const evidencePng = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#eeeeee" } }).png().toBuffer();
	const sourceBytes = Buffer.from("geometry authority fixture");
	const sourcePath = join(root, "source.bin");
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

test("calls the pinned Responses structured-output contract and binds proposal and verified evidence hashes", async () => {
	const fetchCalls: any[] = [];
	const ledger = fixtureLedger();
	const extracted = await extractFacadeGrammar({
		proposalPath, evidence, config: config(), ledger,
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
			proposalPath, evidence, config: config(), ledger: fixtureLedger(),
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
			proposalPath, evidence, config: config(), ledger,
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
			proposalPath, evidence, config: config(), ledger: fixtureLedger(),
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
		proposalPath, evidence, config: config(), ledger: forgedLedger,
		fetchImpl: async () => { calls += 1; return Response.json(responseFixture(grammar)); },
	}), (error: any) => error.code === "GRAMMAR_SUBMISSION_UNAUTHORIZED");
	assert.equal(calls, 0);
});

test("bounds response parsing and applies timeout and caller abort without retrying", async () => {
	let oversizedCalls = 0;
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath, evidence, config: config(), ledger: fixtureLedger(),
		fetchImpl: async () => {
			oversizedCalls += 1;
			return new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } });
		},
	}), (error: any) => error.code === "GRAMMAR_RESPONSE_TOO_LARGE");
	assert.equal(oversizedCalls, 1);

	let timeoutCalls = 0;
	await assert.rejects(() => extractFacadeGrammar({
		proposalPath, evidence, config: config({ grammarTimeoutMs: 10 }), ledger: fixtureLedger(),
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
		proposalPath, evidence, config: config(), ledger: fixtureLedger(), signal: controller.signal,
		fetchImpl: async () => { abortedCalls += 1; return Response.json(responseFixture(grammar)); },
	}), (error: any) => error.code === "GRAMMAR_ABORTED");
	assert.equal(abortedCalls, 0);
});
