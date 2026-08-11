import assert from "node:assert/strict";
import test from "node:test";

import { loadCandidatePackage } from "../plugins/elevation-3d/lib/core.mjs";
import { FacadeFaceError, deriveFacadeFaces } from "../plugins/elevation-3d/lib/facade-agent/design/geometry/faces.mjs";
import { deriveFacadeSegmentsFromMass } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

const DATASET = "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730";
const DEPTHS = { front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

test("groups the facets of a box into one face per elevation", async (t) => {
	const { facadeSegmentAuthority, context } = await createFacadeDesignFixture(t);
	const { faces, bySegment } = deriveFacadeFaces(facadeSegmentAuthority.facade_planes, DEPTHS);

	assert.deepEqual(faces.map((face: any) => face.view), ["front", "back", "left", "right"]);
	for (const face of faces as any[]) {
		assert.equal(face.segment_ids.length, 1);
		assert.equal(face.gap_m, 0);
		assert.equal(face.length_m, face.covered_length_m);
	}
	for (const segment of context.facade_segments as any[]) {
		const record = bySegment[segment.segment_id];
		assert.ok(record, `segment ${segment.segment_id} has no face`);
		assert.equal(record.face_index, 0);
		assert.equal(record.face_offset_m, 0);
		assert.equal(record.projected_length_m, segment.length_m);
	}
});

test("tiles a pleated envelope into continuous elevation coordinates", async () => {
	const candidate = await loadCandidatePackage(DATASET, "creative-020");
	const planes = deriveFacadeSegmentsFromMass({ mesh: candidate.mesh }).facade_planes;
	const { faces, bySegment } = deriveFacadeFaces(planes, DEPTHS);

	const front: any = faces.find((face: any) => face.view === "front");
	assert.equal(front.segment_ids.length, 6);
	assert.equal(Math.abs(front.length_m - 10.652) < 0.01, true, `front face measured ${front.length_m}`);
	assert.equal(front.gap_m, 0, "contiguous elevation must tile without gaps");

	const offsets = front.segment_ids.map((id: string) => bySegment[id].face_offset_m);
	assert.deepEqual([...offsets].sort((left: number, right: number) => left - right), offsets);
	assert.equal(offsets[0], 0);
	const last = front.segment_ids[front.segment_ids.length - 1];
	assert.equal(
		Math.abs(bySegment[last].face_offset_m + bySegment[last].projected_length_m - front.length_m) < 1e-6,
		true,
	);
});

test("reports the recess where an elevation is not continuous", async () => {
	const candidate = await loadCandidatePackage(DATASET, "creative-020");
	const planes = deriveFacadeSegmentsFromMass({ mesh: candidate.mesh }).facade_planes;
	const { faces } = deriveFacadeFaces(planes, DEPTHS);

	const left: any = faces.find((face: any) => face.view === "left");
	assert.equal(left.segment_ids.length, 2);
	assert.equal(left.gap_m > 3, true, `left face gap measured ${left.gap_m}`);
	assert.equal(Math.abs(left.length_m - left.covered_length_m - left.gap_m) < 1e-6, true);
});

test("derives one stable face identity for the same facets", async () => {
	const candidate = await loadCandidatePackage(DATASET, "creative-020");
	const planes = deriveFacadeSegmentsFromMass({ mesh: candidate.mesh }).facade_planes;
	const first = deriveFacadeFaces(planes, DEPTHS);
	const second = deriveFacadeFaces([...planes].reverse(), DEPTHS);

	assert.deepEqual(second.faces, first.faces);
	assert.deepEqual(second.bySegment, first.bySegment);
	assert.equal(new Set(first.faces.map((face: any) => face.face_id)).size, first.faces.length);
	for (const face of first.faces as any[]) assert.match(face.face_id, /^facade-face-[a-f0-9]{20}$/);
});

test("rejects planes without a drawing axis", () => {
	assert.throws(() => deriveFacadeFaces([], DEPTHS), (error: unknown) => error instanceof FacadeFaceError);
	assert.throws(
		() => deriveFacadeFaces([{ segment_id: "a", view: "top", normal: [0, 0, 1], origin: [0, 0, 0], extent_m: [1, 1] }], DEPTHS),
		(error: unknown) => error instanceof FacadeFaceError,
	);
});

test("publishes faces and per-segment face coordinates on the verified context", async (t) => {
	const { context } = await createFacadeDesignFixture(t);

	assert.equal(Array.isArray(context.facade_faces), true);
	assert.equal(context.facade_faces.length, 4);
	const ids = new Set(context.facade_faces.map((face: any) => face.face_id));
	for (const segment of context.facade_segments as any[]) {
		assert.equal(ids.has(segment.face_id), true);
		assert.equal(Number.isFinite(segment.face_offset_m), true);
		assert.equal(Number.isInteger(segment.face_index), true);
	}
});
