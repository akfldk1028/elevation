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
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, found from this file rather than from the caller's cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG_FILE = join(REPO_ROOT, "elevation-agent.json");

const DEFAULTS = Object.freeze({
	datasetRoot: "./data/datasets",
	outputRoot: "./output",
	fixtureRoot: "./test/fixtures",
});

function fromFile() {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		return {
			datasetRoot: typeof parsed.dataset_root === "string" ? parsed.dataset_root : undefined,
			outputRoot: typeof parsed.output_root === "string" ? parsed.output_root : undefined,
			fixtureRoot: typeof parsed.fixture_root === "string" ? parsed.fixture_root : undefined,
			runDirs: parsed.run_dirs && typeof parsed.run_dirs === "object" ? parsed.run_dirs : undefined,
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
 * @param {{datasetRoot?: string, outputRoot?: string, fixtureRoot?: string}} [overrides]
 * @returns {{datasetRoot: string, outputRoot: string, fixtureRoot: string, source: object}}
 */
export function resolveRoots(overrides = {}) {
	const file = fromFile();
	const pick = (name, envName, legacyPath) => {
		const chain = [
			["argument", overrides[name]],
			["environment", process.env[envName]],
			["elevation-agent.json", file[name]],
			["default", DEFAULTS[name]],
		];
		const [source, rawValue] = chain.find(([, candidate]) => typeof candidate === "string" && candidate.length);
		const resolved = anchor(rawValue);
		if (!existsSync(resolved) && legacyPath && existsSync(legacyPath)) {
			return { source: "legacy-fallback", value: legacyPath };
		}
		return { source, value: resolved };
	};
	const dataset = pick("datasetRoot", "ELEVATION_AGENT_DATASET_ROOT", "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730");
	const output = pick("outputRoot", "ELEVATION_AGENT_OUTPUT_ROOT", "D:/Data/50_ELE/facade-agent-verification/llm-facade-design-agent-20260810");
	const fixture = pick("fixtureRoot", "ELEVATION_AGENT_FIXTURE_ROOT", "D:/Data/50_ELE/elevation-3d-e2e-results");
	return {
		datasetRoot: dataset.value,
		outputRoot: output.value,
		fixtureRoot: fixture.value,
		source: { datasetRoot: dataset.source, outputRoot: output.source, fixtureRoot: fixture.source },
	};
}

/**
 * The run directory a candidate's authored schemes live in.
 *
 * The convention is `<output>/<candidate>/llm-facade-subagent-<candidate>`. creative-020
 * predates it and keeps a historical name, which is why `run_dirs` in the config exists:
 * naming the exception is honest about the history, where renaming the directory would
 * orphan every path recorded in the handoff and in twenty retained run folders.
 */
export function runDirFor(candidateId, overrides = {}) {
	const { outputRoot } = resolveRoots(overrides);
	const named = fromFile().runDirs?.[candidateId];
	if (named) return isAbsolute(named) ? named : join(outputRoot, named);
	return join(outputRoot, candidateId, `llm-facade-subagent-${candidateId}`);
}
