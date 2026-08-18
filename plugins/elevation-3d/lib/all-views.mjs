import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";
import { renderCompetitionAxons } from "./competition-axon.mjs";
import { renderCompetitionPlan, validateCompetitionPlanTopPair } from "./competition-plan.mjs";
import { sha256, stableJson } from "./core.mjs";
import { resolveMaterialPalette } from "./material-palettes.mjs";
import { renderCompetitionElevations } from "./multi-elevation.mjs";
import { buildViewerBundle } from "./viewer.mjs";
import { atomicCopy, atomicWrite, prepareSafeDirectory, safeRead } from "./facade-agent/path-safety.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const REQUIRED_CONTROLS = ["orbit", "pan", "zoom", "reset", "fullscreen", "view-buttons", "palette-selector", "glb-download"];

function portable(path) { return path.replaceAll("\\", "/"); }
function dot(left, right) { return left.reduce((sum, value, index) => sum + value * right[index], 0); }

export function validateAllViewsRun({ views, selectedGlbSha256, palette, paletteSha256, viewer }) {
	const codes = [];
	const keys = Object.keys(views ?? {});
	if (keys.sort().join("|") !== [...VIEW_NAMES].sort().join("|")) codes.push("VIEWS_INCOMPLETE");
	const records = VIEW_NAMES.map((name) => views?.[name]).filter(Boolean);
	if (records.length !== VIEW_NAMES.length || new Set(records.map((view) => view.path)).size !== VIEW_NAMES.length || new Set(records.map((view) => view.sha256)).size !== VIEW_NAMES.length) codes.push("VIEWS_DUPLICATE");
	if (!selectedGlbSha256 || records.some((view) => view.selected_glb_sha256 !== selectedGlbSha256)) codes.push("SELECTED_GLB_MISMATCH");
	const paletteIdentities = new Set(records.map((view) => `${view.palette?.preset ?? ""}:${view.palette?.sha256 ?? ""}`));
	const runPalette = palette ?? (paletteSha256 ? { preset: records[0]?.palette?.preset, sha256: paletteSha256 } : null);
	if (paletteIdentities.size !== 1 || !runPalette?.preset || !runPalette?.sha256
		|| records.some((view) => view.palette?.preset !== runPalette.preset || view.palette?.sha256 !== runPalette.sha256)) codes.push("PALETTE_MISMATCH");
	if (records.some((view) => !view.validation?.accepted)) codes.push("VIEW_REJECTED");
	if (records.some((view) => view.width !== 2400 || view.height !== 2400)) codes.push("OUTPUT_SIZE_INVALID");
	if (views?.plan?.sha256 === views?.top?.sha256) codes.push("PLAN_TOP_PIXELS_IDENTICAL");
	const axonDepth = views?.axon?.camera?.depth, oppositeDepth = views?.["opposite-axon"]?.camera?.depth;
	if (!Array.isArray(axonDepth) || !Array.isArray(oppositeDepth) || dot(axonDepth, oppositeDepth) >= -0.8) codes.push("AXON_OPPOSITION_INVALID");
	const evidence = viewer?.evidence;
	if (evidence?.schema_version !== "arr.elevation3d.viewer-evidence.v1" || !evidence.html?.sha256 || !evidence.app?.sha256 || !evidence.config?.sha256
		|| REQUIRED_CONTROLS.some((control) => evidence.controls?.[control] !== true)) codes.push("VIEWER_CONTROLS_MISSING");
	const config = viewer?.config;
	if (config?.mesh != null || config?.strategies?.hunyuan?.glb !== "../enriched.glb" || config?.all_views?.selected_glb?.path !== "../enriched.glb" || config?.all_views?.selected_glb?.sha256 !== selectedGlbSha256) codes.push("VIEWER_ALTERNATE_GEOMETRY");
	const cameraViews = config?.cameras?.views ?? {};
	if (Object.keys(cameraViews).sort().join("|") !== [...VIEW_NAMES].sort().join("|")
		|| ["front", "back", "left", "right", "plan", "top"].some((name) => cameraViews[name]?.type !== "orthographic" || !cameraViews[name]?.projection_axes)
		|| ["axon", "opposite-axon"].some((name) => cameraViews[name]?.type !== "perspective" || !Array.isArray(cameraViews[name]?.depth))
		|| cameraViews.plan?.cut?.enabled !== true || cameraViews.plan?.cut?.elevation_m !== 1.2 || cameraViews.top?.cut?.enabled !== false
		|| JSON.stringify(cameraViews.front?.projection_axes) === JSON.stringify(cameraViews.back?.projection_axes)
		|| JSON.stringify(cameraViews.left?.projection_axes) === JSON.stringify(cameraViews.right?.projection_axes)
		|| dot(cameraViews.axon?.depth ?? [], cameraViews["opposite-axon"]?.depth ?? []) >= -0.8) codes.push("VIEWER_CAMERAS_INVALID");
	return { schema_version: "arr.elevation3d.all-views-validation.v1", accepted: codes.length === 0, codes };
}

export async function inspectBuiltViewer({ runDir }) {
	const root = resolve(runDir);
	const paths = { html: join(root, "viewer", "index.html"), app: join(root, "viewer", "app.js"), config: join(root, "viewer", "config.json") };
	const [htmlBytes, appBytes, configBytes] = await Promise.all([readFile(paths.html), readFile(paths.app), readFile(paths.config)]);
	const html = htmlBytes.toString("utf8"), app = appBytes.toString("utf8"), config = JSON.parse(configBytes.toString("utf8"));
	return {
		schema_version: "arr.elevation3d.viewer-evidence.v1",
		html: { path: "viewer/index.html", sha256: sha256(htmlBytes) }, app: { path: "viewer/app.js", sha256: sha256(appBytes) }, config: { path: "viewer/config.json", sha256: sha256(configBytes) },
		controls: {
			orbit: app.includes("rotateAndZoom"), pan: app.includes("enablePan"), zoom: app.includes("enableZoom"),
			reset: html.includes("data-reset") && app.includes("[data-reset]"),
			fullscreen: html.includes("data-fullscreen") && app.includes("requestFullscreen") && app.includes("exitFullscreen") && app.includes("fullscreenchange"),
			"view-buttons": html.includes("data-view-buttons") && app.includes("[data-view-buttons]"),
			"palette-selector": html.includes("data-palette") && app.includes("[data-palette]"),
			"glb-download": html.includes("data-glb-download") && app.includes("[data-glb-download]"),
		},
		config_value: config,
	};
}

export function createAllViewsViewRecord(runDir, artifact) {
	const camera = artifact.camera ?? artifact.manifest?.camera;
	return {
		path: portable(relative(runDir, artifact.path)), sha256: artifact.sha256, width: artifact.width, height: artifact.height,
		selected_glb_sha256: artifact.selected_glb_sha256 ?? artifact.manifest?.selected_glb?.sha256,
		palette: artifact.palette ?? artifact.manifest?.palette,
		camera, camera_type: camera?.type, validation: artifact.validation,
		manifest: artifact.manifest_record ? { path: portable(relative(runDir, artifact.manifest_record.path)), sha256: artifact.manifest_record.sha256 } : undefined,
		validation_report: artifact.validation_report ? { path: portable(relative(runDir, artifact.validation_report.path)), sha256: artifact.validation_report.sha256 } : undefined,
	};
}

function cameraPreset(name, artifact) {
	const camera = structuredClone(artifact.manifest.camera);
	if (["plan", "top"].includes(name)) camera.cut = structuredClone(artifact.manifest.cut);
	else camera.cut = { enabled: false, elevation_m: null, plane_world: null };
	return camera;
}

function sameRecord(actual, expected) {
	return actual?.path === expected?.path && actual?.sha256 === expected?.sha256;
}

function normalizedPriorView(previousManifest, name) {
	const verified = previousManifest?.verified_evidence?.views?.[name];
	if (verified) {
		const binding = { image: verified.image, manifest: verified.manifest, validation: verified.validation, palette: verified.palette };
		if (verified.binding_sha256 !== sha256(stableJson(binding))) throw new Error(`${name} verified evidence binding SHA-256 is invalid`);
		return verified;
	}
	const legacy = previousManifest?.views?.[name];
	return legacy ? { image: { path: legacy.path, sha256: legacy.sha256 }, manifest: legacy.manifest, validation: legacy.validation_report, palette: legacy.palette } : null;
}

async function reviewedArtifact(root, name, previousManifest, requirePrior) {
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
	const image = { path: portable(relative(root, path)), sha256: sha256(imageBytes) };
	const manifestRecord = { path: portable(relative(root, manifestPath)), sha256: sha256(manifestBytes) };
	const validationRecord = { path: portable(relative(root, validationPath)), sha256: sha256(validationBytes) };
	const prior = normalizedPriorView(previousManifest, name);
	if (requirePrior && !prior) throw new Error(`${name} prior normalized evidence is required for reviewed artifacts`);
	if (prior && !sameRecord(image, prior.image)) throw new Error(`${name} image SHA-256 does not match verified evidence`);
	if (prior && !sameRecord(manifestRecord, prior.manifest)) throw new Error(`${name} manifest SHA-256 does not match verified evidence`);
	if (prior && !sameRecord(validationRecord, prior.validation)) throw new Error(`${name} validation SHA-256 does not match verified evidence`);
	const expectedSchema = ["front", "back", "left", "right"].includes(name) ? "arr.elevation3d.competition-elevation.v1"
		: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-axon.v1";
	const identity = manifest.view ?? manifest.mode;
	if (manifest.schema_version !== expectedSchema || identity !== name) throw new Error(`${name} persisted manifest schema or identity is invalid`);
	if (["front", "back", "left", "right"].includes(name) && manifest.provenance?.final_png_sha256 !== image.sha256) throw new Error(`${name} manifest image SHA-256 does not match current PNG`);
	// Naming the codes, because "not accepted" sent the last diagnosis of this down the wrong
	// path entirely - it reads as a render fault when it is usually a palette or seam one.
	// multi-elevation.mjs was given the same treatment for the elevation views; this is the
	// plan, top and axon half of it.
	if (!validation.accepted || !Array.isArray(validation.codes)) {
		const codes = Array.isArray(validation.codes) ? validation.codes.join(", ") : "codes missing";
		throw new Error(`${name} persisted validation is not accepted: ${codes}`);
	}
	const palette = manifest.palette;
	if (!palette?.preset || !palette?.sha256 || manifest.provenance?.palette_sha256 && manifest.provenance.palette_sha256 !== palette.sha256) throw new Error(`${name} persisted palette identity is invalid`);
	const binding = { image, manifest: manifestRecord, validation: validationRecord, palette: { preset: palette.preset, sha256: palette.sha256 } };
	const verifiedEvidence = { ...binding, binding_sha256: sha256(stableJson(binding)) };
	return {
		path, sha256: image.sha256, width, height, palette: binding.palette, verified_evidence: verifiedEvidence,
		selected_glb_sha256: manifest.selected_glb_sha256 ?? manifest.selected_glb?.sha256,
		camera: manifest.camera, manifest, validation,
		manifest_record: { path: manifestPath, sha256: manifestRecord.sha256 },
		validation_report: { path: validationPath, sha256: validationRecord.sha256 },
	};
}

async function reviewedGroup(root, names, previousManifest, requirePrior) {
	const entries = await Promise.all(names.map(async (name) => [name, await reviewedArtifact(root, name, previousManifest, requirePrior)]));
	return entries.every(([, artifact]) => artifact) ? Object.fromEntries(entries) : null;
}

export async function verifyPersistedAllViewsArtifacts({ runDir, allowMissing = false } = {}) {
	const root = resolve(runDir);
	let previousManifest;
	try { previousManifest = JSON.parse(await readFile(join(root, "all-views-manifest.json"), "utf8")); }
	catch (error) { if (allowMissing && error?.code === "ENOENT") return null; throw error; }
	let artifacts;
	try { artifacts = await reviewedGroup(root, VIEW_NAMES, previousManifest, true); }
	catch (error) { if (allowMissing && error?.code === "ENOENT") return null; throw error; }
	if (!artifacts) { if (allowMissing) return null; throw new Error("all eight persisted view artifacts are required"); }
	const paletteIdentities = new Set(Object.values(artifacts).map((artifact) => `${artifact.palette.preset}:${artifact.palette.sha256}`));
	if (paletteIdentities.size !== 1) throw new Error("all views must use one persisted palette identity");
	const palette = artifacts.front.palette;
	if (previousManifest.palette && (previousManifest.palette.preset !== palette.preset || previousManifest.palette.sha256 !== palette.sha256)) throw new Error("all views must use one persisted palette identity");
	return { artifacts, palette, verified_evidence: { schema_version: "arr.elevation3d.all-views-evidence.v1", views: Object.fromEntries(VIEW_NAMES.map((name) => [name, artifacts[name].verified_evidence])) } };
}

export async function renderAllViews(inputs) {
	const root = resolve(inputs.runDir);
	await prepareSafeDirectory(root, root, "all-views root");
	const selectedPath = join(root, "enriched.glb");
	const selectedBytes = resolve(inputs.glbPath) === selectedPath
		? await safeRead(root, selectedPath, "contained selected GLB")
		: await atomicCopy(inputs.glbPath, selectedPath, root);
	const selectedGlbSha256 = sha256(selectedBytes);
	const containedInputs = { ...inputs, glbPath: selectedPath };
	let verified = await verifyPersistedAllViewsArtifacts({ runDir: root, allowMissing: true });
	if (!verified) {
		const elevationNames = ["front", "back", "left", "right"];
		await renderCompetitionElevations({ ...containedInputs, cameras: Object.fromEntries(elevationNames.map((name) => [name, inputs.cameras[name]])) });
		const plan = await renderCompetitionPlan({ ...containedInputs, camera: inputs.cameras.top, mode: "plan", cutElevationM: inputs.cutElevationM });
		const top = await renderCompetitionPlan({ ...containedInputs, camera: inputs.cameras.top, mode: "top" });
		const planTopValidation = await validateCompetitionPlanTopPair({ plan, top, sourceMesh: inputs.sourceMesh, camera: inputs.cameras.top, selectedGlbPath: selectedPath });
		if (!planTopValidation.accepted) throw new Error(`plan/top pair validation failed: ${planTopValidation.codes.join(", ")}`);
		await renderCompetitionAxons({ ...containedInputs, cameras: { axon: inputs.cameras.axon, "opposite-axon": inputs.cameras["opposite-axon"] } });
		const artifacts = await reviewedGroup(root, VIEW_NAMES, undefined, false);
		const paletteIdentities = new Set(Object.values(artifacts).map((artifact) => `${artifact.palette.preset}:${artifact.palette.sha256}`));
		if (paletteIdentities.size !== 1) throw new Error("all views must use one persisted palette identity");
		verified = { artifacts, palette: artifacts.front.palette, verified_evidence: { schema_version: "arr.elevation3d.all-views-evidence.v1", views: Object.fromEntries(VIEW_NAMES.map((name) => [name, artifacts[name].verified_evidence])) } };
	}
	const { artifacts } = verified;
	const views = Object.fromEntries(VIEW_NAMES.map((name) => [name, createAllViewsViewRecord(root, artifacts[name])]));
	const cameraViews = Object.fromEntries(VIEW_NAMES.map((name) => [name, cameraPreset(name, artifacts[name])]));
	const palettes = Object.fromEntries(["warm", "neutral", "stone"].map((name) => [name, resolveMaterialPalette(`competition-${name}`)]));
	const config = {
		schema_version: "arr.elevation3d.all-views-viewer.v1", candidate_id: inputs.candidateId,
		strategies: { hunyuan: { glb: "../enriched.glb" } }, cameras: { views: cameraViews },
		all_views: {
			selected_glb: { path: "../enriched.glb", sha256: selectedGlbSha256 }, palettes, views,
			selected_palette: verified.palette,
			validation: { accepted: true, codes: [] },
			artifacts: VIEW_NAMES.map((name) => ({ label: `${name} PNG`, path: `../${views[name].path}` })),
		},
	};
	await buildViewerBundle({ runDir: root, config });
	const configPath = join(root, "viewer", "config.json");
	const preliminaryEvidence = await inspectBuiltViewer({ runDir: root });
	const preliminaryValidation = validateAllViewsRun({ views, selectedGlbSha256, palette: verified.palette, viewer: { evidence: preliminaryEvidence, config: preliminaryEvidence.config_value } });
	config.all_views.validation = preliminaryValidation;
	await atomicWrite(configPath, Buffer.from(JSON.stringify(config, null, 2)), root);
	const viewerEvidence = await inspectBuiltViewer({ runDir: root });
	const validation = validateAllViewsRun({ views, selectedGlbSha256, palette: verified.palette, viewer: { evidence: viewerEvidence, config: viewerEvidence.config_value } });
	const validationPath = join(root, "validation.json");
	await atomicWrite(validationPath, Buffer.from(JSON.stringify(validation, null, 2)), root);
	const manifest = {
		schema_version: "arr.elevation3d.all-views.v1",
		selected_glb: { path: "enriched.glb", sha256: selectedGlbSha256 },
		palette: verified.palette,
		palette_sha256: verified.palette.sha256,
		views,
		verified_evidence: { ...verified.verified_evidence, viewer: viewerEvidence },
		viewer: { path: "viewer/index.html", config_sha256: sha256(await readFile(configPath)) },
		validation: { accepted: validation.accepted, codes: validation.codes },
	};
	const manifestPath = join(root, "all-views-manifest.json");
	await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)), root);
	return {
		...manifest, manifest,
		views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { ...views[name], path: artifacts[name].path }])),
		manifest_record: { path: manifestPath, sha256: sha256(await readFile(manifestPath)) },
		validation: { ...validation, path: validationPath, sha256: sha256(await readFile(validationPath)) },
	};
}
