/**
 * A synthetic box candidate, for tests of the engine that need a mass and not a design.
 *
 * `synthetic-box-<W>x<D>x<H>` (metres, H a multiple of the 3.3 m storey) is prepared like any
 * dataset candidate - evidence pack, context, brief, gates, render - but the mass is a box
 * built here, so nothing in the test set is touched and the host of a lattice ModelSpec
 * (spec 2026-09-16 Task 2: a 12 x 6 plane) is a real facet with real cameras. The camera
 * conventions copy the dataset's (front looks along -y from +y, up is z).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256, stableJson } from "../../plugins/elevation-3d/lib/core.mjs";
import { buildEnrichedScene, writeEnrichedGlb } from "../../plugins/elevation-3d/lib/enrichment.mjs";
import { deriveFacadeSegmentsFromMass } from "../../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

export const SYNTHETIC_CANDIDATE = /^synthetic-box-(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/;
// A mass the PICTURE gives: `synthetic-outline-<name>` reads the elevation outline the trace
// already measured (its ROI polygon in the photograph, in the frame's own metres) and extrudes it.
// A photograph of a building states its silhouette and nothing else about its depth, so the depth
// is the one number the caller supplies. Every other step - facets, cameras, floor guides - falls
// out of the mesh exactly as it does for a box.
export const SYNTHETIC_OUTLINE = /^synthetic-outline-[a-z0-9-]+$/;
const STOREY_M = 3.3;

export function isSyntheticCandidate(candidateId) {
	const id = String(candidateId ?? "");
	return SYNTHETIC_CANDIDATE.test(id) || SYNTHETIC_OUTLINE.test(id);
}

function boxMesh(width, depth, height) {
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

/**
 * The mass of an outline: the elevation polygon (u, z in metres, counter-clockwise, first point
 * repeated or not) swept `depth` metres along y. The front face is the polygon itself, which is
 * what a veil is laid on; the back face mirrors it; each edge of the polygon sweeps one quad, so a
 * sagging soffit is a soffit and a lifted corner is a lifted corner.
 */
function outlineMesh(outline, depth, bulge = 0, columns = 20, standsOnGround = true, lean = 0) {
	const ring = outline.length > 1 && outline[0][0] === outline.at(-1)[0] && outline[0][1] === outline.at(-1)[1]
		? outline.slice(0, -1) : outline.slice();
	if (ring.length < 3) throw new Error("an outline mass needs at least three points");
	const us = ring.map(([u]) => u), zs = ring.map(([, z]) => z);
	const u0 = Math.min(...us), u1 = Math.max(...us), width = u1 - u0;
	// The silhouette's own bottom and top at any u: where a vertical line crosses the outline.
	const crossings = (u) => {
		const hits = [];
		for (let i = 0; i < ring.length; i += 1) {
			const [ua, za] = ring[i], [ub, zb] = ring[(i + 1) % ring.length];
			if (ua === ub) continue;
			const lo = Math.min(ua, ub), hi = Math.max(ua, ub);
			if (u < lo - 1e-9 || u > hi + 1e-9) continue;
			hits.push(za + (zb - za) * ((u - ua) / (ub - ua)));
		}
		const span = hits.length ? [Math.min(...hits), Math.max(...hits)] : [Math.min(...zs), Math.max(...zs)];
		// A traced silhouette is the VEIL's outline, and a veil lifts off its corners: taken as the
		// building it gives a mass that touches the ground nowhere, so no door can be placed. The
		// BUILDING stands on the ground and the veil lifts off it - which is what the photograph
		// shows, and the veil's own voids (the ROI's complement, already in the fitted spec) carry
		// the lift. The silhouette gives the top and the sides.
		return standsOnGround ? [0, span[1]] : span;
	};
	// A FLAT sweep is one plane, and a plane is reduced to the rectangle inscribed in it, so a
	// sagging silhouette would lose its sag and its ground contact. Swept along a shallow arc the
	// front is a row of facets instead: each keeps its own piece of the silhouette, the veil (one
	// z datum for the run) stays level across them, and the building meets the ground where the
	// photograph says it does. bulge 0 keeps the single plane, which is what a flat wall wants.
	const shape = (u) => (bulge === 0 ? 0 : bulge * (1 - ((2 * (u - u0)) / width - 1) ** 2));
	// The outline's OWN vertices are column boundaries, not only the uniform samples: the silhouette
	// touches the ground at a vertex, and a column that straddles it gives both its facets a sill
	// above zero - the building then has no ground access and no entrance can be placed.
	const count = Math.max(2, Math.round(columns));
	const uniform = Array.from({ length: count + 1 }, (_, i) => u0 + (width * i) / count);
	// Two boundaries straddling the arc's crown, so the column between them is FLAT and square to
	// the view. Every drawing here dimensions an elevation against one facade plane that is a real
	// face of the mass: on a bulged front no facet was square to the view and the dimension pass
	// had nothing to measure from; a nominal plane spanning the bounds is not on the mass at all.
	const crown = [u0 + width / 2 - width / (2 * count), u0 + width / 2 + width / (2 * count)];
	const inCrown = (u) => u > crown[0] + 1e-9 && u < crown[1] - 1e-9;
	const cols = [...new Set([...uniform.filter((u) => !inCrown(u)), ...us.filter((u) => !inCrown(u)), ...crown]
		.map((u) => Number(u.toFixed(6))))].sort((a, b) => a - b);
	const n = cols.length;
	const vertices = [];
	const index = new Map();
	const put = (key, point) => { if (!index.has(key)) { index.set(key, vertices.length); vertices.push(point); } return index.get(key); };
	// A BATTER: the wall pulled in at its base. It is the move that makes a heavy building look
	// lifted - the Broad's veil leans in all the way to the ground - and it is one number, like the
	// depth and the arc. 0 keeps the wall plumb.
	const zTop = Math.max(...zs), zBottom = standsOnGround ? 0 : Math.min(...zs);
	const height = Math.max(1e-6, zTop - zBottom);
	const yAt = (u, z) => depth / 2 + shape(u) - lean * (1 - (z - zBottom) / height);
	const front = [], back = [];
	cols.forEach((u, i) => {
		const [lo, hi] = crossings(u);
		const x = u - u0 - width / 2;
		front.push([put(`f${i}lo`, [x, -yAt(u, lo), lo]), put(`f${i}hi`, [x, -yAt(u, hi), hi])]);
		back.push([put(`b${i}lo`, [x, yAt(u, lo), lo]), put(`b${i}hi`, [x, yAt(u, hi), hi])]);
	});
	const triangles = [];
	const quad = (a, b, c, d) => { triangles.push([a, b, c]); triangles.push([a, c, d]); };
	for (let i = 0; i < n - 1; i += 1) {
		const [fl0, fh0] = front[i], [fl1, fh1] = front[i + 1];
		const [bl0, bh0] = back[i], [bl1, bh1] = back[i + 1];
		quad(fl0, fl1, fh1, fh0);   // front strip
		quad(bl0, bh0, bh1, bl1);   // back strip
		quad(fh0, fh1, bh1, bh0);   // roof strip
		quad(fl0, bl0, bl1, fl1);   // soffit strip
	}
	quad(front[0][0], front[0][1], back[0][1], back[0][0]);                                  // left end
	quad(front[n - 1][0], back[n - 1][0], back[n - 1][1], front[n - 1][1]);                  // right end
	const volume = triangles.reduce((sum, [a, b, c]) => {
		const p = vertices[a], q = vertices[b], r = vertices[c];
		return sum + (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]));
	}, 0);
	return { vertices, triangles: volume < 0 ? triangles.map(([a, b, c]) => [a, c, b]) : triangles };
}

function unusedOutlineMesh(outline, depth) {
	const ring = outline.length > 1 && outline[0][0] === outline.at(-1)[0] && outline[0][1] === outline.at(-1)[1]
		? outline.slice(0, -1) : outline.slice();
	if (ring.length < 3) throw new Error("an outline mass needs at least three points");
	// counter-clockwise in (u, z) so the swept quads face outward
	const area = ring.reduce((sum, [u, z], i) => {
		const [nu, nz] = ring[(i + 1) % ring.length];
		return sum + (u * nz - nu * z);
	}, 0);
	const loop = area < 0 ? ring.slice().reverse() : ring;
	const width = Math.max(...loop.map(([u]) => u)) - Math.min(...loop.map(([u]) => u));
	const u0 = Math.min(...loop.map(([u]) => u));
	const y = depth / 2;
	const vertices = [];
	for (const [u, z] of loop) vertices.push([u - u0 - width / 2, -y, z]);
	for (const [u, z] of loop) vertices.push([u - u0 - width / 2, y, z]);
	const n = loop.length;
	const triangles = [];
	// caps by fan (the outline is expected to be convex-ish; a fan on a mildly concave outline
	// still closes the shell, which is what the evidence pack and the facet deriver need)
	for (let i = 1; i < n - 1; i += 1) {
		triangles.push([0, i + 1, i]);          // front, normal -y
		triangles.push([n, n + i, n + i + 1]);  // back, normal +y
	}
	for (let i = 0; i < n; i += 1) {
		const j = (i + 1) % n;
		triangles.push([i, j, n + j]);
		triangles.push([i, n + j, n + i]);
	}
	// The shell must wind outward (the authority refuses any other orientation), and which way a
	// fan winds depends on the outline's own handedness: ask the volume rather than assume.
	const volume = triangles.reduce((sum, [a, b, c]) => {
		const p = vertices[a], q = vertices[b], r = vertices[c];
		return sum + (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]));
	}, 0);
	return { vertices, triangles: volume < 0 ? triangles.map(([a, b, c]) => [a, c, b]) : triangles };
}

const AXES = {
	front: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] },
	right: { depth: [1, 0, 0], horizontal: [0, 1, 0], vertical: [0, 0, 1] },
	back: { depth: [0, 1, 0], horizontal: [-1, 0, 0], vertical: [0, 0, 1] },
	left: { depth: [-1, 0, 0], horizontal: [0, -1, 0], vertical: [0, 0, 1] },
	top: { depth: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] },
	axon: {
		depth: [0.5965499862718936, -0.5965499862718936, 0.5368949876447042],
		horizontal: [0.7071067811865476, 0.7071067811865476, 0],
		vertical: [-0.379642086548638, 0.379642086548638, 0.8436490812191957],
	},
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function cameraViews(mesh, identity) {
	const views = {};
	for (const [name, axes] of Object.entries(AXES)) {
		const h = mesh.vertices.map((v) => dot(v, axes.horizontal));
		const vv = mesh.vertices.map((v) => dot(v, axes.vertical));
		const d = mesh.vertices.map((v) => dot(v, axes.depth));
		views[name] = {
			projection: "orthographic",
			projection_axes: axes,
			projected_bounds_m: [[Math.min(...h), Math.min(...vv)], [Math.max(...h), Math.max(...vv)]],
			depth_range_m: [Math.min(...d), Math.max(...d)],
			// Rows are the view basis, as the dataset writes them: horizontal, vertical, depth.
			view_matrix4: [[...axes.horizontal, 0], [...axes.vertical, 0], [...axes.depth, 0], [0, 0, 0, 1]],
			width_px: 720, height_px: 720,
		};
	}
	return { identity, views };
}

/** The candidate record the pipeline reads, plus the artifact it must be able to hash. */
export function buildSyntheticBoxCandidate(candidateId, { sourcePath, sourceBytes, outline } = {}) {
	if (SYNTHETIC_OUTLINE.test(String(candidateId ?? ""))) return buildOutlineCandidate(candidateId, outline, { sourcePath, sourceBytes });
	const match = SYNTHETIC_CANDIDATE.exec(candidateId);
	if (!match) throw new Error(`not a synthetic candidate id: ${candidateId}`);
	const [width, depth, height] = match.slice(1).map(Number);
	const storeys = Math.round(height / STOREY_M);
	if (!(width > 0 && depth > 0 && height > 0) || Math.abs(storeys * STOREY_M - height) > 1e-6) {
		throw new Error(`synthetic box needs positive sides and a height that is a multiple of ${STOREY_M} m: ${candidateId}`);
	}
	const mesh = boxMesh(width, depth, height);
	const geometryHash = sha256(stableJson({ vertices: mesh.vertices, triangles: mesh.triangles }));
	const identity = { candidate_id: candidateId, geometry_hash: geometryHash, run_id: "synthetic" };
	const x = width / 2, y = depth / 2;
	const facadePlanes = {
		facade_planes: [
			{ extent_m: [width, height], normal: [0, -1, 0], origin: [-x, -y, 0], view: "front" },
			{ extent_m: [depth, height], normal: [1, 0, 0], origin: [x, -y, 0], view: "right" },
			{ extent_m: [width, height], normal: [0, 1, 0], origin: [x, y, 0], view: "back" },
			{ extent_m: [depth, height], normal: [-1, 0, 0], origin: [-x, y, 0], view: "left" },
		],
		identity,
	};
	const bytes = sourceBytes ?? Buffer.from(stableJson({ identity, mesh }));
	return {
		candidate: { candidate_id: candidateId, family: "synthetic-box", form_class: "synthetic" },
		identity,
		mesh: { identity, ...mesh },
		cameras: cameraViews(mesh, identity),
		floor_guides: { floor_guides_m: Array.from({ length: storeys + 1 }, (_, i) => Math.round(i * STOREY_M * 1e6) / 1e6), identity },
		facade_planes: facadePlanes,
		surface_normals: null,
		facade_segment_authority: deriveFacadeSegmentsFromMass({ mesh }),
		artifacts: [{ name: "synthetic_mesh", path: "source/mesh.json", sha256: sha256(bytes), absolute_path: sourcePath ?? null }],
	};
}

/** One plane per elevation view, spanning the mass's bounds: the drawing's datum, not the facets. */
function nominalPlanes(mesh) {
	const xs = mesh.vertices.map((v) => v[0]), ys = mesh.vertices.map((v) => v[1]), zs = mesh.vertices.map((v) => v[2]);
	const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
	const z0 = Math.min(...zs), z1 = Math.max(...zs);
	const width = x1 - x0, depth = y1 - y0, height = z1 - z0;
	return [
		{ extent_m: [width, height], normal: [0, -1, 0], origin: [x0, y0, z0], view: "front" },
		{ extent_m: [depth, height], normal: [1, 0, 0], origin: [x1, y0, z0], view: "right" },
		{ extent_m: [width, height], normal: [0, 1, 0], origin: [x1, y1, z0], view: "back" },
		{ extent_m: [depth, height], normal: [-1, 0, 0], origin: [x0, y1, z0], view: "left" },
	];
}

/** The candidate an outline gives: the same record, with the mesh swept from the picture's silhouette. */
export function buildOutlineCandidate(candidateId, outline, { sourcePath, sourceBytes } = {}) {
	if (!outline?.outline_uv_m?.length || !(outline.depth_m > 0)) {
		throw new Error(`${candidateId} needs an outline.json with outline_uv_m and a positive depth_m`);
	}
	const mesh = outlineMesh(outline.outline_uv_m, outline.depth_m, outline.bulge_m ?? 0, outline.columns ?? 20,
		outline.stands_on_ground !== false, outline.lean_m ?? 0);
	const geometryHash = sha256(stableJson({ vertices: mesh.vertices, triangles: mesh.triangles }));
	const identity = { candidate_id: candidateId, geometry_hash: geometryHash, run_id: "synthetic" };
	const top = Math.max(...mesh.vertices.map((v) => v[2]));
	const storeys = Math.max(1, Math.round(top / STOREY_M));
	const authority = deriveFacadeSegmentsFromMass({ mesh });
	const bytes = sourceBytes ?? Buffer.from(stableJson({ identity, mesh }));
	return {
		candidate: { candidate_id: candidateId, family: "synthetic-outline", form_class: "synthetic" },
		identity,
		mesh: { identity, ...mesh },
		cameras: cameraViews(mesh, identity),
		floor_guides: { floor_guides_m: [
			...Array.from({ length: storeys + 1 }, (_, k) => Math.round(k * STOREY_M * 1e6) / 1e6).filter((z) => z <= top - 1e-6),
			Math.round(top * 1e6) / 1e6,
		], identity },
		// The facets the mesh itself declares: a swept outline has as many as its edges, and the
		// front polygon is the one a veil is laid on.
		// The NOMINAL plane of each elevation, from the mass's own bounds - one per view, which is
		// what the dimension pass asks for (it reads the plane a view looks straight at). The facets
		// a veil is laid on are the authority's, all thirty-odd of them; these four are the drawing's
		// datum lines. Handing it the facets instead left the front view with no plane exactly
		// normal to it, and a flat sweep would have left it with sixteen.
		// The mass's own faces: exactly one of them is square to each elevation (the arc's flat
		// crown, and the two ends), which is the plane that view is dimensioned against.
		facade_planes: { facade_planes: authority.facade_planes ?? [], identity },
		surface_normals: null,
		facade_segment_authority: authority,
		artifacts: [{ name: "synthetic_mesh", path: "source/mesh.json", sha256: sha256(bytes), absolute_path: sourcePath ?? null }],
	};
}

/** Write the candidate's one source artifact under the run dir and return the candidate record. */
export async function materializeSyntheticCandidate({ candidateId, runDir }) {
	let outline = null;
	if (SYNTHETIC_OUTLINE.test(String(candidateId ?? ""))) {
		const { readFile } = await import("node:fs/promises");
		outline = JSON.parse(await readFile(join(runDir, "outline.json"), "utf8"));
	}
	const draft = buildSyntheticBoxCandidate(candidateId, { outline });
	const sourceBytes = Buffer.from(stableJson({ identity: draft.identity, mesh: { vertices: draft.mesh.vertices, triangles: draft.mesh.triangles } }));
	const sourcePath = join(runDir, "source", "mesh.json");
	await mkdir(join(runDir, "source"), { recursive: true });
	await writeFile(sourcePath, sourceBytes);
	return buildSyntheticBoxCandidate(candidateId, { sourcePath, sourceBytes, outline });
}

/** The seeds every prepared run carries: a bare selected.glb and two thumbnails. */
export async function seedSyntheticRun({ candidate, runDir, evidenceColorDir }) {
	const { copyFile, access } = await import("node:fs/promises");
	const exists = (path) => access(path).then(() => true, () => false);
	const glbPath = join(runDir, "selected.glb");
	if (!(await exists(glbPath))) {
		const scene = buildEnrichedScene({
			mesh: candidate.mesh, floorGuides: candidate.floor_guides,
			facadePlanes: candidate.facade_segment_authority, safeFallback: true,
		});
		await writeEnrichedGlb(scene, glbPath, { approvedRoot: runDir });
	}
	for (const view of ["front", "axon"]) {
		const target = join(runDir, `${view}.png`);
		if (!(await exists(target))) await copyFile(join(evidenceColorDir, `${view}.png`), target);
	}
}
