/**
 * Node host for the showcase renderer: bundles the browser app with esbuild,
 * serves it through the elevation-3d preview server, drives headless Chrome
 * via puppeteer and screenshots one 1920x1080 PNG.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { build } from "esbuild";

import { findChrome } from "../../../plugins/elevation-3d/lib/results.mjs";
import { startPreview, stopPreview } from "../../../plugins/elevation-3d/lib/preview.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const INDEX_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>showcase</title>
<style>html,body{margin:0;padding:0;overflow:hidden;background:#000}canvas{display:block}</style>
</head><body><script type="module" src="app.js"></script></body></html>
`;

export async function runShowcase({ glbPath, outPngPath, axes, face }) {
	const workDir = await mkdtemp(join(tmpdir(), "facade-showcase-"));
	let browser, previewPort;
	const consoleErrors = [];
	try {
		await mkdir(join(workDir, "viewer"), { recursive: true });
		await copyFile(resolve(glbPath), join(workDir, "model.glb"));
		await writeFile(join(workDir, "viewer", "index.html"), INDEX_HTML);
		const bundled = await build({
			entryPoints: [join(here, "browser", "app.mjs")],
			bundle: true, write: false, format: "esm", platform: "browser", minify: false, sourcemap: false,
			nodePaths: [join(repoRoot, "node_modules")],
			define: {
				__SHOWCASE_AXES__: JSON.stringify(axes),
				__SHOWCASE_FACE__: JSON.stringify(face ?? "auto"),
			},
		});
		if (bundled.outputFiles?.length !== 1) throw new Error("showcase bundle must emit exactly one artifact");
		await writeFile(join(workDir, "viewer", "app.js"), bundled.outputFiles[0].contents);

		const base = await startPreview(workDir, 0);
		previewPort = Number(new URL(base).port);
		browser = await puppeteer.launch({
			executablePath: await findChrome(), headless: true,
			args: ["--disable-gpu-sandbox", "--no-sandbox", "--use-angle=swiftshader"],
		});
		const page = await browser.newPage();
		page.on("pageerror", (error) => consoleErrors.push(error.message));
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
		await page.goto(base, { waitUntil: "networkidle0" });
		try {
			await page.waitForFunction(
				() => globalThis.__SHOWCASE_READY__ === true || globalThis.__SHOWCASE_ERROR__ !== undefined,
				{ timeout: 180_000 },
			);
		} catch (cause) {
			throw new Error(`showcase render timed out; console: ${consoleErrors.join("; ") || "none"}`, { cause });
		}
		const pageError = await page.evaluate(() => globalThis.__SHOWCASE_ERROR__);
		if (pageError) throw new Error(`showcase render failed in browser: ${pageError}`);
		await mkdir(dirname(resolve(outPngPath)), { recursive: true });
		await page.screenshot({ path: resolve(outPngPath), type: "png" });
		process.stdout.write(`${JSON.stringify({ stage: "done", out: resolve(outPngPath), console_errors: consoleErrors })}\n`);
	} finally {
		await browser?.close().catch(() => {});
		if (previewPort) await stopPreview(previewPort).catch(() => {});
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}
