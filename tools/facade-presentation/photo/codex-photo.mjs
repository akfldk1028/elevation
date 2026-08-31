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

export function buildCodexPrompt(inputPng, subject) {
	return [
		`Read the render at ${resolve(inputPng).replace(/\\/g, "/")} and generate a photorealistic`,
		"architectural photograph of the same building. Keep the same massing, window grid,",
		"construction, entrance block - change only surface realism, lighting nuance and context.",
		`Subject: ${subject}.`,
		`If no image generation tool is available, print exactly ${NO_IMAGE_TOOL} and stop.`,
	].join(" ");
}

export function buildCodexCommand(prompt) {
	return { command: "codex", args: ["exec", "--skip-git-repo-check", prompt] };
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

export async function codexPhoto({ inputPng, outputPng, subject, generatedDir = defaultGeneratedImagesDir() }) {
	if (!inputPng || !outputPng || !subject) {
		throw new Error("codexPhoto requires inputPng, outputPng and subject");
	}
	const startMs = Date.now();
	const prompt = buildCodexPrompt(inputPng, subject);
	const { code, output } = await runCodex(buildCodexCommand(prompt));
	if (output.includes(NO_IMAGE_TOOL)) {
		throw new Error("codex reported no image generation tool is available (NO_IMAGE_TOOL); the photo lane needs a codex build with the image tool enabled");
	}
	if (code !== 0) {
		throw new Error(`codex exec exited with code ${code}: ${output.slice(-2000)}`);
	}
	const generated = await findNewestPng(generatedDir, startMs);
	if (!generated) {
		throw new Error(`codex exec finished but no new PNG appeared under ${generatedDir}; output tail: ${output.slice(-2000)}`);
	}
	await mkdir(dirname(resolve(outputPng)), { recursive: true });
	await copyFile(generated, resolve(outputPng));
	return { source: generated, output: resolve(outputPng) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [inputPng, outputPng, subject] = process.argv.slice(2);
	if (!inputPng || !outputPng || !subject) {
		throw new Error('usage: node codex-photo.mjs <input-png> <output-png> "<subject>"');
	}
	const result = await codexPhoto({ inputPng, outputPng, subject });
	process.stdout.write(`${JSON.stringify({ stage: "done", ...result })}\n`);
}
