import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendPresentationVersionMemory } from "../plugins/elevation-3d/lib/run-memory.mjs";
import { renderEmbeddedPbrViews } from "../plugins/elevation-3d/lib/texturing/render-validator.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const OUTPUT_VERSION = "rendered-pbr-v7-competition-daylight";
const ACCEPTED_SOURCE_STYLE_SHA256 = "a80ac48cf978eea1c63bfbd4842d38f7a21179d9c0e782f3b551a4ad72902a06";
const PREVIOUS_STYLE_SHA256 = "ed4dae4fc3bb869810d156adf11c69d23265d4822b4a26e46e6c61fb8da9d9dc";
const PREVIOUS_LIMITATION = "The rendered-pbr-v6 presentation had washed highlights and weak material separation.";
const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function assertContained(root, candidate, label) {
	const scoped = relative(root, candidate);
	if (scoped.startsWith("..") || isAbsolute(scoped)) throw new Error(`${label} escapes the output root`);
}

export async function prepareCanonicalReplay({ outputRoot, canonicalDir, acceptedSourceDir, glbPath, camerasPath, archiveAcceptedCanonical = false }) {
	const root = await realpath(resolve(outputRoot));
	const canonical = resolve(canonicalDir);
	if (dirname(canonical) !== resolve(outputRoot) || basename(canonical) !== OUTPUT_VERSION) throw new Error("Canonical target must be the fixed direct child of the output root");
	const [source, existingCanonical] = await Promise.all([realpath(resolve(acceptedSourceDir)), realpath(canonical)]);
	assertContained(root, source, "Accepted source");
	assertContained(root, existingCanonical, "Canonical target");
	const [sourceReport, sourceConfig, acceptedConfig, glbBytes, canonicalReport] = await Promise.all([
		readFile(join(source, "render-validation.json"), "utf8").then(JSON.parse),
		readFile(join(source, "viewer", "config.json"), "utf8").then(JSON.parse),
		readFile(resolve(camerasPath), "utf8").then(JSON.parse),
		readFile(resolve(glbPath)),
		readFile(join(existingCanonical, "render-validation.json"), "utf8").then(JSON.parse),
	]);
	const style = resolvePbrRenderStyle();
	const styleSha256 = renderStyleHash(style);
	const glbSha256 = (await import("node:crypto")).createHash("sha256").update(glbBytes).digest("hex");
	if (sourceReport.validation?.accepted !== true) throw new Error("Accepted source report is not accepted");
	if (sourceReport.selected_glb?.sha256 !== glbSha256) throw new Error("Accepted source GLB identity does not match");
	if (sourceReport.render_style?.id !== style.id || !new Set([styleSha256, PREVIOUS_STYLE_SHA256, ACCEPTED_SOURCE_STYLE_SHA256]).has(sourceReport.render_style_sha256)) throw new Error("Accepted source style identity does not match");
	if (canonicalJson(sourceConfig.cameras?.views) !== canonicalJson(acceptedConfig.cameras?.views)) throw new Error("Accepted source camera identity does not match");
	if (canonicalReport.validation?.accepted === true && archiveAcceptedCanonical !== true) throw new Error("Refusing to overwrite an accepted canonical artifact");
	if (![true, false].includes(canonicalReport.validation?.accepted)) throw new Error("Existing canonical artifact has no explicit validation decision");
	const attempts = join(root, "attempts");
	await mkdir(attempts, { recursive: true });
	assertContained(root, await realpath(attempts), "Attempts directory");
	let preservedAttempt;
	for (let index = 1; index <= 999; index++) {
		const candidate = join(attempts, `${OUTPUT_VERSION}-attempt-${String(index).padStart(3, "0")}`);
		try { await realpath(candidate); }
		catch (error) { if (error?.code === "ENOENT") { preservedAttempt = candidate; break; } throw error; }
	}
	if (!preservedAttempt) throw new Error("No canonical attempt slot is available");
	const lockPath = join(root, ".canonical-rerender.lock");
	const lock = await open(lockPath, "wx");
	try {
		await rename(existingCanonical, preservedAttempt);
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
	return { canonicalDir: canonical, preservedAttempt, acceptedSourceDir: source, glbSha256, styleSha256 };
}

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
	const supported = new Set(["--glb", "--cameras", "--procedural-baseline", "--presentation-baseline", "--accepted-source", "--archive-accepted-canonical", "--output-root", "--output"]);
	for (const name of values.keys()) if (!supported.has(name)) throw new Error(`Unsupported replay argument: ${name}`);
	const resolved = (name) => resolve(cwd, requiredArgument(values, name));
	const outputDir = resolved("--output");
	return {
		glbPath: resolved("--glb"),
		camerasPath: resolved("--cameras"),
		proceduralBaselineRunDir: resolved("--procedural-baseline"),
		...(values.has("--presentation-baseline") ? { presentationBaselineRunDir: resolved("--presentation-baseline") } : {}),
		...(values.has("--accepted-source") ? { acceptedSourceDir: resolved("--accepted-source") } : {}),
		...(values.has("--archive-accepted-canonical") ? { archiveAcceptedCanonical: requiredArgument(values, "--archive-accepted-canonical") === "true" } : {}),
		outputDir,
		outputRoot: resolved("--output-root"),
	};
}

async function resolveScopedOutput(outputDir, outputRoot, realpathFs = realpath) {
	if (!outputRoot) throw new Error("An explicit output root is required");
	const root = resolve(outputRoot);
	const output = resolve(outputDir);
	if (output === root) throw new Error("Output directory must be distinct from and below the explicit output root");
	if (dirname(output) !== root) throw new Error("Output directory must be the fixed direct child below the explicit output root");
	if (basename(output) !== OUTPUT_VERSION) throw new Error(`Output directory must be named ${OUTPUT_VERSION}`);
	const [realRoot, realParent] = await Promise.all([realpathFs(root), realpathFs(dirname(output))]);
	if (resolve(realParent) !== resolve(realRoot)) throw new Error("Output directory parent must resolve to the explicit output root");
	return { root, output };
}

async function reserveOutput(path, mkdirFs = mkdir) {
	try {
		await mkdirFs(path, { recursive: false });
	} catch (error) {
		if (error?.code === "EEXIST") throw new Error(`Output directory already exists or is reserved: ${path}`);
		throw error;
	}
}

export async function renderCompetitionDaylightReplay(options, deps = {}) {
	const glbPath = resolve(options.glbPath);
	const camerasPath = resolve(options.camerasPath);
	const proceduralBaselineRunDir = resolve(options.proceduralBaselineRunDir);
	const presentationBaselineRunDir = options.presentationBaselineRunDir ? resolve(options.presentationBaselineRunDir) : undefined;
	const acceptedSourceDir = options.acceptedSourceDir ? resolve(options.acceptedSourceDir) : undefined;
	const archiveAcceptedCanonical = options.archiveAcceptedCanonical === true;
	const { root: outputRoot, output: outputDir } = await resolveScopedOutput(options.outputDir, options.outputRoot, deps.realpath);
	if (presentationBaselineRunDir && basename(presentationBaselineRunDir) !== "rendered-pbr-v6") {
		throw new Error("Presentation baseline must point to rendered-pbr-v6");
	}
	if (acceptedSourceDir && !presentationBaselineRunDir) throw new Error("Canonical replay requires the rendered-pbr-v6 presentation baseline");
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
	const prepare = deps.prepareCanonicalReplay ?? prepareCanonicalReplay;
	const canonicalPreparation = acceptedSourceDir ? await prepare({
		outputRoot, canonicalDir: outputDir, acceptedSourceDir, glbPath, camerasPath, archiveAcceptedCanonical,
	}) : null;
	await reserveOutput(outputDir, deps.mkdir);
	let report;
	try {
		report = await render({
			glbPath, runDir: outputDir, candidateId: viewerConfig.candidate_id,
			cameras: viewerConfig.cameras.views, baselineRunDir: proceduralBaselineRunDir,
			...(presentationBaselineRunDir ? { presentationBaselineRunDir, requirePresentationBaselineComparison: true } : {}),
			...(canonicalPreparation ? { canonicalSelection: {
				canonical_path: outputDir, preserved_attempt: canonicalPreparation.preservedAttempt,
				accepted_source: canonicalPreparation.acceptedSourceDir,
			} } : {}),
			renderStyleId: "competition-daylight-v1",
		});
		if (canonicalPreparation && !(report.baseline_comparison?.status === "compared_legacy_reanalyzed"
			&& report.baseline_comparison?.decision?.accepted === true && report.validation?.accepted === true)) {
			throw Object.assign(new Error("Canonical replay did not pass the required legacy comparison"), { code: "PBR_BASELINE_COMPARISON_REQUIRED" });
		}
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
