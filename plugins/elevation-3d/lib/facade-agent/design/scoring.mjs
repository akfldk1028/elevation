import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";

import { sha256 } from "../../core.mjs";
import { SCORE_LIMITS } from "./critic.mjs";

const OPENING_KINDS = new Set(["door", "window"]);
const TRIM_KINDS = new Set(["window-frame", "reveal", "lintel", "sill", "band"]);
const TRIM_GAP_M = 0.08;
const TARGET_OPENING_RATIO = 0.2;
const MINIMUM_ENTRANCE_AREA_RATIO = 2;

export class FacadeDesignScoringError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignScoringError";
		this.code = "FACADE_DESIGN_SCORING_INVALID";
	}
}

function clamp01(value) {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function mean(values) {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(value) {
	return Math.min(100, Math.max(0, Math.round(clamp01(value) * 100)));
}

function area(primitive) {
	const bounds = primitive.local_bounds;
	return (bounds.u1 - bounds.u0) * (bounds.v1 - bounds.v0);
}

export function readTypedFacadePrimitives(document) {
	return document.getRoot().listMeshes()
		.flatMap((mesh) => mesh.listPrimitives())
		.map((primitive) => primitive.getExtras())
		.filter((extras) => extras && typeof extras.kind === "string" && typeof extras.segment_id === "string"
			&& extras.local_bounds && Number.isFinite(extras.local_bounds.u0));
}

export function scoreFacadeDesign({ context, artifacts, primitives } = {}) {
	if (!context?.facade_segments?.length || !context.storeys?.length) fail("a verified facade design context is required");
	if (!Array.isArray(primitives)) fail("typed facade primitives are required");
	const segments = new Map(context.facade_segments.map((segment) => [segment.segment_id, segment]));
	const openings = primitives.filter((primitive) => OPENING_KINDS.has(primitive.kind));
	// An opening counts as trimmed when a jamb, sill or lintel sits against it. Older
	// designs get their trim from the compiler, which tags it with the opening's own
	// index; a grammar draws its own, so the test is geometric adjacency rather than a
	// shared index, and both read the same way.
	const trims = primitives.filter((primitive) => TRIM_KINDS.has(primitive.kind));
	const touches = (opening, trim) => {
		if (trim.segment_id !== opening.segment_id) return false;
		const a = opening.local_bounds, b = trim.local_bounds;
		const uOverlap = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
		const zOverlap = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
		const uGap = Math.max(b.u0 - a.u1, a.u0 - b.u1);
		const zGap = Math.max(b.v0 - a.v1, a.v0 - b.v1);
		if (zOverlap > 1e-6 && uGap <= TRIM_GAP_M && uGap > -TRIM_GAP_M) return true;
		return uOverlap > 1e-6 && zGap <= TRIM_GAP_M && zGap > -TRIM_GAP_M;
	};
	const framed = new Set();
	for (const primitive of primitives) {
		if (!OPENING_KINDS.has(primitive.kind)) continue;
		if (trims.some((trim) => touches(primitive, trim))
			|| primitives.some((other) => other.kind === "window-frame"
				&& other.design_primitive_index === primitive.design_primitive_index)) {
			framed.add(primitive.design_primitive_index);
		}
	}
	const storeyNumbers = context.storeys.map((storey) => storey.storey);
	const storeyOf = (primitive) => {
		const segment = segments.get(primitive.segment_id);
		if (!segment) return null;
		const z = segment.local_z[0] + primitive.local_bounds.v0;
		return context.storeys.find((storey) => z >= storey.z_min - 1e-6 && z < storey.z_max - 1e-6)?.storey ?? null;
	};

	const doors = openings.filter((primitive) => primitive.kind === "door" && primitive.role === "primary_entrance");
	const windows = openings.filter((primitive) => primitive.kind === "window");
	const windowAreas = windows.map(area).sort((left, right) => left - right);
	const medianWindowArea = windowAreas.length ? windowAreas[Math.floor(windowAreas.length / 2)] : 0;
	const groundSegments = context.facade_segments.filter((segment) => segment.ground_access);
	const bestGroundVisibility = groundSegments.length
		? Math.max(...groundSegments.map((segment) => segment.visibility_score)) : null;
	const entrance = doors.length === 1
		? mean([
			segments.get(doors[0].segment_id)?.visibility_score === bestGroundVisibility ? 1 : 0,
			medianWindowArea > 0 ? clamp01(area(doors[0]) / (MINIMUM_ENTRANCE_AREA_RATIO * medianWindowArea)) : 1,
			framed.has(doors[0].design_primitive_index) ? 1 : 0,
		])
		: 0;

	const openStoreys = new Set(openings.map(storeyOf).filter((storey) => storey !== null));
	const hierarchy = mean([
		openStoreys.size / storeyNumbers.length,
		openStoreys.has(storeyNumbers[0]) ? 1 : 0,
		openStoreys.has(storeyNumbers[storeyNumbers.length - 1]) ? 1 : 0,
	]);

	const signatures = new Map();
	for (const primitive of openings) {
		const entry = signatures.get(primitive.segment_id) ?? [];
		const width = (primitive.local_bounds.u1 - primitive.local_bounds.u0).toFixed(3);
		entry.push(`${storeyOf(primitive)}:${primitive.kind}:${primitive.family_id ?? "-"}:${width}`);
		signatures.set(primitive.segment_id, entry);
	}
	const distinctSignatures = new Set([...signatures.values()].map((entry) => [...entry].sort().join("|")));
	const facadeArea = context.facade_segments
		.reduce((sum, segment) => sum + segment.length_m * (segment.local_z[1] - segment.local_z[0]), 0);
	const openingArea = openings.reduce((sum, primitive) => sum + area(primitive), 0);
	const openingRatio = facadeArea > 0 ? openingArea / facadeArea : 0;
	const balance = mean([
		clamp01(new Set(windows.map((primitive) => primitive.family_id)).size / 2),
		clamp01(openingRatio / TARGET_OPENING_RATIO),
		1 - clamp01(distinctSignatures.size / Math.max(1, signatures.size)),
	]);

	const framedRatio = openings.length ? framed.size / openings.length : 0;
	const materialHierarchy = mean([
		framedRatio,
		clamp01(new Set(primitives.map((primitive) => primitive.material)).size / 3),
	]);

	const views = Object.values(artifacts?.technical_views ?? {});
	const viewHashes = new Set(views.map((view) => view.sha256));
	const distinctViews = views.length === 8 && viewHashes.size === views.length;
	const crossView = mean([views.length === 8 ? 1 : 0, views.length ? viewHashes.size / views.length : 0]);
	const consistency = mean([
		artifacts?.perspective_hero?.sha256 ? 1 : 0,
		artifacts?.pbr_contact_sheet?.sha256 ? 1 : 0,
		distinctViews ? 1 : 0,
	]);

	const scores = {
		entrance_legibility: percent(entrance),
		base_middle_top_hierarchy: percent(hierarchy),
		repetition_variation_balance: percent(balance),
		cross_view_coherence: percent(crossView),
		material_hierarchy: percent(materialHierarchy),
		technical_perspective_consistency: percent(consistency),
	};
	const metrics = {
		openings: openings.length,
		framed_openings: framed.size,
		open_storeys: openStoreys.size,
		total_storeys: storeyNumbers.length,
		distinct_segment_signatures: distinctSignatures.size,
		segments_with_openings: signatures.size,
		opening_area_ratio: Number(openingRatio.toFixed(6)),
	};
	const notes = [
		`Openings ${metrics.openings} on ${metrics.segments_with_openings}/${context.facade_segments.length} segments, ${metrics.framed_openings} framed.`,
		`Storeys with openings ${metrics.open_storeys}/${metrics.total_storeys}; opening area ratio ${metrics.opening_area_ratio}.`,
		`Distinct segment rhythms ${metrics.distinct_segment_signatures}; primary entrances ${doors.length}.`,
	];
	return { scores, notes, metrics };
}

function fail(message, cause) {
	throw new FacadeDesignScoringError(message, cause);
}

export function createFacadeDesignCritic() {
	return async function facadeDesignCritic({ sourceSha256, context, compiled, artifacts } = {}) {
		if (typeof compiled?.output?.path !== "string" || typeof compiled.output.sha256 !== "string") {
			fail("a compiled facade manifest is required");
		}
		let bytes;
		try { bytes = await readFile(compiled.output.path); }
		catch (error) { fail("compiled facade GLB is unavailable", error); }
		if (sha256(bytes) !== compiled.output.sha256) fail("compiled facade GLB does not match its manifest");
		let document;
		try { document = await new NodeIO().readBinary(new Uint8Array(bytes)); }
		catch (error) { fail("compiled facade GLB is not readable", error); }
		const { scores, notes } = scoreFacadeDesign({ context, artifacts, primitives: readTypedFacadePrimitives(document) });
		return {
			source_sha256: sourceSha256,
			accepted: Object.entries(SCORE_LIMITS).every(([name, minimum]) => scores[name] >= minimum),
			scores,
			notes,
		};
	};
}
