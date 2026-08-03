import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderCompetitionElevation } from "./competition-elevation.mjs";
import { sha256 } from "./core.mjs";
import { deriveElevationDimensions } from "./elevation-dimensions.mjs";

const ELEVATION_NAMES = ["front", "back", "left", "right"];

function fail(message) {
	throw new Error(`multi-elevation validation failed: ${message}`);
}

export async function buildMultiElevationManifest(views) {
	if (Object.keys(views).sort().join(",") !== [...ELEVATION_NAMES].sort().join(",")) fail("exactly front, back, left, and right views are required");
	if (new Set(Object.values(views).map((view) => view.selected_glb_sha256)).size !== 1) fail("all views must use one selected GLB SHA-256");
	if (new Set(Object.values(views).map((view) => view.palette?.sha256)).size !== 1
		|| Object.values(views).some((view) => !view.palette?.preset || !view.palette?.sha256)) fail("all views must use one resolved palette SHA-256");
	if (new Set(Object.values(views).map((view) => `${view.palette.preset}:${view.palette.sha256}`)).size !== 1) fail("all views must use one resolved palette identity");
	const levelSignatures = new Set(Object.values(views).map((view) => JSON.stringify(view.displayed_dimensions?.levels)));
	if (levelSignatures.size !== 1 || Object.values(views).some((view) => view.displayed_dimensions?.levels?.length !== 4)) fail("all views must display the same four levels");
	for (const name of ELEVATION_NAMES) {
		const view = views[name];
		if (!view.validation?.accepted) fail(`${name} validation was not accepted`);
		if (view.validation.metrics?.canonical_svg_mismatch) fail(`${name} canonical SVG differs`);
		if (view.base?.clipping?.applied || view.validation.codes?.includes("ELEVATION_CONTENT_CLIPPED")) fail(`${name} content is clipped`);
		if (view.width !== 2400 || view.height !== 2400) fail(`${name} output is not 2400x2400`);
		for (const diagnostic of ["material_id", "depth", "normal"]) {
			const record = view.diagnostics?.[diagnostic];
			if (!record?.path || !record?.sha256) fail(`${name} ${diagnostic} diagnostic hash is not resolvable`);
			const bytes = await readFile(record.path).catch(() => undefined);
			if (!bytes) fail(`${name} ${diagnostic} diagnostic file is not resolvable`);
			if (sha256(bytes) !== record.sha256) fail(`${name} ${diagnostic} diagnostic SHA-256 does not match persisted bytes`);
		}
	}
	return {
		schema_version: "arr.elevation3d.multi-elevation-artifacts.v1",
		selected_glb_sha256: views.front.selected_glb_sha256,
		palette: { preset: views.front.palette.preset, sha256: views.front.palette.sha256 },
		views,
	};
}

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new Error("render aborted");
}

export async function renderCompetitionElevations(inputs) {
	const views = {};
	let commonPixelsPerMetre;
	const selectedGlbBytes = await readFile(inputs.glbPath);
	const artifact = { path: inputs.glbPath, sha256: sha256(selectedGlbBytes) };
	for (const name of ELEVATION_NAMES) {
		throwIfAborted(inputs.signal);
		const camera = inputs.cameras?.[name];
		const dimensions = await deriveElevationDimensions({
			sourceMesh: inputs.sourceMesh,
			floorGuides: inputs.floorGuides,
			facadePlanes: inputs.facadePlanes,
			artifact,
			view: camera,
		});
		const rendered = await renderCompetitionElevation({
			...inputs,
			camera,
			dimensions,
			view: name,
			runDir: join(inputs.runDir, "views", name),
			pixelsPerMetre: commonPixelsPerMetre,
		});
		views[name] = {
			...rendered,
			width: rendered.base.width,
			height: rendered.base.height,
			camera: rendered.base.camera,
			selected_glb_sha256: rendered.base.selected_glb_sha256,
		};
		commonPixelsPerMetre ??= rendered.base.camera.px_per_m_x;
	}
	const manifest = await buildMultiElevationManifest(views);
	const root = resolve(inputs.runDir);
	await mkdir(root, { recursive: true });
	const manifestPath = join(root, "multi-elevation-manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
	return {
		...manifest,
		manifest: { path: manifestPath, sha256: sha256(await readFile(manifestPath)) },
	};
}
