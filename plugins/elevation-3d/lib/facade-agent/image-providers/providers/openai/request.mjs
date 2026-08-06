export function serializeOpenAIImageEditRequest(request) {
	const form = new FormData();
	form.set("model", request.model);
	form.set("prompt", request.prompt);
	form.set("quality", "high");
	form.set("n", "1");
	form.set("image", new Blob([request.evidenceBytes], { type: "image/png" }), "evidence.png");
	return form;
}
