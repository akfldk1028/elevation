#!/usr/bin/env node
/**
 * Parse a facade grammar and derive it against a candidate's real facet geometry.
 *
 * Usage: node validate.mjs <candidate-id> <program.json> [dataset-root]
 *
 * This is the fast authoring loop: it catches grammar errors, derivations that
 * produce nothing, empty base or top storeys, and budget overruns in seconds.
 *
 * It deliberately does NOT run the authority-bound checks. Mass backing, fold and
 * floor-band clearances, opening overlap, line density and the review gate all need
 * a verified design context and a render, and they run in the full pipeline. A clean
 * report here means the grammar derives — not that the design will be accepted.
 */
import { readFile } from "node:fs/promises";
import { argv, exit, stdout } from "node:process";

import { loadCandidatePackage } from "../../../plugins/elevation-3d/lib/core.mjs";
import { deriveFacadeFaces } from "../../../plugins/elevation-3d/lib/facade-agent/design/geometry/faces.mjs";
import { parseFacadeGrammar } from "../../../plugins/elevation-3d/lib/facade-agent/design/grammar/contract.mjs";
import { deriveFacadePrimitives } from "../../../plugins/elevation-3d/lib/facade-agent/design/grammar/derive.mjs";
import { deriveFacadeSegmentsFromMass } from "../../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

const [candidateId, programPath, datasetRoot = "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730"] = argv.slice(2);
if (!candidateId || !programPath) {
	stdout.write("usage: node validate.mjs <candidate-id> <program.json> [dataset-root]\n");
	exit(2);
}

const report = (payload) => stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

const candidate = await loadCandidatePackage(datasetRoot, candidateId);
const authority = deriveFacadeSegmentsFromMass({ mesh: candidate.mesh });
const depths = Object.fromEntries(["front", "back", "left", "right"]
	.map((view) => [view, candidate.cameras.views[view].projection_axes.depth]));
const { bySegment } = deriveFacadeFaces(authority.facade_planes, depths);
const floors = candidate.floor_guides.floor_guides_m;
const storeys = floors.slice(0, -1).map((zMin, index) => ({ storey: index + 1, z_min: zMin, z_max: floors[index + 1] }));
const FOLD_CLEARANCE_M = 0.3;

let grammar;
try {
	const raw = JSON.parse(await readFile(programPath, "utf8"));
	const { entrance: _entrance, ...rest } = raw;
	grammar = parseFacadeGrammar(rest);
} catch (error) {
	report({ stage: "parse", ok: false, message: error.message });
	exit(1);
}

const primitives = [];
const perElevation = {};
try {
	for (const plane of authority.facade_planes) {
		const view = bySegment[plane.segment_id].face_view;
		const derived = deriveFacadePrimitives({
			grammar,
			segment: {
				segment_id: plane.segment_id,
				face_view: view,
				length_m: plane.extent_m[0],
				local_z: [plane.origin[2], plane.origin[2] + plane.extent_m[1]],
				placeable: { u_min: FOLD_CLEARANCE_M, u_max: plane.extent_m[0] - FOLD_CLEARANCE_M },
			},
			storeys,
		});
		perElevation[view] = (perElevation[view] ?? 0) + derived.length;
		primitives.push(...derived);
	}
} catch (error) {
	report({ stage: "derive", ok: false, message: error.message });
	exit(1);
}

const kinds = {};
const open = new Set();
for (const primitive of primitives) {
	kinds[primitive.kind] = (kinds[primitive.kind] ?? 0) + 1;
	if (primitive.storey) open.add(primitive.storey);
}
const numbers = storeys.map((storey) => storey.storey);
const warnings = [];
if (!primitives.length) warnings.push("the grammar derived no openings at all");
if (!open.has(numbers[0])) warnings.push("the lowest storey carries no opening");
if (!open.has(numbers[numbers.length - 1])) warnings.push("the highest storey carries no opening");
if (new Set(Object.values(perElevation)).size === 1 && Object.keys(perElevation).length > 1) {
	warnings.push("every elevation derived the same count - branch on face_view for variety");
}
if (primitives.length + 1 > 2048) warnings.push("the resolved primitive budget will be exceeded");

report({
	stage: "derive",
	ok: warnings.length === 0,
	warnings,
	primitives: primitives.length,
	kinds,
	per_elevation: perElevation,
	storeys_with_openings: `${open.size}/${numbers.length}`,
	segments: authority.facade_planes.length,
	unchecked: "mass backing, clearances, overlap, line density and the review gate run in the full pipeline",
});
exit(warnings.length ? 1 : 0);
