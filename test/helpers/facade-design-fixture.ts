import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256, stableJson } from "../../plugins/elevation-3d/lib/core.mjs";
import { buildFacadeDesignContext } from "../../plugins/elevation-3d/lib/facade-agent/design/context.mjs";
import { parseFacadeProgram } from "../../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";
import { verifyFacadeEvidencePack } from "../../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import {
	FACADE_EVIDENCE_PASS_NAMES,
	FACADE_EVIDENCE_VIEW_NAMES,
} from "../../plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs";
import { deriveFacadeSegmentsFromMass } from "../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

function boxMesh(width = 8, depth = 4, height = 6.6) {
	const x = width / 2, y = depth / 2;
	return {
		vertices: [
			[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0],
			[-x, -y, height], [x, -y, height], [x, y, height], [-x, y, height],
		],
		triangles: [
			[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
			[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
			[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
		],
	};
}

export async function createFacadeDesignFixture(t: { after(fn: () => Promise<void>): void }, options: { width?: number; depth?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "facade-design-resolver-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const mesh = boxMesh(options.width, options.depth);
	const facadeSegmentAuthority = deriveFacadeSegmentsFromMass({ mesh });
	const floorGuides = { floor_guides_m: [0, 3.3, 6.6] };
	const cameras = { views: { axon: { projection_axes: { depth: [0.5965499863, -0.5965499863, 0.5368949876] } } } };
	const sourceBytes = Buffer.from("facade-design-resolver-source");
	const sourcePath = join(root, "source.bin");
	await writeFile(sourcePath, sourceBytes);
	const candidate = {
		candidate: { candidate_id: "creative-020" },
		identity: { candidate_id: "creative-020", geometry_hash: "resolver-geometry-fixture" },
		mesh,
		floor_guides: floorGuides,
		facade_segment_authority: facadeSegmentAuthority,
		cameras,
		artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes), absolute_path: sourcePath }],
	};
	const evidenceRoot = join(root, "evidence");
	await mkdir(evidenceRoot);
	const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#8b3f2f" } }).png().toBuffer();
	const artifacts: Record<string, unknown> = {};
	for (const mode of FACADE_EVIDENCE_PASS_NAMES) {
		await mkdir(join(evidenceRoot, mode));
		for (const view of FACADE_EVIDENCE_VIEW_NAMES) {
			await writeFile(join(evidenceRoot, mode, `${view}.png`), png);
			artifacts[`${mode}:${view}`] = { path: `${mode}/${view}.png`, sha256: sha256(png), width: 2, height: 2, mode, view };
		}
	}
	await writeFile(join(evidenceRoot, "contact-sheet.png"), png);
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1",
		candidate_id: "creative-020",
		geometry_hash: candidate.identity.geometry_hash,
		geometry_content_sha256: sha256(stableJson({ vertices: mesh.vertices, triangles: mesh.triangles })),
		floor_guides_m: [...floorGuides.floor_guides_m],
		facade_planes_sha256: sha256(stableJson(facadeSegmentAuthority)),
		facade_segment_authority_sha256: facadeSegmentAuthority.sha256,
		geometry_signed_volume_orientation: facadeSegmentAuthority.source_signed_volume_orientation,
		cameras_sha256: sha256(stableJson(cameras)),
		source_artifacts: [{ name: "source", path: "source.bin", sha256: sha256(sourceBytes) }],
		artifacts,
		contact_sheet: { path: "contact-sheet.png", sha256: sha256(png), width: 2, height: 2 },
	};
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	await writeFile(manifestPath, `${stableJson(manifest)}\n`);
	const evidence = await verifyFacadeEvidencePack({ manifestPath, input: candidate });

	const runDir = join(root, "run");
	await mkdir(runDir);
	const document = new Document();
	document.createScene("Scene").addChild(document.createNode("existing-window").setExtras({
		kind: "window",
		segment_id: facadeSegmentAuthority.facade_planes.find((segment: any) => segment.view === "back").segment_id,
		local_bounds: { u0: 0.5, u1: 1.2, v0: 0.8, v1: 2.4, n0: -0.1, n1: 0.1 },
	}));
	const glbBytes = Buffer.from(await new NodeIO().writeBinary(document));
	await writeFile(join(runDir, "selected.glb"), glbBytes);
	await writeFile(join(runDir, "front.png"), png);
	await writeFile(join(runDir, "axon.png"), png);
	const context = await buildFacadeDesignContext({
		runDir,
		candidate,
		evidence,
		selectedGlb: { path: "selected.glb", sha256: sha256(glbBytes) },
		technicalThumbnails: [
			{ view: "front", path: "front.png", sha256: sha256(png), width: 2, height: 2 },
			{ view: "axon", path: "axon.png", sha256: sha256(png), width: 2, height: 2 },
		],
	});
	const program = parseFacadeProgram({
		schema_version: "arr.elevation3d.facade-program.v2",
		concept_id: "creative-020-corner-entry-v1",
		entrance: {
			segment_selector: "primary_visible_ground_segment",
			preferred_bay: "central_or_corner_focus",
			door_family: "recessed_glazed_portal",
			width_m: 1.8,
			height_m: 2.4,
			recess_m: 0.15,
		},
		zones: [
			{ id: "base", storeys: [1], treatment: "lobby_and_entrance" },
			{ id: "middle", storeys: [2], treatment: "a_b_a_window_rhythm" },
			{ id: "top", storeys: [2], treatment: "paired_openings_and_cornice" },
		],
		window_families: [
			{ id: "narrow", width_m: 0.8, height_m: 1.6, sill_m: 0.8 },
			{ id: "wide", width_m: 1.2, height_m: 1.6, sill_m: 0.8 },
		],
		bay_rules: [{ id: "middle-aba", zone_id: "middle", pattern: ["narrow", "wide", "narrow"], repeat: 1 }],
		articulation: [{
			id: "fold-pilaster", kind: "pilaster", segment_selector: "all_visible_folds",
			width_m: 0.25, depth_m: 0.12, storeys: [1, 2], material_id: "brick-primary",
		}],
		materials: [{ id: "brick-primary", role: "opaque", color: "#8b3f2f", finish: "matte" }],
		design_rationale: ["Legible entry and controlled A-B-A rhythm."],
	}, { sourceAuthority: context.source });
	return { context, program, facadeSegmentAuthority };
}
