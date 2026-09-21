import assert from "node:assert/strict";
import test from "node:test";

import { buildTypedFacadeDetails } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

test("negative-depth metal reveal trim sits inside the recess instead of filling its full depth",async t=>{
	const {mesh,floorGuides,facadeSegmentAuthority,context}=await createFacadeDesignFixture(t);
	const details=buildTypedFacadeDetails({mesh,floorGuides,facadePlanes:facadeSegmentAuthority,
		primitives:[{kind:"reveal",segment_id:context.facade_segments[0].segment_id,
			local_bounds:{u_min:0.6,u_max:0.66,z_min:0.6,z_max:2.6},depth_m:-0.245}]});
	const b=details[0].local_bounds;
	assert.ok(b.n0<0 && b.n1<0);
	assert.ok(Math.abs(b.n1-b.n0)<=0.020001);
});

// A recessed opening is a hole. The mass is never cut, so the hole is what the builder
// emits: the pane as a thin slab at the bottom of the recess, four jamb faces in the
// shell's material lining its sides, and a `recessed` mark the renderers cut the mass by.
// Before this a recess was a solid block of glass from the wall face inward, coplanar
// with the uncut mass, which z-fought it and drew no reveal.
// A funnel is a recessed opening whose far outline is its throat: the pane is the throat, the
// lining is one lofted wall from the mouth on the wall face to the throat, and the pane hands
// the renderer the mouth so the cut is the frustum and not the throat extruded straight out.
test("a funnel opening emits its pane at the throat, one lofted wall, and the mouth for the cut", async (t) => {
	const { mesh, floorGuides, facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const segment = context.facade_segments[0];
	const mouth = [[0.05, 0.5], [0.3, 0.05], [0.7, 0.05], [0.95, 0.5], [0.7, 0.95], [0.3, 0.95]];
	const throat = [[0.3, 0.5], [0.45, 0.35], [0.7, 0.4], [0.75, 0.5], [0.55, 0.65], [0.35, 0.62]];
	const details = buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority, shellMaterial: "precast",
		primitives: [{ kind: "window", segment_id: segment.segment_id, material: "glass", depth_m: -0.5,
			local_bounds: { u_min: 1, u_max: 2.2, z_min: 1, z_max: 2 }, outline: mouth, outline_far: throat }],
	});
	const pane = details.find((d: any) => d.kind === "window");
	assert.equal(pane.recessed, true);
	assert.deepEqual(pane.outline, throat, "the pane is the throat");
	assert.equal(pane.outline_far, undefined, "the pane itself is flat");
	assert.equal(pane.recess_mouth.length, mouth.length, "the mouth travels as world points, one per vertex");
	assert.ok(pane.recess_mouth.every((p: number[]) => p.length === 3 && p.every(Number.isFinite)));
	const wall = details.filter((d: any) => d.jamb === true);
	assert.equal(wall.length, 1, "one lofted wall, no ring");
	assert.equal(wall[0].slot, "typed-0-contour-funnel");
	assert.equal(wall[0].funnel, undefined, "the loops are geometry, not extras");
	assert.equal(wall[0].positions.length, 2 * mouth.length);
	assert.equal(wall[0].indices.length, 4 * mouth.length, "two triangles per edge in both windings, no caps");
	assert.equal(wall[0].material, "precast");
});

test("a recessed opening emits a pane at the bottom of its recess and four jambs in the shell material", async (t) => {
	const { mesh, floorGuides, facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const segment = context.facade_segments[0];
	const primitive = (depth: number) => ({
		kind: "window", segment_id: segment.segment_id, material: "glass", depth_m: depth,
		local_bounds: { u_min: 1, u_max: 2.2, z_min: 1, z_max: 3 },
	});
	const details = buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority,
		primitives: [primitive(-0.18)], shellMaterial: "precast",
	});
	const pane = details.find((detail: any) => detail.kind === "window");
	const jambs = details.filter((detail: any) => detail.jamb === true);
	assert.ok(pane, "the pane is still a window");
	assert.equal(pane.recessed, true);
	assert.equal(pane.recess_m, 0.18);
	// The facet normal travels with the pane so the renderer can rebuild the hole volume.
	assert.equal(pane.recess_normal.length, 3);
	assert.ok(Math.abs(Math.hypot(...pane.recess_normal) - 1) < 1e-6);
	// The slab sits at the bottom of the recess, 15 mm thick, not at the wall face.
	assert.ok(Math.abs(pane.local_bounds.n1 - -0.18) < 1e-9);
	assert.ok(Math.abs(pane.local_bounds.n0 - -0.165) < 1e-9);
	assert.equal(jambs.length, 4);
	for (const jamb of jambs) {
		assert.equal(jamb.kind, "reveal");
		assert.equal(jamb.material, "precast", "the lining is the wall, not a surround");
		assert.equal(jamb.semantic_role, "concrete", "and it carries the wall's role, not trim's");
		assert.equal(jamb.local_bounds.n0, 0);
		assert.ok(Math.abs(jamb.local_bounds.n1 - -0.18) < 1e-9, "from the wall face to the pane");
	}
	// A proud pane keeps the record it always had: one solid from the face outward, no mark.
	const proud = buildTypedFacadeDetails({
		mesh, floorGuides, facadePlanes: facadeSegmentAuthority,
		primitives: [primitive(0.02)],
	});
	const proudPane = proud.find((detail: any) => detail.kind === "window");
	assert.equal(proudPane.recessed, undefined);
	assert.equal(proudPane.local_bounds.n0, 0);
	assert.equal(proud.filter((detail: any) => detail.jamb === true).length, 0);
});
