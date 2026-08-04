import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TexturingError } from "../plugins/elevation-3d/lib/texturing/contract.mjs";
import { deliverTexturedGlb } from "../plugins/elevation-3d/lib/texturing/delivery.mjs";

async function fixture() {
	const runRoot = await mkdtemp(join(tmpdir(), "texturing-delivery-"));
	const acceptedGlb = join(runRoot, "accepted.glb");
	const referenceImage = join(runRoot, "reference.png");
	await writeFile(acceptedGlb, Buffer.from("glTF-authoritative"));
	await writeFile(referenceImage, Buffer.from("png-reference"));
	return { runRoot, acceptedGlb, referenceImage, resultDir: join(runRoot, "texturing"), proceduralDelivery: join(runRoot, "procedural") };
}

function dependencies(overrides: Record<string, unknown> = {}) {
	return {
		prepareProviderUv: async ({ inputGlb, outputGlb }: any) => {
			await cp(inputGlb, outputGlb);
			return { outputGlb, outputSha256: "prepared-hash", uvCoverage: 1, surfaceComparison: { accepted: true, reasons: [] } };
		},
		rebuildTexturedGlb: async ({ outputGlb }: any) => {
			await writeFile(outputGlb, Buffer.from("glTF-textured"));
			return { outputGlb, outputSha256: "final-hash", geometry: { accepted: true }, material: { accepted: true }, compression: "portable-fallback" };
		},
		...overrides,
	};
}

function fakeProvider(overrides: Record<string, unknown> = {}) {
	const counts = { balance: 0, uploadModel: 0, uploadImage: 0, import: 0, texture: 0, poll: 0, download: 0 };
	const provider = {
		name: "tripo",
		counts,
		getBalance: async () => { counts.balance += 1; return { balance: 100, frozen: 0 }; },
		uploadModel: async () => { counts.uploadModel += 1; return { type: "glb", object: { bucket: "bucket", key: "key" } }; },
		uploadImage: async () => { counts.uploadImage += 1; return { type: "png", file_token: "image-token" }; },
		submitImport: async () => { counts.import += 1; return "import-task-1"; },
		submitTexture: async () => { counts.texture += 1; return "texture-task-1"; },
		pollTask: async (taskId: string) => { counts.poll += 1; return {
			task_id: taskId, status: "success", output: { consumed_credit: taskId.startsWith("texture") ? 10 : 0, pbr_model: "https://cdn.example.test/model.glb?signature=secret" },
		}; },
		downloadResult: async ({ outputPath }: any) => { counts.download += 1; await writeFile(outputPath, Buffer.from("glTF-provider")); return { path: outputPath, sha256: "provider-hash", bytes: 13 }; },
		cancelTask: async () => ({ cancelled: false, remoteSupported: false }),
		...overrides,
	};
	return provider;
}

function liveOptions(input: Awaited<ReturnType<typeof fixture>>, provider: any, extra: Record<string, unknown> = {}) {
	return {
		...input,
		provider,
		confirmLive: true,
		maxCredits: 15,
		seed: 13013,
		env: { ELEVATION3D_LIVE_TRIPO: "1" },
		dependencies: dependencies(),
		...extra,
	};
}

test("delivery requires both live gates before any provider request", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider();
		await assert.rejects(() => deliverTexturedGlb({ ...liveOptions(input, provider), confirmLive: false }),
			(error: any) => error.code === "LIVE_APPROVAL_REQUIRED");
		assert.deepEqual(provider.counts, { balance: 0, uploadModel: 0, uploadImage: 0, import: 0, texture: 0, poll: 0, download: 0 });
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});

test("dry run checks balance and local inputs without uploading or submitting", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider();
		const result = await deliverTexturedGlb({ ...liveOptions(input, provider), dryRun: true, confirmLive: false, env: {} });
		assert.equal(result.status, "dry-run");
		assert.equal(provider.counts.balance, 1);
		assert.equal(provider.counts.uploadModel, 0);
		assert.equal(provider.counts.import, 0);
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});

test("delivery accepts one import and one standard texture task and resumes without duplicate submissions", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider();
		const first = await deliverTexturedGlb(liveOptions(input, provider));
		assert.equal(first.status, "accepted");
		assert.equal(first.proceduralDelivery, input.proceduralDelivery);
		assert.equal(provider.counts.import, 1);
		assert.equal(provider.counts.texture, 1);
		const resumed = await deliverTexturedGlb(liveOptions(input, provider));
		assert.equal(resumed.status, "accepted");
		assert.equal(provider.counts.import, 1);
		assert.equal(provider.counts.texture, 1);
		const manifest = JSON.parse(await readFile(join(input.resultDir, "manifest.json"), "utf8"));
		assert.equal(manifest.actualCredits, 10);
		assert.equal(manifest.outputSha256, "final-hash");
		const persisted = await readFile(join(input.resultDir, "state.json"), "utf8");
		assert.equal(persisted.includes("signature=secret"), false);
		assert.equal(persisted.includes("secret-key-value"), false);
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});

test("delivery rejects insufficient balance without a paid task and retains procedural fallback", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider({ getBalance: async () => ({ balance: 5, frozen: 0 }) });
		const result = await deliverTexturedGlb(liveOptions(input, provider));
		assert.equal(result.status, "rejected");
		assert.equal(result.failure.code, "INSUFFICIENT_TRIPO_BALANCE");
		assert.equal(result.proceduralDelivery, input.proceduralDelivery);
		assert.equal(provider.counts.import, 0);
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});

test("delivery writes a redacted rejection manifest when the provider fails", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider({
			uploadModel: async () => { throw new TexturingError("TRIPO_API_ERROR", "Authorization: Bearer secret-key-value"); },
		});
		const result = await deliverTexturedGlb(liveOptions(input, provider));
		assert.equal(result.status, "rejected");
		const manifestText = await readFile(join(input.resultDir, "manifest.json"), "utf8");
		const manifest = JSON.parse(manifestText);
		assert.equal(manifest.status, "rejected");
		assert.equal(manifest.proceduralDelivery, input.proceduralDelivery);
		assert.equal(manifestText.includes("secret-key-value"), false);
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});

test("delivery classifies material quality as review and geometry changes as rejected", async () => {
	for (const scenario of [
		{ code: "PROVIDER_MATERIAL_INVALID", details: { reasons: ["TEXTURE_RESOLUTION_TOO_LOW"] }, status: "review" },
		{ code: "PROVIDER_GEOMETRY_MISMATCH", details: { reasons: ["SURFACE_HASH_MISMATCH"] }, status: "rejected" },
	]) {
		const input = await fixture();
		try {
			const provider = fakeProvider();
			const result = await deliverTexturedGlb(liveOptions(input, provider, { dependencies: dependencies({
				rebuildTexturedGlb: async () => { throw new TexturingError(scenario.code, "validation failed", scenario.details); },
			}) }));
			assert.equal(result.status, scenario.status);
			assert.equal(result.proceduralDelivery, input.proceduralDelivery);
			assert.equal(provider.counts.import, 1);
			assert.equal(provider.counts.texture, 1);
		} finally { await rm(input.runRoot, { recursive: true, force: true }); }
	}
});

test("delivery records cancellation and rejects a result directory outside the run root", async () => {
	const input = await fixture();
	try {
		const provider = fakeProvider({ pollTask: async () => { throw new DOMException("cancelled", "AbortError"); } });
		const cancelled = await deliverTexturedGlb(liveOptions(input, provider));
		assert.equal(cancelled.status, "cancelled");
		await assert.rejects(() => deliverTexturedGlb({ ...liveOptions(input, provider), resultDir: join(input.runRoot, "..", "escape") }),
			(error: any) => error.code === "RESULT_PATH_ESCAPE");
	} finally { await rm(input.runRoot, { recursive: true, force: true }); }
});
