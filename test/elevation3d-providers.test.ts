import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildHunyuanRequest, createHunyuanProvider, normalizeHunyuanStatus } from "../plugins/elevation-3d/lib/providers/hunyuan.mjs";
import { buildWanRequest, normalizeWanStatus } from "../plugins/elevation-3d/lib/providers/wan.mjs";
import { createStabilityProvider } from "../plugins/elevation-3d/lib/providers/stability.mjs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

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

	test("preserves submit and normalized status behavior through the JSON client", async () => {
		const seenActions = [];
		const provider = await createHunyuanProvider({
			TENCENTCLOUD_SECRET_ID: "AKIDEXAMPLE",
			TENCENTCLOUD_SECRET_KEY: "SECRETKEYEXAMPLE",
			TENCENT_COS_BUCKET: "test-bucket",
		}, {
			now: () => new Date("2019-02-25T16:44:25.000Z"),
			fetchImpl: async (_url, init) => {
				const action = init.headers["X-TC-Action"];
				seenActions.push(action);
				if (action === "SubmitTextureTo3DJob") {
					return Response.json({ Response: { JobId: "h-1", RequestId: "submit-request" } });
				}
				return Response.json({ Response: {
					JobId: "h-1",
					Status: "DONE",
					ResultFile3Ds: [{ Type: "GLB", Url: "https://result.test/model.glb" }],
					RequestId: "describe-request",
				} });
			},
		});

		assert.deepEqual(await provider.submit({ Model: "3.1" }), { JobId: "h-1", RequestId: "submit-request" });
		assert.deepEqual(await provider.status("h-1"), { status: "succeeded", files: [{ type: "GLB", url: "https://result.test/model.glb" }] });
		assert.deepEqual(seenActions, ["SubmitTextureTo3DJob", "DescribeTextureTo3DJob"]);
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

describe("Stability SPAR3D provider contract", () => {
	test("writes a successful binary GLB response without exposing the API key", async () => {
		const dir = await mkdtemp(join(tmpdir(), "spar3d-provider-"));
		const image = join(dir, "input.png");
		const output = join(dir, "output.glb");
		await sharp({ create: { width: 640, height: 640, channels: 3, background: "white" } }).png().toFile(image);
		const provider = createStabilityProvider({ STABILITY_API_KEY: "sk-secret-test" }, async (_url, request) => {
			assert.equal(request.method, "POST");
			assert.equal(request.headers.authorization, "Bearer sk-secret-test");
			return new Response(Buffer.from("glTFbinary"), { status: 200, headers: { "content-type": "model/gltf-binary" } });
		});
		const result = await provider.generate({ imagePath: image, outputPath: output, textureResolution: 512, targetType: "face", targetCount: 1000, seed: 7 });
		assert.deepEqual(await readFile(output), Buffer.from("glTFbinary"));
		assert.deepEqual(result, { outputPath: output, bytes: 10, credits: 4 });
	});

	test("rejects a successful response that is not a GLB", async () => {
		const dir = await mkdtemp(join(tmpdir(), "spar3d-provider-"));
		const image = join(dir, "input.png");
		await sharp({ create: { width: 640, height: 640, channels: 3, background: "white" } }).png().toFile(image);
		const provider = createStabilityProvider({ STABILITY_API_KEY: "sk-secret-test" }, async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
		await assert.rejects(() => provider.generate({ imagePath: image, outputPath: join(dir, "output.glb") }), /expected GLB/);
	});

	test("rejects images smaller than the live endpoint minimum before submission", async () => {
		const dir = await mkdtemp(join(tmpdir(), "spar3d-provider-"));
		const image = join(dir, "small.png");
		await sharp({ create: { width: 512, height: 512, channels: 3, background: "white" } }).png().toFile(image);
		const provider = createStabilityProvider({ STABILITY_API_KEY: "sk-secret-test" }, async () => { throw new Error("network must not be called"); });
		await assert.rejects(() => provider.generate({ imagePath: image, outputPath: join(dir, "output.glb") }), /at least 640x640/);
	});
});
