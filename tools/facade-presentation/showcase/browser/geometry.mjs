import * as THREE from "three";

// ---------------- geometry preparation ----------------

// The compiled GLB carries POSITION (some primitives TEXCOORD_0) and no normals.
// Rebuild every geometry as non-indexed with flat normals and box-projected
// world-space UVs in metres, so all procedural textures share one scale.

/**
 * Replace an axis-aligned box with the same box, its twelve arrises chamfered.
 *
 * Every member this grammar derives is a box, and a box drawn with mathematically perfect
 * 90-degree edges is the single most-cited reason modelled architecture reads as CG - a
 * paper model, or LEGO. Blender's own manual put it plainly before the paragraph was
 * dropped: "In the real world, the blunt edges on objects catch the light and change the
 * shading around the edges. This gives a solid, realistic look, as opposed to un-beveled
 * objects which can look too perfect." The mechanism is a specular highlight along the
 * arris, and under a physically based shader it also buys fresnel at a grazing angle.
 *
 * It is also honest to the thing being drawn. A precast panel, a stone band and a steel
 * mullion all have an arris of a few millimetres to a centimetre or two; nothing on a
 * building is a knife edge.
 *
 * The chamfer is clamped to a fifth of the member's smallest dimension, because the
 * grammar emits members down to a few centimetres and a fixed chamfer would swallow them
 * whole. A uniform radius everywhere is itself a tell - Marmoset's artists note that real
 * wear and manufacture vary - but varying it by member size is the cheap half of that, and
 * it falls out of the clamp for free.
 */
function chamferedBox(min, max, chamfer) {
	const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
	const c = Math.min(chamfer, sx / 5, sy / 5, sz / 5);
	if (!(c > 1e-5)) return null;
	// Eight corners of the inner box, then each face pushed back out to full size: the
	// result is the original box with its edges cut, built face by face as a triangle soup
	// so it matches what the rest of this module expects.
	const x0 = min[0], x1 = max[0], y0 = min[1], y1 = max[1], z0 = min[2], z1 = max[2];
	const xi0 = x0 + c, xi1 = x1 - c, yi0 = y0 + c, yi1 = y1 - c, zi0 = z0 + c, zi1 = z1 - c;
	const out = [];
	const quad = (a, b, cc, d) => { out.push(...a, ...b, ...cc, ...a, ...cc, ...d); };
	// Six faces, each inset by the chamfer.
	quad([xi0, yi0, z1], [xi1, yi0, z1], [xi1, yi1, z1], [xi0, yi1, z1]);
	quad([xi1, yi0, z0], [xi0, yi0, z0], [xi0, yi1, z0], [xi1, yi1, z0]);
	quad([x1, yi0, zi0], [x1, yi0, zi1], [x1, yi1, zi1], [x1, yi1, zi0]);
	quad([x0, yi0, zi1], [x0, yi0, zi0], [x0, yi1, zi0], [x0, yi1, zi1]);
	quad([xi0, y1, zi1], [xi1, y1, zi1], [xi1, y1, zi0], [xi0, y1, zi0]);
	quad([xi0, y0, zi0], [xi1, y0, zi0], [xi1, y0, zi1], [xi0, y0, zi1]);
	// Twelve edge bevels.
	quad([xi0, yi0, z1], [xi0, yi1, z1], [x0, yi1, zi1], [x0, yi0, zi1]);
	quad([xi1, yi1, z1], [xi1, yi0, z1], [x1, yi0, zi1], [x1, yi1, zi1]);
	quad([xi0, yi1, z0], [xi0, yi0, z0], [x0, yi0, zi0], [x0, yi1, zi0]);
	quad([xi1, yi0, z0], [xi1, yi1, z0], [x1, yi1, zi0], [x1, yi0, zi0]);
	quad([xi0, yi1, z1], [xi1, yi1, z1], [xi1, y1, zi1], [xi0, y1, zi1]);
	quad([xi1, yi0, z1], [xi0, yi0, z1], [xi0, y0, zi1], [xi1, y0, zi1]);
	quad([xi1, yi1, z0], [xi0, yi1, z0], [xi0, y1, zi0], [xi1, y1, zi0]);
	quad([xi0, yi0, z0], [xi1, yi0, z0], [xi1, y0, zi0], [xi0, y0, zi0]);
	quad([x1, yi1, zi1], [x1, yi1, zi0], [xi1, y1, zi0], [xi1, y1, zi1]);
	quad([x1, yi0, zi0], [x1, yi0, zi1], [xi1, y0, zi1], [xi1, y0, zi0]);
	quad([x0, yi1, zi0], [x0, yi1, zi1], [xi0, y1, zi1], [xi0, y1, zi0]);
	quad([x0, yi0, zi1], [x0, yi0, zi0], [xi0, y0, zi0], [xi0, y0, zi1]);
	// Eight corners.
	const tri = (a, b, cc) => { out.push(...a, ...b, ...cc); };
	tri([xi1, yi1, z1], [x1, yi1, zi1], [xi1, y1, zi1]);
	tri([x1, yi0, zi1], [xi1, yi0, z1], [xi1, y0, zi1]);
	tri([x0, yi1, zi1], [xi0, yi1, z1], [xi0, y1, zi1]);
	tri([xi0, yi0, z1], [x0, yi0, zi1], [xi0, y0, zi1]);
	tri([x1, yi1, zi0], [xi1, yi1, z0], [xi1, y1, zi0]);
	tri([xi1, yi0, z0], [x1, yi0, zi0], [xi1, y0, zi0]);
	tri([xi0, yi1, z0], [x0, yi1, zi0], [xi0, y1, zi0]);
	tri([x0, yi0, zi0], [xi0, yi0, z0], [xi0, y0, zi0]);
	return new Float32Array(out);
}

/** True when every position sits on a corner of the geometry's own bounding box. */
function isAxisAlignedBox(g) {
	const pos = g.getAttribute("position");
	if (pos.count !== 36) return false;
	g.computeBoundingBox();
	const b = g.boundingBox;
	const on = (v, lo, hi) => Math.abs(v - lo) < 1e-6 || Math.abs(v - hi) < 1e-6;
	for (let i = 0; i < pos.count; i++) {
		if (!on(pos.getX(i), b.min.x, b.max.x)) return false;
		if (!on(pos.getY(i), b.min.y, b.max.y)) return false;
		if (!on(pos.getZ(i), b.min.z, b.max.z)) return false;
	}
	return true;
}

/** Metres of arris. A precast panel or a stone band carries about this much. */
export const ARRIS_M = 0.012;

export function prepareGeometry(mesh) {
	let g = mesh.geometry;
	if (g.index) g = g.toNonIndexed();
	// Chamfer before normals and UVs are computed, so the new faces get both.
	//
	// Solids only. Glass panes are thin and there are hundreds of them, and chamfering each
	// one put a bright arris around every pane - the entrance glazing came back reading as
	// wire mesh rather than as glass. The bevel earns its place by catching a highlight on a
	// masonry or metal edge; on a sheet of glass it is inventing a frame that is not there.
	const glazed = /glass|window/i.test((mesh.material && mesh.material.name) || "");
	if (!glazed && isAxisAlignedBox(g)) {
		const b = g.boundingBox;
		const chamfered = chamferedBox([b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z], ARRIS_M);
		if (chamfered) {
			const next = new THREE.BufferGeometry();
			next.setAttribute("position", new THREE.BufferAttribute(chamfered, 3));
			g = next;
		}
	}
	g.computeVertexNormals();
	mesh.updateWorldMatrix(true, false);
	const m = mesh.matrixWorld;
	const pos = g.getAttribute("position");
	const nor = g.getAttribute("normal");
	const uv = new Float32Array(pos.count * 2);
	const v = new THREE.Vector3(), n = new THREE.Vector3();
	for (let i = 0; i < pos.count; i++) {
		v.fromBufferAttribute(pos, i).applyMatrix4(m);
		n.fromBufferAttribute(nor, i).transformDirection(m);
		const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
		let u, w;
		if (ay >= ax && ay >= az) { u = v.x; w = v.z; }
		else if (ax >= az) { u = v.z; w = v.y; }
		else { u = v.x; w = v.y; }
		uv[i * 2] = u; uv[i * 2 + 1] = w;
	}
	g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
	mesh.geometry = g;
}
