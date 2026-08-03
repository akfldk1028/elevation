import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const servers = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".obj": "text/plain; charset=utf-8" };

export async function startPreview(runDir, port = 4173) {
	const root = resolve(runDir);
	await stat(root);
	if (servers.has(port)) return `http://127.0.0.1:${port}/`;
	const server = createServer(async (request, response) => {
		try {
			const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname).replace(/^\/+/, "") || "viewer/index.html";
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
	return `http://127.0.0.1:${port}/`;
}
