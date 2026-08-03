import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";
import { renderCompetitionAxons } from "./competition-axon.mjs";
import { renderCompetitionPlan, validateCompetitionPlanTopPair } from "./competition-plan.mjs";
import { sha256 } from "./core.mjs";
import { resolveMaterialPalette } from "./material-palettes.mjs";
import { renderCompetitionElevations } from "./multi-elevation.mjs";
import { buildViewerBundle } from "./viewer.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const REQUIRED_CONTROLS = ["orbit", "pan", "zoom", "reset", "view-buttons", "palette-selector", "glb-download"];

function portable(path) { return path.replaceAll("\\", "/"); }
function dot(left, right) { return left.reduce((sum, value, index) => sum + value * right[index], 0); }

export function validateAllViewsRun({ views, selectedGlbSha256, paletteSha256, viewer }) {
	const codes = [];
	const keys = Object.keys(views ?? {});
	if (keys.sort().join("|") !== [...VIEW_NAMES].sort().join("|")) codes.push("VIEWS_INCOMPLETE");
	const records = VIEW_NAMES.map((name) => views?.[name]).filter(Boolean);
	if (records.length !== VIEW_NAMES.length || new Set(records.map((view) => view.path)).size !== VIEW_NAMES.length || new Set(records.map((view) => view.sha256)).size !== VIEW_NAMES.length) codes.push("VIEWS_DUPLICATE");
	if (!selectedGlbSha256 || records.some((view) => view.selected_glb_sha256 !== selectedGlbSha256)) codes.push("SELECTED_GLB_MISMATCH");
	if (!paletteSha256) codes.push("PALETTE_MISSING");
	if (records.some((view) => !view.validation?.accepted)) codes.push("VIEW_REJECTED");
	if (records.some((view) => view.width !== 2400 || view.height !== 2400)) codes.push("OUTPUT_SIZE_INVALID");
	if (views?.plan?.sha256 === views?.top?.sha256) codes.push("PLAN_TOP_PIXELS_IDENTICAL");
	const axonDepth = views?.axon?.camera?.depth, oppositeDepth = views?.["opposite-axon"]?.camera?.depth;
	if (!Array.isArray(axonDepth) || !Array.isArray(oppositeDepth) || dot(axonDepth, oppositeDepth) >= -0.8) codes.push("AXON_OPPOSITION_INVALID");
	if (REQUIRED_CONTROLS.some((control) => !viewer?.controls?.includes(control))) codes.push("VIEWER_CONTROLS_MISSING");
	const config = viewer?.config;
	if (config?.mesh != null || config?.strategies?.hunyuan?.glb !== "../enriched.glb" || config?.all_views?.selected_glb?.path !== "../enriched.glb" || config?.all_views?.selected_glb?.sha256 !== selectedGlbSha256) codes.push("VIEWER_ALTERNATE_GEOMETRY");
	return { schema_version: "arr.elevation3d.all-views-validation.v1", accepted: codes.length === 0, codes };
}

function viewRecord(runDir, artifact) {
	return {
		path: portable(relative(runDir, artifact.path)), sha256: artifact.sha256, width: artifact.width, height: artifact.height,
		selected_glb_sha256: artifact.selected_glb_sha256 ?? artifact.manifest?.selected_glb?.sha256,
		camera: artifact.camera ?? artifact.manifest?.camera, validation: artifact.validation,
		manifest: artifact.manifest_record ? { path: portable(relative(runDir, artifact.manifest_record.path)), sha256: artifact.manifest_record.sha256 } : undefined,
		validation_report: artifact.validation_report ? { path: portable(relative(runDir, artifact.validation_report.path)), sha256: artifact.validation_report.sha256 } : undefined,
	};
}

async function reviewedArtifact(root, name) {
	const elevation = ["front", "back", "left", "right"].includes(name);
	const base = elevation ? join(root, "views", name, "competition-elevation", name) : join(root, "views", name);
	const path = join(base, `${name}.png`);
	const manifestPath = join(base, `${name}-${elevation ? "render-" : ""}manifest.json`);
	const validationPath = join(base, `${name}-validation.json`);
	let imageBytes, manifestBytes, validationBytes;
	try { [imageBytes, manifestBytes, validationBytes] = await Promise.all([readFile(path), readFile(manifestPath), readFile(validationPath)]); }
	catch (error) { if (error?.code === "ENOENT") return null; throw error; }
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	const validation = JSON.parse(validationBytes.toString("utf8"));
	const { width, height } = await sharp(imageBytes).metadata();
	return {
		path, sha256: sha256(imageBytes), width, height,
		selected_glb_sha256: manifest.selected_glb_sha256 ?? manifest.selected_glb?.sha256,
		camera: manifest.camera, manifest, validation,
		manifest_record: { path: manifestPath, sha256: sha256(manifestBytes) },
		validation_report: { path: validationPath, sha256: sha256(validationBytes) },
	};
}

async function reviewedGroup(root, names) {
	const entries = await Promise.all(names.map(async (name) => [name, await reviewedArtifact(root, name)]));
	return entries.every(([, artifact]) => artifact) ? Object.fromEntries(entries) : null;
}

export async function renderAllViews(inputs) {
	const root = resolve(inputs.runDir);
	await mkdir(root, { recursive: true });
	const selectedBytes = await readFile(inputs.glbPath);
	const selectedGlbSha256 = sha256(selectedBytes);
	const selectedPath = join(root, "enriched.glb");
	if (resolve(inputs.glbPath) !== selectedPath) await copyFile(inputs.glbPath, selectedPath);
	const elevationNames = ["front", "back", "left", "right"];
	const reviewedElevations = await reviewedGroup(root, elevationNames);
	const elevations = reviewedElevations ? { views: reviewedElevations } : await renderCompetitionElevations({ ...inputs, cameras: Object.fromEntries(elevationNames.map((name) => [name, inputs.cameras[name]])) });
	const reviewedPlans = await reviewedGroup(root, ["plan", "top"]);
	let plan, top, planTopValidation = { accepted: true, codes: [] };
	if (reviewedPlans) ({ plan, top } = reviewedPlans);
	else {
		plan = await renderCompetitionPlan({ ...inputs, camera: inputs.cameras.top, mode: "plan", cutElevationM: inputs.cutElevationM });
		top = await renderCompetitionPlan({ ...inputs, camera: inputs.cameras.top, mode: "top" });
		planTopValidation = await validateCompetitionPlanTopPair({ plan, top, sourceMesh: inputs.sourceMesh, camera: inputs.cameras.top, selectedGlbPath: inputs.glbPath });
	}
	const reviewedAxons = await reviewedGroup(root, ["axon", "opposite-axon"]);
	const axons = reviewedAxons ? { views: reviewedAxons } : await renderCompetitionAxons({ ...inputs, cameras: { axon: inputs.cameras.axon, "opposite-axon": inputs.cameras["opposite-axon"] } });
	const artifacts = {
		front: elevations.views.front, back: elevations.views.back, left: elevations.views.left, right: elevations.views.right,
		plan: { ...plan, selected_glb_sha256: plan.manifest.selected_glb.sha256, validation: planTopValidation.accepted ? plan.validation : { ...plan.validation, accepted: false } },
		top: { ...top, selected_glb_sha256: top.manifest.selected_glb.sha256, validation: planTopValidation.accepted ? top.validation : { ...top.validation, accepted: false } },
		axon: axons.views.axon, "opposite-axon": axons.views["opposite-axon"],
	};
	const views = Object.fromEntries(VIEW_NAMES.map((name) => [name, viewRecord(root, artifacts[name])]));
	const palettes = Object.fromEntries(["warm", "neutral", "stone"].map((name) => [name, resolveMaterialPalette(`competition-${name}`)]));
	const controls = [...REQUIRED_CONTROLS];
	const config = {
		schema_version: "arr.elevation3d.all-views-viewer.v1", candidate_id: inputs.candidateId,
		strategies: { hunyuan: { glb: "../enriched.glb" } }, cameras: { views: {} },
		all_views: {
			selected_glb: { path: "../enriched.glb", sha256: selectedGlbSha256 }, palettes, views,
			validation: { accepted: true, codes: [] },
			artifacts: VIEW_NAMES.map((name) => ({ label: `${name} PNG`, path: `../${views[name].path}` })),
		},
	};
	const validation = validateAllViewsRun({ views, selectedGlbSha256, paletteSha256: inputs.palette.sha256, viewer: { controls, config } });
	config.all_views.validation = validation;
	await buildViewerBundle({ runDir: root, config });
	const configPath = join(root, "viewer", "config.json");
	const validationPath = join(root, "validation.json");
	await writeFile(validationPath, JSON.stringify(validation, null, 2));
	const manifest = {
		schema_version: "arr.elevation3d.all-views.v1",
		selected_glb: { path: "enriched.glb", sha256: selectedGlbSha256 },
		palette_sha256: inputs.palette.sha256,
		views,
		viewer: { path: "viewer/index.html", config_sha256: sha256(await readFile(configPath)) },
		validation: { accepted: validation.accepted, codes: validation.codes },
	};
	const manifestPath = join(root, "all-views-manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
	return {
		...manifest, manifest,
		views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { ...views[name], path: artifacts[name].path }])),
		manifest_record: { path: manifestPath, sha256: sha256(await readFile(manifestPath)) },
		validation: { ...validation, path: validationPath, sha256: sha256(await readFile(validationPath)) },
	};
}
