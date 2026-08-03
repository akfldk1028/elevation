import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildHunyuanRequest, normalizeHunyuanStatus } from "../plugins/elevation-3d/lib/providers/hunyuan.mjs";
import { buildWanRequest, normalizeWanStatus } from "../plugins/elevation-3d/lib/providers/wan.mjs";

describe("Hunyuan provider contract", () => {
	test("builds a prompt-only 3.1 texture request for the UV-less source", () => {
		const request = buildHunyuanRequest({ fileUrl: "https://cos.test/mass.obj?signature=secret", prompt: "现代建筑", plan: { providers: { hunyuan: { model: "3.1", texture_size: 2048, enable_pbr: true, enable_keep_uv: false } } } });
		assert.deepEqual(request, {
			File3D: { Type: "OBJ", Url: "https://cos.test/mass.obj?signature=secret" },
			Model: "3.1",
			Prompt: "现代建筑",
			EnablePBR: true,
			EnableKeepUV: false,
			TextureSize: 2048,
		});
		assert.equal("Image" in request, false);
		assert.equal("MultiViewImages" in request, false);
	});

	test("normalizes DONE files and FAIL errors", () => {
		assert.deepEqual(normalizeHunyuanStatus({ Status: "DONE", ResultFile3Ds: [{ Type: "GLB", Url: "https://x/a.glb?sig=x" }] }), { status: "succeeded", files: [{ type: "GLB", url: "https://x/a.glb?sig=x" }] });
		assert.deepEqual(normalizeHunyuanStatus({ Status: "FAIL", ErrorCode: "Bad", ErrorMessage: "no" }), { status: "failed", code: "Bad", message: "no", files: [] });
	});
});

describe("Wan provider contract", () => {
	test("builds one asynchronous five-view image-set request", () => {
		const images = Array.from({ length: 7 }, (_, i) => `data:image/png;base64,image-${i}`);
		const request = buildWanRequest({ images, prompt: "same building", plan: { providers: { wan: { model: "wan2.7-image-pro", size: "2K", n: 5, enable_sequential: true, watermark: false } } } });
		assert.equal(request.model, "wan2.7-image-pro");
		assert.deepEqual(request.input.messages[0].content.slice(0, 7), images.map((image) => ({ image })));
		assert.deepEqual(request.input.messages[0].content[7], { text: "same building" });
		assert.deepEqual(request.parameters, { size: "2K", n: 5, enable_sequential: true, watermark: false });
	});

	test("normalizes asynchronous success content", () => {
		const response = { output: { task_status: "SUCCEEDED", choices: [{ message: { content: [{ type: "image", image: "https://x/1.png" }, { type: "image", image: "https://x/2.png" }] } }] } };
		assert.deepEqual(normalizeWanStatus(response), { status: "succeeded", task_id: undefined, images: ["https://x/1.png", "https://x/2.png"] });
	});
});
