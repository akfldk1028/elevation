import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendPresentationVersionMemory } from "../plugins/elevation-3d/lib/run-memory.mjs";
import { renderEmbeddedPbrViews } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const OUTPUT_VERSION = "rendered-pbr-v7-competition-daylight";
const PREVIOUS_LIMITATION = "The rendered-pbr-v6 presentation had washed highlights and weak material separation.";
const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function requiredArgument(values, name) {
	const value = values.get(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function parseReplayArgs(argv, cwd = process.cwd()) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid replay argument: ${name ?? "<missing>"}`);
		if (values.has(name)) throw new Error(`Duplicate replay argument: ${name}`);
		values.set(name, value);
	}
	const supported = new Set(["--glb", "--cameras", "--procedural-baseline", "--presentation-baseline", "--output"]);
	for (const name of values.keys()) if (!supported.has(name)) throw new Error(`Unsupported replay argument: ${name}`);
	const resolved = (name) => resolve(cwd, requiredArgument(values, name));
	const outputDir = resolved("--output");
	return {
		glbPath: resolved("--glb"),
		camerasPath: resolved("--cameras"),
		proceduralBaselineRunDir: resolved("--procedural-baseline"),
		...(values.has("--presentation-baseline") ? { presentationBaselineRunDir: resolved("--presentation-baseline") } : {}),
		outputDir,
		outputRoot: outputDir,
	};
}

function assertScopedFreshOutput(outputDir, outputRoot) {
	if (!outputRoot) throw new Error("An explicit output root is required");
	const root = resolve(outputRoot);
	const output = resolve(outputDir);
	const child = relative(root, output);
	if (child === ".." || child.startsWith("..\\") || child.startsWith("../") || isAbsolute(child)) {
		throw new Error("Output directory must remain below the explicit output root");
	}
	if (basename(output) !== OUTPUT_VERSION) throw new Error(`Output directory must be named ${OUTPUT_VERSION}`);
	return { root, output };
}

async function assertMissing(path) {
	try {
		await access(path);
		throw new Error(`Output directory already exists: ${path}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

export async function renderCompetitionDaylightReplay(options, deps = {}) {
	const glbPath = resolve(options.glbPath);
	const camerasPath = resolve(options.camerasPath);
	const proceduralBaselineRunDir = resolve(options.proceduralBaselineRunDir);
	const presentationBaselineRunDir = options.presentationBaselineRunDir ? resolve(options.presentationBaselineRunDir) : undefined;
	const { root: outputRoot, output: outputDir } = assertScopedFreshOutput(options.outputDir, options.outputRoot);
	await assertMissing(outputDir);
	if (presentationBaselineRunDir && basename(presentationBaselineRunDir) !== "rendered-pbr-v6") {
		throw new Error("Presentation baseline must point to rendered-pbr-v6");
	}
	const viewerConfig = JSON.parse(await readFile(camerasPath, "utf8"));
	if (viewerConfig.all_views?.validation?.accepted !== true) {
		throw new Error("Viewer config is not accepted");
	}
	if (Object.keys(viewerConfig.cameras?.views ?? {}).sort().join("|") !== [...VIEW_NAMES].sort().join("|")) {
		throw new Error("Accepted viewer config must contain all eight camera views");
	}
	const render = deps.renderEmbeddedPbrViews ?? renderEmbeddedPbrViews;
	const appendMemory = deps.appendPresentationVersionMemory ?? appendPresentationVersionMemory;
	const renderStyle = resolvePbrRenderStyle();
	const renderStyleSha256 = renderStyleHash(renderStyle);
	let report;
	try {
		report = await render({
			glbPath, runDir: outputDir, candidateId: viewerConfig.candidate_id,
			cameras: viewerConfig.cameras.views, baselineRunDir: proceduralBaselineRunDir,
			...(presentationBaselineRunDir ? { presentationBaselineRunDir } : {}),
			renderStyleId: "competition-daylight-v1",
		});
	} catch (error) {
		report = {
			render_style: renderStyle, render_style_sha256: renderStyleSha256,
			validation: { accepted: false, status: "rejected", codes: [error?.code ?? "PRESENTATION_REPLAY_FAILED"], metrics: {} },
			artifacts: {}, provider_calls: 0, credits_consumed: 0,
		};
		await appendMemory({
			candidateId: viewerConfig.candidate_id, outputDir,
			previousBaseline: { version: "rendered-pbr-v6", limitation: PREVIOUS_LIMITATION }, report,
		}, resolve(outputRoot, "presentation-versions.jsonl"));
		throw error;
	}
	await appendMemory({
		candidateId: viewerConfig.candidate_id, outputDir,
		previousBaseline: { version: "rendered-pbr-v6", limitation: PREVIOUS_LIMITATION }, report,
	}, resolve(outputRoot, "presentation-versions.jsonl"));
	return report;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryPoint) {
	const options = parseReplayArgs(process.argv.slice(2));
	const report = await renderCompetitionDaylightReplay(options);
	process.stdout.write(`${JSON.stringify({ output: options.outputDir, validation: report.validation })}\n`);
}
