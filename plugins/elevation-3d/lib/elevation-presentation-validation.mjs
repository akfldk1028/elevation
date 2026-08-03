import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { sha256 } from "./core.mjs";
import { deriveElevationDimensions } from "./elevation-dimensions.mjs";

function dot(left, right) {
	return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function length(vector) {
	return Math.sqrt(dot(vector, vector));
}

function dimensionValues(manifest) {
	return {
		overall_width: manifest.overall_width?.display_mm,
		overall_height: manifest.overall_height?.display_mm,
		levels: manifest.levels?.map((item) => item.display_mm),
		floor_intervals: manifest.floor_intervals?.map((item) => item.display_mm),
		facade_width: manifest.facade_extent?.width?.display_mm,
		facade_height: manifest.facade_extent?.height?.display_mm,
		scale_bar: manifest.scale_bar?.display_mm,
	};
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function validRecord(record) {
	if (!record?.path || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) return false;
	try { return sha256(await readFile(record.path)) === record.sha256; }
	catch { return false; }
}

function add(codes, code, condition) {
	if (condition && !codes.includes(code)) codes.push(code);
}

export async function validateCompetitionElevation({ artifacts, sourceMesh, facadePlanes, floorGuides, view, selectedGlbPath }) {
	const codes = [];
	let authoritative;
	try {
		authoritative = await deriveElevationDimensions({
			sourceMesh,
			facadePlanes,
			floorGuides,
			view,
			artifact: { path: selectedGlbPath, sha256: artifacts.base?.selected_glb_sha256 },
		});
	} catch {
		add(codes, "DIMENSION_SOURCE_MISSING", true);
	}
	if (authoritative) {
		add(codes, "DIMENSION_MISMATCH", !sameJson(dimensionValues(authoritative), dimensionValues(artifacts.dimensions)));
		add(codes, "LEVEL_GUIDE_MISMATCH", !sameJson(authoritative.levels.map((item) => item.display_mm), artifacts.dimensions?.levels?.map((item) => item.display_mm))
			|| !sameJson(authoritative.floor_intervals.map((item) => item.display_mm), artifacts.dimensions?.floor_intervals?.map((item) => item.display_mm)));
	}
	const camera = artifacts.base?.camera;
	add(codes, "ELEVATION_CAMERA_NOT_ORTHOGRAPHIC", camera?.type !== "orthographic");
	const axes = camera?.projection_axes;
	const axesInvalid = !axes || [axes.horizontal, axes.vertical, axes.depth].some((axis) => !Array.isArray(axis) || axis.length !== 3)
		|| [axes?.horizontal ?? [], axes?.vertical ?? [], axes?.depth ?? []].some((axis) => Math.abs(length(axis) - 1) > 1e-6)
		|| Math.abs(dot(axes?.horizontal ?? [], axes?.vertical ?? [])) > 1e-6
		|| Math.abs(dot(axes?.horizontal ?? [], axes?.depth ?? [])) > 1e-6
		|| Math.abs(dot(axes?.vertical ?? [], axes?.depth ?? [])) > 1e-6
		|| (view?.projection_axes?.vertical && Math.abs(Math.abs(dot(axes?.vertical ?? [], view.projection_axes.vertical)) - 1) > 1e-6)
		|| Math.abs((camera?.px_per_m_x ?? 0) / (camera?.px_per_m_y ?? 1) - 1) > 0.0025;
	add(codes, "ELEVATION_AXIS_MISMATCH", axesInvalid);
	const bounds = artifacts.base?.content_bounds_px;
	const size = artifacts.base?.width;
	add(codes, "ELEVATION_CONTENT_CLIPPED", !bounds || size !== 2400 || artifacts.base?.height !== 2400
		|| bounds.min_x < size * 0.08 || bounds.max_x > size * 0.92 - 1 || bounds.min_y < 48 || bounds.max_y > size - 48);
	const diagnostics = artifacts.base?.diagnostics ?? {};
	add(codes, "MATERIAL_ROLE_MISSING", ["concrete", "glass", "bronze", "opaque"].some((role) => !(diagnostics.role_pixel_counts?.[role] > 0)));
	add(codes, "MATERIAL_VISIBILITY_INVALID", diagnostics.dark_pixel_fraction > 0.07 || artifacts.presentation?.authored_dark_geometry?.invalid_pixels > 0);
	add(codes, "LINE_DENSITY_EXCEEDED", diagnostics.total_edge_density > 0.035 || diagnostics.strong_edge_density > 0.015);
	add(codes, "TRIANGULATION_VISIBLE", diagnostics.same_material_seam_fraction > 0.001 || diagnostics.seam_segments?.connected_at_least_12px > 0);
	add(codes, "ELEVATION_CONTENT_CLIPPED", artifacts.annotation?.overlaps_content || artifacts.annotation?.overlaps_annotations || artifacts.annotation?.min_page_clearance_px < 48);
	if (artifacts.final_png?.path) {
		try {
			const metadata = await sharp(artifacts.final_png.path).metadata();
			add(codes, "ELEVATION_CONTENT_CLIPPED", metadata.width !== 2400 || metadata.height !== 2400 || metadata.format !== "png");
		} catch { add(codes, "ELEVATION_CONTENT_CLIPPED", true); }
	}
	const selectedBytes = selectedGlbPath ? await readFile(selectedGlbPath).catch(() => undefined) : undefined;
	add(codes, "DIMENSION_SOURCE_MISSING", !selectedBytes || artifacts.base?.selected_glb_sha256 !== sha256(selectedBytes));
	const records = [artifacts.final_png, artifacts.annotations_svg, artifacts.dimensions_json, artifacts.render_manifest].filter(Boolean);
	if (records.length) add(codes, "DIMENSION_SOURCE_MISSING", !(await Promise.all(records.map(validRecord))).every(Boolean));
	if (artifacts.dimensions_json?.path) {
		try {
			const persisted = JSON.parse(await readFile(artifacts.dimensions_json.path, "utf8"));
			add(codes, "DIMENSION_MISMATCH", !sameJson(dimensionValues(persisted), dimensionValues(artifacts.dimensions))
				|| (authoritative && !sameJson(dimensionValues(persisted), dimensionValues(authoritative))));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	if (artifacts.annotations_svg?.path) {
		try {
			const svg = await readFile(artifacts.annotations_svg.path, "utf8");
			for (const displayed of artifacts.annotation?.displayed_dimensions ?? []) {
				const source = `data-source-id="${displayed.id}"`;
				const value = `data-display-mm="${displayed.display_mm}"`;
				add(codes, "DIMENSION_MISMATCH", !svg.includes(source) || !svg.includes(value));
			}
			for (const level of artifacts.dimensions?.levels ?? []) add(codes, "LEVEL_GUIDE_MISMATCH", !svg.includes(level.label));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	if (artifacts.render_manifest?.path) {
		try {
			const manifest = JSON.parse(await readFile(artifacts.render_manifest.path, "utf8"));
			const expected = {
				base_png_sha256: artifacts.base?.sha256,
				annotations_svg_sha256: artifacts.annotations_svg?.sha256,
				dimensions_json_sha256: artifacts.dimensions_json?.sha256,
				final_png_sha256: artifacts.final_png?.sha256,
			};
			add(codes, "DIMENSION_SOURCE_MISSING", !Object.entries(expected).every(([field, value]) => manifest.provenance?.[field] === value)
				|| manifest.selected_glb_sha256 !== artifacts.base?.selected_glb_sha256
				|| manifest.viewer_config_sha256 !== artifacts.base?.viewer_config_sha256
				|| !sameJson(manifest.displayed_dimensions, dimensionValues(artifacts.dimensions)));
		} catch { add(codes, "DIMENSION_SOURCE_MISSING", true); }
	}
	return {
		schema_version: "arr.elevation3d.presentation-validation.v1",
		accepted: codes.length === 0,
		codes,
		tolerance_mm: 1,
		metrics: {
			dimension_values: authoritative ? dimensionValues(authoritative) : null,
			total_edge_density: diagnostics.total_edge_density ?? null,
			strong_edge_density: diagnostics.strong_edge_density ?? null,
			same_material_seam_fraction: diagnostics.same_material_seam_fraction ?? null,
			content_bounds_px: bounds ?? null,
			annotation_overlap: Boolean(artifacts.annotation?.overlaps_content || artifacts.annotation?.overlaps_annotations),
			authored_dark_geometry: artifacts.presentation?.authored_dark_geometry ?? null,
		},
	};
}
