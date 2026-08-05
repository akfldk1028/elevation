import { redactSecrets } from "../core.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

function safeIdentifier(value, fallback) {
	return typeof value === "string" && IDENTIFIER.test(value) ? value : fallback;
}

function safeStatus(value) {
	return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function knownRemoteId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function safeMessage(message, remoteId) {
	const redacted = redactSecrets(typeof message === "string" && message ? message : "Provider request failed");
	return knownRemoteId(remoteId) ? redacted.split(remoteId).join("[REDACTED_REMOTE_ID]") : redacted;
}

export class FacadeProviderError extends Error {
	constructor(code, message, {
		provider = "unknown-provider",
		stage = "unknown-stage",
		status = null,
		retryable = false,
		definitiveNonSubmission = false,
		remoteId = null,
	} = {}) {
		super(safeMessage(message, remoteId));
		this.name = "FacadeProviderError";
		this.code = typeof code === "string" && ERROR_CODE.test(code) ? code : "PROVIDER_REQUEST_FAILED";
		this.provider = safeIdentifier(provider, "unknown-provider");
		this.stage = safeIdentifier(stage, "unknown-stage");
		this.status = safeStatus(status);
		this.retryable = retryable === true;
		this.definitiveNonSubmission = definitiveNonSubmission === true && !knownRemoteId(remoteId);
	}
}

export function normalizeProviderFailure(error, provider, stage) {
	const status = safeStatus(error?.status ?? error?.response?.status);
	const aborted = error?.name === "AbortError" || error?.code === "ABORT_ERR";
	const code = error instanceof FacadeProviderError
		? error.code
		: aborted ? "PROVIDER_ABORTED" : "PROVIDER_REQUEST_FAILED";
	return new FacadeProviderError(code, error?.message, {
		provider: safeIdentifier(provider, error?.provider ?? "unknown-provider"),
		stage: safeIdentifier(stage, error?.stage ?? "unknown-stage"),
		status: status ?? error?.status,
		retryable: error instanceof FacadeProviderError ? error.retryable : status === 429 || (status !== null && status >= 500),
		definitiveNonSubmission: error instanceof FacadeProviderError && error.definitiveNonSubmission,
		remoteId: error?.remoteId,
	});
}
