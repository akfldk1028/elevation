import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
	parseReplayArgs,
	renderCompetitionDaylightReplay,
} from "../scripts/render-competition-daylight-pbr.mjs";
import * as replayModule from "../scripts/render-competition-daylight-pbr.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

const temporaryRoots: string[] = [];
const viewNames = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];
const acceptedCameras = Object.fromEntries(viewNames.map((name) => [name, {
	projection: ["axon", "opposite-axon"].includes(name) ? "perspective" : "orthographic",
	locked: true,
}]));

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("resolves replay paths from CLI arguments", () => {
	const cwd = resolve("fixture-root");
	assert.deepEqual(parseReplayArgs([
		"--glb", "model/textured.glb",
		"--cameras", "accepted/viewer/config.json",
		"--procedural-baseline", "accepted/delivery",
		"--presentation-baseline", "old/rendered-pbr-v6",
		"--accepted-source", "accepted-primary/rendered-pbr-v7-competition-daylight",
		"--archive-accepted-canonical", "true",
		"--output-root", "new",
		"--output", "new/rendered-pbr-v7-competition-daylight",
	], cwd), {
		glbPath: join(cwd, "model/textured.glb"),
		camerasPath: join(cwd, "accepted/viewer/config.json"),
		proceduralBaselineRunDir: join(cwd, "accepted/delivery"),
		presentationBaselineRunDir: join(cwd, "old/rendered-pbr-v6"),
		acceptedSourceDir: join(cwd, "accepted-primary/rendered-pbr-v7-competition-daylight"),
		archiveAcceptedCanonical: true,
		outputDir: join(cwd, "new/rendered-pbr-v7-competition-daylight"),
		outputRoot: join(cwd, "new"),
	});
});

test("requires distinct output-root and output CLI arguments", () => {
	const common = [
		"--glb", "textured.glb", "--cameras", "config.json", "--procedural-baseline", "delivery",
	];
	assert.throws(() => parseReplayArgs([...common, "--output", "rendered-pbr-v7-competition-daylight"]), /--output-root is required/i);
	assert.throws(() => parseReplayArgs([...common, "--output-root", "run"]), /--output is required/i);
});

test("replays the accepted cameras without provider access and appends presentation memory", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-replay-"));
	temporaryRoots.push(root);
	const glbPath = join(root, "final", "textured.glb");
	const camerasPath = join(root, "delivery", "viewer", "config.json");
	const proceduralBaselineRunDir = join(root, "delivery");
	const presentationBaselineRunDir = join(root, "rendered-pbr-v6");
	const outputDir = join(root, "rendered-pbr-v7-competition-daylight");
	await mkdir(dirname(glbPath), { recursive: true });
	await mkdir(dirname(camerasPath), { recursive: true });
	await mkdir(presentationBaselineRunDir, { recursive: true });
	await writeFile(glbPath, "same-geometry-glb");
	await writeFile(camerasPath, JSON.stringify({
		candidate_id: "creative-013",
		all_views: { validation: { accepted: true } },
		cameras: { views: acceptedCameras },
	}));
	await writeFile(join(presentationBaselineRunDir, "sentinel.txt"), "v6 remains immutable");

	const calls: any[] = [];
	const report = await renderCompetitionDaylightReplay({
		glbPath, camerasPath, proceduralBaselineRunDir, presentationBaselineRunDir,
		outputDir, outputRoot: root,
	}, {
		renderEmbeddedPbrViews: async (options: any) => {
			calls.push(options);
			return {
				render_style: { id: "competition-daylight-v1" }, render_style_sha256: "a".repeat(64),
				baseline_comparison: { status: "compared_legacy_reanalyzed", decision: { accepted: true } },
				validation: { accepted: true, status: "accepted", codes: [], metrics: { highlight_clip_fraction: 0 } },
				provider_calls: 0, credits_consumed: 0,
				artifacts: { contact_sheet: { path: join(outputDir, "contact-sheet.png"), sha256: "b".repeat(64) } },
			};
		},
	});

	assert.equal(report.validation.accepted, true);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		glbPath: resolve(glbPath), runDir: resolve(outputDir), candidateId: "creative-013",
		cameras: acceptedCameras,
		baselineRunDir: resolve(proceduralBaselineRunDir),
		presentationBaselineRunDir: resolve(presentationBaselineRunDir),
		requirePresentationBaselineComparison: true,
		renderStyleId: "competition-daylight-v1",
	});
	assert.equal(await readFile(join(presentationBaselineRunDir, "sentinel.txt"), "utf8"), "v6 remains immutable");
	const memory = JSON.parse(await readFile(join(root, "presentation-versions.jsonl"), "utf8"));
	assert.equal(memory.result.status, "accepted");
	assert.equal(memory.provider_calls, 0);
	assert.equal(memory.credits_consumed, 0);
	assert.equal(basename(memory.output_directory), "rendered-pbr-v7-competition-daylight");
});

test("rejects viewer configs that are unaccepted or missing any required camera", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-cameras-"));
	temporaryRoots.push(root);
	const camerasPath = join(root, "config.json");
	const options = {
		glbPath: join(root, "textured.glb"), camerasPath, proceduralBaselineRunDir: join(root, "delivery"),
		outputRoot: root, outputDir: join(root, "rendered-pbr-v7-competition-daylight"),
	};
	for (const config of [
		{ candidate_id: "creative-013", cameras: { views: acceptedCameras } },
		{ candidate_id: "creative-013", all_views: { validation: { accepted: false } }, cameras: { views: acceptedCameras } },
		{ candidate_id: "creative-013", all_views: { validation: { accepted: true } }, cameras: { views: { front: acceptedCameras.front } } },
	]) {
		await writeFile(camerasPath, JSON.stringify(config));
		await assert.rejects(
			() => renderCompetitionDaylightReplay(options, { renderEmbeddedPbrViews: async () => ({}) }),
			/accepted|camera/i,
		);
	}
});

test("records the fixed style hash and failure code when rendering throws", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-render-failure-"));
	temporaryRoots.push(root);
	const camerasPath = join(root, "config.json");
	await writeFile(camerasPath, JSON.stringify({
		candidate_id: "creative-013", all_views: { validation: { accepted: true } }, cameras: { views: acceptedCameras },
	}));
	const failure = Object.assign(new Error("Bearer failure-secret"), { code: "BROWSER_CAPTURE_FAILED" });
	await assert.rejects(() => renderCompetitionDaylightReplay({
		glbPath: join(root, "textured.glb"), camerasPath, proceduralBaselineRunDir: join(root, "delivery"),
		outputRoot: root, outputDir: join(root, "rendered-pbr-v7-competition-daylight"),
	}, { renderEmbeddedPbrViews: async () => { throw failure; } }), failure);
	await access(join(root, "rendered-pbr-v7-competition-daylight"));
	const memory = JSON.parse(await readFile(join(root, "presentation-versions.jsonl"), "utf8"));
	assert.match(memory.style.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(memory.result.failure_codes, ["BROWSER_CAPTURE_FAILED"]);
	assert.equal(memory.provider_calls, 0);
	assert.equal(memory.credits_consumed, 0);
	assert.equal(JSON.stringify(memory).includes("failure-secret"), false);
});

test("rejects output paths that are not a fresh v7 directory below the explicit root", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-output-scope-"));
	temporaryRoots.push(root);
	const camerasPath = join(root, "config.json");
	await writeFile(camerasPath, JSON.stringify({
		candidate_id: "creative-013", all_views: { validation: { accepted: true } }, cameras: { views: acceptedCameras },
	}));
	const common = {
		glbPath: join(root, "textured.glb"), camerasPath,
		proceduralBaselineRunDir: join(root, "delivery"), outputRoot: root,
	};
	for (const outputDir of [
		root,
		join(root, "rendered-pbr-v6"),
		resolve(root, "..", "rendered-pbr-v7-competition-daylight"),
	]) {
		await assert.rejects(
			() => renderCompetitionDaylightReplay({ ...common, outputDir }, { renderEmbeddedPbrViews: async () => ({}) }),
			/below the explicit output root|rendered-pbr-v7-competition-daylight/i,
		);
	}
	await mkdir(join(root, "rendered-pbr-v7-competition-daylight"));
	await assert.rejects(
		() => renderCompetitionDaylightReplay({ ...common, outputDir: join(root, "rendered-pbr-v7-competition-daylight") }, { renderEmbeddedPbrViews: async () => ({}) }),
		/already exists/i,
	);
});

test("rejects a junction escape instead of creating output through it", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-junction-root-"));
	const outside = await mkdtemp(join(tmpdir(), "elevation3d-pbr-junction-outside-"));
	temporaryRoots.push(root, outside);
	const escape = join(root, "escape");
	try {
		await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		context.skip(`directory links unavailable: ${error?.code ?? error}`);
		return;
	}
	await assert.rejects(() => renderCompetitionDaylightReplay({
		glbPath: join(root, "textured.glb"), camerasPath: join(root, "config.json"),
		proceduralBaselineRunDir: join(root, "delivery"), outputRoot: root,
		outputDir: join(escape, "rendered-pbr-v7-competition-daylight"),
	}, { renderEmbeddedPbrViews: async () => ({}) }), /direct child|below the explicit output root/i);
	await assert.rejects(() => readFile(join(outside, "rendered-pbr-v7-competition-daylight")), /ENOENT/);
});

test("atomically reserves the output directory for only one concurrent replay", async () => {
	const root = await mkdtemp(join(tmpdir(), "elevation3d-pbr-exclusive-output-"));
	temporaryRoots.push(root);
	const camerasPath = join(root, "config.json");
	await writeFile(camerasPath, JSON.stringify({
		candidate_id: "creative-013", all_views: { validation: { accepted: true } }, cameras: { views: acceptedCameras },
	}));
	const options = {
		glbPath: join(root, "textured.glb"), camerasPath, proceduralBaselineRunDir: join(root, "delivery"),
		outputRoot: root, outputDir: join(root, "rendered-pbr-v7-competition-daylight"),
	};
	let renderCalls = 0;
	const deps = {
		renderEmbeddedPbrViews: async () => {
			renderCalls++;
			await new Promise((done) => setImmediate(done));
			return {
				render_style: { id: "competition-daylight-v1" }, render_style_sha256: "a".repeat(64),
				validation: { accepted: true, codes: [], metrics: {} }, artifacts: {}, provider_calls: 0, credits_consumed: 0,
			};
		},
	};
	const results = await Promise.allSettled([
		renderCompetitionDaylightReplay(options, deps),
		renderCompetitionDaylightReplay(options, deps),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	assert.match((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /already exists|reserved/i);
	assert.equal(renderCalls, 1);
});

test("preserves only a rejected canonical after accepted source identity verification", async () => {
	const prepareCanonicalReplay = (replayModule as any).prepareCanonicalReplay;
	assert.equal(typeof prepareCanonicalReplay, "function");
	const root = await mkdtemp(join(tmpdir(), "elevation3d-canonical-prepare-"));
	temporaryRoots.push(root);
	const glbPath = join(root, "final", "textured.glb");
	const camerasPath = join(root, "accepted-cameras.json");
	const sourceDir = join(root, "accepted-primary", "rendered-pbr-v7-competition-daylight");
	const canonicalDir = join(root, "rendered-pbr-v7-competition-daylight");
	await mkdir(dirname(glbPath), { recursive: true });
	await mkdir(join(sourceDir, "viewer"), { recursive: true });
	await mkdir(canonicalDir, { recursive: true });
	const glb = Buffer.from("immutable-glb");
	const config = { candidate_id: "creative-013", all_views: { validation: { accepted: true } }, cameras: { views: acceptedCameras } };
	await writeFile(glbPath, glb); await writeFile(camerasPath, JSON.stringify(config));
	await writeFile(join(sourceDir, "viewer", "config.json"), JSON.stringify(config));
	await writeFile(join(sourceDir, "render-validation.json"), JSON.stringify({
		validation: { accepted: true }, selected_glb: { sha256: createHash("sha256").update(glb).digest("hex") },
		render_style: resolvePbrRenderStyle(), render_style_sha256: renderStyleHash(resolvePbrRenderStyle()),
	}));
	await writeFile(join(canonicalDir, "render-validation.json"), JSON.stringify({ validation: { accepted: false } }));
	await writeFile(join(canonicalDir, "rejected-sentinel.txt"), "preserve me");
	const prepared = await prepareCanonicalReplay({ outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath });
	assert.match(prepared.preservedAttempt, /[\\/]attempts[\\/]rendered-pbr-v7-competition-daylight-attempt-001$/);
	assert.equal(await readFile(join(prepared.preservedAttempt, "rejected-sentinel.txt"), "utf8"), "preserve me");
	await assert.rejects(() => access(canonicalDir), /ENOENT/);

	await mkdir(canonicalDir); await writeFile(join(canonicalDir, "render-validation.json"), JSON.stringify({ validation: { accepted: true } }));
	await assert.rejects(() => prepareCanonicalReplay({ outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath }), /accepted canonical/i);
	await writeFile(join(canonicalDir, "accepted-sentinel.txt"), "authorized preservation");
	const acceptedPrepared = await prepareCanonicalReplay({
		outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath, archiveAcceptedCanonical: true,
	});
	assert.match(acceptedPrepared.preservedAttempt, /[\\/]attempts[\\/]rendered-pbr-v7-competition-daylight-attempt-002$/);
	assert.equal(await readFile(join(acceptedPrepared.preservedAttempt, "accepted-sentinel.txt"), "utf8"), "authorized preservation");

	await mkdir(canonicalDir); await writeFile(join(canonicalDir, "render-validation.json"), JSON.stringify({ validation: { accepted: false } }));
	await writeFile(join(sourceDir, "render-validation.json"), JSON.stringify({
		validation: { accepted: true }, selected_glb: { sha256: createHash("sha256").update(glb).digest("hex") },
		render_style: { id: "competition-daylight-v1" }, render_style_sha256: "a80ac48cf978eea1c63bfbd4842d38f7a21179d9c0e782f3b551a4ad72902a06",
	}));
	const migrated = await prepareCanonicalReplay({ outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath });
	assert.match(migrated.preservedAttempt, /[\\/]attempts[\\/]rendered-pbr-v7-competition-daylight-attempt-003$/, "the exact accepted-source style remains valid for the tint migration");

	await mkdir(canonicalDir); await writeFile(join(canonicalDir, "render-validation.json"), JSON.stringify({ validation: { accepted: false } }));
	await writeFile(join(sourceDir, "render-validation.json"), JSON.stringify({
		validation: { accepted: true }, selected_glb: { sha256: createHash("sha256").update(glb).digest("hex") },
		render_style: { id: "competition-daylight-v1" }, render_style_sha256: "ed4dae4fc3bb869810d156adf11c69d23265d4822b4a26e46e6c61fb8da9d9dc",
	}));
	const predecessor = await prepareCanonicalReplay({ outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath });
	assert.match(predecessor.preservedAttempt, /[\\/]attempts[\\/]rendered-pbr-v7-competition-daylight-attempt-004$/, "only the exact immediate predecessor tint style is migrated");
	await mkdir(canonicalDir); await writeFile(join(canonicalDir, "render-validation.json"), JSON.stringify({ validation: { accepted: false } }));
	await writeFile(join(sourceDir, "render-validation.json"), JSON.stringify({
		validation: { accepted: true }, selected_glb: { sha256: createHash("sha256").update(glb).digest("hex") },
		render_style: { id: "competition-daylight-v1" }, render_style_sha256: "f".repeat(64),
	}));
	await assert.rejects(() => prepareCanonicalReplay({ outputRoot: root, canonicalDir, acceptedSourceDir: sourceDir, glbPath, camerasPath }), /style identity/i);
});
