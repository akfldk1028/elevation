import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stableJson, sha256 } from "./core.mjs";
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

export async function renderUnifiedDrawings({ runDir, glbPath, sourceMesh, cameras, signal, lifecycle, onProgress }) {
	signal?.throwIfAborted();
	const absoluteRunDir = resolve(runDir);
	const selectedGlb = await placeSelectedGlb(absoluteRunDir, glbPath);
	signal?.throwIfAborted();
	const glb = portable(relative(join(absoluteRunDir, "viewer"), selectedGlb));
	await buildViewerBundle({
		runDir: absoluteRunDir,
		config: {
			candidate_id: "unified-enrichment",
			geometry_hash: sha256(stableJson(sourceMesh)),
			cameras: unifiedCameras(cameras),
			strategies: { hunyuan: { glb } },
		},
	});
	signal?.throwIfAborted();
	const configPath = join(absoluteRunDir, "viewer", "config.json");
	const glbHash = sha256(await readFile(selectedGlb));
	const configHash = sha256(await readFile(configPath));
	const checkpointDrawings = {};
	await renderDrawings(absoluteRunDir, ["hunyuan"], {
		views: DRAWING_NAMES, port: 0, signal, lifecycle,
		onProgress: async ({ view, path }) => {
			const bytes = await readFile(path);
			checkpointDrawings[view] = {
				path, sha256: sha256(bytes), metrics: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
			};
			await onProgress?.({ type: "view", view, render: { drawings: { ...checkpointDrawings }, provenance: null } });
		},
	});
	signal?.throwIfAborted();
	const drawingDir = join(absoluteRunDir, "drawings", "hunyuan");
	const drawings = Object.fromEntries(DRAWING_NAMES.map((name) => [name, join(drawingDir, `${name}.png`)]));
	const drawingEntries = {};
	for (const [name, path] of Object.entries(drawings)) {
		signal?.throwIfAborted();
		const bytes = await readFile(path);
		drawingEntries[name] = {
			path: portable(relative(absoluteRunDir, path)), sha256: sha256(bytes),
			width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
			glb_sha256: glbHash, viewer_config_sha256: configHash,
		};
	}
	const provenancePath = join(absoluteRunDir, "drawing-provenance.json");
	const provenanceBytes = Buffer.from(JSON.stringify({
		schema_version: "arr.elevation3d.drawing-provenance.v1",
		selected_glb: { path: portable(relative(absoluteRunDir, selectedGlb)), sha256: glbHash },
		viewer_config: { path: "viewer/config.json", sha256: configHash },
		drawings: drawingEntries,
	}, null, 2));
	await writeFile(provenancePath, provenanceBytes);
	await onProgress?.({
		type: "provenance",
		render: {
			drawings: { ...checkpointDrawings },
			provenance: { path: provenancePath, sha256: sha256(provenanceBytes) },
		},
	});
	signal?.throwIfAborted();
	return drawings;
}
