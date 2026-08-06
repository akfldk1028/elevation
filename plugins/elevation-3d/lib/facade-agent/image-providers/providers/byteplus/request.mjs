import { readVerifiedFacadeImageEditRequestAuthority } from "../../contract.mjs";
import { FacadeImageBoundaryError } from "../../response-boundary.mjs";

export function serializeBytePlusRequest(request) {
	const authority = readVerifiedFacadeImageEditRequestAuthority(request);
	if (!authority || authority.provider !== "seedream-5-pro" || authority.model !== "dola-seedream-5-0-pro-260628") {
		throw new FacadeImageBoundaryError("PROVIDER_REQUEST_UNAUTHORIZED", "Seedream serialization requires an authorized common request");
	}
	return Object.freeze({
		model: authority.model,
		prompt: request.prompt.text,
		image: `data:image/png;base64,${request.evidence.pngBase64}`,
		size: "1536x1536",
		output_format: "png",
		response_format: "b64_json",
		watermark: false,
	});
}
