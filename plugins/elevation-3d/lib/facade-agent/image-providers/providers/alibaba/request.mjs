import { readVerifiedFacadeImageEditRequestAuthority } from "../../contract.mjs";
import { FacadeImageBoundaryError } from "../../response-boundary.mjs";

export function serializeAlibabaRequest(request) {
	const authority = readVerifiedFacadeImageEditRequestAuthority(request);
	if (!authority || authority.provider !== "qwen-image-2" || authority.model !== "qwen-image-2.0") {
		throw new FacadeImageBoundaryError("PROVIDER_REQUEST_UNAUTHORIZED", "Qwen serialization requires an authorized common request");
	}
	return Object.freeze({
		model: authority.model,
		input: { messages: [{ role: "user", content: [
			{ image: `data:image/png;base64,${request.evidence.pngBase64}` },
			{ text: request.prompt.text },
		] }] },
		parameters: {
			n: 1,
			negative_prompt: request.prohibitedChanges.join("; "),
			prompt_extend: false,
			watermark: false,
			size: "1536*1536",
		},
	});
}
