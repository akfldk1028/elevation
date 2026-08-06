const USD_SCALE = 1_000_000;
const SCORE_SCALE = 1_000;

function providerId(value) {
	return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : null;
}

function scaled(value, scale, maximum = Infinity) {
	if (!Number.isFinite(value) || value < 0 || value > maximum || Object.is(value, -0)) return null;
	const result = Math.round(value * scale);
	return Number.isSafeInteger(result) && Math.abs(result / scale - value) <= Number.EPSILON ? result : null;
}

function acceptedCandidate(value) {
	if (!value || typeof value !== "object" || value.accepted !== true) return null;
	const provider = providerId(value.provider);
	const score = scaled(value.score, SCORE_SCALE, 100);
	if (!provider || score === null) return null;
	const rawCost = value.cost?.actual_total_usd;
	const cost = rawCost === null || rawCost === undefined ? null : scaled(rawCost, USD_SCALE);
	if (rawCost !== null && rawCost !== undefined && cost === null) return null;
	return { provider, score, cost };
}

export function selectFacadeRecommendation(candidates, policy = {}) {
	if (!Array.isArray(candidates)) throw new Error("EVALUATION_CANDIDATES_INVALID");
	const scoreMargin = policy.scoreMargin ?? 3;
	const minimumSavingsRatio = policy.minimumSavingsRatio ?? 0.40;
	const margin = scaled(scoreMargin, SCORE_SCALE, 100);
	const savings = scaled(minimumSavingsRatio, USD_SCALE, 1);
	if (margin === null || savings === null) throw new Error("EVALUATION_POLICY_INVALID");
	const accepted = candidates.map(acceptedCandidate).filter(Boolean)
		.sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
	if (!accepted.length) return Object.freeze({ status: "no-accepted-candidates", technical_winner: null, recommended_default: null, quality_fallback: null });
	const technical = accepted[0];
	let recommended = technical;
	if (technical.cost !== null && technical.cost > 0) {
		const eligible = accepted.filter((candidate) => candidate.provider !== technical.provider
			&& candidate.cost !== null && candidate.cost < technical.cost
			&& technical.score - candidate.score <= margin
			&& (technical.cost - candidate.cost) * USD_SCALE >= technical.cost * savings)
			.sort((left, right) => left.cost - right.cost || right.score - left.score || left.provider.localeCompare(right.provider));
		if (eligible.length) [recommended] = eligible;
	}
	return Object.freeze({
		status: "recommended",
		technical_winner: technical.provider,
		recommended_default: recommended.provider,
		quality_fallback: technical.provider,
	});
}

