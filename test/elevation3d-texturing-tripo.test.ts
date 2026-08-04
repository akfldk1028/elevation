import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { parseEnvText, parseTripoCliArgs } from "../scripts/test-tripo-pbr-texturing.mjs";

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
			if (url.endsWith("/upload")) return jsonResponse({ code: 0, data: { image_token: "image-token-1" } });
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
		assert.deepEqual(styleImage, { type: "jpg", file_token: "image-token-1" });
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
				texture_prompt: { image: styleImage },
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
	const providerError = createTripoProvider({ apiKey, baseUrl, fetchImpl: async () => jsonResponse({
		code: 2002,
		message: `bad ${apiKey}`,
		suggestion: `replace Bearer ${apiKey}`,
	}, 400) });
	await assert.rejects(() => providerError.getBalance(), (error: any) => {
		assert.equal(error.code, "TRIPO_API_ERROR");
		assert.equal(error.message.includes(apiKey), false);
		assert.equal(error.details.suggestion.includes(apiKey), false);
		assert.match(error.details.suggestion, /REDACTED/);
		return true;
	});
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

test("independent paid ledgers reserve one submission and the loser resumes its persisted task", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-ledger-race-"));
	try {
		const path = join(directory, "ledger.json"), key = "d".repeat(64);
		let submissions = 0, release!: () => void;
		const submitted = new Promise<void>((resolve) => { release = resolve; });
		const submit = async () => { submissions++; await submitted; return "race-task-1"; };
		const first = createPaidTaskLedger(path, { lockWaitMs: 2_000, lockPollMs: 5 });
		const second = createPaidTaskLedger(path, { lockWaitMs: 2_000, lockPollMs: 5 });
		const resultsPromise = Promise.all([
			first.getOrSubmitTask({ key, kind: "texture", submit }),
			second.getOrSubmitTask({ key, kind: "texture", submit }),
		]);
		const deadline = Date.now() + 2_000;
		while (submissions === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(submissions, 1, "only the filesystem reservation owner may call the paid provider");
		release();
		assert.deepEqual(await resultsPromise, ["race-task-1", "race-task-1"]);
		assert.equal(submissions, 1);
		assert.equal((await readFile(path, "utf8")).includes(apiKey), false);
		assert.equal((await readFile(`${path}.lock`, "utf8").catch(() => "")).includes(apiKey), false);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("paid ledger reservation is abortable and recovers a stale lock only after its PID is dead", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-ledger-locks-"));
	try {
		const path = join(directory, "ledger.json"), lockPath = `${path}.lock`, key = "e".repeat(64);
		await writeFile(lockPath, JSON.stringify({ version: 1, token: "live-owner", pid: process.pid, created_at: new Date().toISOString() }));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(() => createPaidTaskLedger(path, { lockWaitMs: 2_000, lockPollMs: 5 }).getOrSubmitTask({
			key, kind: "import", signal: controller.signal, submit: async () => "must-not-submit",
		}), { name: "AbortError" });
		await writeFile(lockPath, JSON.stringify({ version: 1, token: "dead-owner", pid: 2_147_483_647, created_at: new Date(0).toISOString() }));
		assert.equal(await createPaidTaskLedger(path).getOrSubmitTask({ key, kind: "import", submit: async () => "recovered-task" }), "recovered-task");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("two Node processes sharing one ledger execute exactly one paid callback", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-ledger-process-race-"));
	try {
		const path = join(directory, "ledger.json"), marker = join(directory, "paid-callbacks.txt");
		const moduleUrl = new URL("../plugins/elevation-3d/lib/texturing/paid-task-ledger.mjs", import.meta.url).href;
		const source = `
			import { appendFile } from "node:fs/promises";
			import { setTimeout as delay } from "node:timers/promises";
			import { createPaidTaskLedger } from ${JSON.stringify(moduleUrl)};
			const task = await createPaidTaskLedger(process.argv[1], { lockWaitMs: 5000, lockPollMs: 5 }).getOrSubmitTask({
				key: "${"f".repeat(64)}", kind: "texture", submit: async () => {
					await appendFile(process.argv[2], process.pid + "\\n"); await delay(150); return "process-race-task";
				},
			});
			process.stdout.write(task);
		`;
		const run = () => new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", source, path, marker], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`child ${code}: ${stderr}`)));
		});
		assert.deepEqual(await Promise.all([run(), run()]), ["process-race-task", "process-race-task"]);
		assert.equal((await readFile(marker, "utf8")).trim().split(/\r?\n/).length, 1);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("paid task ledger fails closed after a crash in the submission uncertainty window", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tripo-ledger-uncertain-"));
	try {
		const path = join(directory, "ledger.json"), key = "a".repeat(64);
		await writeFile(path, JSON.stringify({ version: 1, requests: { [key]: { tasks: { texture: { status: "submitting", taskId: null, consumedCredits: null } } } } }));
		let submissions = 0;
		await assert.rejects(() => createPaidTaskLedger(path).getOrSubmitTask({ key, kind: "texture", submit: async () => { submissions++; return "duplicate"; } }), (error: any) => error.code === "PAID_TASK_SUBMISSION_UNCERTAIN");
		assert.equal(submissions, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("provider router rejects unconfigured names and creates the Tripo boundary", () => {
	assert.equal(createTexturingProvider("tripo", { apiKey, baseUrl }).name, "tripo");
	assert.throws(() => createTexturingProvider("unknown", { apiKey }), /Unsupported texturing provider/);
});

test("Tripo live harness parses explicit spend gates and rejects unknown arguments", () => {
	assert.deepEqual(parseTripoCliArgs([
		"--accepted-glb", "accepted.glb",
		"--reference-image", "reference.png",
		"--result-dir", "result",
		"--run-root", "runs",
		"--max-credits", "15",
		"--seed", "13013",
		"--confirm-live",
	]), {
		acceptedGlb: "accepted.glb",
		referenceImage: "reference.png",
		resultDir: "result",
		runRoot: "runs",
		maxCredits: 15,
		seed: 13013,
		confirmLive: true,
		dryRun: false,
	});
	assert.throws(() => parseTripoCliArgs(["--unknown"]), /Unknown argument/);
});

test("Tripo live harness reads dotenv syntax without evaluating or overwriting values", () => {
	assert.deepEqual(parseEnvText("# local only\nTRIPO_API_KEY='secret value'\nELEVATION3D_LIVE_TRIPO=1\nEMPTY=\n"), {
		TRIPO_API_KEY: "secret value",
		ELEVATION3D_LIVE_TRIPO: "1",
		EMPTY: "",
	});
});
