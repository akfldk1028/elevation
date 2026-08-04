export function chooseTextureCompression({ ktx2Encoder } = {}) {
	if (ktx2Encoder) return { mode: "ktx2", mimeTypes: ["image/ktx2"] };
	return { mode: "portable-fallback", mimeTypes: ["image/png", "image/webp"] };
}
