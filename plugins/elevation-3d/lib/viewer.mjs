import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { atomicWrite, prepareSafeDirectory } from "./facade-agent/path-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildViewerBundle({ runDir, config }) {
	const dir = join(runDir, "viewer");
	await prepareSafeDirectory(runDir, dir, "viewer directory");
	await atomicWrite(join(dir, "config.json"), Buffer.from(JSON.stringify(config, null, 2)), runDir);
	await atomicWrite(join(dir, "index.html"), await readFile(join(here, "..", "web", "viewer.html")), runDir);
	const bundled = await build({ entryPoints: [join(here, "..", "web", "viewer-app.mjs")], bundle: true, write: false, format: "esm", platform: "browser", minify: true, sourcemap: false });
	if (bundled.outputFiles?.length !== 1) throw new Error("viewer bundle must emit exactly one application artifact");
	await atomicWrite(join(dir, "app.js"), bundled.outputFiles[0].contents, runDir);
	return dir;
}
