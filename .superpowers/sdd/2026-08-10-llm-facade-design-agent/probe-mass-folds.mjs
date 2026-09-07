/** Does the mass mesh actually fold? Ask the GLB: the angle between triangles sharing an edge. */
import { NodeIO } from "@gltf-transform/core";

const io = new NodeIO();
const document = await io.read(process.argv[2]);
for (const mesh of document.getRoot().listMeshes()) {
	for (const primitive of mesh.listPrimitives()) {
		const name = mesh.getName();
		if (!name.includes("exact-mass")) continue;
		const position = primitive.getAttribute("POSITION").getArray();
		const indices = primitive.getIndices().getArray();
		const triangles = indices.length / 3;
		const normalOf = (t) => {
			const [a, b, c] = [0, 1, 2].map((k) => indices[t * 3 + k] * 3);
			const u = [position[b] - position[a], position[b + 1] - position[a + 1], position[b + 2] - position[a + 2]];
			const v = [position[c] - position[a], position[c + 1] - position[a + 1], position[c + 2] - position[a + 2]];
			const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
			const l = Math.hypot(...n);
			return l > 0 ? n.map((k) => k / l) : null;
		};
		// Index triangles by the edge they use, so shared edges pair up.
		const byEdge = new Map();
		for (let t = 0; t < triangles; t++) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
			const key = [indices[t * 3 + i], indices[t * 3 + j]].sort((l, r) => l - r).join(":");
			(byEdge.get(key) ?? byEdge.set(key, []).get(key)).push(t);
		}
		const buckets = new Map();
		let shared = 0;
		for (const [, ts] of byEdge) {
			if (ts.length !== 2) continue;
			const [a, b] = ts.map(normalOf);
			if (!a || !b) continue;
			const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
			const angle = Math.acos(dot) * 180 / Math.PI;
			shared++;
			const bucket = angle < 0.5 ? "coplanar" : angle < 2 ? "0.5-2" : angle < 5 ? "2-5" : angle < 10 ? "5-10" : angle < 15 ? "10-15" : angle < 45 ? "15-45" : "45+";
			buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
		}
		console.log(`${name}: ${triangles} triangles, ${shared} shared edges`);
		for (const key of ["coplanar", "0.5-2", "2-5", "5-10", "10-15", "15-45", "45+"]) {
			if (buckets.get(key)) console.log(`   ${key.padStart(9)}  ${buckets.get(key)}`);
		}
	}
}
