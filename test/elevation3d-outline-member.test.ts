import assert from "node:assert/strict";
import test from "node:test";

import { buildTypedFacadeDetails } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { polygonArea, verifyPrism } from "../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs";
import { parseFacadeGrammar } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";
import { FACADE_GRAMMAR_V3_SCHEMA } from "../plugins/elevation-3d/lib/facade-agent/design/grammar/prompt.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

/**
 * The four links a new grammar field has to travel, walked end to end.
 *
 * The fourth is a whitelist inside `pushDetail` that silently drops what it does not name, and
 * it is how the diagonal once parsed, validated, derived and still drew 312 rectangles: 799
 * primitives "accepted" and not one triangle in the file. So this walks a written outline from
 * the contract to the triangles, and the last assertion is about the geometry, not the gate.
 */
const HEXAGON = Array.from({ length: 6 }, (_, index) => {
	const angle = (Math.PI / 3) * index;
	return [0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle)];
});

test("link 1: the contract parses an outline and refuses one with no inside", () => {
	const program = (outline: unknown) => ({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "outline-probe", start: "F",
		design_rationale: ["probe"],
		rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "louvre", inset_m: 0, depth_m: 0.12, outline }] }],
	});
	const parsed = parseFacadeGrammar(program(HEXAGON) as any);
	assert.equal(parsed.rules.F[0].outline.length, 6);
	assert.ok(Object.isFrozen(parsed.rules.F[0].outline));

	assert.throws(() => parseFacadeGrammar(program([[0, 0], [1, 1], [1, 0], [0, 1]]) as any), /closed loop/);
	assert.throws(() => parseFacadeGrammar(program([[0, 0], [1.2, 0], [1, 1]]) as any), /0\.\.1/);
	assert.throws(() => parseFacadeGrammar(program([[0, 0], [1, 0]]) as any), /between 3 and 32/);
	// A shape on a word that has no shape, or already has one.
	assert.throws(() => parseFacadeGrammar({
		...program(HEXAGON), rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "wall", inset_m: 0, depth_m: 0, outline: HEXAGON }] }],
	} as any), /emits no geometry/);
	assert.throws(() => parseFacadeGrammar({
		...program(HEXAGON), rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "spandrel", inset_m: 0, depth_m: 0.1, outline: HEXAGON, diagonal: "rising" }] }],
	} as any), /diagonal/);
});

test("link 2: the deriver carries it onto every primitive", () => {
	const grammar = parseFacadeGrammar({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "outline-probe", start: "F",
		design_rationale: ["probe"],
		rules: [
			{ name: "F", alternatives: [{ when: null, split: { axis: "u", parts: [{ size: "~1.0", symbol: "C", arg: null, repeat: true, grade: null }] }, terminal: null }] },
			{ name: "C", alternatives: [{ when: null, split: null, terminal: "louvre", inset_m: 0, depth_m: 0.12, outline: HEXAGON }] },
		],
	} as any);
	const derived = deriveFacadePrimitives({
		grammar,
		segment: { segment_id: "s", length_m: 6, local_z: [0, 3.3], face_offset_m: 0, origin_m: [0, 0, 0], outward_normal: [0, -1, 0], face_view: "front", face_index: 0, face_total: 1 },
		storeys: [{ storey: 1, z_min: 0, z_max: 3.3 }],
	});
	assert.ok(derived.length > 1);
	assert.equal(derived.filter((primitive: any) => primitive.outline).length, derived.length);
});

test("links 3 and 4: the outline reaches the triangles, and the solid is a hexagonal prism", async (t) => {
	const { mesh, floorGuides, facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const segment = context.facade_segments[0];
	const bounds = { u_min: 0.6, u_max: 1.6, z_min: 0.6, z_max: 1.6 };
	const build = (extra: object) => buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority,
		primitives: [{ kind: "louvre", segment_id: segment.segment_id, local_bounds: bounds, depth_m: 0.2, ...extra }],
	});

	const box = build({}).find((detail: any) => detail.kind === "louvre");
	const hexagonal = build({ outline: HEXAGON }).find((detail: any) => detail.kind === "louvre");
	assert.ok(box && hexagonal);

	// The whitelist link: if `outline` never travels it, this member is a box and everything
	// upstream still reports success. A box has 12 triangles; a hexagonal prism has 4n-4 = 20.
	assert.equal(box.indices.length, 12, "a plain member is still a box");
	assert.equal(hexagonal.indices.length, 20, "the outline reached the geometry");
	assert.equal(hexagonal.positions.length, 12, "2n vertices");

	// And it is a real solid, measured the same way the primitive's own proofs measure it.
	const verified = verifyPrism(hexagonal);
	assert.equal(verified.euler, 2);
	assert.equal(verified.closed, true);
	assert.equal(verified.outward, true);
	const expected = polygonArea(HEXAGON)
		* (bounds.u_max - bounds.u_min) * (bounds.z_max - bounds.z_min) * 0.2;
	assert.ok(Math.abs(verified.volume - expected) < 1e-9, `${verified.volume} vs ${expected}`);
});

test("link 5: the author can read about it, or it does not exist", () => {
	// A field the engine honours and the brief never mentions is unreachable - every operator
	// this grammar has gained was found by an author reading for it.
	const alternative = (FACADE_GRAMMAR_V3_SCHEMA as any).$defs.alternative;
	assert.ok(alternative.properties.outline, "the schema carries it");
	assert.ok(alternative.required.includes("outline"));
	assert.equal(alternative.properties.outline.maxItems, 32);
	assert.match(alternative.properties.outline.description, /concave/i);
});

test("standoff and taper travel the same four links", async (t) => {
	const { mesh, floorGuides, facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const segment = context.facade_segments[0];
	const bounds = { u_min: 0.6, u_max: 1.6, z_min: 0.6, z_max: 1.6 };
	const build = (extra: object) => buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority,
		primitives: [{ kind: "louvre", segment_id: segment.segment_id, local_bounds: bounds, depth_m: 0.2, ...extra }],
	}).find((detail: any) => detail.kind === "louvre");

	// STANDOFF: the near face moves off the wall and the member keeps its own thickness. On the
	// wall a member runs n 0..0.2; stood off 0.9 it runs 0.9..1.1, and the air behind it is
	// what makes a veil a veil.
	const onWall = build({});
	const stoodOff = build({ standoff_m: 0.9 });
	assert.equal(onWall.local_bounds.n0, 0);
	assert.ok(Math.abs(stoodOff.local_bounds.n0 - 0.9) < 1e-9, `${stoodOff.local_bounds.n0}`);
	assert.ok(Math.abs((stoodOff.local_bounds.n1 - stoodOff.local_bounds.n0) - 0.2) < 1e-9, "thickness is unchanged");

	// TAPER: the far cap is a different shape, so the member is a funnel rather than a tube.
	const mouth = HEXAGON;
	const throat = HEXAGON.map(([u, v]) => [0.5 + (u - 0.5) * 0.3, 0.5 + (v - 0.5) * 0.3]);
	const funnel = build({ outline: mouth, outline_far: throat });
	assert.equal(funnel.indices.length, 20, "same topology as a straight hexagonal prism");
	const { prismatoidVolume } = await import("../plugins/elevation-3d/lib/facade-agent/polygon-prism.mjs");
	const expected = prismatoidVolume(mouth, throat, 0.2)
		* (bounds.u_max - bounds.u_min) * (bounds.z_max - bounds.z_min);
	const verified = verifyPrism(funnel);
	assert.equal(verified.closed, true);
	assert.equal(verified.euler, 2);
	assert.ok(Math.abs(verified.volume - expected) < 1e-9, `${verified.volume} vs ${expected}`);
	// And it is genuinely smaller than the tube it would have been.
	assert.ok(verified.volume < verifyPrism(build({ outline: mouth })).volume);
});

/**
 * The angle a hole is cut at, walked the same way - and the last link here is the RENDERER,
 * which is the fifth and the one `outline` itself stopped at: it parsed, derived, cleared the
 * whitelist and built correct lens geometry while `holeCut` went on cutting a box.
 */
test("scoop_deg travels to the cut axis, and is refused where there is no hole", async (t) => {
	const program = (extra: object) => ({
		schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "scoop-probe", start: "F",
		design_rationale: ["probe"],
		rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "glass", inset_m: 0, depth_m: -0.4, ...extra }] }],
	});
	assert.equal(parseFacadeGrammar(program({ scoop_deg: 20 }) as any).rules.F[0].scoop_deg, 20);
	// Straight in is the default, and writing it changes nothing that was drawn before.
	assert.equal(parseFacadeGrammar(program({ scoop_deg: 0 }) as any).rules.F[0].scoop_deg, undefined);
	assert.throws(() => parseFacadeGrammar(program({ scoop_deg: 70 }) as any), /out of range/);
	// A hole to cut is the whole precondition: no recess, or not an opening at all.
	assert.throws(() => parseFacadeGrammar({
		...program({}), rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "glass", inset_m: 0, depth_m: 0.1, scoop_deg: 20 }] }],
	} as any), /needs a recess/);
	assert.throws(() => parseFacadeGrammar({
		...program({}), rules: [{ name: "F", alternatives: [{ when: null, split: null, terminal: "spandrel", inset_m: 0, depth_m: -0.4, scoop_deg: 20 }] }],
	} as any), /only an opening/);

	const alternative = (FACADE_GRAMMAR_V3_SCHEMA as any).$defs.alternative;
	assert.ok(alternative.properties.scoop_deg && alternative.required.includes("scoop_deg"));

	const { mesh, floorGuides, facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const segment = context.facade_segments[0];
	const build = (extra: object) => buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority,
		primitives: [{
			kind: "window", segment_id: segment.segment_id,
			local_bounds: { u_min: 0.6, u_max: 1.6, z_min: 0.6, z_max: 1.6 }, depth_m: -0.4, ...extra,
		}],
	}).find((detail: any) => detail.kind === "window");

	const drilled = build({});
	const scooped = build({ scoop_deg: 20 });
	assert.ok(drilled.recessed && scooped.recessed);
	// A drilled hole says nothing about its axis, so every pane already written keeps the
	// normal the renderer has always used.
	assert.equal(drilled.recess_axis, undefined);
	assert.ok(Array.isArray(scooped.recess_axis));
	// The axis is the normal tilted by exactly the angle asked for, and still a unit vector.
	const axis = scooped.recess_axis as number[];
	const normal = scooped.recess_normal as number[];
	assert.ok(Math.abs(Math.hypot(...axis) - 1) < 1e-12, "unit length");
	const cosine = axis.reduce((sum, value, index) => sum + value * normal[index], 0);
	assert.ok(Math.abs(Math.acos(cosine) * 180 / Math.PI - 20) < 1e-9, `tilted ${Math.acos(cosine) * 180 / Math.PI}`);
	assert.ok(axis[2] > 0, "positive scoops upward");
});
