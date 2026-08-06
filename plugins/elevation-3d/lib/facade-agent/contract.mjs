import { resolve } from "node:path";
import { redactSecrets, sha256, stableJson } from "../core.mjs";
import { assertSafePathSegment } from "../run-memory.mjs";

export const FACADE_AGENT_PROVIDER_IDS = Object.freeze(["gpt-image-2", "seedream-5-pro", "qwen-image-2", "nano-banana-pro"]);
export const FACADE_AGENT_PROVIDERS = Object.freeze(["gpt-image-2", "seedream-5-pro", "qwen-image-2"]);
export const FACADE_AGENT_STAGES = Object.freeze(["preflight", "evidence", "generate", "grammar", "build", "validate", "compare"]);

export class FacadeAgentContractError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "FacadeAgentContractError";
		this.code = code;
	}
}

function safePathSegment(value, label) {
	try {
		return assertSafePathSegment(value, label);
	} catch {
		throw new FacadeAgentContractError("PATH_SEGMENT_INVALID", `${label} must be a safe path segment`);
	}
}

function finiteNonnegative(value, label) {
	if (!Number.isFinite(value) || value < 0) {
		throw new FacadeAgentContractError("BUDGET_INVALID", `${label} must be a finite nonnegative number`);
	}
	return value;
}

function finitePositive(value, label) {
	finiteNonnegative(value, label);
	if (value === 0) throw new FacadeAgentContractError("BUDGET_INVALID", `${label} must be positive for a selected provider`);
	return value;
}

function exactUsdMicros(value, label) {
	finiteNonnegative(value, label);
	const micros = Math.round(value * 1_000_000);
	if (!Number.isSafeInteger(micros) || Math.abs(micros / 1_000_000 - value) > Number.EPSILON) throw new FacadeAgentContractError("BUDGET_INVALID", `${label} must use at most six decimal places`);
	return micros;
}

function resolveRoot(value, label) {
	if (typeof value !== "string" || !value) {
		throw new FacadeAgentContractError("ROOT_INVALID", `${label} is required`);
	}
	const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(value);
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !isWindowsDrivePath) throw new FacadeAgentContractError("ROOT_INVALID", `${label} is required`);
	return resolve(value);
}

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

function deterministicAllocation(total, providers) {
	let assigned = 0;
	return Object.fromEntries(providers.map((provider, index) => {
		const value = index === providers.length - 1 ? total - assigned : total / providers.length;
		assigned += value;
		return [provider, value];
	}));
}

export function normalizeFacadeAgentConfig(input) {
	const candidateId = safePathSegment(input?.candidateId, "candidate_id");
	const runId = safePathSegment(input?.runId, "run_id");
	if (candidateId !== "creative-020") throw new FacadeAgentContractError("CANDIDATE_NOT_APPROVED", "First comparison requires creative-020");
	if (input.briefId !== "brick-punched-window-v1") throw new FacadeAgentContractError("BRIEF_NOT_APPROVED", "First comparison requires brick-punched-window-v1");
	if (input.grammarModel !== "gpt-5.6") throw new FacadeAgentContractError("GRAMMAR_MODEL_INVALID", "First comparison requires gpt-5.6 grammar extraction");
	if (input.maxLocalAttempts !== undefined && input.maxLocalAttempts !== 2) throw new FacadeAgentContractError("LOCAL_ATTEMPT_LIMIT_INVALID", "Exactly two local attempts are allowed");
	const providers = [...(input.providers ?? FACADE_AGENT_PROVIDERS)];
	if (providers.length === 0 || providers.some((provider) => !FACADE_AGENT_PROVIDER_IDS.includes(provider)) || new Set(providers).size !== providers.length) {
		throw new FacadeAgentContractError("PROVIDER_SET_INVALID", "Provider selection must be a unique non-empty allowlisted subset");
	}
	for (const [provider, value] of Object.entries(input.imageBudgetUsd ?? {})) {
		if (!FACADE_AGENT_PROVIDER_IDS.includes(provider)) throw new FacadeAgentContractError("PROVIDER_SET_INVALID", "Image budget contains an unknown provider");
		finiteNonnegative(value, `imageBudgetUsd.${provider}`);
		if (!providers.includes(provider) && value !== 0) throw new FacadeAgentContractError("BUDGET_INVALID", `Unselected provider budget must be absent or zero: ${provider}`);
	}
	const imageBudgetUsd = Object.fromEntries(providers.map((provider) => [
		provider,
		finitePositive(input.imageBudgetUsd?.[provider], `imageBudgetUsd.${provider}`),
	]));
	const grammarBudgetUsd = finiteNonnegative(input.grammarBudgetUsd, "grammarBudgetUsd");
	const grammarEstimateUsd = finiteNonnegative(input.grammarEstimateUsd ?? grammarBudgetUsd, "grammarEstimateUsd");
	if (grammarEstimateUsd > grammarBudgetUsd) throw new FacadeAgentContractError("BUDGET_INVALID", "grammarEstimateUsd cannot exceed the run-wide grammarBudgetUsd");
	const grammarBudgetAllocationUsd = deterministicAllocation(grammarBudgetUsd, providers);
	const grammarEstimateAllocationUsd = deterministicAllocation(grammarEstimateUsd, providers);
	const imageEstimateUsd = Object.fromEntries(providers.map((provider) => {
		const estimate = finiteNonnegative(input.imageEstimateUsd?.[provider] ?? imageBudgetUsd[provider], `imageEstimateUsd.${provider}`);
		if (estimate > imageBudgetUsd[provider]) throw new FacadeAgentContractError("BUDGET_INVALID", `imageEstimateUsd.${provider} cannot exceed its image budget`);
		return [provider, estimate];
	}));
	for (const [provider, value] of Object.entries(input.imageEstimateUsd ?? {})) {
		if (!FACADE_AGENT_PROVIDER_IDS.includes(provider)) throw new FacadeAgentContractError("PROVIDER_SET_INVALID", "Image estimate contains an unknown provider");
		finiteNonnegative(value, `imageEstimateUsd.${provider}`);
		if (!providers.includes(provider) && value !== 0) throw new FacadeAgentContractError("BUDGET_INVALID", `Unselected provider estimate must be absent or zero: ${provider}`);
	}
	const runBudgetMicros = Object.values(imageBudgetUsd).reduce((sum, value, index) => sum + exactUsdMicros(value, `imageBudgetUsd.${providers[index]}`), 0)
		+ exactUsdMicros(grammarBudgetUsd, "grammarBudgetUsd");
	const runEstimateMicros = Object.values(imageEstimateUsd).reduce((sum, value, index) => sum + exactUsdMicros(value, `imageEstimateUsd.${providers[index]}`), 0)
		+ exactUsdMicros(grammarEstimateUsd, "grammarEstimateUsd");
	const runBudgetUsd = runBudgetMicros / 1_000_000;
	const runEstimateUsd = runEstimateMicros / 1_000_000;
	const confirmLive = input.confirmLive === true;
	const confirmedTotalUsd = input.confirmedTotalUsd;
	if (confirmLive && exactUsdMicros(confirmedTotalUsd, "confirmedTotalUsd") !== runBudgetMicros) throw new FacadeAgentContractError("LIVE_COST_CONFIRMATION_INVALID", "Live cost confirmation must exactly equal all selected ceilings");
	if (!confirmLive && confirmedTotalUsd !== undefined) throw new FacadeAgentContractError("LIVE_COST_CONFIRMATION_INVALID", "Cost confirmation requires live execution");
	return deepFreeze(redactSecrets({
		...input,
		candidateId,
		runId,
		datasetRoot: resolveRoot(input.datasetRoot, "datasetRoot"),
		outputRoot: resolveRoot(input.outputRoot, "outputRoot"),
		providers,
		imageBudgetUsd,
		imageEstimateUsd,
		grammarBudgetUsd,
		grammarEstimateUsd,
		grammarBudgetAllocationUsd,
		grammarEstimateAllocationUsd,
		runBudgetUsd,
		runEstimateUsd,
		maxLocalAttempts: 2,
		maxImageSubmissionsPerProvider: 1,
		confirmLive,
		...(confirmLive ? { confirmedTotalUsd } : {}),
	}));
}

export function facadeRequestFingerprint(input) {
	return sha256(stableJson(input));
}
