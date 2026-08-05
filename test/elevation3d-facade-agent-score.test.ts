import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { scoreFacadeCandidate, selectFacadeWinner } from "../plugins/elevation-3d/lib/facade-agent/score.mjs";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const baseGrammar = {
	system: "brick-punched-window-v1", reveal_depth_m: 0.22, confidence: 0.85,
};
const baseValidation = {
	canonical_surface_match: 1, opaque_wall_coverage: 0.8, minimum_reveal_depth_m: 0.22,
	corner_max_gap_m: 0, floor_alignment_max_error_m: 0, facade_orientation_coverage: 1,
};

async function writeCanonical(path: string, value: any) {
	const bytes = Buffer.from(stableJson(value));
	await writeFile(path, bytes);
	return { path, sha256: sha256(bytes) };
}

async function persistedCandidate({
	provider = "gpt-image-2", candidateId = "candidate-gpt", validation = baseValidation,
	grammar = baseGrammar, visual = 75,
}: { provider?: string; candidateId?: string; validation?: any; grammar?: any; visual?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "facade-score-artifacts-"));
	roots.push(root);
	const glb = await writeCanonical(join(root, "facade.glb"), { exact_mass: candidateId, persisted: true });
	const evidence = await writeCanonical(join(root, "evidence.json"), { candidate_id: candidateId, immutable: true });
	const cameras = await writeCanonical(join(root, "cameras.json"), { candidate_id: candidateId, views: ["front", "right", "back", "left"] });
	const proposal = await writeCanonical(join(root, "proposal.png"), { candidate_id: candidateId, provider, pixels: "fixture" });
	const grammarSha256 = sha256(stableJson(grammar));
	const binding = {
		provider, candidate_id: candidateId, glb_sha256: glb.sha256, evidence_sha256: evidence.sha256,
		cameras_sha256: cameras.sha256, proposal_sha256: proposal.sha256, grammar_sha256: grammarSha256,
	};
	const proposalReport = await writeCanonical(join(root, "proposal-report.json"), {
		schema_version: "arr.elevation3d.facade-proposal-report.v1", accepted: true, ...binding,
	});
	const grammarReport = await writeCanonical(join(root, "grammar-report.json"), {
		schema_version: "arr.elevation3d.facade-grammar-report.v1", grammar, ...binding,
	});
	const validationReport = await writeCanonical(join(root, "validation-report.json"), {
		schema_version: "arr.elevation3d.facade-validation-report.v1", accepted: true, codes: [], metrics: validation, ...binding,
	});
	const renderReport = await writeCanonical(join(root, "render-report.json"), {
		schema_version: "arr.elevation3d.facade-render-report.v1", visual_metrics: { score: visual }, ...binding,
	});
	return {
		root,
		input: { provider, artifacts: { glb, evidence, cameras, proposal, proposalReport, grammarReport, validationReport, renderReport } },
	};
}

test("scores only canonical persisted reports bound to the exact GLB, grammar, evidence, cameras, and proposal", async () => {
	const fixture = await persistedCandidate();
	const scored = await scoreFacadeCandidate(fixture.input);
	assert.equal(scored.accepted, true);
	assert.deepEqual(scored.components, { implementability: 93.3, multiview: 100, grammar: 85, visual: 75 });
	assert.equal(scored.score, 92.2);
	assert.equal(scored.formula_version, "arr.elevation3d.facade-score.v1");
	assert.equal(scored.serialized, stableJson(scored.breakdown));
	assert.equal(scored.sha256, sha256(scored.serialized));
	assert.equal(JSON.stringify(scored).includes(fixture.root), false);
});

test("rejects hash and cross-report binding mismatches before producing components", async () => {
	const changedGlb = await persistedCandidate();
	await writeFile(changedGlb.input.artifacts.glb.path, "changed persisted GLB");
	const glbRejected = await scoreFacadeCandidate(changedGlb.input);
	assert.equal(glbRejected.accepted, false);
	assert.equal("components" in glbRejected, false);
	assert.equal("serialized" in glbRejected, false);

	const mismatch = await persistedCandidate();
	const report = JSON.parse(await readFile(mismatch.input.artifacts.renderReport.path, "utf8"));
	report.proposal_sha256 = "f".repeat(64);
	mismatch.input.artifacts.renderReport = await writeCanonical(mismatch.input.artifacts.renderReport.path, report);
	const bindingRejected = await scoreFacadeCandidate(mismatch.input);
	assert.equal(bindingRejected.accepted, false);
	assert.equal("components" in bindingRejected, false);
});

test("rejects naked candidates and copied or forged score results", async () => {
	assert.equal(selectFacadeWinner([
		{ provider: "gpt-image-2", accepted: true, metrics: { implementability: 100, multiview: 100, grammar: 100, visual: 100 } },
	]).status, "no-winner");
	const fixture = await persistedCandidate();
	const scored = await scoreFacadeCandidate(fixture.input);
	assert.equal(selectFacadeWinner([{ ...scored }]).status, "no-winner");
	assert.equal(selectFacadeWinner([JSON.parse(JSON.stringify(scored))]).status, "no-winner");
	assert.equal(selectFacadeWinner([scored]).provider, "gpt-image-2");
});

test("selects by exact 35/35/20/10 score and returns provider-neutral review within tolerance", async () => {
	const gpt = await persistedCandidate({
		provider: "gpt-image-2", candidateId: "gpt", grammar: { ...baseGrammar, confidence: 0.85 }, visual: 75,
		validation: { ...baseValidation, opaque_wall_coverage: 0.7, minimum_reveal_depth_m: 0.198, facade_orientation_coverage: 0.94 },
	});
	const nano = await persistedCandidate({
		provider: "nano-banana-pro", candidateId: "nano", grammar: { ...baseGrammar, confidence: 0.92 }, visual: 96,
		validation: { ...baseValidation, opaque_wall_coverage: 0.62, minimum_reveal_depth_m: 0.1892, facade_orientation_coverage: 0.9 },
	});
	const selected = selectFacadeWinner([await scoreFacadeCandidate(gpt.input), await scoreFacadeCandidate(nano.input)]);
	assert.equal(selected.provider, "nano-banana-pro");
	assert.equal(selected.status, "winner");

	const a = await persistedCandidate({ provider: "z-provider", candidateId: "z", visual: 80 });
	const b = await persistedCandidate({ provider: "a-provider", candidateId: "a", visual: 76 });
	const tied = selectFacadeWinner([await scoreFacadeCandidate(a.input), await scoreFacadeCandidate(b.input)], 0.5);
	assert.equal(tied.status, "human-review");
	assert.equal("provider" in tied, false);
	assert.deepEqual(tied.candidates.map((candidate: any) => candidate.provider), ["z-provider", "a-provider"]);

	const exactA = await persistedCandidate({ provider: "z-provider", candidateId: "exact-z", visual: 80 });
	const exactB = await persistedCandidate({ provider: "a-provider", candidateId: "exact-a", visual: 80 });
	const exact = selectFacadeWinner([await scoreFacadeCandidate(exactA.input), await scoreFacadeCandidate(exactB.input)], 0);
	assert.deepEqual(exact.candidates.map((candidate: any) => candidate.provider), ["a-provider", "z-provider"]);
});

test("rejects negative zero persisted metrics and tolerance", async () => {
	const fixture = await persistedCandidate();
	const report = JSON.parse(await readFile(fixture.input.artifacts.validationReport.path, "utf8"));
	const raw = stableJson(report).replace('"corner_max_gap_m":0', '"corner_max_gap_m":-0');
	await writeFile(fixture.input.artifacts.validationReport.path, raw);
	fixture.input.artifacts.validationReport.sha256 = sha256(raw);
	const rejected = await scoreFacadeCandidate(fixture.input);
	assert.equal(rejected.accepted, false);
	const valid = await persistedCandidate({ candidateId: "valid-negative-zero-check" });
	const scored = await scoreFacadeCandidate(valid.input);
	assert.equal(selectFacadeWinner([scored], -0).status, "no-winner");
});
