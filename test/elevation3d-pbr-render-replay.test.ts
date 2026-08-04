import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
	parseReplayArgs,
	renderCompetitionDaylightReplay,
} from "../scripts/render-competition-daylight-pbr.mjs";

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
		"--output-root", "new",
		"--output", "new/rendered-pbr-v7-competition-daylight",
	], cwd), {
		glbPath: join(cwd, "model/textured.glb"),
		camerasPath: join(cwd, "accepted/viewer/config.json"),
		proceduralBaselineRunDir: join(cwd, "accepted/delivery"),
		presentationBaselineRunDir: join(cwd, "old/rendered-pbr-v6"),
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
				baseline_comparison: { status: "compared" },
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
				validation: { accepted: true, codes: [], metrics: {} }, artifacts: {},
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
