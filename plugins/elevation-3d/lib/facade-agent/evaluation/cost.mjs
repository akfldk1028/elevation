const USD_SCALE = 1_000_000;

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

function actualMicros(receipt) {
	if (receipt === undefined || receipt === null || receipt.actualUsd === undefined || receipt.actualUsd === null) return null;
	const value = receipt.actualUsd;
	if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) throw new Error("EVALUATION_COST_INVALID");
	const micros = Math.round(value * USD_SCALE);
	if (!Number.isSafeInteger(micros) || Math.abs(micros / USD_SCALE - value) > Number.EPSILON) throw new Error("EVALUATION_COST_INVALID");
	return micros;
}

function usd(micros) {
	return micros === null ? null : micros / USD_SCALE;
}

export function normalizeFacadeEvaluationCost(input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("EVALUATION_COST_INVALID");
	const image = actualMicros(input.imageReceipt);
	const grammar = actualMicros(input.grammarReceipt);
	const correction = actualMicros(input.correctionReceipt);
	const complete = image !== null && grammar !== null && correction !== null;
	const total = complete ? image + grammar + correction : null;
	return deepFreeze({
		currency: "USD",
		image_usd: usd(image),
		grammar_usd: usd(grammar),
		correction_usd: usd(correction),
		actual_total_usd: usd(total),
		cost_per_accepted_result_usd: input.accepted === true ? usd(total) : null,
	});
}

