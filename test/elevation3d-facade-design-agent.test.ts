import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createPaidOperationLedger, consumePaidOperationSubmissionCapability } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { runFacadeDesignAgent } from "../plugins/elevation-3d/lib/facade-agent/design/design-agent.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

function proposal(program: any, depth = 0.12) {
	const { source: _source, ...raw } = structuredClone(program);
	raw.articulation[0].depth_m = depth;
	return raw;
}

function provider(outputs: any[], beforeExtract?: (attempt: number, request: any) => Promise<void>) {
	let calls = 0;
	return {
		id: "openai-gpt-5.6", model: "gpt-5.6", transport: "fixture",
		preflight({ request }: any) { assert.equal(request.provider, "openai-gpt-5.6"); },
		async extract({ request, submission }: any) {
			calls += 1;
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider: "openai-gpt-5.6", kind: "grammar-extraction",
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
		ceilingUsd: 0.1, estimateUsd: 0.05,
	});
	assert.equal(adapter.calls, 2);
	assert.equal(result.validation.accepted, true);
	assert.equal(result.attempts.length, 2);
	assert.deepEqual(result.attempts[0].validation_codes, ["PROJECTION_LIMIT_EXCEEDED"]);
	assert.equal(result.program.source.context_sha256, fixture.context.source.context_sha256);
	assert.doesNotMatch(await readFile(join(fixture.runDir, "facade-design", "attempt-02", "response.json"), "utf8"), /"source"/);
	assert.equal((await fixture.ledger.summary()).operations.length, 2);
});

test("director caps correction at two attempts without relaxing validation", async (t) => {
	const fixture = await setup(t);
	const adapter = provider(Array(3).fill(proposal(fixture.program, 0.8)));
	await assert.rejects(() => runFacadeDesignAgent({
		runDir: fixture.runDir, context: fixture.context, provider: adapter, ledger: fixture.ledger,
		ceilingUsd: 0.1, estimateUsd: 0.05,
	}), (error: any) => error?.code === "FACADE_DESIGN_CORRECTION_EXHAUSTED");
	assert.equal(adapter.calls, 3);
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
		ceilingUsd: 0.1, estimateUsd: 0.05,
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
		ceilingUsd: 0.1, estimateUsd: 0.05,
	}), (error: any) => error?.code === "PAID_OPERATION_SUBMISSION_UNCERTAIN");
	assert.equal(getterCalls, 0);
	assert.equal(adapter.calls, 1);
});
