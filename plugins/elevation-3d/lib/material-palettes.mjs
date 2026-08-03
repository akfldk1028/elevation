import { sha256, stableJson } from "./core.mjs";

const SCHEMA_VERSION = "arr.elevation3d.material-palette.v1";
const ROLE_NAMES = ["concrete", "glass", "bronze", "opaque"];

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

const PRESETS = deepFreeze({
	"competition-warm": {
		concrete: { elevation_fill: "#ddd3c3", axon_pbr: "#cfc3b0", opacity: 1, roughness: 0.86, metalness: 0, line_contrast: 0.72, texture_intensity: 0.16, normal_intensity: 0.12 },
		glass: { elevation_fill: "#8fa9b5", axon_pbr: "#abc4cc", opacity: 0.42, roughness: 0.14, metalness: 0, line_contrast: 0.58, texture_intensity: 0.05, normal_intensity: 0.03 },
		bronze: { elevation_fill: "#49362c", axon_pbr: "#5d4332", opacity: 1, roughness: 0.31, metalness: 0.72, line_contrast: 0.84, texture_intensity: 0.09, normal_intensity: 0.08 },
		opaque: { elevation_fill: "#34373a", axon_pbr: "#404347", opacity: 1, roughness: 0.58, metalness: 0.16, line_contrast: 0.78, texture_intensity: 0.08, normal_intensity: 0.06 },
	},
	"competition-neutral": {
		concrete: { elevation_fill: "#d7d6d2", axon_pbr: "#cac9c5", opacity: 1, roughness: 0.84, metalness: 0, line_contrast: 0.70, texture_intensity: 0.12, normal_intensity: 0.10 },
		glass: { elevation_fill: "#9ba9ad", axon_pbr: "#b2bec0", opacity: 0.40, roughness: 0.16, metalness: 0, line_contrast: 0.56, texture_intensity: 0.04, normal_intensity: 0.03 },
		bronze: { elevation_fill: "#4b4d4e", axon_pbr: "#585a5b", opacity: 1, roughness: 0.34, metalness: 0.66, line_contrast: 0.82, texture_intensity: 0.07, normal_intensity: 0.06 },
		opaque: { elevation_fill: "#3b3d3f", axon_pbr: "#484a4c", opacity: 1, roughness: 0.60, metalness: 0.14, line_contrast: 0.76, texture_intensity: 0.07, normal_intensity: 0.05 },
	},
	"competition-stone": {
		concrete: { elevation_fill: "#ddd8ca", axon_pbr: "#d2cbbb", opacity: 1, roughness: 0.88, metalness: 0, line_contrast: 0.68, texture_intensity: 0.20, normal_intensity: 0.15 },
		glass: { elevation_fill: "#75888d", axon_pbr: "#8ea1a4", opacity: 0.48, roughness: 0.18, metalness: 0, line_contrast: 0.62, texture_intensity: 0.05, normal_intensity: 0.03 },
		bronze: { elevation_fill: "#7a6751", axon_pbr: "#91785d", opacity: 1, roughness: 0.36, metalness: 0.64, line_contrast: 0.79, texture_intensity: 0.10, normal_intensity: 0.08 },
		opaque: { elevation_fill: "#454746", axon_pbr: "#515352", opacity: 1, roughness: 0.62, metalness: 0.12, line_contrast: 0.75, texture_intensity: 0.08, normal_intensity: 0.06 },
	},
});

function resolveRequest(presetOrOverrides) {
	if (typeof presetOrOverrides === "string") return { preset: presetOrOverrides, roles: {} };
	if (!presetOrOverrides || typeof presetOrOverrides !== "object") throw new Error("material palette preset invalid");
	return { preset: presetOrOverrides.preset, roles: presetOrOverrides.roles ?? {} };
}

function validateVisibility(roles) {
	for (const roleName of ROLE_NAMES) {
		const role = roles[roleName];
		const [minimum, maximum] = roleName === "glass" ? [0.25, 0.85] : [0.85, 1];
		if (!role || !Number.isFinite(role.opacity) || role.opacity < minimum || role.opacity > maximum) {
			throw new Error(`material visibility invalid: ${roleName}`);
		}
	}
}

export function resolveMaterialPalette(presetOrOverrides) {
	const request = resolveRequest(presetOrOverrides);
	const preset = PRESETS[request.preset];
	if (!preset) throw new Error(`material palette preset invalid: ${request.preset}`);
	for (const roleName of Object.keys(request.roles)) {
		if (!ROLE_NAMES.includes(roleName)) throw new Error(`material role invalid: ${roleName}`);
	}
	const roles = Object.fromEntries(ROLE_NAMES.map((roleName) => [
		roleName,
		{ ...preset[roleName], ...(request.roles[roleName] ?? {}) },
	]));
	validateVisibility(roles);
	const resolved = { schema_version: SCHEMA_VERSION, preset: request.preset, roles };
	return deepFreeze({ ...resolved, sha256: sha256(stableJson(resolved)) });
}
