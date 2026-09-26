import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DATASET_ROOT, FIXTURE_ROOT } from "./roots.ts";

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

/** The one finished run these e2e tests read their authoritative geometry from. */
const SELECTED_GLB = ["creative-013", "final-fix-b-round1-20260803-190000", "versions", "v001", "enriched.glb"];

/**
 * The dataset and the one selected GLB these e2e tests stand on.
 *
 * This helper predates `elevation-agent.json` and asked the FILESYSTEM ABOVE THE REPO for
 * both: a directory holding `MAAS_ELEVATION_TEST_SET_20260730` next to `elevation-3d-e2e-results`.
 * On this machine the repo sits inside exactly such a directory, so the walk always found it
 * and the leak was invisible - until the repo was copied elsewhere and eleven test files
 * stopped at load with "asset root not found above <new path>" (2026-09-22, while checking
 * whether this repo can be moved). The masses are IN the repo now and the finished runs are
 * named by `ELEVATION_AGENT_FIXTURE_ROOT`, so ask those first and keep the walk for a machine
 * that still has the old layout and has said nothing.
 */
export function resolveElevation3dAssets({ start, datasetOverride, glbOverride }: {
	start: string;
	datasetOverride?: string;
	glbOverride?: string;
}) {
	let dataset = datasetOverride;
	let glb = glbOverride;
	if (!dataset && existsSync(join(DATASET_ROOT, "candidates"))) dataset = DATASET_ROOT;
	if (!glb && existsSync(join(FIXTURE_ROOT, ...SELECTED_GLB))) glb = join(FIXTURE_ROOT, ...SELECTED_GLB);
	if (!dataset || !glb) {
		const sharedRoot = discoverElevation3dAssetRoot(start);
		dataset ??= join(sharedRoot, DATASET_DIRECTORY);
		glb ??= join(sharedRoot, RESULTS_DIRECTORY, ...SELECTED_GLB);
	}
	return { datasetRoot: resolve(dataset), selectedGlb: resolve(glb) };
}
