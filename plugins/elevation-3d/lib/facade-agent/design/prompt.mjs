import { sha256, stableJson } from "../../core.mjs";

export const FACADE_DESIGN_PROMPT_REVISION = "arr.elevation3d.facade-design-prompt.v1";

const selector = (values) => ({ type: "string", enum: values });
const id = { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$" };

export const FACADE_PROGRAM_V2_SCHEMA = Object.freeze({
	type: "object", additionalProperties: false,
	required: ["schema_version", "concept_id", "entrance", "zones", "window_families", "bay_rules", "articulation", "materials", "design_rationale"],
	properties: {
		schema_version: { type: "string", const: "arr.elevation3d.facade-program.v2" },
		concept_id: id,
		entrance: {
			type: "object", additionalProperties: false,
			required: ["segment_selector", "preferred_bay", "door_family", "width_m", "height_m", "recess_m"],
			properties: {
				segment_selector: { type: "string", const: "primary_visible_ground_segment" },
				preferred_bay: selector(["central_or_corner_focus", "central_focus", "corner_focus"]),
				door_family: id, width_m: { type: "number", minimum: 0.8, maximum: 6 },
				height_m: { type: "number", minimum: 1.8, maximum: 6 }, recess_m: { type: "number", minimum: 0, maximum: 1.5 },
			},
		},
		zones: { type: "array", minItems: 3, maxItems: 16, items: {
			type: "object", additionalProperties: false, required: ["id", "storeys", "treatment"],
			properties: { id, storeys: { type: "array", minItems: 1, maxItems: 64, items: { type: "integer", minimum: 1, maximum: 128 } }, treatment: id },
		} },
		window_families: { type: "array", minItems: 2, maxItems: 16, items: {
			type: "object", additionalProperties: false, required: ["id", "width_m", "height_m", "sill_m"],
			properties: { id, width_m: { type: "number", minimum: 0.3, maximum: 6 }, height_m: { type: "number", minimum: 0.3, maximum: 6 }, sill_m: { type: "number", minimum: 0, maximum: 3 } },
		} },
		bay_rules: { type: "array", minItems: 0, maxItems: 32, items: {
			type: "object", additionalProperties: false, required: ["id", "zone_id", "pattern", "repeat"],
			properties: {
				id, zone_id: id, pattern: { type: "array", minItems: 1, maxItems: 16, items: id },
				repeat: { type: "integer", minimum: 1, maximum: 32 },
				views: {
					type: "array", minItems: 1, maxItems: 4, items: selector(["front", "back", "left", "right"]),
					description: "Elevations this rhythm applies to. Omit to apply it to every elevation.",
				},
			},
		} },
		articulation: { type: "array", maxItems: 32, items: {
			type: "object", additionalProperties: false, required: ["id", "kind", "segment_selector", "width_m", "depth_m", "storeys", "material_id"],
			properties: {
				id, kind: selector(["reveal", "lintel", "sill", "pilaster", "band", "cornice"]),
				segment_selector: selector(["all_visible_folds", "primary_visible_segment", "all_eligible_segments"]),
				width_m: { type: "number", minimum: 0.02, maximum: 3 }, depth_m: { type: "number", minimum: 0, maximum: 1.5 },
				storeys: { type: "array", minItems: 1, maxItems: 64, items: { type: "integer", minimum: 1, maximum: 128 } }, material_id: id,
			},
		} },
		materials: { type: "array", minItems: 0, maxItems: 16, items: {
			type: "object", additionalProperties: false, required: ["id", "role", "color", "finish"],
			properties: { id, role: selector(["opaque", "glass", "bronze", "concrete"]), color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, finish: selector(["matte", "satin", "polished", "transparent"]) },
		} },
		design_rationale: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
	},
});

export function buildFacadeDesignPrompt({ context, correctionCodes = [], attempt }) {
	const boundedContext = {
		source: context.source,
		facade_segments: context.facade_segments,
		facade_faces: context.facade_faces,
		storeys: context.storeys,
		existing_openings: context.existing_openings,
		exclusions: context.exclusions,
		technical_thumbnails: context.technical_thumbnails,
	};
	const prompt = [
		"You are the architectural facade design director. Return exactly one FacadeProgramV2 JSON object.",
		"Design a legible building facade, not a repetitive window grid: include one clear ground entrance, base-middle-top hierarchy, reusable window families, and controlled articulation.",
		"facade_faces groups the segments into the elevations a drawing shows; give the elevations different rhythms with bay_rules.views instead of repeating one rhythm everywhere.",
		"Express semantic intent only. Never invent segment IDs, coordinates, vertices, cameras, floors, roof geometry, or output paths; deterministic code owns all placement.",
		`Attempt: ${attempt}.`,
		`Technical context: ${stableJson(boundedContext)}`,
		correctionCodes.length ? `Correct these unchanged deterministic validation codes: ${correctionCodes.join(", ")}.` : "No prior validation failures.",
	].join("\n");
	return Object.freeze({ revision: FACADE_DESIGN_PROMPT_REVISION, prompt, sha256: sha256(prompt) });
}
