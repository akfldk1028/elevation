import { resolve } from "node:path";
import { redactSecrets, sha256, stableJson } from "../core.mjs";
import { assertSafePathSegment } from "../run-memory.mjs";

export const FACADE_AGENT_PROVIDERS = Object.freeze(["gpt-image-2", "nano-banana-pro"]);
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

export function normalizeFacadeAgentConfig(input) {
	const candidateId = safePathSegment(input?.candidateId, "candidate_id");
	const runId = safePathSegment(input?.runId, "run_id");
	if (candidateId !== "creative-020") throw new FacadeAgentContractError("CANDIDATE_NOT_APPROVED", "First comparison requires creative-020");
	if (input.briefId !== "brick-punched-window-v1") throw new FacadeAgentContractError("BRIEF_NOT_APPROVED", "First comparison requires brick-punched-window-v1");
	if (input.grammarModel !== "gpt-5.6") throw new FacadeAgentContractError("GRAMMAR_MODEL_INVALID", "First comparison requires gpt-5.6 grammar extraction");
	if (input.maxLocalAttempts !== undefined && input.maxLocalAttempts !== 2) throw new FacadeAgentContractError("LOCAL_ATTEMPT_LIMIT_INVALID", "Exactly two local attempts are allowed");
	const providers = [...(input.providers ?? FACADE_AGENT_PROVIDERS)];
	if (providers.join("|") !== FACADE_AGENT_PROVIDERS.join("|")) throw new FacadeAgentContractError("PROVIDER_SET_INVALID", "Controlled comparison requires both providers in fixed order");
	const imageBudgetUsd = Object.fromEntries(providers.map((provider) => [
		provider,
		finiteNonnegative(input.imageBudgetUsd?.[provider], `imageBudgetUsd.${provider}`),
	]));
	const grammarBudgetUsd = finiteNonnegative(input.grammarBudgetUsd, "grammarBudgetUsd");
	return deepFreeze(redactSecrets({
		...input,
		candidateId,
		runId,
		datasetRoot: resolveRoot(input.datasetRoot, "datasetRoot"),
		outputRoot: resolveRoot(input.outputRoot, "outputRoot"),
		providers,
		imageBudgetUsd,
		grammarBudgetUsd,
		maxLocalAttempts: 2,
		maxImageSubmissionsPerProvider: 1,
		confirmLive: input.confirmLive === true,
	}));
}

export function facadeRequestFingerprint(input) {
	return sha256(stableJson(input));
}
