import { SEMANTIC_ROLES } from "./semantic-role-mask.mjs";
import { TERMINAL_MATERIAL_CHOICES } from "./facade-agent/facade-vocabulary.mjs";
import { sha256, stableJson } from "./core.mjs";

const SCHEMA_VERSION = "arr.elevation3d.material-palette.v1";
// A fifth copy of the role list lived here and the consolidation missed it, so adding
// `masonry` passed every test that reads the leaf module and then hung the render page for
// sixty seconds with nothing to say. It reads the one table now.
const ROLE_NAMES = SEMANTIC_ROLES;
// A drawing paints a member with the fill of its ROLE, and four roles cannot separate two
// materials that share one - a brick field and the mass behind it print the same tone. A
// preset may therefore name a fill per MATERIAL, which the elevation prefers when a
// member's glTF material is one of them. The key set is the vocabulary's own list rather
// than a fifth hand-copied one: this file already learned that lesson with the role names.
const MATERIAL_NAMES = TERMINAL_MATERIAL_CHOICES;
const MATERIAL_FIELDS = ["elevation_fill"];
const ROLE_FIELDS = ["elevation_fill", "axon_pbr", "opacity", "roughness", "metalness", "line_contrast", "texture_intensity", "normal_intensity"];
const UNIT_INTERVAL_FIELDS = ["roughness", "metalness", "line_contrast", "texture_intensity", "normal_intensity"];

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
	// The first preset where the wall reads as a fired material rather than a render tone.
	// The three presets above differ in temperature, not in what the building seems to be
	// made of, and a vocabulary that says `brick` deserved a palette that does. The wall
	// field is a mid-light brick red (luminance ~125, well clear of the dark threshold and
	// the luminance floors), the glass stays cool so concrete_glass keeps its distance,
	// bronze is a warm dark and opaque a cool near-black so the closest pair stays apart.
	"competition-brick": {
		concrete: { elevation_fill: "#b3745a", axon_pbr: "#a86a50", opacity: 1, roughness: 0.85, metalness: 0, line_contrast: 0.72, texture_intensity: 0.22, normal_intensity: 0.16 },
		glass: { elevation_fill: "#8fa6ad", axon_pbr: "#a9c0c6", opacity: 0.42, roughness: 0.14, metalness: 0, line_contrast: 0.58, texture_intensity: 0.05, normal_intensity: 0.03 },
		bronze: { elevation_fill: "#3f2f26", axon_pbr: "#503c2f", opacity: 1, roughness: 0.31, metalness: 0.72, line_contrast: 0.84, texture_intensity: 0.09, normal_intensity: 0.08 },
		opaque: { elevation_fill: "#2f3134", axon_pbr: "#3b3d40", opacity: 1, roughness: 0.58, metalness: 0.16, line_contrast: 0.78, texture_intensity: 0.08, normal_intensity: 0.06 },
	},
	// The first palette that answers "what is this made of" rather than only "what part is
	// this". Its roles are the warm preset's, so value structure and every threshold derived
	// from it stay where they were; on top of that it names a fill per MATERIAL, and a member
	// whose glTF material is one of these is painted with it instead of with its role. That is
	// what lets a brick field and the mass behind it - both the opaque role - stop printing as
	// one tone. The four fills are separated in VALUE, not only in hue, so the sheet still
	// reads in a grey print: brick mid-warm, precast pale, window-frame near-black, glass cool.
	"competition-material": {
		concrete: { elevation_fill: "#ddd3c3", axon_pbr: "#cfc3b0", opacity: 1, roughness: 0.86, metalness: 0, line_contrast: 0.72, texture_intensity: 0.16, normal_intensity: 0.12 },
		glass: { elevation_fill: "#8fa9b5", axon_pbr: "#abc4cc", opacity: 0.42, roughness: 0.14, metalness: 0, line_contrast: 0.58, texture_intensity: 0.05, normal_intensity: 0.03 },
		bronze: { elevation_fill: "#49362c", axon_pbr: "#5d4332", opacity: 1, roughness: 0.31, metalness: 0.72, line_contrast: 0.84, texture_intensity: 0.09, normal_intensity: 0.08 },
		opaque: { elevation_fill: "#34373a", axon_pbr: "#404347", opacity: 1, roughness: 0.58, metalness: 0.16, line_contrast: 0.78, texture_intensity: 0.08, normal_intensity: 0.06 },
		materials: {
			brick: { elevation_fill: "#a86a52" },
			precast: { elevation_fill: "#cfc7b8" },
			"window-frame": { elevation_fill: "#3a2f28" },
			glass: { elevation_fill: "#8fa9b5" },
		},
	},
});

function resolveRequest(presetOrOverrides) {
	if (typeof presetOrOverrides === "string") return { preset: presetOrOverrides, roles: {}, materials: {} };
	if (!presetOrOverrides || typeof presetOrOverrides !== "object") throw new Error("material palette preset invalid");
	const roles = presetOrOverrides.roles ?? {};
	if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error("material parameter invalid: roles");
	const materials = presetOrOverrides.materials ?? {};
	if (!materials || typeof materials !== "object" || Array.isArray(materials)) throw new Error("material parameter invalid: materials");
	return { preset: presetOrOverrides.preset, roles, materials };
}

function validateRoleParameters(roleName, role) {
	if (!role || typeof role !== "object" || Array.isArray(role)) throw new Error(`material parameter invalid: ${roleName}`);
	if (Object.keys(role).some((field) => !ROLE_FIELDS.includes(field))) throw new Error(`material parameter invalid: ${roleName}`);
	for (const field of ["elevation_fill", "axon_pbr"]) {
		if (typeof role[field] !== "string" || !/^#[0-9a-f]{6}$/i.test(role[field])) throw new Error(`material parameter invalid: ${roleName}.${field}`);
	}
	for (const field of UNIT_INTERVAL_FIELDS) {
		if (!Number.isFinite(role[field]) || role[field] < 0 || role[field] > 1) throw new Error(`material parameter invalid: ${roleName}.${field}`);
	}
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
	for (const [roleName, override] of Object.entries(request.roles)) {
		if (!ROLE_NAMES.includes(roleName)) throw new Error(`material role invalid: ${roleName}`);
		if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error(`material parameter invalid: ${roleName}`);
		if (Object.keys(override).some((field) => !ROLE_FIELDS.includes(field))) throw new Error(`material parameter invalid: ${roleName}`);
	}
	for (const [materialName, override] of Object.entries(request.materials)) {
		if (!MATERIAL_NAMES.includes(materialName)) throw new Error(`material name invalid: ${materialName}`);
		if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error(`material parameter invalid: ${materialName}`);
		if (Object.keys(override).some((field) => !MATERIAL_FIELDS.includes(field))) throw new Error(`material parameter invalid: ${materialName}`);
	}
	const roles = Object.fromEntries(ROLE_NAMES.map((roleName) => [
		roleName,
		{ ...preset[roleName], ...(request.roles[roleName] ?? {}) },
	]));
	for (const roleName of ROLE_NAMES) validateRoleParameters(roleName, roles[roleName]);
	validateVisibility(roles);
	// Absent on every preset written before this existed, and absent means "paint by role",
	// so those palettes resolve to the same object and every retained render stays identical.
	const materials = Object.fromEntries(MATERIAL_NAMES
		.map((materialName) => [materialName, { ...preset.materials?.[materialName], ...(request.materials[materialName] ?? {}) }])
		.filter(([, material]) => Object.keys(material).length));
	for (const [materialName, material] of Object.entries(materials)) {
		if (typeof material.elevation_fill !== "string" || !/^#[0-9a-f]{6}$/i.test(material.elevation_fill)) {
			throw new Error(`material parameter invalid: ${materialName}.elevation_fill`);
		}
	}
	const resolved = { schema_version: SCHEMA_VERSION, preset: request.preset, roles, ...(Object.keys(materials).length ? { materials } : {}) };
	return deepFreeze({ ...resolved, sha256: sha256(stableJson(resolved)) });
}
