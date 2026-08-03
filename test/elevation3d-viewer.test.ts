import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildViewerBundle } from "../plugins/elevation-3d/lib/viewer.mjs";

test("builds a standalone Three.js viewer bundle with locked cameras", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-viewer-"));
	try {
		await buildViewerBundle({ runDir: root, config: { candidate_id: "fixture", geometry_hash: "hash", mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] }, cameras: { views: { front: { view_matrix4: [[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]], projected_bounds_m: [[-1,0],[1,1]] } } }, strategies: {} } });
		await stat(join(root, "viewer", "index.html"));
		await stat(join(root, "viewer", "app.js"));
		const config = JSON.parse(await readFile(join(root, "viewer", "config.json"), "utf8"));
		assert.equal(config.geometry_hash, "hash");
		assert.ok(config.cameras.views.front.view_matrix4);
		assert.match(await readFile(join(root, "viewer", "app.js"), "utf8"), /THREE/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
