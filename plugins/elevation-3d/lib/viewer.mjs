import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildViewerBundle({ runDir, config }) {
	const dir = join(runDir, "viewer");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2));
	await writeFile(join(dir, "index.html"), await readFile(join(here, "..", "web", "viewer.html")));
	await build({ entryPoints: [join(here, "..", "web", "viewer-app.mjs")], outfile: join(dir, "app.js"), bundle: true, format: "esm", platform: "browser", minify: true, sourcemap: false });
	return dir;
}
