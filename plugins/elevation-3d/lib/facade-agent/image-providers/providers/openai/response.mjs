export function selectOpenAIImageResponse(payload, headerRemoteId = null) {
	const outputs = Array.isArray(payload?.data) ? payload.data : [];
	return Object.freeze({
		remoteId: headerRemoteId ?? payload?.id ?? null,
		imageCount: outputs.length,
		encodedImage: outputs.length === 1 && outputs[0] && typeof outputs[0] === "object" ? outputs[0].b64_json ?? null : null,
		usage: payload?.usage ?? null,
	});
}
