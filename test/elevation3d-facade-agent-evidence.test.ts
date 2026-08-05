import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { loadCandidatePackage, sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import {
	buildFacadeEvidencePack,
	readVerifiedFacadeEvidenceAuthority,
	verifyFacadeEvidencePack,
} from "../plugins/elevation-3d/lib/facade-agent/evidence.mjs";
import { renderFacadeEvidencePasses } from "../plugins/elevation-3d/lib/facade-agent/evidence-renderer.mjs";
import { deriveFacadeSegmentsFromMass } from "../plugins/elevation-3d/lib/facade-agent/punched-facade.mjs";

const DATASET_ROOT = process.env.ELEVATION3D_DATASET_ROOT ?? "D:/Data/50_ELE/MAAS_ELEVATION_TEST_SET_20260730";
const VIEW_NAMES = ["front", "right", "back", "left", "top", "axon", "opposite-axon"];
const PASS_NAMES = ["color", "depth", "normal", "edge", "surface-id"];

function perspectiveCameras() {
	return Object.fromEntries(VIEW_NAMES.map((name) => [name, {
		name,
		projection: "perspective",
		position: [0, 0, 0],
		target: [0, 0, 1],
		up: [0, 1, 0],
		fov_degrees: 90,
	}]));
}

async function rgbAt(path: string, x: number, y: number) {
	const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const offset = (y * info.width + x) * info.channels;
	return [...data.subarray(offset, offset + 3)];
}

async function createDirectoryLink(target: string, path: string) {
	try {
		await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error: any) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return false;
		throw error;
	}
}

async function withTemporaryDirectory(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-facade-evidence-"));
	try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("builds a 35-image immutable evidence pack and rejects changed source hashes", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		input.facade_segment_authority = deriveFacadeSegmentsFromMass({ mesh: input.mesh });
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
		assert.equal(pack.manifest.geometry_signed_volume_orientation, 1);
		assert.equal(pack.manifest.facade_segment_authority_sha256, input.facade_segment_authority.sha256);
		assert.deepEqual(pack.manifest.floor_guides_m, input.floor_guides.floor_guides_m);
		assert.equal(Object.keys(pack.manifest.artifacts).length, 35);
		assert.equal(pack.manifest.contact_sheet.sha256.length, 64);
		assert.deepEqual(renderRequest.modes, PASS_NAMES);
		assert.deepEqual(Object.keys(renderRequest.cameras), VIEW_NAMES);
		assert.strictEqual(renderRequest.mesh, input.mesh);
		assert.equal(pack.manifestSha256, sha256(await readFile(pack.manifestPath)));
		const verified = await verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input });
		assert.equal(verified.manifestSha256, pack.manifestSha256);
		assert.deepEqual(readVerifiedFacadeEvidenceAuthority(verified)?.facadeSegmentAuthority, {
			sha256: input.facade_segment_authority.sha256,
			segmentIds: input.facade_segment_authority.facade_planes.map((segment: any) => segment.segment_id),
		});

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
		await writeFile(pack.manifestPath, `${stableJson(changedManifest)}\n`);
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

test("verifier rejects noncanonical manifest bytes with unchanged meaning", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 60, g: 70, b: 80 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const pack = await buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses });
		await writeFile(pack.manifestPath, JSON.stringify(pack.manifest, null, 2));
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_MANIFEST_INVALID",
		);
	});
});

test("verifier rejects a canonically rehashed PNG whose IDAT does not fully decode", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 60, g: 70, b: 80 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const pack = await buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses });
		const artifactPath = pack.artifacts["color:front"].path;
		const truncated = (await readFile(artifactPath)).subarray(0, 70);
		assert.deepEqual(await sharp(truncated).metadata().then(({ format, width, height }) => [format, width, height]), ["png", 2, 2]);
		await assert.rejects(() => sharp(truncated).raw().toBuffer());
		await writeFile(artifactPath, truncated);
		pack.manifest.artifacts["color:front"].sha256 = sha256(truncated);
		await writeFile(pack.manifestPath, `${stableJson(pack.manifest)}\n`);
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_ARTIFACT_HASH_MISMATCH",
		);
	});
});

test("verifier fully decodes a canonically rehashed contact sheet before acceptance", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 60, g: 70, b: 80 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const pack = await buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses });
		const truncated = (await readFile(pack.contactSheetPath)).subarray(0, 70);
		assert.deepEqual(
			await sharp(truncated).metadata().then(({ format, width, height }) => [format, width, height]),
			["png", pack.manifest.contact_sheet.width, pack.manifest.contact_sheet.height],
		);
		await assert.rejects(() => sharp(truncated).raw().toBuffer());
		await writeFile(pack.contactSheetPath, truncated);
		pack.manifest.contact_sheet.sha256 = sha256(truncated);
		await writeFile(pack.manifestPath, `${stableJson(pack.manifest)}\n`);
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_ARTIFACT_HASH_MISMATCH",
		);
	});
});

test("builder rejects an evidence-directory junction without writing through it", async (t) => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 90, g: 100, b: 110 } } }).png().toFile(fixturePng);
		const runDir = join(root, "run");
		const outside = join(root, "outside");
		await Promise.all([mkdir(join(runDir, "evidence"), { recursive: true }), mkdir(outside)]);
		if (!await createDirectoryLink(outside, join(runDir, "evidence", "color"))) return t.skip("directory links are unavailable on this platform");
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		await assert.rejects(
			() => buildFacadeEvidencePack({ input, runDir, renderPasses }),
			(error: any) => error?.code === "EVIDENCE_PATH_UNSAFE",
		);
		assert.deepEqual(await readdir(outside), []);
	});
});

test("builder refuses to publish a renderer-created reparse point from staging", async (t) => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		const outside = join(root, "outside");
		await Promise.all([
			sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 90, g: 100, b: 110 } } }).png().toFile(fixturePng),
			mkdir(outside),
		]);
		const probe = join(root, "link-probe");
		if (!await createDirectoryLink(outside, probe)) return t.skip("directory links are unavailable on this platform");
		await rm(probe);
		const renderPasses = async ({ modes, outputDir }: any) => {
			await createDirectoryLink(outside, join(outputDir, "untrusted"));
			return Object.fromEntries(modes.flatMap((mode: string) => VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		};
		await assert.rejects(
			() => buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses }),
			(error: any) => error?.code === "EVIDENCE_PATH_UNSAFE",
		);
	});
});

test("verifier rejects a junction that redirects persisted artifacts outside the pack", async (t) => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 120, g: 100, b: 80 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const pack = await buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses });
		const evidenceRoot = join(root, "run", "evidence");
		const outside = join(root, "outside-color");
		await cp(join(evidenceRoot, "color"), outside, { recursive: true });
		await rm(join(evidenceRoot, "color"), { recursive: true });
		if (!await createDirectoryLink(outside, join(evidenceRoot, "color"))) return t.skip("directory links are unavailable on this platform");
		await assert.rejects(
			() => verifyFacadeEvidencePack({ manifestPath: pack.manifestPath, input }),
			(error: any) => error?.code === "EVIDENCE_PATH_UNSAFE",
		);
	});
});

test("contact sheet labels use the embedded deterministic bitmap glyphs", async () => {
	await withTemporaryDirectory(async (root) => {
		const input = await loadCandidatePackage(DATASET_ROOT, "creative-020");
		const fixturePng = join(root, "fixture.png");
		await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(fixturePng);
		const renderPasses = async ({ modes }: any) => Object.fromEntries(modes.flatMap((mode: string) =>
			VIEW_NAMES.map((view) => [`${mode}:${view}`, fixturePng])));
		const pack = await buildFacadeEvidencePack({ input, runDir: join(root, "run"), renderPasses });
		const expectedC = ["01110", "10001", "10000", "10000", "10000", "10001", "01110"];
		for (let row = 0; row < expectedC.length; row++) for (let column = 0; column < expectedC[row].length; column++) {
			const expected = expectedC[row][column] === "1" ? [32, 32, 32] : [248, 248, 246];
			assert.deepEqual(await rgbAt(pack.contactSheetPath, 20 + column * 2, 204 + row * 2), expected, `${column},${row}`);
		}
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

test("software rasterizer clips a perspective triangle crossing the camera plane", async () => {
	await withTemporaryDirectory(async (root) => {
		const mesh = {
			vertices: [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0, 0.8, -0.5]],
			triangles: [[0, 1, 2]],
		};
		const passes = await renderFacadeEvidencePasses({ mesh, cameras: perspectiveCameras(), outputDir: root, modes: PASS_NAMES });
		assert.deepEqual(await rgbAt(passes["surface-id:front"], 512, 600), [37, 37, 37]);
	});
});

test("software rasterizer uses perspective-correct reciprocal depth for overlaps", async () => {
	await withTemporaryDirectory(async (root) => {
		const mesh = {
			vertices: [
				[0.8, -0.8, 1], [-8, -8, 10], [0, 8, 10],
				[4, -4, 5], [-4, -4, 5], [0, 4, 5],
			],
			triangles: [[0, 1, 2], [3, 4, 5]],
		};
		const passes = await renderFacadeEvidencePasses({ mesh, cameras: perspectiveCameras(), outputDir: root, modes: PASS_NAMES });
		assert.deepEqual(await rgbAt(passes["surface-id:front"], 512, 512), [37, 37, 37]);
		assert.notDeepEqual(await rgbAt(passes["color:front"], 512, 512), [242, 242, 240]);
	});
});

test("software rasterizer skips zero-area triangles without renumbering valid surfaces", async () => {
	await withTemporaryDirectory(async (root) => {
		const mesh = {
			vertices: [[0, 0, 1], [0.1, 0, 1], [0.2, 0, 1], [0.6, -0.6, 2], [-0.6, -0.6, 2], [0, 0.6, 2]],
			triangles: [[0, 1, 2], [3, 4, 5]],
		};
		const passes = await renderFacadeEvidencePasses({ mesh, cameras: perspectiveCameras(), outputDir: root, modes: PASS_NAMES });
		assert.deepEqual(await rgbAt(passes["surface-id:front"], 512, 512), [110, 146, 188]);
	});
});
