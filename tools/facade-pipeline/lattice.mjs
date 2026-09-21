/**
 * The lattice lane: evaluate a ModelSpec (Python, tools/facade-parametric) and hand the cells
 * to a grammar. Node never evaluates a spec - the evaluator is one program, in one language, so
 * the 2D CAD and the 3D drawing carry one model hash.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT } from "./config.mjs";

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const script = join(REPO_ROOT, "tools", "facade-parametric", "cli.py");

/** `cli.py evaluate <spec> <out>`: instances.json + facade.svg + facade.dxf + facade_model.json. */
export async function evaluateLattice({ specPath, outDir }) {
	let stdout;
	// Ten minutes: a 4,096-cell evaluation with the overlap check runs in seconds, and an
	// evaluator that spins (a spec the contract did not refuse) must not hang the caller.
	try { ({ stdout } = await exec(python, [script, "evaluate", resolve(specPath), resolve(outDir)], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })); }
	catch (error) { throw new Error(`lattice evaluation failed (${error.code ?? error.signal}): ${error.stdout ?? ""}\n${error.stderr ?? error.message}`); }
	const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
	if (!report.ok) throw new Error(`lattice evaluation refused: ${report.error}`);
	return report;
}

/** `cli.py fit <curves.json> <spec-out.json> [depth_m] [scoop_deg]`: observed cells -> ModelSpec + recovery numbers. */
export async function fitLattice({ curvesPath, specOut, depthM, scoopDeg }) {
	const args = [script, "fit", resolve(curvesPath), resolve(specOut)];
	// Positional on the Python side: a scoop without a depth would be read as the depth.
	if (depthM !== undefined || scoopDeg !== undefined) args.push(String(depthM ?? -0.36));
	if (scoopDeg !== undefined) args.push(String(scoopDeg));
	let stdout;
	try { ({ stdout } = await exec(python, args, { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })); }
	catch (error) { throw new Error(`lattice fit failed (${error.code ?? error.signal}): ${error.stdout ?? ""}\n${error.stderr ?? error.message}`); }
	const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
	if (!report.ok) throw new Error(`lattice fit refused: ${report.error}`);
	return report;
}

/**
 * A grammar on disk names its cells by file (`lattice.instances: "lattice-001/instances.json"`,
 * relative to the grammar) so the file stays readable; the parser wants the cells inline. Load
 * them here, keep only the named family, and refuse a file whose model hash is not the one the
 * grammar wrote - the hash is the whole point.
 */
export async function inlineLatticeInstances(authored, baseDir) {
	// A copy: the caller keeps the grammar it read (the file form, what a report should quote)
	// and the checked program is the copy with the cells in it.
	const grammar = structuredClone(authored);
	const rules = Array.isArray(grammar?.rules) ? grammar.rules.flatMap((rule) => rule.alternatives ?? [])
		: Object.values(grammar?.rules ?? {}).flat();
	for (const alternative of rules) {
		const lattice = alternative?.lattice;
		if (!lattice || typeof lattice.instances !== "string") continue;
		const path = isAbsolute(lattice.instances) ? lattice.instances : join(baseDir, lattice.instances);
		const evaluated = JSON.parse(await readFile(path, "utf8"));
		if (evaluated.schema_version !== "arr.elevation3d.facade-instances.v1") throw new Error(`${path} is not an instances file`);
		if (evaluated.model_hash !== lattice.model_hash) {
			throw new Error(`lattice model_hash mismatch: the grammar names ${lattice.model_hash}, ${path} carries ${evaluated.model_hash}`);
		}
		const cells = evaluated.instances.filter((instance) => instance.unit === lattice.family);
		if (!cells.length) throw new Error(`${path} holds no cells of family ${lattice.family}`);
		// The keys the contract reads, and nothing the evaluator wrote for the 2D alone. A funnel's
		// throat (outline_far_m) is one of them - the first draw of the funnel module lost it here,
		// and every cell came out as a straight hexagonal tube with the pane at its mouth.
		// (and the tile, the third time this line lost a loop: the module's footprint)
		// (and the profile, the funnel's section - the fourth thing this line has had to learn to carry)
		lattice.instances = cells.map(({ id, center_m, outline_m, outline_far_m, tile_m, throat_scale, profile, attributes, segment_id, mesh_uzn, aperture_area_m2 }) => ({
			id, center_m, outline_m, ...(mesh_uzn ? {mesh_uzn,aperture_area_m2} : {}), ...(outline_far_m ? { outline_far_m } : {}), ...(tile_m ? { tile_m } : {}),
			...(Number.isFinite(throat_scale) ? { throat_scale } : {}), ...(outline_far_m && profile ? { profile } : {}),
			attributes, ...(segment_id ? { segment_id } : {}),
		}));
	}
	return grammar;
}

/** A grammar file, with its lattice cells inlined: the one way every command reads one. */
export async function readAuthoredGrammar(grammarPath) {
	const path = resolve(grammarPath);
	return inlineLatticeInstances(JSON.parse(await readFile(path, "utf8")), dirname(path));
}
