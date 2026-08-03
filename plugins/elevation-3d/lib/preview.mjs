import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const servers = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".obj": "text/plain; charset=utf-8" };

export async function startPreview(runDir, port = 4173) {
	const root = resolve(runDir);
	await stat(root);
	if (servers.has(port)) return `http://127.0.0.1:${port}/viewer/`;
	const server = createServer(async (request, response) => {
		try {
			const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname).replace(/^\/+/, "");
			const requested = !pathname ? "viewer/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
			const path = resolve(root, normalize(requested));
			if (path !== root && !path.startsWith(root + "\\") && !path.startsWith(root + "/")) throw new Error("forbidden");
			const bytes = await readFile(path);
			response.writeHead(200, { "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
			response.end(bytes);
		} catch {
			response.writeHead(404); response.end("Not found");
		}
	});
	await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveReady); });
	servers.set(port, server);
	return `http://127.0.0.1:${port}/viewer/`;
}

export async function stopPreview(port) {
	const server = servers.get(port);
	if (!server) return;
	await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
	servers.delete(port);
}
