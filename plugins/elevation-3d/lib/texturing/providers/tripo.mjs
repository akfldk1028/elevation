import { createHash } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { TexturingError } from "../contract.mjs";

const FINAL_STATUSES = new Set(["success", "failed", "banned", "expired", "cancelled", "unknown"]);

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(milliseconds, signal) {
	return new Promise((resolveDelay, reject) => {
		const timeout = setTimeout(finish, milliseconds);
		function finish() {
			signal?.removeEventListener("abort", abort);
			resolveDelay();
		}
		function abort() {
			clearTimeout(timeout);
			reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		}
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function redact(message, apiKey) {
	return String(message ?? "Tripo request failed")
		.replaceAll(apiKey, "[REDACTED]")
		.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(/tsk_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function fileType(path) {
	const extension = extname(path).slice(1).toLowerCase();
	if (extension === "jpg") return "jpeg";
	return extension;
}

function taskFailureCode(status) {
	return {
		failed: "TRIPO_TASK_FAILED",
		banned: "TRIPO_TASK_BANNED",
		expired: "TRIPO_TASK_EXPIRED",
		cancelled: "TRIPO_TASK_CANCELLED",
		unknown: "TRIPO_TASK_UNKNOWN",
	}[status] ?? "TRIPO_TASK_FAILED";
}

export function createTripoProvider({
	apiKey,
	baseUrl = "https://api.tripo3d.ai/v2/openapi",
	fetchImpl = fetch,
	sleep = abortableDelay,
	s3Factory = (configuration) => new S3Client(configuration),
} = {}) {
	if (typeof apiKey !== "string" || apiKey.trim() === "") throw new TexturingError("TRIPO_KEY_MISSING", "Tripo API key is required");
	const authorization = `Bearer ${apiKey}`;

	async function apiRequest(path, { method = "GET", body, signal } = {}) {
		throwIfAborted(signal);
		const headers = { Authorization: authorization };
		if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
		let response;
		try {
			response = await fetchImpl(`${baseUrl}${path}`, {
				method,
				headers,
				body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
			throw new TexturingError("TRIPO_NETWORK_ERROR", redact(error?.message, apiKey));
		}
		let payload;
		try {
			payload = await response.json();
		} catch {
			throw new TexturingError("TRIPO_INVALID_RESPONSE", `Tripo returned HTTP ${response.status} without JSON`);
		}
		if (!response.ok || payload?.code !== 0) {
			throw new TexturingError("TRIPO_API_ERROR", redact(payload?.message ?? `Tripo returned HTTP ${response.status}`, apiKey), {
				providerCode: payload?.code,
				traceId: response.headers.get("x-tripo-trace-id"),
			});
		}
		return payload.data ?? payload;
	}

	async function submitTask(body, signal) {
		const data = await apiRequest("/task", { method: "POST", body, signal });
		if (typeof data?.task_id !== "string" || data.task_id.length === 0) throw new TexturingError("TRIPO_INVALID_RESPONSE", "Tripo task response omitted task_id");
		return data.task_id;
	}

	return {
		name: "tripo",
		async getBalance({ signal } = {}) {
			const data = await apiRequest("/user/balance", { signal });
			if (!Number.isFinite(data?.balance) || !Number.isFinite(data?.frozen)) throw new TexturingError("TRIPO_INVALID_RESPONSE", "Tripo balance response is invalid");
			return { balance: data.balance, frozen: data.frozen };
		},
		async uploadModel({ path, signal }) {
			const absolutePath = resolve(path);
			const type = fileType(absolutePath);
			if (!["glb", "obj", "fbx", "stl"].includes(type)) throw new TexturingError("TRIPO_MODEL_FORMAT_NOT_ALLOWED", `Unsupported Tripo model format: ${type}`);
			const token = await apiRequest("/upload/sts/token", { method: "POST", body: { format: type }, signal });
			for (const field of ["resource_bucket", "resource_uri", "session_token", "sts_ak", "sts_sk"]) {
				if (typeof token?.[field] !== "string" || token[field].length === 0) throw new TexturingError("TRIPO_INVALID_RESPONSE", `Tripo STS response omitted ${field}`);
			}
			throwIfAborted(signal);
			const client = s3Factory({
				region: "us-west-2",
				credentials: { accessKeyId: token.sts_ak, secretAccessKey: token.sts_sk, sessionToken: token.session_token },
				useAccelerateEndpoint: true,
			});
			await client.send(new PutObjectCommand({
				Bucket: token.resource_bucket,
				Key: token.resource_uri,
				Body: await readFile(absolutePath),
				ContentType: "model/gltf-binary",
			}), { abortSignal: signal });
			return { type, object: { bucket: token.resource_bucket, key: token.resource_uri } };
		},
		async uploadImage({ path, signal }) {
			const absolutePath = resolve(path);
			const type = fileType(absolutePath);
			if (!["png", "jpeg", "webp"].includes(type)) throw new TexturingError("TRIPO_IMAGE_FORMAT_NOT_ALLOWED", `Unsupported Tripo image format: ${type}`);
			const form = new FormData();
			form.append("file", new Blob([await readFile(absolutePath)]), basename(absolutePath));
			const data = await apiRequest("/upload/sts", { method: "POST", body: form, signal });
			if (typeof data?.image_token !== "string" || data.image_token.length === 0) throw new TexturingError("TRIPO_INVALID_RESPONSE", "Tripo image upload omitted image_token");
			return { type, file_token: data.image_token };
		},
		submitImport({ file, signal }) {
			return submitTask({ type: "import_model", file }, signal);
		},
		submitTexture({ importTaskId, styleImage, seed = 13013, signal }) {
			return submitTask({
				type: "texture_model",
				original_model_task_id: importTaskId,
				model_version: "v3.0-20250812",
				texture: true,
				pbr: true,
				texture_quality: "standard",
				texture_alignment: "geometry",
				bake: true,
				texture_seed: seed,
				texture_prompt: { style_image: styleImage },
			}, signal);
		},
		async getTask(taskId, { signal } = {}) {
			const data = await apiRequest(`/task/${encodeURIComponent(taskId)}`, { signal });
			if (data?.task_id !== taskId || typeof data?.status !== "string") throw new TexturingError("TRIPO_INVALID_RESPONSE", "Tripo task response does not match the requested task");
			return data;
		},
		async pollTask(taskId, { signal, intervalMs = 2000, maxAttempts = 300 } = {}) {
			for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
				throwIfAborted(signal);
				const task = await this.getTask(taskId, { signal });
				if (task.status === "success") return task;
				if (FINAL_STATUSES.has(task.status)) throw new TexturingError(taskFailureCode(task.status), `Tripo task finalized as ${task.status}`);
				if (attempt + 1 < maxAttempts) await sleep(intervalMs, signal);
			}
			throw new TexturingError("TRIPO_TASK_TIMEOUT", `Tripo task did not finish within ${maxAttempts} polls`);
		},
		async cancelTask() {
			return { cancelled: false, remoteSupported: false };
		},
		async downloadResult({ task, outputPath, signal }) {
			const url = task?.output?.pbr_model ?? task?.output?.model;
			if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new TexturingError("TRIPO_RESULT_MISSING", "Successful Tripo task omitted an HTTPS model URL");
			throwIfAborted(signal);
			const response = await fetchImpl(url, { signal });
			if (!response.ok) throw new TexturingError("TRIPO_DOWNLOAD_FAILED", `Tripo result download returned HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			const path = resolve(outputPath);
			await mkdir(dirname(path), { recursive: true });
			const temporaryPath = `${path}.tmp-${process.pid}`;
			try {
				await writeFile(temporaryPath, bytes, { flag: "wx" });
				throwIfAborted(signal);
				await rename(temporaryPath, path);
			} finally {
				await rm(temporaryPath, { force: true });
			}
			return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
		},
	};
}
