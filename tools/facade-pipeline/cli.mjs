/**
 * One entry point for the elevation agent.
 *
 *   node tools/facade-pipeline/cli.mjs roots
 *   node tools/facade-pipeline/cli.mjs prepare <candidate> [--glb p --front p --axon p]
 *   node tools/facade-pipeline/cli.mjs brief   <candidate>
 *   node tools/facade-pipeline/cli.mjs check   <candidate> <grammar.json>
 *   node tools/facade-pipeline/cli.mjs render  <candidate> <grammar.json> <name> [--palette preset|palette.json]
 *
 * Every subcommand prints one JSON object on stdout and exits non-zero when the step did not
 * succeed - so a caller can pipe it, and a failed check cannot be mistaken for a pass by a
 * shell that only reads the exit code. The scripts this replaces printed a done line through
 * `| tail -1`, which masked the exit code of the step that mattered and reported two failed
 * renders as successes.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { codexPhoto } from "../facade-presentation/photo/codex-photo.mjs";
import { buildConceptSubject } from "../facade-presentation/photo/concept-subject.mjs";
import { runCli as runShowcase } from "../facade-presentation/showcase/cli.mjs";
import { resolveRoots, runDirFor } from "./config.mjs";
import { makeConcept } from "./concept.mjs";
import { prepareFacadeContext } from "./prepare.mjs";
import { briefIsStale, checkFacadeGrammar, renderFacadeScheme, writeFacadeBrief } from "./index.mjs";
import { compareDrawingToSource } from "./source-check.mjs";
import { traceFacade, exportFacadeCAD } from "./vision.mjs";
import { runPerspectiveWorkflow } from './perspective-workflow.mjs';
import { evaluateLattice, fitLattice, readAuthoredGrammar } from "./lattice.mjs";
import { applyBaseModel } from "./apply.mjs";

/**
 * The compiled GLB of a rendered scheme.
 *
 * The compiler writes under a content hash, so `compiled/facade.glb` does not exist and
 * every caller that guessed it failed with ENOENT on a path that reads as if it should be
 * right. Presentation callers should ask for the scheme by name and be handed the file.
 */
async function compiledGlb(runDir, name) {
	const root = join(runDir, name, "compiled");
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const candidate = join(root, entry.name, "facade.glb");
			if (await readFile(candidate).then(() => true, () => false)) return candidate;
		}
	}
	throw new Error(`no compiled facade.glb under ${root} - render ${name} first`);
}

function flags(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i].startsWith("--")) {
			// A flag with no value of its own is a switch: `--keep-voids` used to swallow whatever
			// came next (or end up undefined at the end of the line) and read as false.
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) out[argv[i].slice(2)] = true;
			else { out[argv[i].slice(2)] = next; i += 1; }
		} else rest.push(argv[i]);
	}
	return { out, rest };
}

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const USAGE = "usage: cli.mjs roots | prepare <candidate> | brief <candidate>"
	+ " | agent <candidate> <name> --idea <design-intent> [--concept existing.png --engine sam3 --attempts 3]"
	+ " | check <candidate> <grammar.json> | draw <candidate> <grammar.json> <name> [--palette preset|palette.json]"
	+ " | render <candidate> <grammar.json> <name> [--palette preset|palette.json]"
	+ " | showcase <candidate> <name> <out.png> [--wall --glass --frame --mood --face]"
	+ " | photo <in.png> <out.png> [--subject s]"
	+ " | concept <candidate> <name> --idea \"...\" [--engine codex|sdxl --seed 7 --scale 0.6 --steps 30]"
	+ " | lattice <spec.json> <out-dir>   (evaluate a ModelSpec: instances.json + SVG + DXF under one model hash)"
	+ " | mass <roi.json> <name> --depth <m>   (TEST FIXTURE ONLY: a mass from a photograph's silhouette, for judging a drawing before the mass agent delivers. The mass is the authority and comes from the mass agent; this agent never designs one.) | fit <curves.json> <spec-out.json> [--depth -0.36 --scoop 25]   (observed cells from `trace` -> a ModelSpec, with recovery numbers)"
	+ " | apply <candidate> <base-spec.json> <name> [--scale 1 --pitch 1 --thickness 0.45 --web 0.05 --rotate 0 --points 24 --faces front,back --keep-voids]   (a base model onto a mass: facet run, spec, grammar, gates)"
	+ " | trace <candidate> <image> [name] --roi <polygon-and-scale.json> [--engine sam3|sam2|classical]"
	+ " | cad <facade_model.json> <output-directory>"
	+ " | edit <facade_model.json> <output-directory> --edits <design-edits.json>";

// A palette is a design decision, and until now this CLI could only pass one of four preset
// NAMES - so an author could say which member is brick but never what brick looks like, and
// one of them wrote `brick` on a metal rainscreen purely to borrow its hue. The palette
// module has always accepted an object ({ preset, roles, materials }); this makes that
// reachable: --palette may be a preset name OR a path to a JSON file the author wrote.
async function resolvePaletteFlag(value) {
	const requested = value ?? "competition-warm";
	if (!/[\/.]/.test(requested)) return requested;
	return JSON.parse(await readFile(requested, "utf8"));
}

export async function runPipelineCli(argv) {
	const { out: flag, rest } = flags(argv);
	const [command, candidateId, ...args] = rest;
	const roots = { datasetRoot: flag.dataset, outputRoot: flag.output };

	if (command === "roots") { say(resolveRoots(roots)); return 0; }
	if (command === 'agent') {
		const report = await runPerspectiveWorkflow({candidateId,name:args[0],idea:flag.idea,conceptPath:flag.concept,
			resume:Boolean(flag.resume),
			rerender:Boolean(flag.rerender),
			requireVision:Boolean(flag['require-vision'] || flag.requireVision),
			engine:flag.engine ?? 'sam3',tileSize:Number(flag['tile-size'] ?? 512),maxAttempts:Number(flag.attempts ?? 3),...roots});
		say({ok:report.ok,stage:report.stage,candidate:report.candidate,vision_ok:report.vision_ok ?? false,manifest:report.manifest,
			source:report.source,views:report.views,attempts:report.attempts.map(a=>({attempt:a.attempt,stage:a.stage}))});
		return report.ok ? 0 : 1;
	}
	if (command === "lattice") {
		const [specPath, outDir] = [candidateId, ...args];
		if (!specPath || !outDir) { say({ ok: false, error: USAGE }); return 2; }
		const report = await evaluateLattice({ specPath, outDir });
		say(report); return report.ok ? 0 : 1;
	}
	if (command === "apply") {
		const [specPath, name] = args;
		if (!candidateId || !specPath || !name) { say({ ok: false, error: USAGE }); return 2; }
		const edits = Object.fromEntries(["scale", "pitch", "thickness", "web", "rotate", "points"].filter((k) => flag[k] !== undefined).map((k) => [k, Number(flag[k])]));
		// A design void is the SOURCE building's (an oculus belongs to the photograph, not to our
		// mass), so apply drops it - except when the mass IS that building and the base model is
		// being laid back onto it, which is how the source's own drawing covers its whole facet.
		if (flag["keep-voids"] || flag.keepVoids) edits.keep_voids = true;
		// The fitted size field is the SOURCE building's; keep it only when the base model is being
		// laid back onto that building (its own mass), which is also when its voids are kept.
		if (flag["keep-fields"] || flag.keepFields) edits.flat_fields = false;
		if (flag.face) edits.face = String(flag.face);
		const report = await applyBaseModel({ candidateId, specPath, name, edits, faces: flag.faces ? String(flag.faces).split(",") : undefined });
		say(report); return report.ok ? 0 : 1;
	}
	// A TEST FIXTURE, in the same class as `synthetic-box-WxDxH`: the mass a picture's silhouette
	// gives, so a drawing can be judged against the photograph before the mass agent has delivered
	// anything. THE MASS IS THE AUTHORITY AND IT COMES FROM THE MASS AGENT - this agent designs the
	// elevation on whatever mass it is handed and never makes one for a delivery. It exists because
	// the answer to "why does the Broad's veil not look like the Broad" was the box we had chosen,
	// and that is shown by putting the same veil on the photograph's own form, not by arguing it.
	if (command === "mass") {
		const [roiPath, name] = [candidateId, ...args];
		if (!roiPath || !name) { say({ ok: false, error: USAGE }); return 2; }
		const { massFromOutline } = await import("./outline-mass.mjs");
		const report = await massFromOutline({ roiPath, name, depthM: Number(flag.depth),
			bulgeM: flag.bulge === undefined ? 0 : Number(flag.bulge),
			leanM: flag.lean === undefined ? 0 : Number(flag.lean),
			columns: flag.columns === undefined ? 20 : Number(flag.columns), outputRoot: flag.output });
		if (report.ok) await prepareFacadeContext({ candidateId: report.candidate, ...roots });
		say(report); return report.ok ? 0 : 1;
	}
	if (command === "fit") {
		const [curvesPath, specOut] = [candidateId, ...args];
		if (!curvesPath || !specOut) { say({ ok: false, error: USAGE }); return 2; }
		const report = await fitLattice({ curvesPath, specOut, depthM: flag.depth, scoopDeg: flag.scoop });
		say(report); return report.ok ? 0 : 1;
	}
	if (command === "cad" || command === "edit") {
		if (!candidateId || !args[0]) { say({ok: false, error: USAGE}); return 2; }
		if (command === 'edit' && !flag.edits) { say({ok:false, error:'EDIT_SPEC_REQUIRED'}); return 2; }
		const report = await exportFacadeCAD(candidateId, args[0], command === 'edit' ? flag.edits : undefined);
		say(report); return report.ok ? 0 : 1;
	}
	if (command === "trace") {
		if (!candidateId || !args[0]) { say({ok: false, error: USAGE}); return 2; }
		const report = await traceFacade({candidateId, imagePath: args[0], name: args[1], flags: flag});
		say(report); return report.ok ? 0 : 1;
	}
	// The photoreal pass takes a picture, not a mass, so it needs no context and must not pay
	// for preparing one. It is the free lane: the user's Codex CLI, not a paid image API.
	if (command === "photo") {
		const [inputPng, outputPng] = [candidateId, ...args];
		if (!inputPng || !outputPng) { say({ ok: false, error: USAGE }); return 2; }
		const photo = await codexPhoto({
			inputPng: resolve(inputPng), outputPng: resolve(outputPng), subject: flag.subject,
		});
		say({ ok: true, ...photo });
		return 0;
	}
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

	// A concept is the perspective the standard lane starts from: the image model dresses
	// THIS mass with the commissioner's idea. The mass facts come from the prepared context,
	// so nobody types the storey count by hand; the idea is passed through verbatim.
	if (command === "concept") {
		const [name] = args;
		if (!name || !flag.idea) { say({ ok: false, error: USAGE }); return 2; }
		const subject = buildConceptSubject({ context, idea: flag.idea });
		const outputPng = join(runDir, `concept-${name}.png`);
		const photo = await makeConcept({ engine: flag.engine ?? "codex", runDir, outputPng, subject,
			seed: flag.seed, scale: flag.scale, steps: flag.steps });
		say({ ok: true, candidate: candidateId, concept: name, subject, ...photo });
		return 0;
	}

	// Showcase reads a rendered scheme, not a grammar: it is presentation, deliberately outside
	// the gated chain, and it takes its subject by scheme name so no caller has to know where
	// the compiler hid the GLB.
	if (command === "showcase") {
		const [name, outPng] = args;
		if (!name || !outPng) { say({ ok: false, error: USAGE }); return 2; }
		const glb = await compiledGlb(runDir, name);
		const showcaseArgs = [glb, resolve(outPng)];
		for (const axis of ["style", "wall", "glass", "frame", "mood", "face"]) {
			if (flag[axis]) showcaseArgs.push(`--${axis}`, flag[axis]);
		}
		await runShowcase(showcaseArgs);
		say({ ok: true, candidate: candidateId, scheme: name, glb, out: resolve(outPng) });
		return 0;
	}
	const [grammarPath, name] = args;
	if (!grammarPath) { say({ ok: false, error: USAGE }); return 2; }
	const grammar = await readAuthoredGrammar(grammarPath);
	// Is the brief in this run directory still the brief the engine would write?
	//
	// `brief` writes a file per candidate and nothing regenerates it when the prompt changes,
	// so a run directory quietly keeps whatever was written into it last. A transcriber read
	// one that predated the recess work by a day: it told them, at length and with
	// measurements, that a set-back opening "is not yet a drawing move - do not spend a render
	// on it", while the schema beside it described the hole the engine had been cutting since
	// the day before. They followed the brief, filed the photograph's most visible feature as
	// a missing capability, and said the two documents could not both be current. They were
	// right. Nothing had told them, so every run says it now.
	const briefStale = await (async () => {
		try {
			const onDisk = await readFile(join(runDir, "grammar-prompt.txt"), "utf8");
			if (!briefIsStale({ context, onDisk })) return null;
			return "the brief in this run directory is not what `brief` would write now - re-run `brief` and re-read it; an author following a stale one drew a building without the feature it was written to forbid";
		} catch { return null; }
	})();

	if (command === "check") {
		const checked = checkFacadeGrammar({ context, grammar });
		// The program and its resolution are megabytes of derived geometry and no caller of a
		// CLI wants them on stdout; the verdict, the measurements and the faults are the answer.
		const { program, resolved, validation, ...report } = checked;
		say({ ...report, ...(briefStale ? { brief_stale: briefStale } : {}) });
		return checked.ok ? 0 : 1;
	}

	// `check` answers "does this design hold" and `render` answers "does it draw", and they are
	// not the same question - a scheme has passed every design gate here and then died in the
	// renderer on a seam the design gates cannot see. An author whose loop ended at "accepted"
	// could not find that out, so it was found days later by someone building a sheet. `draw`
	// is the two in one, and it is what the authoring role stops on.
	if (command === "draw") {
		if (!name) { say({ ok: false, error: USAGE }); return 2; }
		const checked = checkFacadeGrammar({ context, grammar });
		if (!checked.ok) {
			const { program, resolved, validation, ...report } = checked;
			say({ ...report, drew: false, ...(briefStale ? { brief_stale: briefStale } : {}) });
			return 1;
		}
		const drawn = await renderFacadeScheme({
			runDir: join(runDir, name), candidate, context, grammar,
			palette: await resolvePaletteFlag(flag.palette),
		});
		await writeFile(join(runDir, name, "composition.json"), `${JSON.stringify(drawn.composition, null, 2)}\n`, "utf8");
		const sourceComparison = await compareDrawingToSource({runDir, grammar, heroPath: drawn.hero.path});
		const sourceOK = sourceComparison.source_fidelity?.accepted !== false;
		say({
			ok: sourceOK, stage: sourceOK ? "drawn" : "source_rejected", drew: true, candidate: candidateId, out: join(runDir, name),
			hero: drawn.hero.path, metrics: checked.metrics, composition: drawn.composition,
			// The one measurement that reads the photograph. `source_photograph` had eleven uses
			// in this engine and every one of them spent it turning a gate OFF; nothing opened
			// the file. So the project's own first rule - a person shown the photograph and the
			// drawing agrees they are the same building - was enforced by nobody, while eight
			// gates checked the drawing against itself and passed a drawing that was brown where
			// its photograph was grey and one note where its photograph ran shut to open.
			...sourceComparison,
			...(briefStale ? { brief_stale: briefStale } : {}),
		});
		return sourceOK ? 0 : 1;
	}

	if (command === "render") {
		if (!name) { say({ ok: false, error: USAGE }); return 2; }
		const rendered = await renderFacadeScheme({
			runDir: join(runDir, name), candidate, context, grammar,
			palette: await resolvePaletteFlag(flag.palette),
		});
		await writeFile(join(runDir, name, "composition.json"), `${JSON.stringify(rendered.composition, null, 2)}\n`, "utf8");
		const sourceComparison = await compareDrawingToSource({runDir, grammar, heroPath: rendered.hero.path});
		const sourceOK = sourceComparison.source_fidelity?.accepted !== false;
		say({
			ok: sourceOK, candidate: candidateId, out: join(runDir, name), ...sourceComparison,
			hero: rendered.hero.path, composition: rendered.composition,
		});
		return sourceOK ? 0 : 1;
	}

	say({ ok: false, error: USAGE });
	return 2;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
	process.exitCode = await runPipelineCli(process.argv.slice(2)).catch((error) => {
		// A compile failure wraps its real cause and the top message is always the same
		// sentence, so printing only `error.message` says "facade design compilation failed"
		// and nothing else. Walk the chain.
		const chain = [];
		for (let e = error; e && chain.length < 6; e = e.cause) chain.push(String(e?.message ?? e));
		say({ ok: false, error: chain.join(" <- ").slice(0, 900) });
		return 1;
	});
}
