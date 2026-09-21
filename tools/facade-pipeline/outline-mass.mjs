/**
 * The mass a PICTURE gives - A TEST FIXTURE, not a step of a delivery.
 *
 * The division of labour does not move: the MASS is the authority and comes from the mass agent;
 * this agent takes whatever mass it is handed and designs the elevation on it. What this file adds
 * is the same thing `synthetic-box-WxDxH` adds - a mass to test against when no real one exists yet,
 * built here so nothing in the test set is touched. When the mass agent delivers, the commands are
 * unchanged: `apply <candidate> <spec> <name>` then `draw`.
 *
 * The lane is perspective -> drawing, and until now only the FACADE came from the picture: the
 * mass was a box we chose, so the Broad's veil - read correctly, cell for cell - was drawn on a
 * rectangular block and read as a pattern stuck on a box. A photograph states one thing about the
 * form with no ambiguity: the building's SILHOUETTE, which the trace has already measured as the
 * ROI polygon in the frame's own metres. That polygon is the mass's elevation outline; swept by a
 * depth (the one number a single photograph cannot give), it is a mass the rest of the pipeline
 * reads like any other - facets, cameras, floor guides, gates.
 *
 * Nothing here names a building: any ROI polygon becomes a mass the same way.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDirFor } from "./config.mjs";

/** The ROI polygon in the frame's own metres, as an elevation outline (u right, z up). */
export function outlineFromRoi(roi) {
	const polygon = roi?.polygon_px;
	if (!Array.isArray(polygon) || polygon.length < 3) throw new Error("the ROI carries no polygon_px");
	if (!(roi.width_m > 0 && roi.height_m > 0)) throw new Error("the ROI carries no width_m / height_m");
	const xs = polygon.map(([x]) => x), ys = polygon.map(([, y]) => y);
	const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys), minY = Math.min(...ys);
	// The frame's scale in each axis; a ROI that is not a rectangle still states its own extent.
	const perMetreX = (maxX - minX) / roi.width_m, perMetreY = (maxY - minY) / roi.height_m;
	return polygon.map(([x, y]) => [
		Number(((x - minX) / perMetreX).toFixed(4)),
		Number(((maxY - y) / perMetreY).toFixed(4)),
	]).concat().filter((point, index, all) => index === 0 || Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]) > 1e-6);
}

/**
 * Write the candidate a picture's silhouette gives. `name` is the candidate's own slug, so the id
 * is `synthetic-outline-<name>` and everything downstream (prepare, apply, draw) takes it by name.
 */
export async function massFromOutline({ roiPath, name, depthM, bulgeM = 0, leanM = 0, columns = 20, outputRoot } = {}) {
	const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("a name is required");
	if (!(depthM > 0)) throw new Error("--depth <metres> is required: a photograph does not state a building's depth");
	const roi = JSON.parse(await readFile(roiPath, "utf8"));
	const outline = outlineFromRoi(roi);
	const candidateId = `synthetic-outline-${slug}`;
	const runDir = runDirFor(candidateId, { outputRoot });
	await mkdir(runDir, { recursive: true });
	const record = {
		outline_uv_m: outline,
		depth_m: Number(depthM),
		// A flat sweep is ONE plane, and the engine places members on the rectangle inscribed in a
		// plane - so a sagging silhouette would lose both its sag and its ground contact. A shallow
		// arc makes the front a row of facets, each keeping its own piece of the silhouette.
		bulge_m: Number(bulgeM) || 0,
		// the wall pulled in at its base: what makes a heavy building read as lifted
		lean_m: Number(leanM) || 0,
		columns: Number(columns) || 20,
		provenance: { roi: roiPath, width_m: roi.width_m, height_m: roi.height_m,
			note: "the photograph's silhouette, in the frame's assigned metres; the depth is the caller's" },
	};
	await writeFile(join(runDir, "outline.json"), JSON.stringify(record, null, 1));
	return { ok: true, candidate: candidateId, run_dir: runDir, points: outline.length,
		width_m: Math.max(...outline.map(([u]) => u)), height_m: Math.max(...outline.map(([, z]) => z)), depth_m: Number(depthM) };
}
