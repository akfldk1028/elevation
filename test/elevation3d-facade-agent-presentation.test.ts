import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { deliverFacadeFinalPresentation } from "../plugins/elevation-3d/lib/facade-agent/final-presentation.mjs";
import { stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { rehydrateVerifiedFacadeValidationAuthority } from "../plugins/elevation-3d/lib/enrichment-validation.mjs";

const VIEW_NAMES = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

function sha256(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function candidate() {
	const views = Object.fromEntries(["front", "right", "back", "left", "top"].map((name) => [name, {
		projection: "orthographic", projection_axes: { depth: [0, 1, 0], vertical: [0, 0, 1] },
	}]));
	return {
		mesh: { vertices: [[0, 0, 0], [10, 0, 0], [0, 8, 12]] },
		cameras: { identity: { source: "fixture" }, views },
	};
}

async function writeAcceptedTechnicalDelivery(runDir: string, glbSha256: string) {
	const root = join(runDir, "technical-delivery");
	const views: Record<string, any> = {};
	const detailPaths: Record<string, string> = {};
	for (const name of VIEW_NAMES) {
		const relativePath = join("views", name, "view.json");
		const path = join(root, relativePath);
		await mkdir(join(root, "views", name), { recursive: true });
		const type = ["axon", "opposite-axon"].includes(name) ? "perspective" : "orthographic";
		const camera = type === "perspective"
			? { type, position: [10, -10, 10], target: [0, 0, 5], up: [0, 0, 1], fov_degrees: 32, near: 0.1, far: 100 }
			: { type, projection_axes: { depth: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] }, frustum: { left: -10, right: 10, top: 10, bottom: -10, near: 0.1, far: 100 } };
		const detail = {
			schema_version: type === "perspective" ? "arr.elevation3d.competition-axon.v1"
				: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1",
			...(["plan", "top"].includes(name) ? { mode: name } : { view: name }),
			selected_glb_sha256: glbSha256, camera,
			content_bounds_px: { min_x: 10, min_y: 10, max_x: 89, max_y: 89 },
		};
		const bytes = Buffer.from(JSON.stringify(detail));
		await writeFile(path, bytes);
		detailPaths[name] = path;
		views[name] = {
			width: 100, height: 100, selected_glb_sha256: glbSha256, camera,
			validation: { accepted: true, codes: [] }, manifest: { path: relativePath, sha256: sha256(bytes) },
		};
	}
	const manifest = {
		schema_version: "arr.elevation3d.all-views.v1", selected_glb: { path: "enriched.glb", sha256: glbSha256 },
		views, validation: { accepted: true, codes: [] },
	};
	const manifestPath = join(root, "all-views-manifest.json");
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	await writeFile(manifestPath, manifestBytes);
	return {
		delivery: { run_dir: root, manifest, memory_record: { manifest: { path: manifestPath, sha256: sha256(manifestBytes) } } },
		manifestPath, detailPaths,
	};
}

function claimDifferentTechnicalGlb(delivery: any, glbSha256: string) {
	const changed = structuredClone(delivery);
	changed.manifest.selected_glb.sha256 = glbSha256;
	return changed;
}

function fakeAcceptedPbrRenderer(calls: any[], glbSha256: string, overrides: Record<string, unknown> = {}) {
	return async (options: any) => {
		calls.push(options);
		return {
			schema_version: "arr.elevation3d.embedded-pbr-render.v2",
			selected_glb: { sha256: glbSha256 },
			views: Object.fromEntries(VIEW_NAMES.map((name) => [name, { selectedGlbSha256: glbSha256, sha256: sha256(name) }])),
			validation: { accepted: true, codes: [] }, provider_calls: 0, credits_consumed: 0,
			...overrides,
		};
	};
}

async function fixture() {
	const runDir = await mkdtemp(join(tmpdir(), "elevation3d-facade-presentation-"));
	const glbPath = join(runDir, "enriched.glb");
	const glbBytes = Buffer.from("glTF-authoritative-facade");
	await writeFile(glbPath, glbBytes);
	const receiptPath = join(runDir, "facade-validation.json");
	const receiptValue = {
		schema_version: "arr.elevation3d.facade-validation-receipt.v1",
		provider: "local-fixture", version_id: "v001", artifact_sha256: sha256(glbBytes),
		validation: { accepted: true, codes: [] },
	};
	const receiptBytes = Buffer.from(JSON.stringify(receiptValue, null, 2));
	await writeFile(receiptPath, receiptBytes);
	const technical = await writeAcceptedTechnicalDelivery(runDir, sha256(glbBytes));
	return {
		runDir, glbPath, glbSha256: sha256(glbBytes), receiptPath, receiptSha256: sha256(receiptBytes),
		receiptContentSha256: sha256(stableJson(receiptValue)), technicalDelivery: technical.delivery,
		technicalManifestPath: technical.manifestPath, technicalDetailPaths: technical.detailPaths,
	};
}

function authoritativeValidation(glbSha256: string) {
	const metrics = { canonical_surface_match: 1, segment_authority_match: true };
	const artifacts = { provenance: "drawing-provenance.json" };
	const authority = {
		provider: "local-fixture", candidateId: "creative-020",
		bindings: { glb_sha256: glbSha256, grammar_sha256: "a".repeat(64) },
		grammar: { system: "brick-punched-window-v1" }, metrics, visualScore: 92,
	};
	const validation = rehydrateVerifiedFacadeValidationAuthority({ accepted: true, codes: [], metrics, artifacts }, authority);
	return { validation, authority, normalized: { accepted: true, codes: [], retryable: false, metrics, artifacts } };
}

async function replaceValidationReceipt(f: any, validation: any, validationAuthority: any) {
	const value = {
		schema_version: "arr.elevation3d.facade-validation-receipt.v1",
		provider: "local-fixture", version_id: "v001", artifact_sha256: f.glbSha256,
		validation, validation_authority: validationAuthority,
	};
	const bytes = Buffer.from(JSON.stringify(value, null, 2));
	await writeFile(f.receiptPath, bytes);
	return { path: f.receiptPath, sha256: sha256(bytes), receipt_sha256: sha256(stableJson(value)) };
}

test("renders one validated facade GLB into a bound final presentation", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		const result = await deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "final-presentation"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 },
			validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
			technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].glbPath, f.glbPath);
		assert.equal(calls[0].runDir, resolve(f.runDir, "final-presentation"));
		assert.equal(calls[0].renderStyleId, "competition-daylight-v1");
		assert.equal(calls[0].proceduralBaseline.manifest.sha256, f.technicalDelivery.memory_record.manifest.sha256);
		assert.equal(calls[0].proceduralBaseline.views.front.camera.type, "orthographic");
		assert.equal(result.schema_version, "arr.elevation3d.facade-final-presentation.v1");
		assert.equal(result.selected_glb.sha256, f.glbSha256);
		assert.equal(result.render.selected_glb.sha256, f.glbSha256);
		assert.equal(result.memory_record.presentation.sha256.length, 64);
		assert.equal(result.receipt.sha256, f.receiptSha256);
		assert.deepEqual(Object.keys(result.render.views).sort(), [...VIEW_NAMES].sort());
		assert.equal(JSON.parse(await readFile(result.memory_record.presentation.path, "utf8")).selected_glb.sha256, f.glbSha256);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects unauthenticated technical baseline paths, hashes, and cameras before rendering", async (t) => {
	for (const [name, code, tamper] of [
		["escaped manifest path", "FACADE_PRESENTATION_PATH_INVALID", async (f: any, delivery: any) => {
			delivery.memory_record.manifest.path = resolve(f.runDir, "..", "outside-all-views-manifest.json");
		}],
		["manifest hash", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", async (_f: any, delivery: any) => {
			delivery.memory_record.manifest.sha256 = "0".repeat(64);
		}],
		["detailed camera", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", async (f: any) => {
			const detail = JSON.parse(await readFile(f.technicalDetailPaths.front, "utf8"));
			detail.camera.frustum.left -= 1;
			await writeFile(f.technicalDetailPaths.front, JSON.stringify(detail));
		}],
	] as const) await t.test(name, async () => {
		const f = await fixture();
		try {
			const technicalDelivery = structuredClone(f.technicalDelivery);
			await tamper(f, technicalDelivery);
			const calls: any[] = [];
			await assert.rejects(() => deliverFacadeFinalPresentation({
				runDir: f.runDir, presentationRoot: join(f.runDir, `tampered-${name.replaceAll(" ", "-")}`), candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 },
				technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
			}), (error: any) => error?.code === code);
			assert.equal(calls.length, 0);
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	});
});

test("accepts a normalized receipt for its authoritative runtime validation and rejects semantic drift", async () => {
	const acceptedFixture = await fixture();
	try {
		const authoritative = authoritativeValidation(acceptedFixture.glbSha256);
		const receipt = await replaceValidationReceipt(acceptedFixture, authoritative.normalized, authoritative.authority);
		const calls: any[] = [];
		await deliverFacadeFinalPresentation({
			runDir: acceptedFixture.runDir, presentationRoot: join(acceptedFixture.runDir, "authoritative-presentation"), candidateId: "creative-020",
			artifact: { path: acceptedFixture.glbPath, sha256: acceptedFixture.glbSha256 }, validation: authoritative.validation,
			validationReceipt: receipt, technicalDelivery: acceptedFixture.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, acceptedFixture.glbSha256) },
		});
		assert.equal(calls.length, 1);
	} finally { await rm(acceptedFixture.runDir, { recursive: true, force: true }); }

	const mismatchedFixture = await fixture();
	try {
		const authoritative = authoritativeValidation(mismatchedFixture.glbSha256);
		const mismatchedValidation = {
			...authoritative.normalized,
			metrics: { ...authoritative.normalized.metrics, canonical_surface_match: 0 },
		};
		const receipt = await replaceValidationReceipt(mismatchedFixture, mismatchedValidation, authoritative.authority);
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: mismatchedFixture.runDir, presentationRoot: join(mismatchedFixture.runDir, "mismatched-presentation"), candidateId: "creative-020",
			artifact: { path: mismatchedFixture.glbPath, sha256: mismatchedFixture.glbSha256 }, validation: authoritative.validation,
			validationReceipt: receipt, technicalDelivery: mismatchedFixture.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, mismatchedFixture.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(mismatchedFixture.runDir, { recursive: true, force: true }); }
});

test("rejects unsafe presentation inputs before invoking the renderer", async () => {
	const scenarios = [
		["tampered GLB", "FACADE_PRESENTATION_GLB_HASH_MISMATCH", (f: any) => ({ artifact: { path: f.glbPath, sha256: "0".repeat(64) } })],
		["rejected facade validation", "FACADE_PRESENTATION_VALIDATION_REQUIRED", (_f: any) => ({ validation: { accepted: false, codes: ["REJECTED"] } })],
		["different technical GLB", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", (f: any) => ({ technicalDelivery: claimDifferentTechnicalGlb(f.technicalDelivery, "1".repeat(64)) })],
		["rejected PBR report", "FACADE_PRESENTATION_RENDER_REJECTED", (_f: any) => ({ render: { validation: { accepted: false } } })],
		["renderer reports provider calls", "FACADE_PRESENTATION_REMOTE_ACTIVITY", (_f: any) => ({ render: { provider_calls: 1 } })],
	] as const;
	for (const [name, code, change] of scenarios) {
		const f = await fixture();
		try {
			const calls: any[] = [];
			const renderOverride = (change(f) as any).render;
			const resultOverride = renderOverride ? { ...renderOverride } : {};
			const args: any = {
				runDir: f.runDir, presentationRoot: join(f.runDir, "final-presentation"), candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256, resultOverride) },
			};
			Object.assign(args, change(f));
			await assert.rejects(() => deliverFacadeFinalPresentation(args), (error: any) => error?.code === code, name);
			assert.equal(calls.length, code === "FACADE_PRESENTATION_RENDER_REJECTED" || code === "FACADE_PRESENTATION_REMOTE_ACTIVITY" ? 1 : 0, name);
		} finally { await rm(f.runDir, { recursive: true, force: true }); }
	}
});

test("rejects presentation roots that escape the run directory", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: resolve(f.runDir, "..", "escape"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_PATH_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects a reparse-point presentation root", async (context) => {
	const f = await fixture();
	try {
		const outside = await mkdtemp(join(tmpdir(), "elevation3d-facade-presentation-outside-"));
		const link = join(f.runDir, "linked-presentation");
		try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
		catch (error: any) { await rm(outside, { recursive: true, force: true }); if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return context.skip("directory links unavailable"); throw error; }
		try {
			const calls: any[] = [];
			await assert.rejects(() => deliverFacadeFinalPresentation({
				runDir: f.runDir, presentationRoot: link, candidateId: "creative-020",
				artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
				deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
			}), (error: any) => error?.code === "FACADE_PRESENTATION_PATH_INVALID");
			assert.equal(calls.length, 0);
		} finally { await rm(outside, { recursive: true, force: true }); }
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed when the validation receipt is missing or tampered", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await rm(f.receiptPath);
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "missing-receipt"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);

		await writeFile(f.receiptPath, "tampered receipt");
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "tampered-receipt"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed when the local renderer mutates the selected GLB", async () => {
	const f = await fixture();
	try {
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "mutated-glb"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: async (options: any) => {
				calls.push(options);
				await writeFile(options.glbPath, "mutated-by-renderer");
				return await fakeAcceptedPbrRenderer([], f.glbSha256)(options);
			} },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_GLB_MUTATED");
		assert.equal(calls.length, 1);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("fails closed instead of overwriting an existing final presentation", async () => {
	const f = await fixture();
	try {
		const presentationRoot = join(f.runDir, "existing-presentation");
		await mkdir(presentationRoot);
		await writeFile(join(presentationRoot, "final-presentation.json"), JSON.stringify({ selected_glb: { sha256: "0".repeat(64) } }));
		const calls: any[] = [];
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot, candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: f.technicalDelivery, input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_OUTPUT_EXISTS");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});
