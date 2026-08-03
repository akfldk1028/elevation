import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DATASET_DIRECTORY = "MAAS_ELEVATION_TEST_SET_20260730";
const RESULTS_DIRECTORY = "elevation-3d-e2e-results";

export function discoverElevation3dAssetRoot(start: string) {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, DATASET_DIRECTORY)) && existsSync(join(current, RESULTS_DIRECTORY))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`Elevation 3D asset root not found above ${resolve(start)}; set ELEVATION3D_DATASET_ROOT and ELEVATION3D_SELECTED_GLB`);
}

export function resolveElevation3dAssets({ start, datasetOverride, glbOverride }: {
	start: string;
	datasetOverride?: string;
	glbOverride?: string;
}) {
	const sharedRoot = datasetOverride && glbOverride ? undefined : discoverElevation3dAssetRoot(start);
	return {
		datasetRoot: resolve(datasetOverride ?? join(sharedRoot!, DATASET_DIRECTORY)),
		selectedGlb: resolve(glbOverride ?? join(sharedRoot!, RESULTS_DIRECTORY, "creative-013", "final-fix-b-round1-20260803-190000", "versions", "v001", "enriched.glb")),
	};
}
