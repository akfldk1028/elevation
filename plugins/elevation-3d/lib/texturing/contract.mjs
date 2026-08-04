export const TEXTURING_STATES = Object.freeze([
	"idle",
	"prepared",
	"import_submitted",
	"import_ready",
	"texture_submitted",
	"texture_ready",
	"downloaded",
	"validated",
	"accepted",
	"review",
	"rejected",
	"cancelled",
]);

export class TexturingError extends Error {
	constructor(code, message, details = undefined) {
		super(message, { cause: details?.cause });
		this.name = "TexturingError";
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

export function assertTexturingRequest(request) {
	if (!request || typeof request !== "object") {
		throw new TexturingError("INVALID_TEXTURING_REQUEST", "Texturing request must be an object");
	}
	for (const field of ["acceptedGlb", "referenceImage", "resultDir"]) {
		if (typeof request[field] !== "string" || request[field].trim() === "") {
			throw new TexturingError("INVALID_TEXTURING_REQUEST", `${field} must be a non-empty path`);
		}
	}
	if (request.provider !== "tripo") {
		throw new TexturingError("TEXTURING_PROVIDER_NOT_ALLOWED", "Only the configured Tripo provider is allowed");
	}
	if (request.textureQuality !== "standard") {
		throw new TexturingError("TEXTURE_QUALITY_NOT_ALLOWED", "Only standard texture quality is allowed");
	}
	if (!Number.isInteger(request.seed)) {
		throw new TexturingError("INVALID_TEXTURE_SEED", "Texture seed must be an integer");
	}
	if (!Number.isInteger(request.maxCredits) || request.maxCredits < 1 || request.maxCredits > 15) {
		throw new TexturingError("CREDIT_CAP_EXCEEDED", "Credit cap must be an integer from 1 through 15");
	}
	return { ...request };
}
