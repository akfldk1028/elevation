import { sha256, stableJson } from "../../core.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { readVerifiedFacadeProgramAuthority } from "./contract.mjs";
import { deriveFacadePrimitives } from "./grammar/derive.mjs";

const verifiedResolutionAuthorities = new WeakMap();

export function readVerifiedResolvedFacadeAuthority(value) {
	const authority = value && typeof value === "object" ? verifiedResolutionAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

export class FacadeDesignResolverError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignResolverError";
		this.code = "FACADE_DESIGN_RESOLUTION_INVALID";
	}
}

function fail(message, cause) {
	throw new FacadeDesignResolverError(message, cause);
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function round(value) {
	return Number(value.toFixed(8));
}

function rankedSegments(context, minimumWidth, groundOnly = false) {
	const fold = context.exclusions.fold_clearance_m;
	return context.facade_segments
		.filter((segment) => (!groundOnly || segment.ground_access) && segment.length_m >= minimumWidth + fold * 2)
		.sort((left, right) => right.visibility_score - left.visibility_score
			|| right.length_m - left.length_m || left.segment_id.localeCompare(right.segment_id));
}

function entrancePrimitive(program, context) {
	const candidates = rankedSegments(context, program.entrance.width_m, true);
	if (!candidates.length) fail("no ground-access facade segment can contain the primary entrance");
	const segment = candidates[0];
	const fold = context.exclusions.fold_clearance_m;
	let uMin;
	if (program.entrance.preferred_bay === "corner_focus") uMin = fold;
	else if (program.entrance.preferred_bay === "central_or_corner_focus"
		&& segment.length_m < program.entrance.width_m * 2 + fold * 2) uMin = fold;
	else uMin = (segment.length_m - program.entrance.width_m) / 2;
	const ground = context.storeys[0];
	if (!ground || ground.z_min + program.entrance.height_m > ground.z_max) fail("primary entrance does not fit within storey 1");
	return {
		kind: "door",
		segment_id: segment.segment_id,
		local_bounds: {
			u_min: round(uMin), u_max: round(uMin + program.entrance.width_m),
			z_min: ground.z_min, z_max: round(ground.z_min + program.entrance.height_m),
		},
		depth_m: program.entrance.recess_m,
		family_id: program.entrance.door_family,
		role: "primary_entrance",
		storey: 1,
	};
}

function displacedByEntrance(entrance, segmentId, bounds, gap) {
	if (entrance.segment_id !== segmentId) return false;
	const door = entrance.local_bounds;
	const horizontal = Math.min(bounds.u_max, door.u_max + gap) - Math.max(bounds.u_min, door.u_min - gap);
	const vertical = Math.min(bounds.z_max, door.z_max) - Math.max(bounds.z_min, door.z_min);
	return horizontal > 1e-8 && vertical > 1e-8;
}

function windowPrimitives(program, context, entrance) {
	const zones = new Map(program.zones.map((zone) => [zone.id, zone]));
	const families = new Map(program.window_families.map((family) => [family.id, family]));
	const storeys = new Map(context.storeys.map((storey) => [storey.storey, storey]));
	const gap = context.exclusions.edge_clearance_m;
	const fold = context.exclusions.fold_clearance_m;
	const primitives = [];
	for (const rule of program.bay_rules) {
		const zone = zones.get(rule.zone_id);
		if (!zone) fail(`bay rule ${rule.id} references a missing zone`);
		const unit = rule.pattern.map((id) => families.get(id));
		if (unit.some((family) => !family)) fail(`bay rule ${rule.id} references a missing window family`);
		const unitWidth = unit.reduce((sum, family) => sum + family.width_m, 0) + gap * (unit.length - 1);
		const eligible = rankedSegments(context, unitWidth * rule.repeat + gap * (rule.repeat - 1));
		const segments = eligible.filter((segment) => rule.views.includes(segment.face_view));
		if (!segments.length) fail(`bay rule ${rule.id} does not fit any facade segment on its selected views`);
		for (const segment of segments) {
			const usable = segment.length_m - fold * 2;
			const count = Math.floor((usable + gap) / (unitWidth + gap) + 1e-9);
			const slack = usable - unitWidth * count;
			const spacing = count > 1 ? slack / (count - 1) : 0;
			const start = count > 1 ? fold : fold + slack / 2;
			for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
				let cursor = start + unitIndex * (unitWidth + spacing);
				for (let patternIndex = 0; patternIndex < unit.length; patternIndex += 1) {
					const family = unit[patternIndex];
					for (const storeyNumber of zone.storeys) {
						const storey = storeys.get(storeyNumber);
						if (!storey) fail(`zone ${zone.id} references a missing storey`);
						const zMin = storey.z_min + family.sill_m;
						const zMax = zMin + family.height_m;
						if (zMax > storey.z_max) fail(`window family ${family.id} does not fit storey ${storeyNumber}`);
						const bounds = { u_min: round(cursor), u_max: round(cursor + family.width_m), z_min: round(zMin), z_max: round(zMax) };
						if (displacedByEntrance(entrance, segment.segment_id, bounds, gap)) continue;
						primitives.push({
							kind: "window", segment_id: segment.segment_id, local_bounds: bounds,
							depth_m: 0, family_id: family.id, zone_id: zone.id, rule_id: rule.id,
							storey: storeyNumber, pattern_index: patternIndex,
						});
					}
					cursor += family.width_m + gap;
				}
			}
		}
	}
	return primitives;
}

function articulationPrimitives(program, context, primarySegmentId) {
	const storeys = new Map(context.storeys.map((storey) => [storey.storey, storey]));
	const output = [];
	for (const item of program.articulation) {
		let segments;
		if (item.segment_selector === "primary_visible_segment") {
			segments = context.facade_segments.filter((segment) => segment.segment_id === primarySegmentId);
		} else if (item.segment_selector === "all_visible_folds") {
			segments = context.facade_segments.filter((segment) => segment.visibility_score > 0);
		} else segments = [...context.facade_segments];
		if (!segments.length) fail(`articulation ${item.id} has no eligible facade segment`);
		const selectedStoreys = item.storeys.map((number) => storeys.get(number));
		if (selectedStoreys.some((storey) => !storey)) fail(`articulation ${item.id} references a missing storey`);
		const zMin = Math.min(...selectedStoreys.map((storey) => storey.z_min));
		const zMax = Math.max(...selectedStoreys.map((storey) => storey.z_max));
		for (const segment of segments) {
			if (item.width_m > segment.length_m) fail(`articulation ${item.id} exceeds its facade segment`);
			output.push({
				kind: item.kind, segment_id: segment.segment_id,
				local_bounds: { u_min: 0, u_max: item.width_m, z_min: zMin, z_max: zMax },
				depth_m: item.depth_m, material_id: item.material_id, articulation_id: item.id,
				storeys: [...item.storeys],
			});
		}
	}
	return output;
}

function grammarPrimitives(program, context, entrance) {
	const gap = context.exclusions.edge_clearance_m;
	const fold = context.exclusions.fold_clearance_m;
	const primitives = [];
	for (const segment of context.facade_segments) {
		const derived = deriveFacadePrimitives({
			grammar: program,
			segment: { ...segment, placeable: { u_min: fold, u_max: segment.length_m - fold } },
			storeys: context.storeys,
		});
		for (const primitive of derived) {
			if (primitive.kind === "door") continue;
			if (displacedByEntrance(entrance, segment.segment_id, primitive.local_bounds, gap)) continue;
			primitives.push(primitive);
		}
	}
	return primitives;
}

/**
 * Resolve whichever design language the program is written in.
 *
 * v2 lays out bay rules; v3 derives a split grammar. Both produce the same frozen
 * resolution behind the same capability, so the validator, compiler and scorer never
 * learn which one was used.
 */
export function resolveFacadeProgram(program, context) {
	try {
		const programAuthority = readVerifiedFacadeProgramAuthority(program);
		const contextAuthority = readVerifiedFacadeDesignContextAuthority(context);
		if (!programAuthority || !contextAuthority) fail("verified facade program and context capabilities are required");
		if (stableJson(programAuthority) !== stableJson(contextAuthority)
			|| stableJson(program.source) !== stableJson(contextAuthority)
			|| stableJson(context.source) !== stableJson(contextAuthority)) {
			fail("facade program source authority does not match its verified context");
		}
		const entrance = entrancePrimitive(program, context);
		const primitives = program.schema_version === "arr.elevation3d.facade-grammar.v3"
			? [entrance, ...grammarPrimitives(program, context, entrance)]
			: [
				entrance,
				...windowPrimitives(program, context, entrance),
				...articulationPrimitives(program, context, entrance.segment_id),
			];
		if (primitives.length > 2_048) fail("resolved facade primitive budget exceeded");
		const resolution = {
			schema_version: "arr.elevation3d.resolved-facade-program.v1",
			concept_id: program.concept_id,
			source: { ...contextAuthority },
			primitives,
		};
		const resolved = deepFreeze({ ...resolution, resolution_sha256: sha256(stableJson(resolution)) });
		verifiedResolutionAuthorities.set(resolved, Object.freeze({ ...contextAuthority, resolution_sha256: resolved.resolution_sha256 }));
		return resolved;
	} catch (error) {
		if (error instanceof FacadeDesignResolverError) throw error;
		fail("facade program resolution failed", error);
	}
}
