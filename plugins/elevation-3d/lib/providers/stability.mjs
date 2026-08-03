import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";

const ENDPOINT = "https://api.stability.ai/v2beta/3d/stable-point-aware-3d";

function isGlb(buffer) {
	return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "glTF";
}

export function createStabilityProvider(env = process.env, fetchImpl = fetch) {
	const apiKey = env.STABILITY_API_KEY?.trim();
	if (!apiKey) throw new Error("STABILITY_API_KEY is required");
	return {
		async generate({ imagePath, outputPath, textureResolution = 1024, targetType = "none", targetCount = 1000, guidanceScale = 3, seed = 0 }) {
			const image = await readFile(imagePath);
			const metadata = await sharp(image).metadata();
			if ((metadata.width ?? 0) < 640 || (metadata.height ?? 0) < 640) throw new Error("Stability SPAR3D image must be at least 640x640 pixels");
			const form = new FormData();
			form.append("image", new Blob([image], { type: "image/png" }), basename(imagePath));
			form.append("texture_resolution", String(textureResolution));
			form.append("target_type", targetType);
			form.append("target_count", String(targetCount));
			form.append("guidance_scale", String(guidanceScale));
			form.append("seed", String(seed));
			const response = await fetchImpl(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form });
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!response.ok) {
				let detail = `HTTP ${response.status}`;
				try { detail = JSON.parse(bytes.toString("utf8")).errors?.join("; ") || detail; } catch {}
				throw new Error(`Stability SPAR3D failed: ${detail}`);
			}
			if (!isGlb(bytes)) throw new Error(`Stability SPAR3D expected GLB but received ${response.headers.get("content-type") || "unknown content"}`);
			await writeFile(outputPath, bytes);
			return { outputPath, bytes: bytes.length, credits: 4 };
		},
	};
}
