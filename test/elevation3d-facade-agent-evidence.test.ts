import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { loadCandidatePackage, sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import {
	buildFacadeEvidencePack,
	verifyFacadeEvidencePack,
} from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";

const DATASET_ROOT = process.env.ELEVATION3D_DATASET_ROOT ?? "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730";
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];

async function withTemporaryDirectory(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-facade-evidence-"));
	try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("builds a 35-image immutable evidence pack and rejects changed source hashes", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 120, g: 130, b: 140 } } }).png().toFile(fixturePng);
		let renderRequest: any;
		const pack = await buildFacadeEvidencePack({
			input,
			runDir: join(root, "run"),
			renderPasses: async (request: any) => {
				renderRequest = request;
				return Object.fromEntries(request.modes.flatMap((mode: string) =>
					VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
			},
		});

		assert.equal(pack.manifest.candidate_id, "creative-020");
		assert.equal(pack.manifest.geometry_hash, input.identity.geometry_hash);
		assert.deepEqual(pack.manifest.floor_guides_m, input.floor_guides.floor_guides_m);
		assert.equal(Object.keys(pack.manifest.artifacts).length, 35);
		assert.equal(pack.manifest.contact_sheet.sha256.length, 64);
		assert.deepEqual(renderRequest.modes, PASS_NAMES);
		assert.deepEqual(Object.keys(renderRequest.cameras), VIEW_NAMES);
		assert.strictEqual(renderRequest.mesh, input.mesh);
		assert.equal(pack.manifestSha256, sha256(await readFile(pack.manifestPath)));
		assert.equal((await verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input })).manifestSha256, pack.manifestSha256);

		input.artifacts[0].sha256 = "0".repeat(64);
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_INPUT_HASH_MISMATCH",
		);
	});
});

test("rejects changed rendered bytes and refuses to replace a finalized manifest", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 30, g: 40, b: 50 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const runDir = join(root, "run");
		const pack = await buildFacadeEvidencePack({ input, runDir, renderPasses });
		const originalManifestBytes = await readFile(pack.manifestPath);
		const changedManifest = JSON.parse(originalManifestBytes.toString("utf8"));
		changedManifest.artifacts["color:front"].mode = "depth";
		await writeFile(pack.manifestPath, JSON.stringify(changedManifest));
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_MANIFEST_INVALID",
		);
		await writeFile(pack.manifestPath, originalManifestBytes);
		const colorFront = pack.artifacts["color:front"].path;
		await writeFile(colorFront, Buffer.from("substituted"));
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_ARTIFACT_HASH_MISMATCH",
		);
		await assert.rejects(
			() => buildFacadeEvidencePack({ input, runDir, renderPasses }),
			(error: any) => error?.code === "EVIDENCE_MANIFEST_EXISTS",
		);
	});
});

test("software rasterizer emits byte-identical 1024px evidence packs", { timeout: 120_000 }, async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const first = await buildFacadeEvidencePack({ input, runDir: join(root, "first") });
		const second = await buildFacadeEvidencePack({ input, runDir: join(root, "second") });
		const keys = PASS_NAMES.flatMap((mode) => VIEW_NAMES.map((view) => `${mode}:${view}`));
		assert.deepEqual(Object.keys(first.artifacts), keys);
		assert.equal(first.manifestSha256, second.manifestSha256);
		assert.equal(first.manifest.contact_sheet.sha256, second.manifest.contact_sheet.sha256);
		for (const key of keys) {
			assert.deepEqual(await sharp(first.artifacts[key].path).metadata().then(({ width, height }) => [width, height]), [1024, 1024]);
			assert.equal(first.manifest.artifacts[key].sha256, second.manifest.artifacts[key].sha256, key);
		}
		assert.notEqual(first.manifest.artifacts["color:front"].sha256, first.manifest.artifacts["normal:front"].sha256);
	});
});
