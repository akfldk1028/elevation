export function selectGoogleImageResponse(payload, headerRemoteId = null) {
	const images = (Array.isArray(payload?.candidates) ? payload.candidates : []).flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
		.filter((part) => part?.inlineData && typeof part.inlineData === "object")
		.map((part) => part.inlineData);
	return Object.freeze({
		remoteId: headerRemoteId ?? payload?.responseId ?? null,
		resolvedModel: payload?.modelVersion ?? null,
		imageCount: images.length,
		encodedImage: images.length === 1 ? images[0].data ?? null : null,
		declaredMimeType: images.length === 1 ? images[0].mimeType ?? null : null,
		usage: payload?.usageMetadata ?? null,
		finishReasons: Object.freeze((Array.isArray(payload?.candidates) ? payload.candidates : []).map((candidate) => candidate?.finishReason ?? null)),
		moderationBlocked: Boolean(payload?.promptFeedback?.blockReason && payload.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED")
			|| (Array.isArray(payload?.candidates) ? payload.candidates : []).some((candidate) => /SAFETY|BLOCK|PROHIBITED_CONTENT/.test(candidate?.finishReason ?? "")),
	});
}
