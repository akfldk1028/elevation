import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { deliverFacadeFinalPresentation } from "../plugins/elevation-3d/lib/facade-agent/final-presentation.mjs";
import { stableJson } from "../plugins/elevation-3d/lib/core.mjs";

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

function acceptedTechnicalDelivery(glbSha256: string) {
	return { run_dir: "technical-delivery", manifest: { selected_glb: { sha256: glbSha256 } } };
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
	return {
		runDir, glbPath, glbSha256: sha256(glbBytes), receiptPath, receiptSha256: sha256(receiptBytes),
		receiptContentSha256: sha256(stableJson(receiptValue)),
	};
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
			technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].glbPath, f.glbPath);
		assert.equal(calls[0].runDir, resolve(f.runDir, "final-presentation"));
		assert.equal(calls[0].renderStyleId, "competition-daylight-v1");
		assert.equal(result.schema_version, "arr.elevation3d.facade-final-presentation.v1");
		assert.equal(result.selected_glb.sha256, f.glbSha256);
		assert.equal(result.render.selected_glb.sha256, f.glbSha256);
		assert.equal(result.memory_record.presentation.sha256.length, 64);
		assert.equal(result.receipt.sha256, f.receiptSha256);
		assert.deepEqual(Object.keys(result.render.views).sort(), [...VIEW_NAMES].sort());
		assert.equal(JSON.parse(await readFile(result.memory_record.presentation.path, "utf8")).selected_glb.sha256, f.glbSha256);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});

test("rejects unsafe presentation inputs before invoking the renderer", async () => {
	const scenarios = [
		["tampered GLB", "FACADE_PRESENTATION_GLB_HASH_MISMATCH", (f: any) => ({ artifact: { path: f.glbPath, sha256: "0".repeat(64) } })],
		["rejected facade validation", "FACADE_PRESENTATION_VALIDATION_REQUIRED", (_f: any) => ({ validation: { accepted: false, codes: ["REJECTED"] } })],
		["different technical GLB", "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", (_f: any) => ({ technicalDelivery: acceptedTechnicalDelivery("1".repeat(64)) })],
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
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
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
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
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
				validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
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
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID");
		assert.equal(calls.length, 0);

		await writeFile(f.receiptPath, "tampered receipt");
		await assert.rejects(() => deliverFacadeFinalPresentation({
			runDir: f.runDir, presentationRoot: join(f.runDir, "tampered-receipt"), candidateId: "creative-020",
			artifact: { path: f.glbPath, sha256: f.glbSha256 }, validation: { accepted: true, codes: [] },
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
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
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
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
			validationReceipt: { path: f.receiptPath, sha256: f.receiptSha256, receipt_sha256: f.receiptContentSha256 }, technicalDelivery: acceptedTechnicalDelivery(f.glbSha256), input: candidate(),
			deps: { renderEmbeddedPbrViews: fakeAcceptedPbrRenderer(calls, f.glbSha256) },
		}), (error: any) => error?.code === "FACADE_PRESENTATION_OUTPUT_EXISTS");
		assert.equal(calls.length, 0);
	} finally { await rm(f.runDir, { recursive: true, force: true }); }
});
