import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createPaidTaskLedger,
	texturingRequestKey,
} from "../plugins/elevation-3d/lib/texturing/paid-task-ledger.mjs";
import { createTexturingProvider } from "../plugins/elevation-3d/lib/texturing/provider-router.mjs";
import { createTripoProvider } from "../plugins/elevation-3d/lib/texturing/providers/tripo.mjs";

const apiKey = "secret-key-value";
const baseUrl = "https://api.example.test/v2/openapi";

function jsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", "x-tripo-trace-id": "trace-public-1" },
	});
}

test("Tripo adapter maps balance, STS uploads, import, and exact standard PBR texture payloads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-adapter-"));
	try {
		const modelPath = join(directory, "prepared.glb");
		const imagePath = join(directory, "reference.png");
		await writeFile(modelPath, Buffer.from("glTF-model"));
		await writeFile(imagePath, Buffer.from("png-image"));
		const requests: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
		const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input);
			const method = init.method ?? "GET";
			const headers = new Headers(init.headers);
			let body: unknown = init.body;
			if (typeof body === "string") body = JSON.parse(body);
			requests.push({ url, method, body, authorization: headers.get("authorization") });
			if (url.endsWith("/user/balance")) return jsonResponse({ code: 0, data: { balance: 100, frozen: 0 } });
			if (url.endsWith("/upload/sts/token")) return jsonResponse({ code: 0, data: {
				s3_host: "s3.us-west-2.amazonaws.com",
				resource_bucket: "tripo-data",
				resource_uri: "inputs/prepared.glb",
				session_token: "temporary-session",
				sts_ak: "temporary-access",
				sts_sk: "temporary-secret",
			} });
			if (url.endsWith("/upload/sts")) return jsonResponse({ code: 0, data: { image_token: "image-token-1" } });
			if (url.endsWith("/task") && (body as { type?: string }).type === "import_model") {
				return jsonResponse({ code: 0, data: { task_id: "import-task-1" } });
			}
			if (url.endsWith("/task") && (body as { type?: string }).type === "texture_model") {
				return jsonResponse({ code: 0, data: { task_id: "texture-task-1" } });
			}
			throw new Error(`Unexpected request ${method} ${url}`);
		};
		const s3Calls: unknown[] = [];
		const provider = createTripoProvider({
			apiKey,
			baseUrl,
			fetchImpl,
			s3Factory: (configuration: unknown) => ({ send: async (command: unknown) => {
				s3Calls.push({ configuration, command });
				return {};
			} }),
		});
		assert.deepEqual(await provider.getBalance(), { balance: 100, frozen: 0 });
		const modelFile = await provider.uploadModel({ path: modelPath });
		const styleImage = await provider.uploadImage({ path: imagePath });
		assert.deepEqual(modelFile, { type: "glb", object: { bucket: "tripo-data", key: "inputs/prepared.glb" } });
		assert.deepEqual(styleImage, { type: "png", file_token: "image-token-1" });
		assert.equal(s3Calls.length, 1);
		assert.equal(await provider.submitImport({ file: modelFile }), "import-task-1");
		assert.equal(await provider.submitTexture({ importTaskId: "import-task-1", styleImage, seed: 13013 }), "texture-task-1");
		const taskBodies = requests.filter((request) => request.url.endsWith("/task")).map((request) => request.body);
		assert.deepEqual(taskBodies, [
			{ type: "import_model", file: modelFile },
			{
				type: "texture_model",
				original_model_task_id: "import-task-1",
				model_version: "v3.0-20250812",
				texture: true,
				pbr: true,
				texture_quality: "standard",
				texture_alignment: "geometry",
				bake: true,
				texture_seed: 13013,
				texture_prompt: { style_image: styleImage },
			},
		]);
		assert.equal(requests.every((request) => request.authorization === `Bearer ${apiKey}`), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Tripo adapter polls finalized task states and never sends credentials to a result URL", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-poll-"));
	try {
		const outputPath = join(directory, "provider.glb");
		const statuses = ["queued", "running", "success"];
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const provider = createTripoProvider({
			apiKey,
			baseUrl,
			sleep: async () => {},
			fetchImpl: async (input, init = {}) => {
				const url = String(input);
				const authorization = new Headers(init.headers).get("authorization");
				calls.push({ url, authorization });
				if (url.startsWith(`${baseUrl}/task/`)) {
					const status = statuses.shift()!;
					return jsonResponse({ code: 0, data: {
						task_id: "texture-task-1", type: "texture_model", status,
						input: {}, progress: status === "success" ? 100 : 50, create_time: 1,
						output: status === "success" ? { pbr_model: "https://cdn.example.test/result.glb", consumed_credit: 10 } : {},
					} });
				}
				if (url === "https://cdn.example.test/result.glb") return new Response(Buffer.from("glTF-result"));
				throw new Error(`Unexpected URL ${url}`);
			},
		});
		const task = await provider.pollTask("texture-task-1", { intervalMs: 0, maxAttempts: 3 });
		assert.equal(task.status, "success");
		const result = await provider.downloadResult({ task, outputPath });
		assert.equal((await readFile(outputPath)).toString(), "glTF-result");
		assert.equal(result.bytes, 11);
		assert.equal(calls.at(-1)?.authorization, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Tripo adapter rejects expired tasks, provider errors, and stops locally on cancellation", async () => {
	const expired = createTripoProvider({ apiKey, baseUrl, fetchImpl: async () => jsonResponse({ code: 0, data: {
		task_id: "task-1", type: "texture_model", status: "expired", input: {}, output: {}, progress: 0, create_time: 1,
	} }) });
	await assert.rejects(() => expired.pollTask("task-1", { intervalMs: 0 }), (error: any) => error.code === "TRIPO_TASK_EXPIRED");
	const providerError = createTripoProvider({ apiKey, baseUrl, fetchImpl: async () => jsonResponse({ code: 2002, message: `bad ${apiKey}` }, 400) });
	await assert.rejects(() => providerError.getBalance(), (error: any) => error.code === "TRIPO_API_ERROR" && !error.message.includes(apiKey));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => expired.pollTask("task-1", { signal: controller.signal }), { name: "AbortError" });
	assert.deepEqual(await expired.cancelTask("task-1"), { cancelled: false, remoteSupported: false });
});

test("Tripo polling observes cancellation while waiting between status requests", async () => {
	const provider = createTripoProvider({ apiKey, baseUrl, fetchImpl: async () => jsonResponse({ code: 0, data: {
		task_id: "task-1", type: "texture_model", status: "queued", input: {}, output: {}, progress: 0, create_time: 1,
	} }) });
	const controller = new AbortController();
	const polling = provider.pollTask("task-1", { signal: controller.signal, intervalMs: 1000 })
		.then(() => "completed", (error: Error) => error.name);
	setTimeout(() => controller.abort(), 5);
	const outcome = await Promise.race([
		polling,
		new Promise((resolve) => setTimeout(() => resolve("did-not-cancel-promptly"), 100)),
	]);
	assert.equal(outcome, "AbortError");
});

test("paid task ledger resumes a persisted task without submitting a duplicate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-ledger-"));
	try {
		const path = join(directory, "ledger.json");
		const key = texturingRequestKey({
			provider: "tripo", acceptedGlbHash: "a", preparedGlbHash: "b", referenceImageHash: "c",
			request: { texture_quality: "standard", texture_seed: 13013 },
		});
		let submissions = 0;
		const first = createPaidTaskLedger(path);
		const taskId = await first.getOrSubmitTask({ key, kind: "import", submit: async () => {
			submissions += 1;
			return "import-task-1";
		} });
		assert.equal(taskId, "import-task-1");
		const resumed = createPaidTaskLedger(path);
		assert.equal(await resumed.getOrSubmitTask({ key, kind: "import", submit: async () => {
			submissions += 1;
			return "duplicate-task";
		} }), "import-task-1");
		assert.equal(submissions, 1);
		await resumed.recordStatus({ key, kind: "import", status: "success", consumedCredits: 0 });
		const summary = await resumed.summary();
		assert.equal(summary.tasks[0].taskHash.length, 64);
		assert.equal(JSON.stringify(summary).includes("import-task-1"), false);
		assert.equal(JSON.stringify(summary).includes(apiKey), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("provider router rejects unconfigured names and creates the Tripo boundary", () => {
	assert.equal(createTexturingProvider("tripo", { apiKey, baseUrl }).name, "tripo");
	assert.throws(() => createTexturingProvider("unknown", { apiKey }), /Unsupported texturing provider/);
});
