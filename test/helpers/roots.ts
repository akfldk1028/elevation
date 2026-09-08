/**
 * Where the tests' data lives, decided in the one place that decides it for everything else.
 *
 * Nine test files had `D:/Data/50_ELE/...` typed into them - the dataset root in five, a
 * third root of finished e2e runs in ten - while `elevation-agent.json` sat beside them
 * claiming to be the only place that says where the data is. It was not: it named two roots
 * of three, and the suite could not follow a moved dataset or run on another machine.
 *
 * These re-export the resolved roots so a test names a CANDIDATE and a FILE, never a drive.
 * The resolution order is the agent's own: argument, then environment
 * (`ELEVATION_AGENT_DATASET_ROOT`, `ELEVATION_AGENT_FIXTURE_ROOT`), then
 * `elevation-agent.json`, then the historical default.
 */
import { join } from "node:path";

import { resolveRoots } from "../../tools/facade-pipeline/config.mjs";

const roots = resolveRoots({
	// One test carried its own environment override under an older name. Keeping it means
	// nothing that worked before stops working; naming it here means there is still one
	// place to read, which was the whole point.
	datasetRoot: process.env.ELEVATION3D_DATASET_ROOT,
});

/** The masses the agent designs for: `<dataset>/candidates/<id>/mass/...`. */
export const DATASET_ROOT: string = roots.datasetRoot;

/** Where authored schemes and their drawings are written. */
export const OUTPUT_ROOT: string = roots.outputRoot;

/** Finished e2e runs the tests read fixtures from - enriched GLBs, rendered views. */
export const FIXTURE_ROOT: string = roots.fixtureRoot;

/** A candidate's mass directory, the one shape every mass fixture is found under. */
export function massDir(candidateId: string): string {
	return join(DATASET_ROOT, "candidates", candidateId, "mass");
}

/** A path inside the fixture tree, named in segments rather than as one long string. */
export function fixture(...segments: string[]): string {
	return join(FIXTURE_ROOT, ...segments);
}
