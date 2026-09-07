/**
 * Photoreal pass over a showcase render through the free codex lane.
 *
 * Runs `codex exec` with a geometry-locking img2img prompt against an input
 * PNG. Codex's sandbox cannot write outside its home, so the generated image
 * lands under ~/.codex/generated_images/<id>/ and is found by mtime and copied
 * to the requested output path.
 *
 * CLI: node codex-photo.mjs <input-png> <output-png> "<subject>"
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NO_IMAGE_TOOL = "NO_IMAGE_TOOL";

export function defaultGeneratedImagesDir() {
	return join(homedir(), ".codex", "generated_images");
}

/** The image tool codex exposes. Named in the prompt because the model denies having it. */
export const CODEX_IMAGE_TOOL = "image_gen__imagegen";

/**
 * Two passes share the lane and want opposite things from the picture they are handed.
 * `photo` re-photographs a RENDERED scheme and must keep every member of it; `concept`
 * dresses a BARE mass and must keep only the mass - the facade is what it is asked for.
 * One prompt served both until a concept commission told the model to keep "the same
 * window grid" of a picture that had no windows.
 */
const PROMPT_BY_MODE = Object.freeze({
	photo: [
		"architectural photograph of the same building. Keep the same massing, window grid,",
		"construction, entrance block - change only surface realism, lighting nuance and context.",
	],
	concept: [
		"architectural photograph of that exact mass with a facade designed onto it. Keep the",
		"silhouette, storey count and every facet exactly as rendered; the facade is the subject.",
	],
});

export function buildCodexPrompt(inputPng, subject, mode = "photo") {
	const wording = PROMPT_BY_MODE[mode];
	if (!wording) throw new Error(`codex prompt mode must be photo or concept, got ${mode}`);
	return [
		`Use your ${CODEX_IMAGE_TOOL} tool.`,
		`Read the render at ${resolve(inputPng).replace(/\\/g, "/")} and generate a photorealistic`,
		...wording,
		`Subject: ${subject}.`,
		"Do not answer that you lack the tool without calling it.",
		// Left to itself the model sometimes reaches for an image_gen.py script instead,
		// which needs an OPENAI_API_KEY this environment does not have - it then exits 1
		// without generating. The built-in tool is the only lane that works here.
		"Call the tool DIRECTLY; never run image_gen.py, python, or any script to generate.",
	].join(" ");
}

export function buildCodexCommand(prompt) {
	return { command: "codex", args: ["exec", "--skip-git-repo-check", prompt] };
}

/**
 * The session id codex prints on stderr, which is also the directory it writes its
 * generated images into.
 *
 * Without it the image was found by scanning the whole shared generated_images tree for
 * the newest file, and two photo runs started together both claimed whichever image
 * landed first: two concepts for two different masses came back byte-identical, one of
 * them a building that had nothing to do with the mass it was supposed to dress. Nothing
 * in either run's output said so. Binding the search to the session makes an invocation
 * able to find only its own image.
 */
export function parseCodexSessionId(output) {
	return /^\s*session id:\s*([0-9a-f-]{36})\s*$/im.exec(String(output ?? ""))?.[1] ?? null;
}

// Newest PNG under rootDir (recursive) whose mtime is after sinceMs, or null.
export async function findNewestPng(rootDir, sinceMs) {
	let newest = null;
	async function walk(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
				const info = await stat(full);
				if (info.mtimeMs > sinceMs && (!newest || info.mtimeMs > newest.mtimeMs)) {
					newest = { path: full, mtimeMs: info.mtimeMs };
				}
			}
		}
	}
	await walk(rootDir);
	return newest ? newest.path : null;
}

/**
 * Arguments as the shell will actually receive them.
 *
 * The codex entry point is a .cmd shim on Windows, which spawn can only reach through a
 * shell - and a shell re-parses the argv, so a multi-word prompt arrives as a dozen
 * arguments and codex reads the second word as a subcommand ("error: unrecognized
 * subcommand 'the'"). Quote for the shell we are actually handing it to rather than
 * hoping spawn's escaping survives the round trip. Off Windows there is no shell and the
 * argv passes through untouched.
 */
export function shellQuoteArgs(args, platform = process.platform) {
	if (platform !== "win32") return args;
	return args.map((arg) => (/^[\w.\-\/:=]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '\\"')}"`));
}

function runCodex({ command, args }, timeoutMs = 15 * 60 * 1000) {
	return new Promise((resolvePromise, rejectPromise) => {
		const useShell = process.platform === "win32";
		// stdin ignored, and a deadline. With an inherited-but-empty stdin codex waits for
		// input that never arrives: the first run through this module sat for four days and
		// left four codex processes behind. A photo pass that cannot finish in the timeout
		// has failed, and saying so beats hanging the caller.
		const child = spawn(command, shellQuoteArgs(args), {
			shell: useShell, windowsVerbatimArguments: false, stdio: ["ignore", "pipe", "pipe"],
		});
		const deadline = setTimeout(() => {
			child.kill();
			rejectPromise(new Error(`codex exec exceeded ${Math.round(timeoutMs / 1000)}s and was killed; the photo lane is not usable from this process`));
		}, timeoutMs);
		child.on("close", () => clearTimeout(deadline));
		child.on("error", () => clearTimeout(deadline));
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		child.on("error", rejectPromise);
		child.on("close", (code) => resolvePromise({ code, output }));
	});
}

export async function codexPhoto({ inputPng, outputPng, subject, mode = "photo", generatedDir = defaultGeneratedImagesDir() }) {
	if (!inputPng || !outputPng || !subject) {
		throw new Error("codexPhoto requires inputPng, outputPng and subject");
	}
	const startMs = Date.now();
	const prompt = buildCodexPrompt(inputPng, subject, mode);
	const { code, output } = await runCodex(buildCodexCommand(prompt));
	// Success is the file, not the model's account of itself. This used to ask codex to print a
	// sentinel when it had no image tool, and then search the whole transcript for that word -
	// but codex echoes the prompt it was given, so the detector kept finding its own
	// instruction and reporting a missing tool while the image was being written. Two runs were
	// called failures that way; a direct probe answered "image generation: image_gen__imagegen"
	// and a third run produced the photograph. An artifact check cannot be fooled by what the
	// model says about itself, and `findNewestPng` below was always the real signal.
	if (code !== 0) {
		// A quota refusal is one line in the middle of the transcript and the tail below cut
		// it off, so two commissions were read as the tool outage. Say it first when present.
		const limit = output.split(/\r?\n/).find((line) => /usage limit/i.test(line));
		throw new Error(`codex exec exited with code ${code}${limit ? ` - ${limit.trim()}` : ""}: ${output.slice(-2000)}`);
	}
	// Only this session's own directory. A run that cannot name its session falls back to
	// the whole tree, which is the racing search, so it says which one answered rather than
	// leaving the caller unable to tell a bound result from a borrowed one.
	const session = parseCodexSessionId(output);
	const searchDir = session ? join(generatedDir, session) : generatedDir;
	const generated = await findNewestPng(searchDir, startMs);
	if (!generated) {
		throw new Error(`codex exec finished but no new PNG appeared under ${searchDir}; output tail: ${output.slice(-2000)}`);
	}
	await mkdir(dirname(resolve(outputPng)), { recursive: true });
	await copyFile(generated, resolve(outputPng));
	return { source: generated, output: resolve(outputPng), session, bound: Boolean(session) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [inputPng, outputPng, subject] = process.argv.slice(2);
	if (!inputPng || !outputPng || !subject) {
		throw new Error('usage: node codex-photo.mjs <input-png> <output-png> "<subject>"');
	}
	const result = await codexPhoto({ inputPng, outputPng, subject });
	process.stdout.write(`${JSON.stringify({ stage: "done", ...result })}\n`);
}
