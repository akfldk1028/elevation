import { sha256, stableJson } from "../../core.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { readVerifiedFacadeProgramAuthority } from "./contract.mjs";
import { readVerifiedResolvedFacadeAuthority, resolveFacadeProgram } from "./resolver.mjs";

const verifiedValidationAuthorities = new WeakMap();

export class FacadeDesignValidationError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignValidationError";
		this.code = "FACADE_DESIGN_VALIDATION_INVALID";
	}
}

function fail(message, cause) {
	throw new FacadeDesignValidationError(message, cause);
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function readVerifiedFacadeDesignValidationAuthority(value) {
	const authority = value && typeof value === "object" ? verifiedValidationAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

function rectanglesOverlap(left, right) {
	const u = Math.min(left.u_max, right.u_max) - Math.max(left.u_min, right.u_min);
	const z = Math.min(left.z_max, right.z_max) - Math.max(left.z_min, right.z_min);
	return u > 1e-8 && z > 1e-8 ? u * z : 0;
}

export function validateResolvedFacadeProgram({ program, context, resolved } = {}) {
	try {
		const programAuthority = readVerifiedFacadeProgramAuthority(program);
		const contextAuthority = readVerifiedFacadeDesignContextAuthority(context);
		const resolutionAuthority = readVerifiedResolvedFacadeAuthority(resolved);
		if (!programAuthority || !contextAuthority || !resolutionAuthority) {
			fail("verified facade program, context, and resolution capabilities are required");
		}
		if (stableJson(programAuthority) !== stableJson(contextAuthority)
			|| stableJson(resolutionAuthority) !== stableJson({ ...contextAuthority, resolution_sha256: resolved.resolution_sha256 })) {
			fail("facade validation authorities do not share one source");
		}
		const independentlyResolved = resolveFacadeProgram(program, context);
		if (stableJson(independentlyResolved) !== stableJson(resolved)) fail("resolved facade primitives do not match deterministic resolution");

		const codes = new Set();
		const measurements = [];
		const measure = (code, primitiveIndex, actual, limit) => {
			codes.add(code);
			if (measurements.length < 64) measurements.push({ code, primitive_index: primitiveIndex, actual: Number(actual.toFixed(8)), limit: Number(limit.toFixed(8)) });
		};
		const zoneIds = new Set(program.zones.map((zone) => zone.id));
		if (!["base", "middle", "top"].every((id) => zoneIds.has(id))) codes.add("HIERARCHY_MISSING");

		const segments = new Map(context.facade_segments.map((segment) => [segment.segment_id, segment]));
		const storeys = new Map(context.storeys.map((storey) => [storey.storey, storey]));
		const entrances = resolved.primitives.filter((primitive) => primitive.kind === "door" && primitive.role === "primary_entrance");
		if (entrances.length !== 1) codes.add("PRIMARY_ENTRANCE_INVALID");

		for (let index = 0; index < resolved.primitives.length; index += 1) {
			const primitive = resolved.primitives[index];
			const segment = segments.get(primitive.segment_id);
			const bounds = primitive.local_bounds;
			if (!segment || !bounds || ![bounds.u_min, bounds.u_max, bounds.z_min, bounds.z_max].every(Number.isFinite)
				|| bounds.u_min < 0 || bounds.u_max > (segment?.length_m ?? 0) || bounds.u_min >= bounds.u_max
				|| bounds.z_min < segment?.local_z?.[0] || bounds.z_max > segment?.local_z?.[1] || bounds.z_min >= bounds.z_max) {
				measure("SEGMENT_BOUNDS_INVALID", index, bounds?.u_max ?? Number.MAX_SAFE_INTEGER, segment?.length_m ?? 0);
				continue;
			}
			if (primitive.kind === "door" || primitive.kind === "window") {
				const edge = Math.min(bounds.u_min, segment.length_m - bounds.u_max);
				if (edge + 1e-8 < context.exclusions.fold_clearance_m) measure("FOLD_CLEARANCE_INVALID", index, edge, context.exclusions.fold_clearance_m);
				const storey = storeys.get(primitive.storey);
				if (!storey) measure("FLOOR_BAND_INTRUSION", index, primitive.storey ?? 0, context.storeys.length);
				else {
					const lowerLimit = primitive.kind === "door" && primitive.storey === 1 ? storey.z_min : storey.z_min + context.exclusions.floor_band_clearance_m;
					const upperLimit = storey.z_max - context.exclusions.floor_band_clearance_m;
					if (bounds.z_min < lowerLimit - 1e-8) measure("FLOOR_BAND_INTRUSION", index, bounds.z_min, lowerLimit);
					if (bounds.z_max > upperLimit + 1e-8) measure("FLOOR_BAND_INTRUSION", index, bounds.z_max, upperLimit);
				}
			}
			const depthLimit = primitive.kind === "door" ? context.exclusions.max_recess_m : context.exclusions.max_projection_m;
			if (!Number.isFinite(primitive.depth_m) || primitive.depth_m < 0 || primitive.depth_m > depthLimit) {
				measure("PROJECTION_LIMIT_EXCEEDED", index, primitive.depth_m ?? Number.MAX_SAFE_INTEGER, depthLimit);
			}
		}

		if (entrances.length === 1) {
			const entrance = entrances[0];
			const segment = segments.get(entrance.segment_id);
			const ground = context.storeys[0];
			if (!segment?.ground_access || entrance.storey !== 1 || entrance.local_bounds.z_min !== ground?.z_min) codes.add("PRIMARY_ENTRANCE_INVALID");
		}

		const collidable = new Set(["door", "window", "pilaster", "band", "cornice"]);
		for (let leftIndex = 0; leftIndex < resolved.primitives.length; leftIndex += 1) {
			const left = resolved.primitives[leftIndex];
			if (!collidable.has(left.kind)) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < resolved.primitives.length; rightIndex += 1) {
				const right = resolved.primitives[rightIndex];
				if (right.segment_id !== left.segment_id || !collidable.has(right.kind)) continue;
				const overlap = rectanglesOverlap(left.local_bounds, right.local_bounds);
				if (overlap > 0) measure("PRIMITIVE_OVERLAP", rightIndex, overlap, 0);
				else if ((left.kind === "door" || left.kind === "window") && (right.kind === "door" || right.kind === "window")) {
					const verticalOverlap = Math.min(left.local_bounds.z_max, right.local_bounds.z_max)
						- Math.max(left.local_bounds.z_min, right.local_bounds.z_min);
					const gap = Math.max(right.local_bounds.u_min - left.local_bounds.u_max, left.local_bounds.u_min - right.local_bounds.u_max);
					if (verticalOverlap > 1e-8 && gap >= 0 && gap + 1e-8 < context.exclusions.edge_clearance_m) {
						measure("OPENING_CLEARANCE_INVALID", rightIndex, gap, context.exclusions.edge_clearance_m);
					}
				}
			}
		}

		const sortedCodes = [...codes].sort();
		const receiptBase = {
			schema_version: "arr.elevation3d.facade-design-validation.v1",
			accepted: sortedCodes.length === 0,
			codes: sortedCodes,
			measurements,
			source: { ...contextAuthority },
			resolution_sha256: resolved.resolution_sha256,
		};
		const receipt = deepFreeze({ ...receiptBase, validation_sha256: sha256(stableJson(receiptBase)) });
		verifiedValidationAuthorities.set(receipt, Object.freeze({
			...contextAuthority,
			resolution_sha256: resolved.resolution_sha256,
			validation_sha256: receipt.validation_sha256,
			accepted: receipt.accepted,
		}));
		return receipt;
	} catch (error) {
		if (error instanceof FacadeDesignValidationError) throw error;
		fail("facade design validation failed", error);
	}
}
