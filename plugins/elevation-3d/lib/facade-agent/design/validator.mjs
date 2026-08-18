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
		// v2 declares base/middle/top as zones; v3 has no zone list, so the same
		// requirement is read off the resolution instead - the lowest and the highest
		// storey must both carry an opening.
		if (program.zones) {
			const zoneIds = new Set(program.zones.map((zone) => zone.id));
			if (!["base", "middle", "top"].every((id) => zoneIds.has(id))) codes.add("HIERARCHY_MISSING");
		} else {
			// An opening is credited to every storey its height overlaps, not only the
			// one it starts in: a spanning slot lights all of them.
			const open = new Set();
			for (const primitive of resolved.primitives) {
				if (primitive.kind !== "door" && primitive.kind !== "window") continue;
				for (const storey of context.storeys) {
					const overlap = Math.min(primitive.local_bounds.z_max, storey.z_max)
						- Math.max(primitive.local_bounds.z_min, storey.z_min);
					if (overlap > 1e-6) open.add(storey.storey);
				}
			}
			// Only the highest storey is asked about. The lowest-storey half could never fire:
			// `resolveFacadeProgram` prepends the deterministic entrance unconditionally and
			// `entrancePrimitive` throws unless it fits inside storey one, so an opening always
			// overlaps the ground storey whatever the grammar wrote. It was a fossil of the v2
			// zone check it sits opposite, and it read as a rule forbidding a solid plinth.
			const numbers = context.storeys.map((storey) => storey.storey);
			if (!open.has(numbers[numbers.length - 1])) codes.add("HIERARCHY_MISSING");
		}

		const segments = new Map(context.facade_segments.map((segment) => [segment.segment_id, segment]));
		const storeys = new Map(context.storeys.map((storey) => [storey.storey, storey]));
		const entrances = resolved.primitives.filter((primitive) => primitive.kind === "door" && primitive.role === "primary_entrance");
		if (entrances.length !== 1) codes.add("PRIMARY_ENTRANCE_INVALID");

		const skinSegments = new Set(resolved.primitives
			.filter((primitive) => primitive.kind === "mullion" || primitive.kind === "transom" || primitive.kind === "spandrel")
			.map((primitive) => primitive.segment_id));
		const framedToFold = (primitive, segment, atLowEdge) => resolved.primitives.some((member) => {
			// Either solid skin member answers for the corner. A mullion is the obvious one,
			// but a precast pier standing at the fold is the stronger return, and keying the
			// rule to one word rejected the scheme that did it properly. `transom` is excluded:
			// it is a horizontal member and cannot stand in for the turn.
			if ((member.kind !== "mullion" && member.kind !== "spandrel") || member.segment_id !== primitive.segment_id) return false;
			const covers = atLowEdge
				? member.local_bounds.u_min <= 1e-8 && member.local_bounds.u_max + 1e-8 >= primitive.local_bounds.u_min
				: member.local_bounds.u_max + 1e-8 >= segment.length_m && member.local_bounds.u_min <= primitive.local_bounds.u_max + 1e-8;
			if (!covers) return false;
			return Math.min(member.local_bounds.z_max, primitive.local_bounds.z_max)
				- Math.max(member.local_bounds.z_min, primitive.local_bounds.z_min) > 1e-8;
		});
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
				// A hole must stay off the fold because cutting one through a turn breaks the
				// mass. That is an argument about punching a solid wall, and a glazed skin is
				// not doing that: its corner glass replaces the mass rather than piercing it,
				// and the corner mullion is the return. So on a segment carrying a skin the
				// requirement is not 0.3 m of bare mass, it is that the strip be framed - a
				// mullion that runs to the facet edge and overlaps the pane in height.
				const edge = Math.min(bounds.u_min, segment.length_m - bounds.u_max);
				if (edge + 1e-8 < context.exclusions.fold_clearance_m
					&& !(primitive.kind === "window" && skinSegments.has(primitive.segment_id)
						&& framedToFold(primitive, segment, bounds.u_min <= segment.length_m - bounds.u_max))) {
					measure("FOLD_CLEARANCE_INVALID", index, edge, context.exclusions.fold_clearance_m);
				}
				// An opening must not start or finish inside a floor band, because that is
				// where the slab lands. It may pass a slab on its way - a double-height
				// lobby and a vertical slot both do - so the test is on the two ends
				// rather than on fitting inside one storey. Requiring containment is what
				// makes every facade read as stacked identical cells.
				const clearance = context.exclusions.floor_band_clearance_m;
				const inBand = (z) => context.storeys.some((storey) => {
					const atGrade = primitive.kind === "door" && Math.abs(z - context.storeys[0].z_min) <= 1e-8;
					if (atGrade) return false;
					return (z > storey.z_min - clearance - 1e-8 && z < storey.z_min + clearance - 1e-8)
						|| (z > storey.z_max - clearance + 1e-8 && z < storey.z_max + clearance + 1e-8);
				});
				const top = context.storeys[context.storeys.length - 1].z_max;
				if (bounds.z_min < context.storeys[0].z_min - 1e-8 || bounds.z_max > top + 1e-8) {
					measure("FLOOR_BAND_INTRUSION", index, bounds.z_max, top);
				} else if (inBand(bounds.z_min)) measure("FLOOR_BAND_INTRUSION", index, bounds.z_min, clearance);
				else if (inBand(bounds.z_max)) measure("FLOOR_BAND_INTRUSION", index, bounds.z_max, clearance);
			}
			const depthLimit = primitive.kind === "door" ? context.exclusions.max_recess_m : context.exclusions.max_projection_m;
			// A solid member needs a thickness. `boxGeometry` in punched-facade.mjs throws on
			// `Math.abs(n1 - n0) <= EPSILON`, so a member written with `depth_m: 0` passes every
			// gate here and then kills the compiler with "detail prism has non-positive
			// dimensions" - which is a stack trace, not a fault code, so the correction loop
			// never sees it and the author cannot repair it. Both repo-blind authors wrote it.
			// Openings are exempt because they are cut rather than built: glass and the door
			// take their depth from the reveal around them and several accepted grammars leave
			// them at zero.
			const mustHaveThickness = primitive.kind !== "glass" && primitive.kind !== "window" && primitive.kind !== "door";
			if (!Number.isFinite(primitive.depth_m) || primitive.depth_m < 0 || primitive.depth_m > depthLimit
				|| (mustHaveThickness && primitive.depth_m <= 0)) {
				measure("PROJECTION_LIMIT_EXCEEDED", index, primitive.depth_m ?? Number.MAX_SAFE_INTEGER, depthLimit);
			}
		}

		if (entrances.length === 1) {
			const entrance = entrances[0];
			const segment = segments.get(entrance.segment_id);
			const ground = context.storeys[0];
			if (!segment?.ground_access || entrance.storey !== 1 || entrance.local_bounds.z_min !== ground?.z_min) codes.add("PRIMARY_ENTRANCE_INVALID");
		}

		// Deliberately excludes mullion, transom and spandrel. A curtain wall's framing sits
		// over its glass by construction - that is what a framed surface is - so putting the
		// skin members in here would reject every curtain wall on contact. This has read as an
		// oversight once already; it is not one.
		const collidable = new Set(["door", "window", "pilaster", "band", "cornice"]);
		// A framing member between two panes is what separates them on a glazed skin. The
		// clearance rule below asks for bare wall between two openings, which is the right
		// question for two holes cut in masonry and the wrong one for one framed surface: it
		// left a facet buildable only as a single pane, or as a grid whose mullions were wider
		// than its glass. A mullion that spans the gap is the separation.
		const mullionSpans = (left, right) => resolved.primitives.some((primitive) => primitive.kind !== "mullion"
			|| primitive.segment_id !== left.segment_id ? false : (
			primitive.local_bounds.u_min + 1e-8 >= Math.min(left.local_bounds.u_max, right.local_bounds.u_max)
			&& primitive.local_bounds.u_max - 1e-8 <= Math.max(left.local_bounds.u_min, right.local_bounds.u_min)
			&& Math.min(primitive.local_bounds.z_max, left.local_bounds.z_max, right.local_bounds.z_max)
				- Math.max(primitive.local_bounds.z_min, left.local_bounds.z_min, right.local_bounds.z_min) > 1e-8));
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
					if (verticalOverlap > 1e-8 && gap >= 0 && gap + 1e-8 < context.exclusions.edge_clearance_m
						&& !mullionSpans(left, right)) {
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
