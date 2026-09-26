/**
 * The concept perspective the standard lane starts from, by whichever engine.
 *
 * Two entrances to one step, and the choice belongs here rather than in the CLI - the same way
 * `vision.mjs` owns the trace engines and `lattice.mjs` owns the evaluator. A caller asks for a
 * concept of a mass; it does not assemble arguments for a provider.
 *
 *   codex  a closed provider is DESCRIBED the mass in words and asked to respect it - which is
 *          how a five-storey prism once came back as a star-plan tower, and which stops
 *          entirely when that account loses its entitlement.
 *   sdxl   Stable Diffusion XL with a ControlNet over the mass's OWN depth raster, on this
 *          machine. The silhouette is an input, not a request, so the picture cannot come back
 *          as another building. Both models are ungated and cost nothing per image.
 *
 * Neither obeys a storey COUNT - there are no storeys in a depth map and no arithmetic in a
 * diffusion model - so the transcriber still reads the picture against the mass facts.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { codexPhoto } from "../facade-presentation/photo/codex-photo.mjs";
import { REPO_ROOT } from "./config.mjs";

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const script = join(REPO_ROOT, "tools", "facade-concept", "cli.py");

export const CONCEPT_ENGINES = Object.freeze(["codex", "sdxl"]);

/** The raster each engine is handed: the rendered mass for a provider, its depth for a ControlNet. */
export function conceptInputs(runDir, engine) {
	return engine === "sdxl"
		? { control: join(runDir, "evidence", "depth", "axon.png") }
		: { input: join(runDir, "evidence", "color", "axon.png") };
}

async function sdxlConcept({ controlPng, outputPng, subject, seed, scale, steps }) {
	const args = [script, "--control", resolve(controlPng), "--out", resolve(outputPng), "--subject", subject];
	for (const [flag, value] of [["--seed", seed], ["--scale", scale], ["--steps", steps]]) {
		if (value !== undefined) args.push(flag, String(value));
	}
	let stdout;
	try {
		({ stdout } = await exec(python, args, { maxBuffer: 16 * 1024 * 1024, timeout: 1_800_000 }));
	} catch (error) {
		const tail = `${error.stdout ?? ""}${error.stderr ?? error.message}`.trim().split(/\r?\n/).slice(-3).join(" ");
		throw new Error(`local concept generation failed: ${tail}`);
	}
	return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

/**
 * @param {{engine?: string, runDir: string, outputPng: string, subject: string,
 *          seed?: number|string, scale?: number|string, steps?: number|string}} options
 */
export async function makeConcept({ engine = "codex", runDir, outputPng, subject, seed, scale, steps }) {
	if (!CONCEPT_ENGINES.includes(engine)) {
		throw new Error(`unknown concept engine ${engine}: one of ${CONCEPT_ENGINES.join(", ")}`);
	}
	const inputs = conceptInputs(runDir, engine);
	const report = engine === "sdxl"
		? await sdxlConcept({ controlPng: inputs.control, outputPng, subject, seed, scale, steps })
		: await codexPhoto({ inputPng: inputs.input, outputPng, subject, mode: "concept" });

	// The picture has to be on disk, not merely reported. Two photo runs once claimed the same
	// image and both said ok:true; see the memory `the-photo-lane-returned-another-runs-image`.
	const bytes = await readFile(outputPng).catch(() => null);
	if (!bytes?.length) throw new Error(`the ${engine} concept reported success but wrote no image at ${outputPng}`);
	// `engine` stays the lane that was asked for; what the engine calls itself is its `variant`,
	// so a report always answers "which entrance" with the word the caller used.
	const { engine: variant, ...rest } = report;
	return { engine, ...(variant && variant !== engine ? { variant } : {}), ...rest, bytes: bytes.length };
}
