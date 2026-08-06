const HASH = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]+$/;
const DIAGNOSTIC_FIELDS = Object.freeze([
	"proposal_width", "proposal_height", "proposal_entropy", "prompt_sha256", "evidence_sha256",
	"local_correction_count", "provider_latency_ms", "human_review_notes",
]);
const COST_FIELDS = Object.freeze([
	"image_usd", "grammar_usd", "correction_usd", "actual_total_usd", "cost_per_accepted_result_usd",
]);

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}

function safeArtifact(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const output = {};
	if (typeof value.path === "string" && SAFE_PATH.test(value.path)) output.path = value.path.replaceAll("\\", "/");
	if (typeof value.sha256 === "string" && HASH.test(value.sha256)) output.sha256 = value.sha256;
	if (Number.isInteger(value.width) && value.width > 0) output.width = value.width;
	if (Number.isInteger(value.height) && value.height > 0) output.height = value.height;
	return Object.keys(output).length ? output : undefined;
}

function safeArtifacts(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const output = {};
	for (const key of Object.keys(value).sort()) {
		if (!/^[a-z0-9_-]+$/.test(key)) continue;
		if (Array.isArray(value[key])) {
			output[key] = value[key].map(safeArtifact).filter(Boolean);
		} else {
			const artifact = safeArtifact(value[key]);
			if (artifact) output[key] = artifact;
		}
	}
	return output;
}

function safeDiagnostics(value) {
	const output = {};
	for (const key of DIAGNOSTIC_FIELDS) {
		const item = value?.[key];
		if (typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = item;
		else if (key === "human_review_notes" && typeof item === "string" && !/https?:|token|secret|authorization/i.test(item)) output[key] = item.slice(0, 2_000);
		else if (typeof item === "string" && HASH.test(item)) output[key] = item;
	}
	return output;
}

function safeCost(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.currency !== "USD") return null;
	const output = { currency: "USD" };
	for (const key of COST_FIELDS) {
		const item = value[key];
		if (item === null) output[key] = null;
		else if (Number.isFinite(item) && item >= 0 && !Object.is(item, -0)) output[key] = item;
	}
	return output;
}

export function buildFacadeEvaluationReport(input = {}) {
	if (!input || typeof input !== "object" || !input.recommendation || !Array.isArray(input.candidates)) throw new Error("EVALUATION_REPORT_INVALID");
	const providers = {};
	for (const item of [...input.candidates].sort((left, right) => String(left.provider).localeCompare(String(right.provider)))) {
		if (typeof item.provider !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.provider)) throw new Error("EVALUATION_REPORT_INVALID");
		providers[item.provider] = {
			status: item.accepted === true ? "accepted" : "rejected",
			...(Number.isFinite(item.score) ? { score: item.score } : {}),
			cost: safeCost(item.cost),
			diagnostics: safeDiagnostics(item.diagnostics),
			artifacts: safeArtifacts(item.artifacts),
		};
	}
	return deepFreeze({
		schema_version: "arr.elevation3d.facade-evaluation.v1",
		candidate_id: input.candidateId,
		run_id: input.runId,
		technical_winner: input.recommendation.technical_winner,
		recommended_default: input.recommendation.recommended_default,
		quality_fallback: input.recommendation.quality_fallback,
		providers,
	});
}
