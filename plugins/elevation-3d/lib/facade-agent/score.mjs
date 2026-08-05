const FORMULA_VERSION = "arr.elevation3d.facade-score.v1";
const WEIGHTS = Object.freeze({ implementability: 0.35, multiview: 0.35, grammar: 0.20, visual: 0.10 });

function compareProvider(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function finiteScore(value) {
	return Number.isFinite(value) && value >= 0 && value <= 100;
}

function roundedScore(value) {
	return Math.round((value + Number.EPSILON) * 10) / 10;
}

function weighted(components) {
	if (!components || Object.keys(WEIGHTS).some((name) => !finiteScore(components[name]))) return null;
	return roundedScore(Object.entries(WEIGHTS).reduce((sum, [name, weight]) => sum + components[name] * weight, 0));
}

function rejected(provider, reason) {
	return { status: "rejected", accepted: false, provider, reason, formula_version: FORMULA_VERSION };
}

export function scoreFacadeCandidate({ provider, validation, grammar, visualMetrics }) {
	if (typeof provider !== "string" || !provider.trim()) return rejected("invalid-provider", "PROVIDER_INVALID");
	if (validation?.accepted !== true) return rejected(provider, "VALIDATION_REJECTED");
	const metrics = validation.metrics;
	const required = [
		metrics?.canonical_surface_match, metrics?.opaque_wall_coverage, metrics?.minimum_reveal_depth_m,
		metrics?.corner_max_gap_m, metrics?.floor_alignment_max_error_m, metrics?.facade_orientation_coverage,
	];
	if (required.some((value) => !Number.isFinite(value))) return rejected(provider, "VALIDATION_METRICS_INVALID");
	if ([metrics.canonical_surface_match, metrics.opaque_wall_coverage, metrics.facade_orientation_coverage]
		.some((value) => value < 0 || value > 1)
		|| [metrics.minimum_reveal_depth_m, metrics.corner_max_gap_m, metrics.floor_alignment_max_error_m]
		.some((value) => value < 0)) return rejected(provider, "VALIDATION_METRICS_INVALID");
	if (grammar?.system !== "brick-punched-window-v1" || !Number.isFinite(grammar.reveal_depth_m)
		|| grammar.reveal_depth_m <= 0 || !Number.isFinite(grammar.confidence) || grammar.confidence < 0 || grammar.confidence > 1) {
		return rejected(provider, "GRAMMAR_METRICS_INVALID");
	}
	if (visualMetrics?.verified !== true || visualMetrics?.source !== "local-render-analysis" || !finiteScore(visualMetrics.score)) {
		return rejected(provider, "VISUAL_METRICS_UNVERIFIED");
	}
	const implementability = 100 * (
		metrics.canonical_surface_match
		+ metrics.opaque_wall_coverage
		+ Math.min(1, Math.max(0, metrics.minimum_reveal_depth_m / grammar.reveal_depth_m))
	) / 3;
	const cornerQuality = Math.max(0, 1 - metrics.corner_max_gap_m / 0.00001);
	const floorQuality = Math.max(0, 1 - metrics.floor_alignment_max_error_m / 0.00001);
	const multiview = 100 * (metrics.facade_orientation_coverage + cornerQuality + floorQuality) / 3;
	const components = {
		implementability: roundedScore(implementability),
		multiview: roundedScore(multiview),
		grammar: roundedScore(grammar.confidence * 100),
		visual: roundedScore(visualMetrics.score),
	};
	const score = weighted(components);
	if (score === null) return rejected(provider, "SCORE_COMPONENT_INVALID");
	return {
		status: "scored", accepted: true, provider, score, components, formula_version: FORMULA_VERSION,
		explanation: {
			formula: "0.35*implementability + 0.35*multiview + 0.20*grammar + 0.10*visual",
			component_basis: {
				implementability: "canonical surface, opaque-wall coverage, and persisted reveal depth",
				multiview: "canonical orientation coverage, corner gap, and floor alignment",
				grammar: "validated typed-grammar confidence",
				visual: "verified local render-analysis score",
			},
		},
	};
}

function normalizedCandidate(candidate) {
	if (candidate?.accepted !== true || typeof candidate.provider !== "string" || !candidate.provider.trim()) return null;
	const score = weighted(candidate.metrics);
	if (score === null) return null;
	const components = Object.fromEntries(Object.keys(WEIGHTS).map((name) => [name, candidate.metrics[name]]));
	return {
		status: "scored", accepted: true, provider: candidate.provider, score,
		components, formula_version: FORMULA_VERSION,
		geometry_score: roundedScore(0.35 * candidate.metrics.implementability + 0.35 * candidate.metrics.multiview),
		explanation: { formula: "0.35*implementability + 0.35*multiview + 0.20*grammar + 0.10*visual" },
	};
}

export function selectFacadeWinner(candidates, tolerance = 0.5) {
	if (!Array.isArray(candidates) || !Number.isFinite(tolerance) || tolerance < 0) return { status: "no-winner", candidates: [] };
	const scored = candidates.map(normalizedCandidate).filter(Boolean).sort((left, right) => (
		right.geometry_score - left.geometry_score || right.score - left.score || compareProvider(left.provider, right.provider)
	));
	if (!scored.length) return { status: "no-winner", candidates: [] };
	const geometryPeers = scored.filter((candidate) => scored[0].geometry_score - candidate.geometry_score <= tolerance);
	const bestPeerScore = Math.max(...geometryPeers.map((candidate) => candidate.score));
	const review = geometryPeers.filter((candidate) => bestPeerScore - candidate.score <= tolerance)
		.sort((left, right) => compareProvider(left.provider, right.provider));
	if (review.length > 1) return { status: "human-review", candidates: review, tolerance, formula_version: FORMULA_VERSION };
	return { ...review[0], status: "winner" };
}
