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
import { existsSync } from "node:fs";
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

/**
 * A path inside the fixture tree, named in segments rather than as one long string.
 *
 * Those fixtures are FINISHED e2e runs - enriched GLBs, rendered views, validation receipts -
 * and the five the suite names weigh about 420 MB, one of them 302 MB on its own. They are
 * deliberately not in the repository (2026-09-22, the user's call while making this repo
 * movable): the code, the three masses and their run seeds are in, the heavy renders stay out.
 * So when the tree is absent the fourteen tests that read it have to say WHY rather than
 * produce a bare ENOENT on a path nobody recognises - which is exactly how they read on the
 * day the repo was made self-contained and the fixtures were left behind.
 */
export function fixture(...segments: string[]): string {
	const path = join(FIXTURE_ROOT, ...segments);
	const group = segments[0];
	// The tree is missing, not the one file: judged on the first segment, which is the run
	// group (a candidate id, or `autonomous`), never on the leaf a test is about to read.
	if (group && !existsSync(join(FIXTURE_ROOT, group))) {
		throw new Error(
			`the finished e2e fixture tree is not at ${FIXTURE_ROOT} (no "${group}" in it).`
			+ " Those runs are ~420 MB and are kept outside the repository on purpose; point"
			+ " ELEVATION_AGENT_FIXTURE_ROOT at them, or fixture_root in elevation-agent.json."
			+ " They were produced under D:/Data/50_ELE/elevation-3d-e2e-results."
			+ " Only the tests that read a finished run need them; the rest of the suite does not.",
		);
	}
	return path;
}
