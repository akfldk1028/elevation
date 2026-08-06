import { sha256, stableJson } from "../core.mjs";
import { readVerifiedFacadeValidationAuthority } from "../enrichment-validation.mjs";

const FORMULA_VERSION = "arr.elevation3d.facade-score.v1";
const WEIGHTS = Object.freeze({ implementability: 0.35, multiview: 0.35, grammar: 0.20, visual: 0.10 });
const SCORE_RESULTS = new WeakSet();

function rejected(provider, reason) {
	return Object.freeze({ status: "rejected", accepted: false, provider: typeof provider === "string" ? provider : "invalid-provider", reason, formula_version: FORMULA_VERSION });
}

function finiteNonnegative(value) {
	return Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function finiteScore(value) {
	return finiteNonnegative(value) && value <= 100;
}

function unitInterval(value) {
	return finiteNonnegative(value) && value <= 1;
}

function roundedScore(value) {
	return Math.round((value + Number.EPSILON) * 10) / 10;
}

function compareProvider(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

function scoreComponents({ grammar, metrics, visualScore }) {
	if (!metrics || !unitInterval(metrics.canonical_surface_match) || !unitInterval(metrics.opaque_wall_coverage)
		|| !finiteNonnegative(metrics.minimum_reveal_depth_m) || !finiteNonnegative(metrics.corner_max_gap_m)
		|| !finiteNonnegative(metrics.floor_alignment_max_error_m) || !unitInterval(metrics.facade_orientation_coverage)) {
		throw new Error("VALIDATION_METRICS_INVALID");
	}
	if (grammar?.system !== "brick-punched-window-v1" || !finiteNonnegative(grammar.reveal_depth_m) || grammar.reveal_depth_m === 0
		|| !unitInterval(grammar.confidence)) throw new Error("GRAMMAR_METRICS_INVALID");
	if (!finiteScore(visualScore)) throw new Error("VISUAL_METRICS_INVALID");
	const implementability = 100 * (metrics.canonical_surface_match + metrics.opaque_wall_coverage
		+ Math.min(1, metrics.minimum_reveal_depth_m / grammar.reveal_depth_m)) / 3;
	const cornerQuality = Math.max(0, 1 - metrics.corner_max_gap_m / 0.00001);
	const floorQuality = Math.max(0, 1 - metrics.floor_alignment_max_error_m / 0.00001);
	return {
		implementability: roundedScore(implementability),
		multiview: roundedScore(100 * (metrics.facade_orientation_coverage + cornerQuality + floorQuality) / 3),
		grammar: roundedScore(grammar.confidence * 100), visual: roundedScore(visualScore),
	};
}

export async function scoreFacadeCandidate({ provider, validation } = {}) {
	try {
		if (typeof provider !== "string" || !provider.trim()) throw new Error("PROVIDER_INVALID");
		const verified = readVerifiedFacadeValidationAuthority(validation);
		if (!verified) throw new Error("VALIDATION_AUTHORITY_REQUIRED");
		if (provider !== verified.provider) throw new Error("PROVIDER_BINDING_MISMATCH");
		const components = scoreComponents(verified);
		const score = roundedScore(Object.entries(WEIGHTS).reduce((sum, [name, weight]) => sum + components[name] * weight, 0));
		if (!finiteScore(score)) throw new Error("SCORE_INVALID");
		const breakdown = {
			formula_version: FORMULA_VERSION,
			formula: "0.35*implementability + 0.35*multiview + 0.20*grammar + 0.10*visual",
			provider, candidate_id: verified.candidateId, bindings: verified.bindings, components, score,
		};
		const serialized = stableJson(breakdown);
		const result = deepFreeze({
			status: "scored", accepted: true, provider, score, components, formula_version: FORMULA_VERSION,
			breakdown, serialized, sha256: sha256(serialized),
		});
		SCORE_RESULTS.add(result);
		return result;
	} catch (error) {
		return rejected(provider, error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ARTIFACT_VERIFICATION_FAILED");
	}
}

export function rehydrateFacadeScoreResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "scored" || value.accepted !== true
		|| value.formula_version !== FORMULA_VERSION || !value.breakdown || value.breakdown.formula_version !== FORMULA_VERSION
		|| value.provider !== value.breakdown.provider || value.score !== value.breakdown.score
		|| value.serialized !== stableJson(value.breakdown) || value.sha256 !== sha256(value.serialized)) {
		throw new Error("SCORE_REHYDRATION_INVALID");
	}
	deepFreeze(value);
	SCORE_RESULTS.add(value);
	return value;
}

export function selectFacadeWinner(candidates, tolerance = 0.5) {
	if (!Array.isArray(candidates) || !finiteNonnegative(tolerance)) return { status: "no-winner", candidates: [] };
	const scored = candidates.filter((candidate) => SCORE_RESULTS.has(candidate) && candidate.accepted === true)
		.sort((left, right) => right.score - left.score || compareProvider(left.provider, right.provider));
	if (!scored.length) return { status: "no-winner", candidates: [] };
	const review = scored.filter((candidate) => scored[0].score - candidate.score <= tolerance);
	if (review.length > 1) {
		if (review.every((candidate) => candidate.score === review[0].score)) review.sort((left, right) => compareProvider(left.provider, right.provider));
		return { status: "human-review", candidates: review, tolerance, formula_version: FORMULA_VERSION };
	}
	return { status: "winner", provider: scored[0].provider, score: scored[0].score, candidate: scored[0], formula_version: FORMULA_VERSION };
}

export { selectFacadeRecommendation } from "./evaluation/scorecard.mjs";
