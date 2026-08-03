import assert from "node:assert/strict";
import { test } from "node:test";
import { buildElevationAnnotations } from "../plugins/elevation-3d/lib/elevation-annotations.mjs";

const dimensions = {
	schema_version: "arr.elevation3d.dimension-manifest.v1",
	view: "front",
	projected_bounds_m: { min: [-12.180745, 0], max: [12.180743, 9.9] },
	overall_width: { display_mm: 24361, value_m: 24.361, projected_endpoints_m: [[-12.180745, 0], [12.180743, 0]] },
	overall_height: { display_mm: 9900, value_m: 9.9, projected_endpoints_m: [[12.180743, 0], [12.180743, 9.9]] },
	levels: [0, 3.3, 6.6, 9.9].map((value, index) => ({
		id: `level-${Math.round(value * 1000)}`,
		value_m: value,
		display_mm: Math.round(value * 1000),
		label: `EL. +${value.toFixed(3)}`,
		projected_endpoints_m: [[-12.180745, value], [12.180743, value]],
		source: { field: "floor_guides.floor_guides_m", index },
	})),
	floor_intervals: [0, 1, 2].map((index) => ({
		id: `floor-interval-${index}`,
		value_m: 3.3,
		display_mm: 3300,
		projected_endpoints_m: [[-12.180745, index * 3.3], [-12.180745, (index + 1) * 3.3]],
	})),
	facade_extent: { width: { display_mm: 24361, value_m: 24.361 }, height: { display_mm: 9900, value_m: 9.9 } },
	scale_bar: { display_mm: 5000, value_m: 5 },
};

const camera = {
	type: "orthographic",
	projection_axes: { horizontal: [1, 0, 0], vertical: [0, 0, 1], depth: [0, -1, 0] },
	center_m: [0, 4.95, 0],
	frustum: { left: -15.074, right: 15.074, top: 15.074, bottom: -15.074, near: 0.1, far: 225 },
	px_per_m_x: 79.60685862,
	px_per_m_y: 79.60685862,
};

test("lays out authoritative overall and level dimensions outside the building", () => {
	const annotation = buildElevationAnnotations({
		dimensions,
		camera,
		contentBounds: { min_x: 215, min_y: 805, max_x: 2184, max_y: 1594 },
		canvas: [2400, 2400],
		candidateId: "creative-013",
	});
	assert.equal(annotation.labels.includes("9900"), true);
	assert.equal(annotation.labels.includes("24361"), true);
	assert.deepEqual(annotation.level_labels, ["EL. +0.000", "EL. +3.300", "EL. +6.600", "EL. +9.900"]);
	assert.equal(annotation.overlaps_content, false);
	assert.equal(annotation.overlaps_annotations, false);
	assert.equal(annotation.note, "ALL DIMENSIONS IN MILLIMETRES");
	assert.match(annotation.svg, /<g id="floor-intervals">/);
	assert.match(annotation.svg, /<g id="facade-extent">/);
	assert.match(annotation.svg, /<g id="scale-bar">/);
	assert.match(annotation.svg, /data-source-id="level-3300"/);
	assert.match(annotation.svg, /data-source-id="facade-height"[^>]*data-display-mm="9900"[^>]*>9900</);
	assert.match(annotation.svg, /data-source-id="scale-bar"[^>]*data-display-mm="5000"[^>]*>5 m</);
	for (const box of annotation.annotation_boxes) {
		assert.ok(box.min_x >= 48 && box.min_y >= 48 && box.max_x <= 2352 && box.max_y <= 2352, `${box.id} violates page clearance`);
	}
});

test("fails deterministic layout when the building consumes an annotation lane", () => {
	assert.throws(() => buildElevationAnnotations({
		dimensions,
		camera,
		contentBounds: { min_x: 40, min_y: 40, max_x: 2360, max_y: 2320 },
		canvas: [2400, 2400],
	}), /annotation layout unavailable/);
});
