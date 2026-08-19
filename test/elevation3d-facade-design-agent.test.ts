import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createPaidOperationLedger, consumePaidOperationSubmissionCapability } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { isBetterFallbackComposition, runFacadeDesignAgent } from "../plugins/elevation-3d/lib/facade-agent/design/design-agent.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

function proposal(program: any, depth = 0.12) {
	const { source: _source, ...raw } = structuredClone(program);
	raw.articulation[0].depth_m = depth;
	return raw;
}

function provider(outputs: any[], beforeExtract?: (attempt: number, request: any) => Promise<void>) {
	let calls = 0;
	return {
		id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture",
		preflight({ request }: any) { assert.equal(request.provider, "openai-gpt-5.5"); },
		async extract({ request, submission }: any) {
			calls += 1;
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider: "openai-gpt-5.5", kind: "grammar-extraction",
			}), true);
			await beforeExtract?.(calls, request);
			const value = outputs[calls - 1];
			if (value instanceof Error) throw value;
			return { grammarCandidate: value, remoteId: `fixture-design-${calls}`, actualUsd: 0 };
		},
		get calls() { return calls; },
	};
}

async function setup(t: any) {
	const fixture = await createFacadeDesignFixture(t);
	const ledgerRoot = join(fixture.root, "design-ledger");
	await mkdir(ledgerRoot);
	return {
		...fixture,
		ledger: createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot }),
	};
}

test("director persists prepared authority, corrects validator rejection, and returns accepted typed authorities", async (t) => {
	const fixture = await setup(t);
	const adapter = provider([proposal(fixture.program, 0.8), proposal(fixture.program)], async (attempt, request) => {
		await access(join(fixture.runDir, "facade-design", `attempt-${String(attempt).padStart(2, "0")}`, "prepared.json"));
		assert.deepEqual(request.schema.properties.entrance.properties.preferred_bay.enum, ["central_or_corner_focus", "central_focus", "corner_focus"]);
		assert.deepEqual(request.schema.properties.materials.items.properties.role.enum, ["opaque", "glass", "bronze", "concrete"]);
		assert.equal(request.schema.properties.zones.minItems, 3);
		assert.equal(request.schema.properties.window_families.minItems, 2);
		if (attempt === 2) assert.match(request.prompt, /PROJECTION_LIMIT_EXCEEDED/);
	});
	const result = await runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05, language: "v2",
	});
	assert.equal(adapter.calls, 2);
	assert.equal(result.validation.accepted, true);
	assert.equal(result.attempts.length, 2);
	// The code carries its locus now. A bare code left a repo-blind author spending two of its
	// three attempts working out which face and which member the fault meant, so the measured
	// value, the limit and the offending primitive travel with it.
	assert.equal(result.attempts[0].validation_codes.length, 1);
	const reported = result.attempts[0].validation_codes[0];
	assert.match(reported, /^PROJECTION_LIMIT_EXCEEDED /, reported);
	assert.match(reported, /measured [\d.]+ against [\d.]+/, reported);
	assert.match(reported, /elevation, at a \w+ spanning u [\d.]+-[\d.]+ z [\d.]+-[\d.]+/, reported);
	assert.equal(result.program.source.context_sha256, fixture.context.source.context_sha256);
	assert.doesNotMatch(await readFile(join(fixture.runDir, "facade-design", "attempt-02", "response.json"), "utf8"), /"source"/);
	assert.equal((await fixture.ledger.summary()).operations.length, 2);
});

test("director caps correction at two attempts without relaxing validation", async (t) => {
	const fixture = await setup(t);
	const adapter = provider(Array(3).fill(proposal(fixture.program, 0.8)));
	await assert.rejects(() => runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05, language: "v2",
	}), (error: any) => error?.code === "FACADE_DESIGN_CORRECTION_EXHAUSTED");
	assert.equal(adapter.calls, 3);
});

// The first live provider run spent all three attempts on one overrun because the
// correction relayed only the resolver's wrapper - "facade program resolution failed" -
// and the layout message with the numbers and the fix stayed inside error.cause. The
// model must see the cause, or it corrects blind and repeats itself.
test("a resolve failure reaches the next attempt with its cause, not just the wrapper", async (t) => {
	const fixture = await setup(t);
	const overrun = {
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: "overrun-probe",
		start: "Facade",
		entrance: {
			segment_selector: "primary_visible_ground_segment", preferred_bay: "central_focus",
			door_family: "storefront-double", width_m: 1.6, height_m: 2.6, recess_m: 0.3,
		},
		rules: [
			{ name: "Facade", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "50", symbol: "W", arg: null, repeat: null }] }, terminal: null, inset_m: 0, depth_m: 0 }] },
			{ name: "W", alternatives: [{ when: null, split: null, terminal: "wall", inset_m: 0, depth_m: 0 }] },
		],
	};
	let secondPrompt = "";
	const adapter = provider(Array(3).fill(overrun), async (attempt, request) => {
		if (attempt === 2) secondPrompt = request.prompt;
	});
	await assert.rejects(() => runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05, language: "grammar",
	}), (error: any) => error?.code === "FACADE_DESIGN_CORRECTION_EXHAUSTED");
	assert.equal(adapter.calls, 3);
	assert.match(secondPrompt, /PROGRAM_INVALID: facade program resolution failed - /, secondPrompt.slice(-600));
	assert.match(secondPrompt, /does not fit: its parts need/, secondPrompt.slice(-600));
});

test("an uncertain paid design submission is never replayed", async (t) => {
	const fixture = await setup(t);
	const adapter = provider([new Error("connection lost after submit")]);
	const input = {
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05,
	};
	await assert.rejects(() => runFacadeDesignAgent(input), (error: any) => error?.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	await assert.rejects(() => runFacadeDesignAgent(input), (error: any) => error?.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(adapter.calls, 1);
});

test("director rejects a cloned context before provider or ledger work", async (t) => {
	const fixture = await setup(t);
	const adapter = provider([proposal(fixture.program)]);
	await assert.rejects(() => runFacadeDesignAgent({
		runDir: fixture.runDir, context: structuredClone(fixture.context), provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05, language: "v2",
	}), (error: any) => error?.code === "FACADE_DESIGN_AGENT_INVALID");
	assert.equal(adapter.calls, 0);
	assert.equal((await fixture.ledger.summary()).operations.length, 0);
});

test("director never invokes accessors hidden inside a returned design", async (t) => {
	const fixture = await setup(t);
	let getterCalls = 0;
	const hostile = Object.defineProperty({}, "schema_version", {
		enumerable: true, get() { getterCalls += 1; return "arr.elevation3d.facade-program.v2"; },
	});
	const adapter = provider([hostile]);
	await assert.rejects(() => runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05, language: "v2",
	}), (error: any) => error?.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(getterCalls, 0);
	assert.equal(adapter.calls, 1);
});

test("asks the model for a grammar unless a caller pins the flat language", async (t) => {
	const fixture = await setup(t);
	const seen: any[] = [];
	const adapter = provider([proposal(fixture.program)]);
	const spy = { ...adapter, async extract(input: any) { seen.push(input.request); return adapter.extract(input); } };
	await runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: spy, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05,
	}).catch(() => undefined);

	assert.equal(seen.length > 0, true);
	assert.equal(seen[0].promptRevision, "arr.elevation3d.facade-grammar-prompt.v1");
	assert.equal(seen[0].schema.properties.rules.type, "array", "the model is asked for a rule graph");
	assert.deepEqual(seen[0].schema.properties.rules.items.required, ["name", "alternatives"]);
	assert.equal(seen[0].schema.properties.window_families, undefined, "not the flat v2 record");
	assert.match(seen[0].prompt, /split grammar, not a list of windows/);
});

// No attempt composed, so one of them still has to ship. Ranking by fault count alone
// counts a blank wall as a single fault, which is how one shipped: it beat an elevation
// that kept its openings and only wanted a cornice and a subject.
test("the fallback prefers an elevation that kept its openings over a blank wall", () => {
	const blank = { codes: ["OPENING_RATIO_LOW"] };
	const flat = { codes: ["TOP_TERMINATION_MISSING", "SCALE_HIERARCHY_FLAT", "STOREY_LOCKSTEP"] };
	assert.equal(isBetterFallbackComposition(flat, blank), true);
	assert.equal(isBetterFallbackComposition(blank, flat), false);
});

test("the fallback keeps the least faulty attempt once none of them is blank", () => {
	const one = { codes: ["STOREY_LOCKSTEP"] };
	const two = { codes: ["STOREY_LOCKSTEP", "SCALE_HIERARCHY_FLAT"] };
	assert.equal(isBetterFallbackComposition(one, two), true);
	assert.equal(isBetterFallbackComposition(two, one), false);
	assert.equal(isBetterFallbackComposition(two, null), true);
});

test("the fallback still ranks blank walls against each other", () => {
	const blank = { codes: ["OPENING_RATIO_LOW"] };
	const worse = { codes: ["OPENING_RATIO_LOW", "TOP_TERMINATION_MISSING"] };
	assert.equal(isBetterFallbackComposition(blank, worse), true);
	assert.equal(isBetterFallbackComposition(worse, blank), false);
});
