export class FacadeDesignContractError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "FacadeDesignContractError";
		this.code = code;
	}
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const TOP_KEYS = new Set([
	"schema_version", "concept_id", "entrance", "zones", "window_families",
	"bay_rules", "articulation", "materials", "design_rationale",
]);
const SOURCE_KEYS = new Set(["candidate_id", "candidate_sha256", "selected_glb_sha256", "context_sha256"]);
const ENTRANCE_KEYS = new Set(["segment_selector", "preferred_bay", "door_family", "width_m", "height_m", "recess_m"]);
const ZONE_KEYS = new Set(["id", "storeys", "treatment"]);
const WINDOW_KEYS = new Set(["id", "width_m", "height_m", "sill_m"]);
const BAY_KEYS = new Set(["id", "zone_id", "pattern", "repeat"]);
const ARTICULATION_KEYS = new Set(["id", "kind", "segment_selector", "width_m", "depth_m", "storeys", "material_id"]);
const MATERIAL_KEYS = new Set(["id", "role", "color", "finish"]);
const verifiedProgramAuthorities = new WeakMap();

export function readVerifiedFacadeProgramAuthority(value) {
	const authority = value && typeof value === "object" ? verifiedProgramAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

function fail(message) {
	throw new FacadeDesignContractError("FACADE_DESIGN_PROGRAM_INVALID", message);
}

function record(value, label, allowedKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain data object`);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		fail(`${label} could not be inspected safely`);
	}
	if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain data object`);
	const result = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowedKeys.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) {
			fail(`${label} contains an unauthorized field or accessor`);
		}
		result[key] = descriptor.value;
	}
	return result;
}

function arrayValues(value, label, minimum, maximum) {
	let isArray;
	let prototype;
	let descriptors;
	try {
		isArray = Array.isArray(value);
		prototype = isArray ? Object.getPrototypeOf(value) : null;
		descriptors = isArray ? Object.getOwnPropertyDescriptors(value) : null;
	} catch {
		fail(`${label} could not be inspected safely`);
	}
	if (!isArray || prototype !== Array.prototype) fail(`${label} must be a plain array`);
	const length = descriptors.length?.value;
	const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
	if (!Number.isSafeInteger(length) || length < minimum || length > maximum || keys.length !== length) {
		fail(`${label} has an invalid size or shape`);
	}
	const result = new Array(length);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
			|| descriptor.get || descriptor.set || !("value" in descriptor)) fail(`${label} contains unsafe data`);
		result[Number(key)] = descriptor.value;
	}
	return result;
}

function boundedString(value, label, maximum = 256) {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/.test(value)) {
		fail(`${label} must be a bounded non-empty string`);
	}
	return value;
}

function id(value, label) {
	const result = boundedString(value, label, 128);
	if (!ID.test(result)) fail(`${label} must be a safe lowercase identifier`);
	return result;
}

function enumeration(value, label, allowed) {
	if (!allowed.has(value)) fail(`${label} is unsupported`);
	return value;
}

function finite(value, label, minimum, maximum) {
	if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`${label} is outside its finite bounds`);
	return value;
}

function positiveInteger(value, label, maximum) {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${label} must be a bounded positive integer`);
	return value;
}

function unique(values, label) {
	if (new Set(values).size !== values.length) fail(`${label} contains duplicate identities`);
	return values;
}

function storeys(value, label) {
	return unique(arrayValues(value, label, 1, 64).map((item, index) => positiveInteger(item, `${label}[${index}]`, 128)), label);
}

function parseSourceAuthority(value) {
	const source = record(value, "sourceAuthority", SOURCE_KEYS);
	const candidateId = id(source.candidate_id, "sourceAuthority.candidate_id");
	const hashes = ["candidate_sha256", "selected_glb_sha256", "context_sha256"];
	for (const key of hashes) if (typeof source[key] !== "string" || !HASH.test(source[key])) fail(`sourceAuthority.${key} must be a lowercase SHA-256 hash`);
	return {
		candidate_id: candidateId,
		candidate_sha256: source.candidate_sha256,
		selected_glb_sha256: source.selected_glb_sha256,
		context_sha256: source.context_sha256,
	};
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function parseFacadeProgram(input, options = {}) {
	const optionFields = record(options, "Facade program options", new Set(["sourceAuthority"]));
	const source = parseSourceAuthority(optionFields.sourceAuthority);
	const fields = record(input, "Facade program", TOP_KEYS);
	if (fields.schema_version !== "arr.elevation3d.facade-program.v2") fail("schema_version is unsupported");
	const conceptId = id(fields.concept_id, "concept_id");

	const entranceFields = record(fields.entrance, "entrance", ENTRANCE_KEYS);
	const entrance = {
		segment_selector: enumeration(entranceFields.segment_selector, "entrance.segment_selector", new Set(["primary_visible_ground_segment"])),
		preferred_bay: enumeration(entranceFields.preferred_bay, "entrance.preferred_bay", new Set(["central_or_corner_focus", "central_focus", "corner_focus"])),
		door_family: id(entranceFields.door_family, "entrance.door_family"),
		width_m: finite(entranceFields.width_m, "entrance.width_m", 0.8, 6),
		height_m: finite(entranceFields.height_m, "entrance.height_m", 1.8, 6),
		recess_m: finite(entranceFields.recess_m, "entrance.recess_m", 0, 1.5),
	};

	const zones = arrayValues(fields.zones, "zones", 3, 16).map((value, index) => {
		const zone = record(value, `zones[${index}]`, ZONE_KEYS);
		return { id: id(zone.id, `zones[${index}].id`), storeys: storeys(zone.storeys, `zones[${index}].storeys`), treatment: id(zone.treatment, `zones[${index}].treatment`) };
	});
	unique(zones.map((zone) => zone.id), "zones");

	const windowFamilies = arrayValues(fields.window_families, "window_families", 2, 16).map((value, index) => {
		const family = record(value, `window_families[${index}]`, WINDOW_KEYS);
		return {
			id: id(family.id, `window_families[${index}].id`),
			width_m: finite(family.width_m, `window_families[${index}].width_m`, 0.3, 6),
			height_m: finite(family.height_m, `window_families[${index}].height_m`, 0.3, 6),
			sill_m: finite(family.sill_m, `window_families[${index}].sill_m`, 0, 3),
		};
	});
	unique(windowFamilies.map((family) => family.id), "window_families");
	const familyIds = new Set(windowFamilies.map((family) => family.id));
	const zoneIds = new Set(zones.map((zone) => zone.id));

	const bayRules = arrayValues(fields.bay_rules, "bay_rules", 0, 32).map((value, index) => {
		const rule = record(value, `bay_rules[${index}]`, BAY_KEYS);
		const zoneId = id(rule.zone_id, `bay_rules[${index}].zone_id`);
		if (!zoneIds.has(zoneId)) fail(`bay_rules[${index}].zone_id must reference a zone`);
		const pattern = arrayValues(rule.pattern, `bay_rules[${index}].pattern`, 1, 16).map((item, itemIndex) => id(item, `bay_rules[${index}].pattern[${itemIndex}]`));
		if (pattern.some((familyId) => !familyIds.has(familyId))) fail(`bay_rules[${index}].pattern must reference window families`);
		return { id: id(rule.id, `bay_rules[${index}].id`), zone_id: zoneId, pattern, repeat: positiveInteger(rule.repeat, `bay_rules[${index}].repeat`, 32) };
	});
	unique(bayRules.map((rule) => rule.id), "bay_rules");

	const materials = arrayValues(fields.materials, "materials", 0, 16).map((value, index) => {
		const material = record(value, `materials[${index}]`, MATERIAL_KEYS);
		const color = boundedString(material.color, `materials[${index}].color`, 7);
		if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(`materials[${index}].color must be a hex color`);
		return {
			id: id(material.id, `materials[${index}].id`),
			role: enumeration(material.role, `materials[${index}].role`, new Set(["opaque", "glass", "bronze", "concrete"])),
			color: color.toLowerCase(),
			finish: enumeration(material.finish, `materials[${index}].finish`, new Set(["matte", "satin", "polished", "transparent"])),
		};
	});
	unique(materials.map((material) => material.id), "materials");
	const materialIds = new Set(materials.map((material) => material.id));

	const articulation = arrayValues(fields.articulation, "articulation", 0, 32).map((value, index) => {
		const item = record(value, `articulation[${index}]`, ARTICULATION_KEYS);
		const materialId = id(item.material_id, `articulation[${index}].material_id`);
		if (!materialIds.has(materialId)) fail(`articulation[${index}].material_id must reference a material`);
		return {
			id: id(item.id, `articulation[${index}].id`),
			kind: enumeration(item.kind, `articulation[${index}].kind`, new Set(["reveal", "lintel", "sill", "pilaster", "band", "cornice"])),
			segment_selector: enumeration(item.segment_selector, `articulation[${index}].segment_selector`, new Set(["all_visible_folds", "primary_visible_segment", "all_eligible_segments"])),
			width_m: finite(item.width_m, `articulation[${index}].width_m`, 0.02, 3),
			depth_m: finite(item.depth_m, `articulation[${index}].depth_m`, 0, 1.5),
			storeys: storeys(item.storeys, `articulation[${index}].storeys`),
			material_id: materialId,
		};
	});
	unique(articulation.map((item) => item.id), "articulation");

	const designRationale = arrayValues(fields.design_rationale, "design_rationale", 0, 32)
		.map((value, index) => boundedString(value, `design_rationale[${index}]`, 512));

	const program = deepFreeze({
		schema_version: "arr.elevation3d.facade-program.v2",
		concept_id: conceptId,
		source,
		entrance,
		zones,
		window_families: windowFamilies,
		bay_rules: bayRules,
		articulation,
		materials,
		design_rationale: designRationale,
	});
	verifiedProgramAuthorities.set(program, Object.freeze({ ...source }));
	return program;
}
