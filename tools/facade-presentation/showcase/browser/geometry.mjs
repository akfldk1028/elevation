import * as THREE from "three";

// ---------------- geometry preparation ----------------

// The compiled GLB carries POSITION (some primitives TEXCOORD_0) and no normals.
// Rebuild every geometry as non-indexed with flat normals and box-projected
// world-space UVs in metres, so all procedural textures share one scale.
export function prepareGeometry(mesh) {
	let g = mesh.geometry;
	if (g.index) g = g.toNonIndexed();
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
