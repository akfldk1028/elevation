import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets } from "../core.mjs";
import { assertTexturingRequest, TexturingError } from "./contract.mjs";
import { createPaidTaskLedger, texturingRequestKey } from "./paid-task-ledger.mjs";
import { rebuildTexturedGlb } from "./pbr-embedder.mjs";
import { createTexturingProvider } from "./provider-router.mjs";
import { prepareProviderUv } from "./uv-preparation.mjs";

async function sha256File(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function atomicJson(path, value) {
	const safe = redactSecrets(value);
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function containedBy(root, target) {
	const relation = relative(root, target);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function taskHash(taskId) {
	return createHash("sha256").update(taskId).digest("hex");
}

function consumedCredits(task) {
	const value = task?.consumed_credit ?? task?.output?.consumed_credit ?? 0;
	return Number.isFinite(value) ? value : 0;
}

function failureStatus(error) {
	if (error?.name === "AbortError") return "cancelled";
	if (error?.code === "PROVIDER_MATERIAL_INVALID") {
		const reasons = error.details?.reasons ?? [];
		const reviewable = new Set(["TEXTURE_RESOLUTION_TOO_LOW", "REQUIRED_PBR_CHANNEL_MISSING"]);
		if (reasons.length > 0 && reasons.every((reason) => reviewable.has(reason))) return "review";
	}
	return "rejected";
}

export async function deliverTexturedGlb(options) {
	const {
		acceptedGlb,
		referenceImage,
		resultDir,
		runRoot = resultDir,
		proceduralDelivery = null,
		provider = "tripo",
		providerOptions = {},
		confirmLive = false,
		maxCredits = 15,
		seed = 13013,
		dryRun = false,
		signal,
		env = process.env,
		dependencies = {},
	} = options ?? {};
	const providerName = typeof provider === "string" ? provider : provider?.name;
	assertTexturingRequest({
		acceptedGlb,
		referenceImage,
		resultDir,
		provider: providerName,
		textureQuality: "standard",
		seed,
		maxCredits,
	});
	const outputRoot = resolve(runRoot);
	const outputDirectory = resolve(resultDir);
	if (!containedBy(outputRoot, outputDirectory)) throw new TexturingError("RESULT_PATH_ESCAPE", "Texturing result directory must stay inside the run root");
	if (!dryRun && (confirmLive !== true || env.ELEVATION3D_LIVE_TRIPO !== "1")) {
		throw new TexturingError("LIVE_APPROVAL_REQUIRED", "Paid Tripo execution requires confirmLive and ELEVATION3D_LIVE_TRIPO=1");
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
	await Promise.all([readFile(resolve(acceptedGlb)), readFile(resolve(referenceImage))]);
	await mkdir(outputDirectory, { recursive: true });
	const providerDirectory = join(outputDirectory, "provider");
	const finalDirectory = join(outputDirectory, "final");
	await Promise.all([mkdir(providerDirectory, { recursive: true }), mkdir(finalDirectory, { recursive: true })]);
	const acceptedGlbHash = await sha256File(resolve(acceptedGlb));
	const referenceImageHash = await sha256File(resolve(referenceImage));
	const request = {
		provider: providerName,
		modelVersion: "v3.0-20250812",
		textureQuality: "standard",
		textureAlignment: "geometry",
		pbr: true,
		bake: true,
		seed,
		maxCredits,
		acceptedGlbHash,
		referenceImageHash,
	};
	await atomicJson(join(outputDirectory, "request.json"), request);
	let state = { state: "idle", provider: providerName, dryRun, requestHash: texturingRequestKey(request) };
	const setState = async (patch) => {
		state = { ...state, ...patch };
		await atomicJson(join(outputDirectory, "state.json"), state);
	};
	await setState({ state: "idle" });
	const providerClient = typeof provider === "string"
		? (dependencies.createTexturingProvider ?? createTexturingProvider)(provider, providerOptions)
		: provider;
	const prepare = dependencies.prepareProviderUv ?? prepareProviderUv;
	const rebuild = dependencies.rebuildTexturedGlb ?? rebuildTexturedGlb;
	const ledgerFactory = dependencies.createPaidTaskLedger ?? createPaidTaskLedger;
	let activeTaskId = null;
	try {
		const balance = await providerClient.getBalance({ signal });
		await setState({ balance: balance.balance, frozen: balance.frozen });
		if (balance.balance < maxCredits) throw new TexturingError("INSUFFICIENT_TRIPO_BALANCE", `Tripo balance ${balance.balance} is below the approved cap ${maxCredits}`);
		const preparedGlb = join(providerDirectory, "prepared.glb");
		const preparation = await prepare({ inputGlb: acceptedGlb, outputGlb: preparedGlb, signal });
		await setState({ state: "prepared", preparedGlbHash: preparation.outputSha256, uvCoverage: preparation.uvCoverage });
		if (dryRun) {
			await setState({ state: "dry-run" });
			return { status: "dry-run", request, balance, preparation, proceduralDelivery };
		}

		const key = texturingRequestKey({
			provider: providerName,
			acceptedGlbHash,
			preparedGlbHash: preparation.outputSha256,
			referenceImageHash,
			request,
		});
		const ledger = ledgerFactory(join(outputDirectory, "ledger.json"));
		const modelFile = await providerClient.uploadModel({ path: preparedGlb, signal });
		const styleImage = await providerClient.uploadImage({ path: referenceImage, signal });
		const importTaskId = await ledger.getOrSubmitTask({
			key,
			kind: "import",
			signal,
			submit: () => providerClient.submitImport({ file: modelFile, signal }),
		});
		activeTaskId = importTaskId;
		await setState({ state: "import_submitted", importTaskHash: taskHash(importTaskId) });
		const importTask = await providerClient.pollTask(importTaskId, { signal });
		await ledger.recordStatus({ key, kind: "import", status: importTask.status, consumedCredits: consumedCredits(importTask), signal });
		await setState({ state: "import_ready", importCredits: consumedCredits(importTask) });

		const textureTaskId = await ledger.getOrSubmitTask({
			key,
			kind: "texture",
			signal,
			submit: () => providerClient.submitTexture({ importTaskId, styleImage, seed, signal }),
		});
		activeTaskId = textureTaskId;
		await setState({ state: "texture_submitted", textureTaskHash: taskHash(textureTaskId) });
		const textureTask = await providerClient.pollTask(textureTaskId, { signal });
		await ledger.recordStatus({ key, kind: "texture", status: textureTask.status, consumedCredits: consumedCredits(textureTask), signal });
		await setState({ state: "texture_ready", textureCredits: consumedCredits(textureTask) });

		const providerGlb = join(providerDirectory, "provider-textured.glb");
		const download = await providerClient.downloadResult({ task: textureTask, outputPath: providerGlb, signal });
		await setState({ state: "downloaded", providerGlbHash: download.sha256, providerBytes: download.bytes });
		const rebuilt = await rebuild({
			authoritativeGlb: acceptedGlb,
			preparedUvGlb: preparedGlb,
			providerGlb,
			outputGlb: join(finalDirectory, "textured.glb"),
			signal,
		});
		await Promise.all([
			atomicJson(join(outputDirectory, "geometry-report.json"), rebuilt.geometry),
			atomicJson(join(outputDirectory, "material-report.json"), rebuilt.material),
			atomicJson(join(outputDirectory, "transfer-report.json"), rebuilt.transfer),
		]);
		const actualCredits = consumedCredits(importTask) + consumedCredits(textureTask);
		const deliveryStatus = [rebuilt.material?.status, rebuilt.transfer?.status].includes("review") ? "review" : "accepted";
		const manifest = {
			status: deliveryStatus,
			provider: providerName,
			requestHash: state.requestHash,
			outputGlb: rebuilt.outputGlb,
			outputSha256: rebuilt.outputSha256,
			compression: rebuilt.compression,
			actualCredits,
			maxCredits,
			proceduralDelivery,
		};
		await atomicJson(join(outputDirectory, "manifest.json"), manifest);
		await setState({ state: deliveryStatus, actualCredits, outputSha256: rebuilt.outputSha256 });
		return { status: deliveryStatus, ...manifest, preparation, download, geometry: rebuilt.geometry, material: rebuilt.material, transfer: rebuilt.transfer };
	} catch (error) {
		const status = failureStatus(error);
		if (status === "cancelled" && activeTaskId) {
			try { await providerClient.cancelTask(activeTaskId); } catch { /* v2 has no documented remote cancellation endpoint. */ }
		}
		const failure = redactSecrets({
			code: error?.code ?? (status === "cancelled" ? "CANCELLED" : "TEXTURING_FAILED"),
			message: error?.message ?? String(error),
			details: error?.details,
		});
		await atomicJson(join(outputDirectory, "failure.json"), failure);
		await atomicJson(join(outputDirectory, "manifest.json"), {
			status,
			provider: providerName,
			requestHash: state.requestHash,
			outputGlb: null,
			outputSha256: null,
			actualCredits: (state.importCredits ?? 0) + (state.textureCredits ?? 0),
			maxCredits,
			proceduralDelivery,
			failure,
		});
		await setState({ state: status, failure });
		return { status, failure, proceduralDelivery, resultDir: outputDirectory };
	}
}
