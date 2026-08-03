import { copyFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stableJson, sha256 } from "./core.mjs";
import { stopPreview } from "./preview.mjs";
import { renderDrawings } from "./results.mjs";
import { buildViewerBundle } from "./viewer.mjs";

const DRAWING_NAMES = ["plan", "front", "back", "left", "right", "top", "axon"];

function portable(path) {
	return path.replaceAll("\\", "/");
}

async function placeSelectedGlb(runDir, glbPath) {
	const absoluteRunDir = resolve(runDir);
	const absoluteGlbPath = resolve(glbPath);
	const fromRunDir = relative(absoluteRunDir, absoluteGlbPath);
	if (!fromRunDir.startsWith("..") && !isAbsolute(fromRunDir)) return absoluteGlbPath;
	const destination = join(absoluteRunDir, "geometry", "selected.glb");
	await mkdir(join(absoluteRunDir, "geometry"), { recursive: true });
	await copyFile(absoluteGlbPath, destination);
	return destination;
}

function unifiedCameras(cameras) {
	const views = { ...(cameras?.views ?? {}) };
	if (!views.plan) {
		if (!views.top) throw new Error("A source top camera is required to derive the plan drawing");
		views.plan = {
			...views.top,
			projection_axes: {
				depth: [...views.top.projection_axes.depth],
				horizontal: [...views.top.projection_axes.horizontal],
				vertical: [...views.top.projection_axes.vertical],
			},
			rendering: { material_mode: "line-oriented" },
		};
	}
	return { ...cameras, views };
}

export async function renderUnifiedDrawings({ runDir, glbPath, sourceMesh, cameras }) {
	const absoluteRunDir = resolve(runDir);
	const selectedGlb = await placeSelectedGlb(absoluteRunDir, glbPath);
	const glb = portable(relative(join(absoluteRunDir, "viewer"), selectedGlb));
	await buildViewerBundle({
		runDir: absoluteRunDir,
		config: {
			candidate_id: "unified-enrichment",
			geometry_hash: sha256(stableJson(sourceMesh)),
			mesh: sourceMesh,
			cameras: unifiedCameras(cameras),
			strategies: { hunyuan: { glb } },
		},
	});
	const originalRandom = Math.random;
	const renderPort = 42000 + Math.floor(originalRandom() * 1000);
	Math.random = () => (renderPort - 42000 + 0.5) / 1000;
	try {
		await renderDrawings(absoluteRunDir, ["hunyuan"]);
	} finally {
		Math.random = originalRandom;
		await stopPreview(renderPort);
	}
	const drawingDir = join(absoluteRunDir, "drawings", "hunyuan");
	await copyFile(join(drawingDir, "top.png"), join(drawingDir, "plan.png"));
	return Object.fromEntries(DRAWING_NAMES.map((name) => [name, join(drawingDir, `${name}.png`)]));
}
