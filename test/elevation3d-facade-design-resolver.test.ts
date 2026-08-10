import assert from "node:assert/strict";
import test from "node:test";

import {
	FacadeDesignResolverError,
	readVerifiedResolvedFacadeAuthority,
	resolveFacadeProgram,
} from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

function typedRejection(error: unknown) {
	return error instanceof FacadeDesignResolverError && error.code === "FACADE_DESIGN_RESOLUTION_INVALID";
}

test("resolves one ground-floor entrance onto the highest-ranked eligible segment", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	const door = resolved.primitives.find((primitive: any) => primitive.kind === "door");
	const segment = context.facade_segments.find((item: any) => item.segment_id === door.segment_id);

	assert.equal(door.family_id, "recessed_glazed_portal");
	assert.equal(door.local_bounds.z_min, 0);
	assert.equal(door.local_bounds.z_max, 2.4);
	assert.deepEqual([door.local_bounds.u_min, door.local_bounds.u_max], [3.1, 4.9]);
	assert.equal(segment.visibility_score, Math.max(...context.facade_segments.map((item: any) => item.visibility_score)));
	assert.equal(door.local_bounds.u_min >= context.exclusions.edge_clearance_m, true);
	assert.equal(door.local_bounds.u_max <= segment.length_m - context.exclusions.edge_clearance_m, true);
});

test("emits deterministic window families and articulation without crossing segment bounds", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const first = resolveFacadeProgram(program, context);
	const second = resolveFacadeProgram(program, context);

	assert.deepEqual(second, first);
	assert.equal(Object.isFrozen(first), true);
	assert.match(first.resolution_sha256, /^[a-f0-9]{64}$/);
	assert.equal(first.primitives.some((primitive: any) => primitive.kind === "window" && primitive.family_id === "wide"), true);
	assert.equal(first.primitives.some((primitive: any) => primitive.kind === "pilaster"), true);
	for (const primitive of first.primitives as any[]) {
		const segment = context.facade_segments.find((item: any) => item.segment_id === primitive.segment_id);
		assert.ok(segment);
		assert.equal(primitive.local_bounds.u_min >= 0, true);
		assert.equal(primitive.local_bounds.u_max <= segment.length_m, true);
		assert.equal(primitive.local_bounds.u_min < primitive.local_bounds.u_max, true);
		if (primitive.kind === "door" || primitive.kind === "window") {
			assert.equal(primitive.local_bounds.u_min >= context.exclusions.edge_clearance_m, true);
			assert.equal(primitive.local_bounds.u_max <= segment.length_m - context.exclusions.edge_clearance_m, true);
		}
	}
});

test("uses stable segment ID as the final tie-breaker", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t, { width: 4, depth: 4 });
	const resolved = resolveFacadeProgram(program, context);
	const door = resolved.primitives.find((primitive: any) => primitive.kind === "door");
	const eligible = context.facade_segments
		.filter((segment: any) => segment.ground_access && segment.visibility_score === Math.max(...context.facade_segments.map((item: any) => item.visibility_score)))
		.sort((left: any, right: any) => left.segment_id.localeCompare(right.segment_id));
	assert.equal(door.segment_id, eligible[0].segment_id);
});

test("rejects cloned program or context capabilities", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	assert.throws(() => resolveFacadeProgram(structuredClone(program), context), typedRejection);
	assert.throws(() => resolveFacadeProgram(program, structuredClone(context)), typedRejection);
});

test("exposes resolution authority only for the exact resolver output", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	assert.deepEqual(readVerifiedResolvedFacadeAuthority(resolved), {
		...resolved.source,
		resolution_sha256: resolved.resolution_sha256,
	});
	assert.equal(readVerifiedResolvedFacadeAuthority(structuredClone(resolved)), null);
});
