import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const LIMITS = {
	bay_width_m: [0.9, 3.0],
	frame_depth_m: [0.05, 0.25],
	mullion_depth_m: [0.03, 0.12],
	glazing_recess_m: [0.03, 0.20],
	parapet_height_m: [0.15, 0.60],
	window_width_m: [0.6, 2.2],
	window_height_m: [0.8, 2.4],
	sill_height_m: [0.45, 1.2],
	reveal_depth_m: [0.12, 0.4],
	frame_width_m: [0.03, 0.12],
	lintel_height_m: [0.08, 0.4],
	sill_depth_m: [0.03, 0.25],
	cladding_depth_m: [0.04, 0.25],
	corner_datum_m: [-0.25, 0.25],
	confidence: [0.8, 1],
};

export const PUNCHED_FACADE_SYSTEM = "brick-punched-window-v1";
export const PUNCHED_FACADE_SURFACES = Object.freeze(["front", "right", "back", "left"]);
export const PUNCHED_FACADE_MATERIALS = Object.freeze(["brick", "precast", "window-frame", "glass"]);
export const PUNCHED_FACADE_FIELDS = Object.freeze([
	"system", "surfaces", "materials", "corner_datum_m", "bay_width_m", "window_width_m",
	"window_height_m", "sill_height_m", "reveal_depth_m", "frame_width_m", "lintel_height_m",
	"sill_depth_m", "cladding_depth_m", "brick_module_m", "confidence", "unresolved_surfaces",
]);

const PUNCHED_DERIVED_FIELDS = new Set(["wall_opacity", "curtain_wall_allowed", "floor_elevations_m", "facade_lengths_m"]);

function grammarError(message) {
	const error = new TypeError(message);
	error.code = "FACADE_GRAMMAR_INVALID";
	return error;
}

function plainRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw grammarError(`${label} must be a plain object`);
	}
	return value;
}

function exactUniqueStrings(value, expected, label) {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
		|| value.length !== expected.length || value.some((entry) => typeof entry !== "string")
		|| new Set(value).size !== value.length || value.some((entry) => !expected.includes(entry))
		|| expected.some((entry) => !value.includes(entry))) {
		throw grammarError(`${label} must contain each allowlisted value exactly once`);
	}
	return [...expected];
}

function boundedNumber(value, field) {
	const limits = LIMITS[field];
	if (!Number.isFinite(value) || value < limits[0] || value > limits[1]) {
		throw grammarError(`${field} must be finite and within the candidate-safe range`);
	}
	return value;
}

function floorHeights(floorGuides) {
	const guides = floorGuides?.floor_guides_m;
	if (!Array.isArray(guides) || guides.length < 2 || guides.some((value) => !Number.isFinite(value))) {
		throw grammarError("finite floor guides are required for punched facade validation");
	}
	const heights = guides.slice(1).map((value, index) => value - guides[index]);
	if (heights.some((value) => value <= 0)) throw grammarError("floor guides must increase strictly");
	return heights;
}

export function validatePunchedFacadeGrammar(value, { floorGuides, allowMissingMaterials = false, allowDerived = false } = {}) {
	const grammar = plainRecord(value, "punched facade grammar");
	const allowed = new Set(PUNCHED_FACADE_FIELDS);
	if (allowDerived) for (const field of PUNCHED_DERIVED_FIELDS) allowed.add(field);
	const unknown = Object.keys(grammar).filter((field) => !allowed.has(field));
	if (unknown.length) throw grammarError("punched facade grammar contains unknown fields");
	for (const field of PUNCHED_FACADE_FIELDS) {
		if (field === "materials" && allowMissingMaterials) continue;
		if (!Object.hasOwn(grammar, field)) throw grammarError(`punched facade grammar is missing ${field}`);
	}
	if (grammar.system !== PUNCHED_FACADE_SYSTEM) throw grammarError("punched facade system is not approved");
	const surfaces = exactUniqueStrings(grammar.surfaces, PUNCHED_FACADE_SURFACES, "surfaces");
	const materials = grammar.materials === undefined && allowMissingMaterials
		? [...PUNCHED_FACADE_MATERIALS]
		: exactUniqueStrings(grammar.materials, PUNCHED_FACADE_MATERIALS, "materials");
	if (!Array.isArray(grammar.unresolved_surfaces) || grammar.unresolved_surfaces.length !== 0) {
		throw grammarError("unresolved facade surfaces are not allowed");
	}
	const numbers = Object.fromEntries([
		"corner_datum_m", "bay_width_m", "window_width_m", "window_height_m", "sill_height_m",
		"reveal_depth_m", "frame_width_m", "lintel_height_m", "sill_depth_m", "cladding_depth_m", "confidence",
	].map((field) => [field, boundedNumber(grammar[field], field)]));
	if (!Array.isArray(grammar.brick_module_m) || grammar.brick_module_m.length !== 2
		|| !Number.isFinite(grammar.brick_module_m[0]) || grammar.brick_module_m[0] < 0.18 || grammar.brick_module_m[0] > 0.26
		|| !Number.isFinite(grammar.brick_module_m[1]) || grammar.brick_module_m[1] < 0.05 || grammar.brick_module_m[1] > 0.09) {
		throw grammarError("brick_module_m must be a candidate-safe width and course-height pair");
	}
	if (numbers.window_width_m + 2 * numbers.frame_width_m > numbers.bay_width_m) {
		throw grammarError("window and frame dimensions are infeasible for the facade bay");
	}
	if (floorGuides) {
		const minimumFloorHeight = Math.min(...floorHeights(floorGuides));
		if (numbers.sill_height_m + numbers.window_height_m + numbers.lintel_height_m >= minimumFloorHeight) {
			throw grammarError("window dimensions cross a floor band");
		}
	}
	return {
		system: PUNCHED_FACADE_SYSTEM,
		surfaces,
		materials,
		corner_datum_m: numbers.corner_datum_m,
		bay_width_m: numbers.bay_width_m,
		window_width_m: numbers.window_width_m,
		window_height_m: numbers.window_height_m,
		sill_height_m: numbers.sill_height_m,
		reveal_depth_m: numbers.reveal_depth_m,
		frame_width_m: numbers.frame_width_m,
		lintel_height_m: numbers.lintel_height_m,
		sill_depth_m: numbers.sill_depth_m,
		cladding_depth_m: numbers.cladding_depth_m,
		brick_module_m: [...grammar.brick_module_m],
		confidence: numbers.confidence,
		unresolved_surfaces: [],
	};
}

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
	if (approvedDesign?.facade_grammar?.system === PUNCHED_FACADE_SYSTEM) {
		const grammar = validatePunchedFacadeGrammar(approvedDesign.facade_grammar, {
			floorGuides, allowMissingMaterials: true, allowDerived: true,
		});
		const planes = facadePlanes?.facade_planes;
		if (!Array.isArray(planes) || planes.length !== PUNCHED_FACADE_SURFACES.length) {
			throw grammarError("all canonical facade planes are required");
		}
		const facadeLengths = Object.fromEntries(planes.map((plane) => [plane.view, plane.extent_m?.[0]]));
		if (Object.keys(facadeLengths).length !== PUNCHED_FACADE_SURFACES.length
			|| PUNCHED_FACADE_SURFACES.some((surface) => !Number.isFinite(facadeLengths[surface]) || facadeLengths[surface] <= 0)) {
			throw grammarError("all canonical facade planes require finite positive extents");
		}
		return {
			...grammar,
			wall_opacity: "opaque",
			curtain_wall_allowed: false,
			floor_elevations_m: [...floorGuides.floor_guides_m],
			facade_lengths_m: facadeLengths,
		};
	}
	const grammar = { ...approvedDesign.facade_grammar };
	for (const [field, limits] of Object.entries(LIMITS)) {
		if (Object.hasOwn(grammar, field)) grammar[field] = clamp(grammar[field], limits);
	}
	grammar.floor_elevations_m = [...floorGuides.floor_guides_m];
	grammar.facade_lengths_m = Object.fromEntries(
		facadePlanes.facade_planes.map((plane) => [plane.view, plane.extent_m[0]]),
	);
	return grammar;
}

export function correctGrammar(grammar, failureCodes) {
	if (!Array.isArray(failureCodes) || failureCodes.some((code) => typeof code !== "string")
		|| new Set(failureCodes).size !== failureCodes.length) {
		throw grammarError("grammar failure codes must be a unique string array");
	}
	if (grammar?.system === PUNCHED_FACADE_SYSTEM) {
		const corrections = {
			WINDOW_CROSSES_FLOOR_BAND: (value) => ({ ...value, window_height_m: clamp(value.window_height_m * 0.85, LIMITS.window_height_m) }),
			DETAIL_BOUNDS_EXCEEDED: (value) => ({
				...value,
				cladding_depth_m: clamp(value.cladding_depth_m * 0.75, LIMITS.cladding_depth_m),
				reveal_depth_m: clamp(value.reveal_depth_m * 0.75, LIMITS.reveal_depth_m),
			}),
			CORNER_DATUM_MISMATCH: (value) => ({ ...value, corner_datum_m: 0 }),
			PRIMITIVE_BUDGET_EXCEEDED: (value) => ({ ...value, bay_width_m: clamp(value.bay_width_m * 1.25, LIMITS.bay_width_m) }),
		};
		let corrected = { ...grammar };
		for (const code of failureCodes) {
			if (!Object.hasOwn(corrections, code)) throw grammarError(`unrecognized grammar failure code: ${code}`);
			corrected = corrections[code](corrected);
		}
		return corrected;
	}
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
