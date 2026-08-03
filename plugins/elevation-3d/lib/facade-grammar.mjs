import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const LIMITS = {
	bay_width_m: [0.9, 3.0],
	frame_depth_m: [0.05, 0.25],
	mullion_depth_m: [0.03, 0.12],
	glazing_recess_m: [0.03, 0.20],
	parapet_height_m: [0.15, 0.60],
};

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function clamp(value, [minimum, maximum]) {
	return Math.min(maximum, Math.max(minimum, value));
}

export async function resolveApprovedDesign({ candidateId, approvedImage, memoryRoot }) {
	const metadataPath = join(resolve(memoryRoot), "assets", candidateId, "approved-design-v1.json");
	const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
	const imagePath = approvedImage
		? (isAbsolute(approvedImage) ? approvedImage : resolve(approvedImage))
		: resolve(dirname(metadataPath), metadata.image_path);
	const actualHash = sha256(await readFile(imagePath));
	if (actualHash !== metadata.image_sha256.toLowerCase()) throw new Error("approved image hash mismatch");
	return { ...metadata, image_path: imagePath, image_sha256: actualHash };
}

export function normalizeFacadeGrammar({ approvedDesign, floorGuides, facadePlanes }) {
	const grammar = { ...approvedDesign.facade_grammar };
	for (const [field, limits] of Object.entries(LIMITS)) grammar[field] = clamp(grammar[field], limits);
	grammar.floor_elevations_m = [...floorGuides.floor_guides_m];
	grammar.facade_lengths_m = Object.fromEntries(
		facadePlanes.facade_planes.map((plane) => [plane.view, plane.extent_m[0]]),
	);
	return grammar;
}

export function correctGrammar(grammar, failureCodes) {
	const corrected = { ...grammar };
	if (failureCodes.includes("DETAIL_BOUNDS_EXCEEDED")) {
		corrected.frame_depth_m = clamp(grammar.frame_depth_m / 2, LIMITS.frame_depth_m);
		corrected.mullion_depth_m = clamp(grammar.mullion_depth_m / 2, LIMITS.mullion_depth_m);
	}
	if (failureCodes.includes("PRIMITIVE_BUDGET_EXCEEDED")) {
		corrected.bay_width_m = 2.25;
	}
	return corrected;
}
