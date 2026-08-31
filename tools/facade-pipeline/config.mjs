/**
 * Where the elevation agent's data lives, decided in one place.
 *
 * The agent is a folder of logic. The masses it designs for and the drawings it produces are
 * not in that folder and should not be - a compiler does not contain its source files. What
 * was wrong is that every runner hardcoded both locations: eleven copies of the dataset root
 * and fifteen of the output root, in scripts that were never tracked. The folder could not be
 * renamed, copied, or pointed at a second dataset without editing all of them, and renaming it
 * is exactly what broke first.
 *
 * Resolution order, most specific first:
 *   1. what the caller passed
 *   2. ELEVATION_AGENT_DATASET_ROOT / ELEVATION_AGENT_OUTPUT_ROOT in the environment
 *   3. `elevation-agent.json` beside this repository's root
 *   4. the locations this project has always used
 *
 * The defaults are the historical paths on purpose. Nothing that works today changes
 * behaviour by this module existing; what changes is that there is now one place to move.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, found from this file rather than from the caller's cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG_FILE = join(REPO_ROOT, "elevation-agent.json");

const DEFAULTS = Object.freeze({
	datasetRoot: "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730",
	outputRoot: "D:/Data/50_ELE/facade-agent-verification/llm-facade-design-agent-20260810",
});

function fromFile() {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		return {
			datasetRoot: typeof parsed.dataset_root === "string" ? parsed.dataset_root : undefined,
			outputRoot: typeof parsed.output_root === "string" ? parsed.output_root : undefined,
		};
	} catch {
		// No config file is the normal case, and a malformed one must not take the agent down
		// silently in a different way than a missing one would.
		return {};
	}
}

/** A root given relative to the repository is resolved against it, not against cwd. */
const anchor = (value) => (value === undefined ? undefined : isAbsolute(value) ? value : join(REPO_ROOT, value));

/**
 * @param {{datasetRoot?: string, outputRoot?: string}} [overrides]
 * @returns {{datasetRoot: string, outputRoot: string, source: object}}
 */
export function resolveRoots(overrides = {}) {
	const file = fromFile();
	const pick = (name, envName) => {
		const chain = [
			["argument", overrides[name]],
			["environment", process.env[envName]],
			["elevation-agent.json", file[name]],
			["default", DEFAULTS[name]],
		];
		const [source, value] = chain.find(([, candidate]) => typeof candidate === "string" && candidate.length);
		return { source, value: anchor(value) };
	};
	const dataset = pick("datasetRoot", "ELEVATION_AGENT_DATASET_ROOT");
	const output = pick("outputRoot", "ELEVATION_AGENT_OUTPUT_ROOT");
	return {
		datasetRoot: dataset.value,
		outputRoot: output.value,
		source: { datasetRoot: dataset.source, outputRoot: output.source },
	};
}

/** The run directory a candidate's authored schemes live in. */
export function runDirFor(candidateId, overrides = {}) {
	const { outputRoot } = resolveRoots(overrides);
	return join(outputRoot, candidateId, `llm-facade-subagent-${candidateId}`);
}
