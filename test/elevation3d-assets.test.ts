import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverElevation3dAssetRoot } from "./helpers/elevation3d-assets.ts";

test("discovers shared elevation assets from normal checkout and nested worktree paths", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "elevation3d-assets-"));
	try {
		const sharedRoot = join(temporary, "50_ELE");
		await Promise.all([
			mkdir(join(sharedRoot, "MAAS_ELEVATION_TEST_SET_20260730"), { recursive: true }),
			mkdir(join(sharedRoot, "elevation-3d-e2e-results"), { recursive: true }),
		]);
		const normalCheckout = join(sharedRoot, "gitagent", "test");
		const worktreeCheckout = join(sharedRoot, "gitagent", ".worktrees", "feature", "test");
		await Promise.all([mkdir(normalCheckout, { recursive: true }), mkdir(worktreeCheckout, { recursive: true })]);
		assert.equal(discoverElevation3dAssetRoot(normalCheckout), sharedRoot);
		assert.equal(discoverElevation3dAssetRoot(worktreeCheckout), sharedRoot);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
