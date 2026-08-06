import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFacadeEvaluationCost } from "../plugins/elevation-3d/lib/facade-agent/evaluation/cost.mjs";
import { buildFacadeEvaluationReport } from "../plugins/elevation-3d/lib/facade-agent/evaluation/report.mjs";
import { selectFacadeRecommendation } from "../plugins/elevation-3d/lib/facade-agent/evaluation/scorecard.mjs";

function candidate(provider: string, score: number, actualTotalUsd: number | null, accepted = true) {
	return { provider, score, accepted, cost: { currency: "USD", actual_total_usd: actualTotalUsd } };
}

test("normalizes receipt costs exactly and never treats missing actual cost as zero", () => {
	assert.deepEqual(normalizeFacadeEvaluationCost({
		accepted: true,
		imageReceipt: { actualUsd: 0.1 },
		grammarReceipt: { actualUsd: 0.2 },
		correctionReceipt: { actualUsd: 0.000001 },
	}), {
		currency: "USD", image_usd: 0.1, grammar_usd: 0.2, correction_usd: 0.000001,
		actual_total_usd: 0.300001, cost_per_accepted_result_usd: 0.300001,
	});
	assert.deepEqual(normalizeFacadeEvaluationCost({
		accepted: false, imageReceipt: { actualUsd: 0.1 }, grammarReceipt: { actualUsd: null },
	}), {
		currency: "USD", image_usd: 0.1, grammar_usd: null, correction_usd: null,
		actual_total_usd: null, cost_per_accepted_result_usd: null,
	});
	assert.throws(() => normalizeFacadeEvaluationCost({ accepted: true, imageReceipt: { actualUsd: -0 } }), /EVALUATION_COST_INVALID/);
});

test("selects technical quality first and applies exact practical-equivalence boundaries", () => {
	const technical = candidate("gpt-image-2", 95, 0.5);
	for (const row of [
		{ name: "exact margin and savings", other: candidate("qwen-image-2", 92, 0.3), expected: "qwen-image-2" },
		{ name: "outside margin", other: candidate("qwen-image-2", 91.9, 0.1), expected: "gpt-image-2" },
		{ name: "below savings", other: candidate("qwen-image-2", 94, 0.300001), expected: "gpt-image-2" },
		{ name: "missing cost", other: candidate("qwen-image-2", 94, null), expected: "gpt-image-2" },
		{ name: "failed hard gate", other: candidate("qwen-image-2", 99, 0.01, false), expected: "gpt-image-2" },
	]) {
		const result = selectFacadeRecommendation([row.other, technical]);
		assert.equal(result.technical_winner, "gpt-image-2", row.name);
		assert.equal(result.recommended_default, row.expected, row.name);
		assert.equal(result.quality_fallback, "gpt-image-2", row.name);
	}
});

test("handles no accepted candidates, deterministic ties, zero cost, and shuffled input", () => {
	assert.deepEqual(selectFacadeRecommendation([
		candidate("qwen-image-2", 99, 0.01, false),
	]), { status: "no-accepted-candidates", technical_winner: null, recommended_default: null, quality_fallback: null });

	const tied = [candidate("seedream-5-pro", 95, 0.5), candidate("gpt-image-2", 95, 0.5)];
	assert.equal(selectFacadeRecommendation(tied).technical_winner, "gpt-image-2");
	assert.equal(selectFacadeRecommendation([...tied].reverse()).technical_winner, "gpt-image-2");
	assert.equal(selectFacadeRecommendation([
		candidate("gpt-image-2", 95, 0.5), candidate("qwen-image-2", 94, 0),
	]).recommended_default, "qwen-image-2");
	assert.equal(selectFacadeRecommendation([
		candidate("gpt-image-2", 95, 0), candidate("qwen-image-2", 94, 0),
	]).recommended_default, "gpt-image-2");
});

test("builds a stable deeply frozen report from an explicit redacted allowlist", () => {
	const recommendation = selectFacadeRecommendation([
		candidate("gpt-image-2", 95, 0.5), candidate("qwen-image-2", 93, 0.2),
	]);
	const input = {
		candidateId: "creative-020", runId: "offline-001", recommendation,
		candidates: [{
			provider: "qwen-image-2", accepted: true, score: 93,
			cost: { ...candidate("x", 0, 0.2).cost, remoteId: "cost-secret", signed_url: "https://example.test/cost?token=secret" },
			diagnostics: { proposal_width: 1536, proposal_entropy: 7.2, remoteId: "raw-secret" },
			artifacts: { proposal: { path: "providers/qwen/proposal.png", sha256: "a".repeat(64), signedUrl: "https://example.test/file?token=secret" } },
		}],
	};
	const first = buildFacadeEvaluationReport(input);
	const second = buildFacadeEvaluationReport({ ...input, candidates: [...input.candidates].reverse() });
	assert.equal(JSON.stringify(first), JSON.stringify(second));
	assert.equal(Object.isFrozen(first), true);
	assert.equal(Object.isFrozen(first.providers), true);
	assert.deepEqual(first.providers["qwen-image-2"].artifacts.proposal, {
		path: "providers/qwen/proposal.png", sha256: "a".repeat(64),
	});
	const serialized = JSON.stringify(first);
	assert.equal(serialized.includes("raw-secret"), false);
	assert.equal(serialized.includes("cost-secret"), false);
	assert.equal(serialized.includes("token=secret"), false);
	assert.equal(first.technical_winner, "gpt-image-2");
	assert.equal(first.recommended_default, "qwen-image-2");
});
