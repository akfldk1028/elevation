import { sha256, stableJson } from "./core.mjs";

const DRAWING_NAMES = ["plan", "front", "back", "left", "right", "top", "axon"];

function boundsOf(vertices) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const point of vertices) for (let axis = 0; axis < 3; axis++) {
		min[axis] = Math.min(min[axis], point[axis]);
		max[axis] = Math.max(max[axis], point[axis]);
	}
	return { min, max };
}

function rounded(value) {
	return Number(value.toFixed(12));
}

export async function validateEnrichment({ sourceMesh, artifact, grammar, requiredDrawings }) {
	const sourceBaseHash = sha256(stableJson({ positions: sourceMesh.vertices, indices: sourceMesh.triangles }));
	const artifactBaseHash = sha256(stableJson({
		positions: artifact.base_primitive?.positions ?? [],
		indices: artifact.base_primitive?.indices ?? [],
	}));
	const sourceBounds = boundsOf(sourceMesh.vertices);
	const artifactBounds = artifact.bounds ?? { min: [], max: [] };
	const allowedDetailExcess = Math.max(Number(grammar.frame_depth_m), Number(grammar.mullion_depth_m)) + 0.01;
	let maximumBoundsExcess = 0;
	for (let axis = 0; axis < 3; axis++) {
		maximumBoundsExcess = Math.max(
			maximumBoundsExcess,
			sourceBounds.min[axis] - Number(artifactBounds.min[axis]),
			Number(artifactBounds.max[axis]) - sourceBounds.max[axis],
		);
	}
	maximumBoundsExcess = rounded(maximumBoundsExcess);
	const missingDrawings = DRAWING_NAMES.filter((name) => !requiredDrawings?.[name]);
	const codes = [];
	if (sourceBaseHash !== artifactBaseHash) codes.push("BASE_GEOMETRY_CHANGED");
	if (maximumBoundsExcess > rounded(allowedDetailExcess)) codes.push("DETAIL_BOUNDS_EXCEEDED");
	if (missingDrawings.length) codes.push("DRAWING_MISSING");
	return {
		accepted: codes.length === 0,
		codes,
		metrics: {
			source_base_sha256: sourceBaseHash,
			artifact_base_sha256: artifactBaseHash,
			allowed_detail_excess_m: rounded(allowedDetailExcess),
			maximum_bounds_excess_m: maximumBoundsExcess,
			missing_drawings: missingDrawings,
		},
		artifacts: {
			glb: artifact.path,
			glb_sha256: artifact.sha256,
			drawings: requiredDrawings,
		},
	};
}
