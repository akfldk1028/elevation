export function serializeGoogleImageEditRequest(request) {
	return {
		contents: [{ role: "user", parts: [
			{ text: request.prompt },
			{ inlineData: { mimeType: "image/png", data: Buffer.from(request.evidenceBytes).toString("base64") } },
		] }],
		generationConfig: { responseModalities: ["IMAGE"] },
	};
}
