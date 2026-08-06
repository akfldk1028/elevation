export function serializeBytePlusGrammarRequest(request) {
	return {
		model: "seed-2-0-mini-260428",
		input: [{
			role: "user",
			content: [
				{ type: "input_text", text: request.prompt },
				{ type: "input_image", image_url: `data:${request.imageMimeType};base64,${request.imageBase64}`, detail: "high" },
			],
		}],
		text: {
			format: {
				type: "json_schema",
				name: "brick_punched_window_facade",
				strict: true,
				schema: request.schema,
			},
		},
	};
}
