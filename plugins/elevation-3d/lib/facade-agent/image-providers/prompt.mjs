import { createHash } from "node:crypto";

import { cloneBoundedPlainData, FacadeImageBoundaryError } from "./response-boundary.mjs";

export const FACADE_IMAGE_PROMPT_REVISION = "facade-architectural-edit-v1";
export const FACADE_PROHIBITED_CHANGES = Object.freeze([
	"curtain wall",
	"extra floors",
	"balconies",
	"setbacks",
	"projections",
	"roof changes",
	"landscaping",
	"people",
	"text",
	"labels",
	"logos",
	"camera changes",
]);

function requiredIdentity(value, label) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new FacadeImageBoundaryError("PROVIDER_BOUNDARY_INVALID", `${label} must be a safe non-empty identity`);
	}
	return value;
}

export function buildFacadeArchitecturalPrompt(input) {
	const fields = cloneBoundedPlainData(input);
	const candidateId = requiredIdentity(fields.candidateId, "candidateId");
	const briefId = requiredIdentity(fields.briefId, "briefId");
	if (typeof fields.evidenceManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.evidenceManifestSha256)) {
		throw new FacadeImageBoundaryError("PROVIDER_EVIDENCE_INVALID", "evidenceManifestSha256 must be a lowercase SHA-256");
	}
	const prompt = [
		"Goal:",
		"Create a competition-quality architectural facade concept that will be rebuilt as exact local 3D.",
		"",
		"Authority:",
		`Candidate ${candidateId}, brief ${briefId}, and evidence manifest ${fields.evidenceManifestSha256} are binding.`,
		"The supplied contact sheet fixes the silhouette, footprint, height, storey count, facade planes, opening zones, and every camera.",
		"",
		"Material direction:",
		"Use warm red or red-brown masonry, deep punched windows, mineral mortar, restrained precast lintels and sills, dark durable metal frames, and realistic glazing.",
		"",
		"Composition:",
		"Preserve every panel and view in the supplied sheet and design one coherent facade system across all visible sides.",
		"",
		"Constraints:",
		"Change facade articulation and material appearance only.",
		"Do not create a curtain wall, extra floors, balconies, setbacks, projections, roof changes, landscaping, people, text, labels, logos, or camera changes.",
		"",
		"Output use:",
		"Produce a reference board for deterministic architectural grammar extraction, not a free-form marketing rendering.",
		"",
		"Critical preserve rules:",
		"Preserve the silhouette, footprint, height, storey count, facade planes, opening zones, every panel, every view, and every camera exactly.",
	].join("\n");
	return Object.freeze({
		revision: FACADE_IMAGE_PROMPT_REVISION,
		prompt,
		negativePrompt: FACADE_PROHIBITED_CHANGES.join("; "),
		sha256: createHash("sha256").update(prompt).digest("hex"),
	});
}
