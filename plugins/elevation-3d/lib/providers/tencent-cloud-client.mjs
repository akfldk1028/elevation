import { createHash, createHmac } from "node:crypto";

const CONTENT_TYPE = "application/json; charset=utf-8";
const PRODUCTION_ENDPOINT = "https://ai3d.tencentcloudapi.com";
const ALLOWED_ACTIONS = new Set(["SubmitTextureTo3DJob", "DescribeTextureTo3DJob"]);

function sha256Hex(value) {
	return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value) {
	return createHmac("sha256", key).update(value).digest();
}

export function createTc3Authorization({ secretId, secretKey, service, host, timestamp, payload }) {
	const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${host}\n`;
	const signedHeaders = "content-type;host";
	const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(payload)].join("\n");
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
	const credentialScope = `${date}/${service}/tc3_request`;
	const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
	const secretDate = hmacSha256(`TC3${secretKey}`, date);
	const secretService = hmacSha256(secretDate, service);
	const secretSigning = hmacSha256(secretService, "tc3_request");
	const signature = hmacSha256(secretSigning, stringToSign).toString("hex");
	return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function parseEndpoint(endpoint) {
	const url = new URL(endpoint);
	const isProduction = url.origin === PRODUCTION_ENDPOINT;
	const isLoopback = ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((!isProduction && !isLoopback) || url.username || url.password || url.search || url.hash) {
		throw new Error("Tencent Cloud endpoint is not allowed");
	}
	url.pathname = "/";
	return url;
}

function sanitizedMetadata(value, sensitiveValues) {
	if (typeof value !== "string" && typeof value !== "number") return "";
	let sanitized = String(value).slice(0, 128);
	for (const sensitive of sensitiveValues) {
		if (typeof sensitive === "string" && sensitive.length > 0) sanitized = sanitized.replaceAll(sensitive, "[REDACTED]");
	}
	return sanitized.replace(/[^A-Za-z0-9_.:\/[\]-]/g, "_");
}

function requestFailure(error, signal) {
	if (error?.name === "AbortError") {
		return new Error(signal.aborted ? "Tencent Cloud request timed out" : "Tencent Cloud request aborted");
	}
	return new Error("Tencent Cloud network request failed");
}

export function createTencentCloudJsonClient({
	secretId,
	secretKey,
	region,
	endpoint = PRODUCTION_ENDPOINT,
	version,
	service,
	fetchImpl = globalThis.fetch,
	now = () => new Date(),
	timeoutMs = 60_000,
}) {
	const url = parseEndpoint(endpoint);
	return {
		async call(action, request) {
			if (!ALLOWED_ACTIONS.has(action)) throw new Error("Tencent Cloud action is not allowed");
			const payload = JSON.stringify(request);
			const timestamp = Math.floor(new Date(now()).getTime() / 1000);
			const authorization = createTc3Authorization({ secretId, secretKey, service, host: url.host, timestamp, payload });
			const sensitiveValues = [secretId, secretKey, payload, authorization];
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				let response;
				try {
					response = await fetchImpl(url.href, {
						method: "POST",
						headers: {
							Authorization: authorization,
							"Content-Type": CONTENT_TYPE,
							Host: url.host,
							"X-TC-Action": action,
							"X-TC-Region": region,
							"X-TC-Timestamp": String(timestamp),
							"X-TC-Version": version,
						},
						body: payload,
						signal: controller.signal,
					});
				} catch (error) {
					throw requestFailure(error, controller.signal);
				}
				if (!response.ok) throw new Error(`Tencent Cloud HTTP error: ${response.status}`);
				let body;
				try {
					body = await response.json();
				} catch (error) {
					if (error?.name === "AbortError") throw requestFailure(error, controller.signal);
					throw new Error("Tencent Cloud response was not valid JSON");
				}
				if (!body || typeof body !== "object" || !body.Response || typeof body.Response !== "object") {
					throw new Error("Tencent Cloud response was invalid");
				}
				if (body.Response.Error) {
					const code = sanitizedMetadata(body.Response.Error.Code, sensitiveValues);
					const requestId = sanitizedMetadata(body.Response.RequestId, sensitiveValues);
					throw new Error(`Tencent Cloud API error${code ? `: ${code}` : ""}${requestId ? ` (RequestId: ${requestId})` : ""}`);
				}
				return body.Response;
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}
