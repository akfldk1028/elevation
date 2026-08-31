/**
 * One entry point for the elevation agent.
 *
 *   node tools/facade-pipeline/cli.mjs roots
 *   node tools/facade-pipeline/cli.mjs prepare <candidate> [--glb p --front p --axon p]
 *   node tools/facade-pipeline/cli.mjs brief   <candidate>
 *   node tools/facade-pipeline/cli.mjs check   <candidate> <grammar.json>
 *   node tools/facade-pipeline/cli.mjs render  <candidate> <grammar.json> <name> [--palette p]
 *
 * Every subcommand prints one JSON object on stdout and exits non-zero when the step did not
 * succeed - so a caller can pipe it, and a failed check cannot be mistaken for a pass by a
 * shell that only reads the exit code. The scripts this replaces printed a done line through
 * `| tail -1`, which masked the exit code of the step that mattered and reported two failed
 * renders as successes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveRoots, runDirFor } from "./config.mjs";
import { prepareFacadeContext } from "./prepare.mjs";
import { checkFacadeGrammar, renderFacadeScheme, writeFacadeBrief } from "./index.mjs";

function flags(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1], i += 1;
		else rest.push(argv[i]);
	}
	return { out, rest };
}

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const USAGE = "usage: cli.mjs roots | prepare <candidate> | brief <candidate>"
	+ " | check <candidate> <grammar.json> | render <candidate> <grammar.json> <name> [--palette p]";

export async function runPipelineCli(argv) {
	const { out: flag, rest } = flags(argv);
	const [command, candidateId, ...args] = rest;
	const roots = { datasetRoot: flag.dataset, outputRoot: flag.output };

	if (command === "roots") { say(resolveRoots(roots)); return 0; }
	if (!command || !candidateId) { say({ ok: false, error: USAGE }); return 2; }

	const prepared = await prepareFacadeContext({
		candidateId, selectedGlb: flag.glb, frontPng: flag.front, axonPng: flag.axon, ...roots,
	});
	const { runDir, candidate, context } = prepared;

	if (command === "prepare") {
		const byFace = {};
		for (const segment of context.facade_segments) {
			const view = segment.face_view ?? segment.view;
			byFace[view] = (byFace[view] ?? 0) + 1;
		}
		say({
			ok: true, candidate: candidateId, run_dir: runDir,
			storeys: context.storeys.length, segments: context.facade_segments.length,
			segments_by_face: byFace,
			storey_heights: context.storeys.map((storey) => Number((storey.z_max - storey.z_min).toFixed(3))),
		});
		return 0;
	}

	if (command === "brief") {
		const brief = await writeFacadeBrief({ runDir, context });
		say({ ok: true, candidate: candidateId, sha256: brief.promptSha256, chars: brief.prompt.length, paths: brief.paths });
		return 0;
	}

	const [grammarPath, name] = args;
	if (!grammarPath) { say({ ok: false, error: USAGE }); return 2; }
	const grammar = JSON.parse(await readFile(resolve(grammarPath), "utf8"));

	if (command === "check") {
		const checked = checkFacadeGrammar({ context, grammar });
		// The program and its resolution are megabytes of derived geometry and no caller of a
		// CLI wants them on stdout; the verdict, the measurements and the faults are the answer.
		const { program, resolved, validation, ...report } = checked;
		say(report);
		return checked.ok ? 0 : 1;
	}

	if (command === "render") {
		if (!name) { say({ ok: false, error: USAGE }); return 2; }
		const rendered = await renderFacadeScheme({
			runDir: join(runDir, name), candidate, context, grammar,
			palette: flag.palette ?? "competition-warm",
		});
		await writeFile(join(runDir, name, "composition.json"), `${JSON.stringify(rendered.composition, null, 2)}\n`, "utf8");
		say({
			ok: true, candidate: candidateId, out: join(runDir, name),
			hero: rendered.hero.path, composition: rendered.composition,
		});
		return 0;
	}

	say({ ok: false, error: USAGE });
	return 2;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
	process.exitCode = await runPipelineCli(process.argv.slice(2)).catch((error) => {
		say({ ok: false, error: String(error?.message ?? error).slice(0, 900) });
		return 1;
	});
}
