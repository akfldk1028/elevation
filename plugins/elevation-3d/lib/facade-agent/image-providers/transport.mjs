import { FacadeProviderError } from "../provider.mjs";

function failure(code, message, options = {}) {
	return new FacadeProviderError(code, message, {
		provider: options.provider ?? "facade-image-provider",
		stage: "generate",
		definitiveNonSubmission: options.definitiveNonSubmission ?? false,
	});
}
function authenticSignal(signal) {
	if (signal === undefined) return undefined;
	try {
		if (Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new Error();
		Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get.call(signal);
		return signal;
	} catch {
		throw failure("PROVIDER_BOUNDARY_INVALID", "Provider signal must be an authentic AbortSignal", { definitiveNonSubmission: true });
	}
}

export async function fetchWithProviderDeadline({ fetchImpl, url, init = {}, signal: signalInput, timeoutMs, provider, consume } = {}) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
	if (typeof url !== "string" || !url) throw new TypeError("url must be a non-empty string");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");
	const signal = authenticSignal(signalInput);
	if (signal?.aborted) throw failure("PROVIDER_ABORTED", "Provider request was aborted before submission", { provider, definitiveNonSubmission: true });
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
	}, timeoutMs);
	try {
		const requestInit = { ...init, signal: controller.signal };
		if (`${requestInit.method ?? "GET"}`.toUpperCase() === "POST") requestInit.redirect = "error";
		const response = await fetchImpl(url, requestInit);
		const result = typeof consume === "function" ? await consume(response, controller.signal) : response;
		if (timedOut) throw failure("PROVIDER_TIMEOUT", "Provider request timed out", { provider });
		if (signal?.aborted) throw failure("PROVIDER_ABORTED", "Provider request was aborted", { provider });
		return result;
	} catch (error) {
		if (timedOut) throw failure("PROVIDER_TIMEOUT", "Provider request timed out", { provider });
		if (signal?.aborted) throw failure("PROVIDER_ABORTED", "Provider request was aborted", { provider });
		if (error instanceof FacadeProviderError) throw error;
		throw failure("PROVIDER_REQUEST_FAILED", "Provider transport failed", { provider });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
