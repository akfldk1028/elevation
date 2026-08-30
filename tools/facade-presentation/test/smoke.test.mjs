import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseShowcaseArgs } from "../showcase/cli.mjs";
import { AXIS_VALUES, STYLE_AXES, FACE_VALUES } from "../showcase/axes.mjs";
import { buildCodexPrompt, buildCodexCommand, findNewestPng, NO_IMAGE_TOOL, shellQuoteArgs } from "../photo/codex-photo.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("parseShowcaseArgs: positional and defaults", () => {
	const parsed = parseShowcaseArgs(["in.glb", "out.png"]);
	assert.equal(parsed.glbPath, "in.glb");
	assert.equal(parsed.outPngPath, "out.png");
	assert.deepEqual(parsed.axes, { wall: "", glass: "", frame: "", mood: "" });
	assert.equal(parsed.face, "auto");
});

test("parseShowcaseArgs: style shorthand sets the four axes", () => {
	const parsed = parseShowcaseArgs(["in.glb", "out.png", "--style", "stone"]);
	assert.deepEqual(parsed.axes, STYLE_AXES.stone);
});

test("parseShowcaseArgs: explicit axis flag overrides style", () => {
	const parsed = parseShowcaseArgs(["in.glb", "out.png", "--style", "brick", "--glass", "clear"]);
	assert.deepEqual(parsed.axes, { ...STYLE_AXES.brick, glass: "clear" });
});

test("parseShowcaseArgs: --face accepted values", () => {
	for (const face of FACE_VALUES) {
		assert.equal(parseShowcaseArgs(["a", "b", "--face", face]).face, face);
	}
});

test("parseShowcaseArgs: bad values throw", () => {
	assert.throws(() => parseShowcaseArgs(["a", "b", "--style", "gothic"]), /unknown --style/);
	assert.throws(() => parseShowcaseArgs(["a", "b", "--wall", "marble"]), /unknown --wall/);
	assert.throws(() => parseShowcaseArgs(["a", "b", "--glass", "frosted"]), /unknown --glass/);
	assert.throws(() => parseShowcaseArgs(["a", "b", "--frame", "gold"]), /unknown --frame/);
	assert.throws(() => parseShowcaseArgs(["a", "b", "--mood", "noir"]), /unknown --mood/);
	assert.throws(() => parseShowcaseArgs(["a", "b", "--face", "top"]), /unknown --face/);
	assert.throws(() => parseShowcaseArgs(["a"]), /usage/);
});

test("axes tables are complete and consistent", () => {
	assert.deepEqual(Object.keys(AXIS_VALUES).sort(), ["frame", "glass", "mood", "wall"]);
	assert.equal(AXIS_VALUES.wall.length, 6);
	for (const [style, axes] of Object.entries(STYLE_AXES)) {
		for (const [axis, value] of Object.entries(axes)) {
			assert.ok(AXIS_VALUES[axis].includes(value), `${style}.${axis}=${value} not in AXIS_VALUES`);
		}
	}
	assert.ok(FACE_VALUES.includes("auto"));
});

// The browser modules import "three" and touch document/window at call time,
// so they are checked statically: the file exists and declares the exports the
// app composes, rather than importing them into node.
const BROWSER_EXPORTS = {
	"moods.mjs": ["MOOD_PRESETS", "styleValue"],
	"textures.mjs": ["canvasTexture", "mulberry32", "speckle", "brickMaps", "stoneMaps", "precastMaps", "zincMaps", "woodMaps", "groundMaps"],
	"sky-env.mjs": ["skyDome", "buildEnvironmentTexture"],
	"geometry.mjs": ["prepareGeometry"],
	"materials.mjs": ["buildShowcaseMaterials", "materialForMesh"],
	"camera.mjs": ["deriveBaseAzimuth", "setupCamera"],
};

test("browser modules exist and declare their exports", () => {
	for (const [file, names] of Object.entries(BROWSER_EXPORTS)) {
		const path = join(here, "..", "showcase", "browser", file);
		assert.ok(existsSync(path), `${file} missing`);
		const source = readFileSync(path, "utf8");
		for (const name of names) {
			assert.ok(
				new RegExp(`export (function|const) ${name}\\b`).test(source),
				`${file} does not export ${name}`,
			);
		}
	}
	const app = readFileSync(join(here, "..", "showcase", "browser", "app.mjs"), "utf8");
	assert.ok(app.includes("__SHOWCASE_AXES__"), "app.mjs must read __SHOWCASE_AXES__");
	assert.ok(app.includes("__SHOWCASE_FACE__"), "app.mjs must read __SHOWCASE_FACE__");
});

test("codex photo: prompt locks geometry and command is codex exec", () => {
	const prompt = buildCodexPrompt("C:/x/in.png", "red brick block at golden hour");
	assert.ok(prompt.includes("massing"));
	assert.ok(prompt.includes("window grid"));
	assert.ok(prompt.includes("construction"));
	assert.ok(prompt.includes("entrance block"));
	assert.ok(prompt.includes("red brick block at golden hour"));
	assert.ok(prompt.includes(NO_IMAGE_TOOL));
	const { command, args } = buildCodexCommand(prompt);
	assert.equal(command, "codex");
	assert.deepEqual(args.slice(0, 2), ["exec", "--skip-git-repo-check"]);
	assert.equal(args[2], prompt);
});

test("codex photo: findNewestPng picks the newest post-start PNG", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-png-"));
	try {
		await mkdir(join(root, "a"), { recursive: true });
		await mkdir(join(root, "b"), { recursive: true });
		const old = join(root, "a", "old.png");
		const mid = join(root, "a", "mid.png");
		const newest = join(root, "b", "newest.png");
		const notPng = join(root, "b", "newest.txt");
		for (const f of [old, mid, newest, notPng]) await writeFile(f, "x");
		const now = Date.now() / 1000;
		await utimes(old, now - 3600, now - 3600);
		await utimes(mid, now + 10, now + 10);
		await utimes(newest, now + 20, now + 20);
		await utimes(notPng, now + 30, now + 30);
		assert.equal(await findNewestPng(root, Date.now() - 1000), newest);
		assert.equal(await findNewestPng(root, Date.now() + 3600_000), null);
		assert.equal(await findNewestPng(join(root, "missing"), 0), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// The photo lane shipped broken because it was written and never run: on Windows the
// codex .cmd shim needs a shell, the shell re-parsed the argv, and a 49-word prompt
// arrived as 49 arguments - codex read the second word as a subcommand and exited 2.
test("the codex prompt survives the shell as one argument", () => {
	const prompt = buildCodexPrompt("D:/renders/kahn.png", "a brick arcade at golden hour");
	const { command, args } = buildCodexCommand(prompt);
	assert.equal(command, "codex");
	assert.deepEqual(args.slice(0, 2), ["exec", "--skip-git-repo-check"]);

	const quoted = shellQuoteArgs(args, "win32");
	assert.equal(quoted.length, 3, "quoting must not split the prompt into more arguments");
	assert.equal(quoted[0], "exec", "a bare flag-shaped argument needs no quotes");
	assert.ok(quoted[2].startsWith('"') && quoted[2].endsWith('"'), quoted[2].slice(0, 40));
	assert.ok(quoted[2].includes("NO_IMAGE_TOOL"), "the sentinel has to reach codex");

	// Off Windows there is no shell in the way, so the argv is handed over untouched.
	assert.deepEqual(shellQuoteArgs(args, "linux"), args);
});
