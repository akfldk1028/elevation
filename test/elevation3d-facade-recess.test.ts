import assert from "node:assert/strict";
import test from "node:test";

import { buildTypedFacadeDetails } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

// A recessed opening is a hole. The mass is never cut, so the hole is what the builder
// emits: the pane as a thin slab at the bottom of the recess, four jamb faces in the
// shell's material lining its sides, and a `recessed` mark the renderers cut the mass by.
// Before this a recess was a solid block of glass from the wall face inward, coplanar
// with the uncut mass, which z-fought it and drew no reveal.
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
