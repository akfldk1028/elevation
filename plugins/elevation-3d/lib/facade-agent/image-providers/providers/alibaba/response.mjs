import { readBoundedJsonResponse } from "../../response-boundary.mjs";

export async function readAlibabaResponse(response) {
	return readBoundedJsonResponse(response);
}

export function selectAlibabaImageResponse(payload, headerRemoteId = null) {
	const images = (Array.isArray(payload?.output?.choices) ? payload.output.choices : [])
		.flatMap((choice) => Array.isArray(choice?.message?.content) ? choice.message.content : [])
		.filter((item) => item && typeof item === "object" && typeof item.image === "string")
		.map((item) => item.image);
	return Object.freeze({
		remoteId: headerRemoteId ?? payload?.request_id ?? null,
		imageCount: images.length,
		imageUrl: images.length === 1 ? images[0] : null,
		usage: payload?.usage ?? null,
	});
}
