import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreFacadeCandidate, selectFacadeWinner } from "../plugins/elevation-3d/lib/facade-agent/score.mjs";

test("uses the provider-neutral 35/35/20/10 facade score", () => {
	const selected = selectFacadeWinner([
		{ provider: "gpt-image-2", accepted: true, metrics: { implementability: 90, multiview: 88, grammar: 85, visual: 75 } },
		{ provider: "nano-banana-pro", accepted: true, metrics: { implementability: 86, multiview: 84, grammar: 92, visual: 96 } },
	]);
	assert.equal(selected.provider, "gpt-image-2");
	assert.equal(selected.score, 86.8);
	assert.equal(selected.formula_version, "arr.elevation3d.facade-score.v1");
	assert.deepEqual(selected.components, { implementability: 90, multiview: 88, grammar: 85, visual: 75 });
});

test("gates rejected and malformed candidates before scoring", () => {
	assert.equal(selectFacadeWinner([{ provider: "gpt-image-2", accepted: false, metrics: {} }]).status, "no-winner");
	assert.equal(selectFacadeWinner([{ provider: "gpt-image-2", accepted: true, metrics: { implementability: NaN, multiview: 100, grammar: 100, visual: 100 } }]).status, "no-winner");
	assert.equal(scoreFacadeCandidate({
		provider: "gpt-image-2",
		validation: { accepted: false, metrics: {} },
		grammar: { confidence: 0.95 },
		visualMetrics: { verified: true, score: 100 },
	}).accepted, false);
	assert.equal(scoreFacadeCandidate({
		provider: "gpt-image-2",
		validation: { accepted: true, metrics: {
			canonical_surface_match: -1, opaque_wall_coverage: 1, minimum_reveal_depth_m: 0.2,
			corner_max_gap_m: 0, floor_alignment_max_error_m: 0, facade_orientation_coverage: 1,
		} },
		grammar: { system: "brick-punched-window-v1", reveal_depth_m: 0.2, confidence: 0.9 },
		visualMetrics: { verified: true, source: "local-render-analysis", score: 80 },
	}).accepted, false);
	const safe = selectFacadeWinner([{
		provider: "gpt-image-2", accepted: true,
		metrics: { implementability: 80, multiview: 80, grammar: 80, visual: 80, api_key: "sk-must-not-leak" },
	}]);
	assert.equal(JSON.stringify(safe).includes("sk-must-not-leak"), false);
});

test("returns provider-neutral human review for scores within tolerance in deterministic order", () => {
	const selected = selectFacadeWinner([
		{ provider: "z-provider", accepted: true, metrics: { implementability: 90, multiview: 90, grammar: 90, visual: 90 } },
		{ provider: "a-provider", accepted: true, metrics: { implementability: 90, multiview: 90, grammar: 90, visual: 86 } },
	], 0.5);
	assert.equal(selected.status, "human-review");
	assert.equal("provider" in selected, false);
	assert.deepEqual(selected.candidates.map((candidate: any) => candidate.provider), ["a-provider", "z-provider"]);
});

test("derives auditable components only from accepted local validation, typed grammar, and verified visuals", () => {
	const scored = scoreFacadeCandidate({
		provider: "gpt-image-2",
		validation: { accepted: true, metrics: {
			canonical_surface_match: 1,
			opaque_wall_coverage: 1,
			minimum_reveal_depth_m: 0.22,
			corner_max_gap_m: 0,
			floor_alignment_max_error_m: 0,
			facade_orientation_coverage: 1,
		} },
		grammar: { system: "brick-punched-window-v1", reveal_depth_m: 0.22, confidence: 0.85 },
		visualMetrics: { verified: true, score: 75, source: "local-render-analysis" },
	});
	assert.equal(scored.accepted, true);
	assert.deepEqual(scored.components, { implementability: 100, multiview: 100, grammar: 85, visual: 75 });
	assert.equal(scored.score, 94.5);
	assert.deepEqual(Object.keys(scored.explanation).sort(), ["component_basis", "formula"]);
	assert.equal(JSON.stringify(scored).includes("source"), false);
});
