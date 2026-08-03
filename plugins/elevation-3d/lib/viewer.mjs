import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildViewerBundle({ runDir, config }) {
	const dir = join(runDir, "viewer");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2));
	await writeFile(join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Elevation 3D</title><style>html,body{margin:0;background:#171717;color:#eee;font:14px system-ui}main{display:grid;place-items:center;min-height:100vh}canvas{width:min(90vw,90vh);height:min(90vw,90vh);background:#f7f7f5}aside{position:fixed;left:16px;top:16px;background:#111c;padding:10px 12px;border-radius:6px}</style></head><body><aside data-status>loading</aside><main><canvas width="2048" height="2048"></canvas></main><script type="module" src="app.js"></script></body></html>`);
	await build({ entryPoints: [join(here, "..", "web", "viewer-app.mjs")], outfile: join(dir, "app.js"), bundle: true, format: "esm", platform: "browser", minify: true, sourcemap: false });
	return dir;
}
