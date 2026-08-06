import { isIP } from "node:net";

import { decodeBoundedProviderImage } from "./image-codec.mjs";
import { FacadeImageBoundaryError } from "./response-boundary.mjs";
import { fetchWithProviderDeadline } from "./transport.mjs";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function fail(code, message) {
	throw new FacadeImageBoundaryError(code, message);
}

function publicIPv4(address) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && (b === 0 || b === 168)) return false;
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

function publicIPv6(address) {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff") || value.startsWith("2001:db8:")) return false;
	if (value.startsWith("::ffff:")) return publicIPv4(value.slice(7));
	return true;
}

function publicAddress(address) {
	const family = isIP(address.replace(/^\[|\]$/g, ""));
	return family === 4 ? publicIPv4(address) : family === 6 ? publicIPv6(address) : false;
}

function safeUrl(value, base) {
	let url;
	try { url = base ? new URL(value, base) : new URL(value); }
	catch { fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider download URL is invalid"); }
	if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider download URL must be credential-free HTTPS without a fragment");
	if (!url.hostname || url.port && url.port !== "443") fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider download URL uses an unsafe host or port");
	return url;
}

async function validateResolution(url, lookupImpl) {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname)) {
		if (!publicAddress(hostname)) fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider download URL resolves to a non-public address");
		return;
	}
	let addresses;
	try { addresses = await lookupImpl(hostname, { all: true, verbatim: true }); }
	catch { fail("PROVIDER_DOWNLOAD_DNS_FAILED", "Provider download hostname could not be resolved safely"); }
	if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !entry || !publicAddress(entry.address))) {
		fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider download hostname has a non-public address");
	}
}

async function readBoundedBytes(response, maxBytes) {
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) fail("PROVIDER_DOWNLOAD_TOO_LARGE", "Provider download exceeds the byte limit");
	const reader = response.body?.getReader();
	if (!reader) fail("PROVIDER_DOWNLOAD_INVALID", "Provider download body is missing");
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) fail("PROVIDER_DOWNLOAD_INVALID", "Provider download body is invalid");
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				fail("PROVIDER_DOWNLOAD_TOO_LARGE", "Provider download exceeds the byte limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks, total);
}

export async function downloadVerifiedProviderImage({
	url: initialUrl,
	fetchImpl,
	lookupImpl,
	signal,
	timeoutMs = 120_000,
	maxBytes = 32 * 1024 * 1024,
	maxRedirects = 3,
} = {}) {
	if (typeof fetchImpl !== "function" || typeof lookupImpl !== "function") throw new TypeError("fetchImpl and lookupImpl are required");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) throw new TypeError("Download bounds are invalid");
	let current = safeUrl(initialUrl);
	for (let redirectCount = 0; ; redirectCount += 1) {
		await validateResolution(current, lookupImpl);
		const response = await fetchWithProviderDeadline({
			fetchImpl,
			url: current.toString(),
			init: { method: "GET", headers: { accept: "image/png" }, redirect: "manual" },
			signal,
			timeoutMs,
			provider: "qwen-image-2",
			consume: async (response) => {
				if (REDIRECT_STATUS.has(response.status)) return { response, bytes: null };
				return { response, bytes: await readBoundedBytes(response, maxBytes) };
			},
		});
		if (REDIRECT_STATUS.has(response.response.status)) {
			if (redirectCount >= maxRedirects) fail("PROVIDER_DOWNLOAD_REDIRECT_LIMIT", "Provider download exceeded the redirect limit");
			const location = response.response.headers.get("location");
			if (!location) fail("PROVIDER_DOWNLOAD_URL_UNSAFE", "Provider redirect is missing a location");
			current = safeUrl(location, current);
			continue;
		}
		if (!response.response.ok) fail("PROVIDER_DOWNLOAD_FAILED", `Provider artifact download failed with HTTP ${response.response.status}`);
		const contentType = response.response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
		if (contentType && contentType !== "image/png") fail("PROVIDER_DOWNLOAD_INVALID", "Provider artifact download is not PNG");
		return decodeBoundedProviderImage({ bytes: response.bytes });
	}
}
