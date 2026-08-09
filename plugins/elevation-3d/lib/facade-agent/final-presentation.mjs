import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { sha256, stableJson } from "../core.mjs";
import { deriveDeliveryCameras } from "../final-delivery.mjs";
import { readVerifiedFacadeValidationAuthority } from "../enrichment-validation.mjs";
import { loadVerifiedProceduralBaseline, renderEmbeddedPbrViews } from "../texturing/render-validator.mjs";
import { atomicWrite, assertNoReparsePoints, containedPath } from "./harness.mjs";

const VIEW_NAMES = Object.freeze(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]);

export class FacadePresentationError extends Error {
	constructor(code, message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadePresentationError";
		this.code = code;
	}
}

function fail(code, message, cause) {
	throw new FacadePresentationError(code, message, cause);
}

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function safeContainedPath(root, path, label) {
	try { return containedPath(root, path, label); }
	catch (error) { fail("FACADE_PRESENTATION_PATH_INVALID", `${label} is unsafe`, error); }
}

async function safeNoReparsePoints(path) {
	try { await assertNoReparsePoints(path); }
	catch (error) { fail("FACADE_PRESENTATION_PATH_INVALID", "presentation path contains a link or reparse point", error); }
}

function exactViewNames(value) {
	return Object.keys(value ?? {}).sort().join("|") === [...VIEW_NAMES].sort().join("|");
}

function viewHash(view) {
	return view?.selectedGlbSha256 ?? view?.selected_glb_sha256;
}

function validationReceiptBound(receipt, validation, selectedGlbSha256) {
	const receiptValidation = receipt?.validation;
	if (!receiptValidation || typeof receiptValidation !== "object" || Array.isArray(receiptValidation)) return false;
	const allowedKeys = new Set(["accepted", "codes", "retryable", "metrics", "artifacts"]);
	if (Object.keys(receiptValidation).some((key) => !allowedKeys.has(key))) return false;
	if (Object.hasOwn(receiptValidation, "retryable") && receiptValidation.retryable !== false) return false;
	const semanticRecord = (value) => Object.fromEntries(["accepted", "codes", "metrics", "artifacts"]
		.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]));
	if (stableJson(semanticRecord(receiptValidation)) !== stableJson(semanticRecord(validation))) return false;

	const runtimeAuthority = readVerifiedFacadeValidationAuthority(validation);
	const receiptAuthority = receipt.validation_authority ?? null;
	if (Boolean(runtimeAuthority) !== Boolean(receiptAuthority)) return false;
	if (!runtimeAuthority) return true;
	return stableJson(runtimeAuthority) === stableJson(receiptAuthority)
		&& receiptAuthority.provider === receipt.provider
		&& receiptAuthority.bindings?.glb_sha256 === selectedGlbSha256
		&& stableJson(receiptAuthority.metrics) === stableJson(receiptValidation.metrics);
}

async function writeJsonAtomic(path, value, root) {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	await atomicWrite(path, bytes, root);
	return { path, sha256: sha256(bytes) };
}

async function rejectExistingOutput(path) {
	try {
		await lstat(path);
		fail("FACADE_PRESENTATION_OUTPUT_EXISTS", "final presentation output already exists");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function verifyValidationReceipt(runDir, validationReceipt, selectedGlbSha256, validation) {
	if (!validationReceipt || typeof validationReceipt.path !== "string" || !/^[a-f0-9]{64}$/i.test(validationReceipt.sha256 ?? "")) {
		fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt reference is invalid");
	}
	const requestedPath = isAbsolute(validationReceipt.path) ? validationReceipt.path : resolve(runDir, validationReceipt.path);
	const receiptPath = safeContainedPath(runDir, requestedPath, "validation receipt");
	let bytes;
	try {
		await safeNoReparsePoints(receiptPath);
		bytes = await readFile(receiptPath);
	} catch (error) {
		if (error?.code === "FACADE_PRESENTATION_PATH_INVALID") throw error;
		fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt is unavailable", error);
	}
	if (sha256(bytes) !== validationReceipt.sha256) fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt file hash does not match", undefined);
	let receipt;
	try { receipt = JSON.parse(bytes.toString("utf8")); }
	catch (error) { fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt is not valid JSON", error); }
	if (validationReceipt.receipt_sha256 && sha256(stableJson(receipt)) !== validationReceipt.receipt_sha256) {
		fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt content hash does not match");
	}
	if (receipt?.schema_version !== "arr.elevation3d.facade-validation-receipt.v1"
		|| receipt?.artifact_sha256 !== selectedGlbSha256
		|| receipt?.validation?.accepted !== true
		|| !validationReceiptBound(receipt, validation, selectedGlbSha256)) {
		fail("FACADE_PRESENTATION_VALIDATION_RECEIPT_INVALID", "validation receipt is not bound to the accepted validation and GLB");
	}
	return { path: validationReceipt.path, sha256: validationReceipt.sha256, ...(validationReceipt.receipt_sha256 ? { receipt_sha256: validationReceipt.receipt_sha256 } : {}) };
}

function validateRender(render, selectedGlbSha256) {
	if (render?.validation?.accepted !== true) fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render validation was rejected");
	if (render.provider_calls !== 0 || render.credits_consumed !== 0) fail("FACADE_PRESENTATION_REMOTE_ACTIVITY", "final presentation renderer reported remote activity");
	if (!exactViewNames(render.views)) fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render must contain exactly eight named views");
	if (render.selected_glb?.sha256 !== selectedGlbSha256
		|| VIEW_NAMES.some((name) => viewHash(render.views[name]) !== selectedGlbSha256)) {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render is not bound to the selected GLB");
	}
}

export async function deliverFacadeFinalPresentation({
	runDir, presentationRoot, candidateId, artifact, validation, validationReceipt, technicalDelivery,
	input, signal, lifecycle, deps = {},
} = {}) {
	throwIfAborted(signal);
	const absoluteRunDir = resolve(runDir);
	const root = safeContainedPath(absoluteRunDir, presentationRoot, "presentation root");
	await safeNoReparsePoints(absoluteRunDir);
	await safeNoReparsePoints(root);

	const glbPath = resolve(artifact.path);
	await safeNoReparsePoints(glbPath);
	const glbBytes = await readFile(glbPath);
	const selectedGlbSha256 = sha256(glbBytes);
	if (selectedGlbSha256 !== artifact.sha256) fail("FACADE_PRESENTATION_GLB_HASH_MISMATCH", "selected GLB hash does not match the artifact authority");
	if (validation?.accepted !== true) fail("FACADE_PRESENTATION_VALIDATION_REQUIRED", "accepted facade validation is required");
	const receipt = await verifyValidationReceipt(absoluteRunDir, validationReceipt, selectedGlbSha256, validation);
	if (technicalDelivery?.manifest?.selected_glb?.sha256 !== selectedGlbSha256) {
		fail("FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", "technical delivery is bound to a different selected GLB");
	}
	let proceduralBaseline;
	try {
		if (typeof technicalDelivery?.run_dir !== "string") {
			fail("FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", "technical delivery root is unavailable");
		}
		const requestedTechnicalRoot = isAbsolute(technicalDelivery.run_dir)
			? technicalDelivery.run_dir : resolve(absoluteRunDir, technicalDelivery.run_dir);
		const technicalRoot = safeContainedPath(absoluteRunDir, requestedTechnicalRoot, "technical delivery root");
		await safeNoReparsePoints(technicalRoot);
		proceduralBaseline = await loadVerifiedProceduralBaseline({
			runDir: technicalRoot,
			manifestRecord: technicalDelivery.memory_record?.manifest,
			selectedGlbSha256,
		});
	} catch (error) {
		if (error?.code === "FACADE_PRESENTATION_PATH_INVALID") throw error;
		if (error?.code === "PROCEDURAL_BASELINE_PATH_INVALID") {
			fail("FACADE_PRESENTATION_PATH_INVALID", "technical delivery baseline path is unsafe", error);
		}
		if (error?.code === "FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH") throw error;
		fail("FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", "durable technical delivery baseline is invalid", error);
	}
	const manifestPath = join(root, "final-presentation.json");
	await safeNoReparsePoints(manifestPath);
	await rejectExistingOutput(manifestPath);
	const cameras = deriveDeliveryCameras(input);
	throwIfAborted(signal);

	let render;
	try {
		render = await (deps.renderEmbeddedPbrViews ?? renderEmbeddedPbrViews)({
			glbPath: artifact.path,
			runDir: root,
			candidateId,
			cameras,
			proceduralBaseline,
			renderStyleId: "competition-daylight-v1",
			canonicalSelection: {
				candidate_id: candidateId,
				selected_glb_sha256: selectedGlbSha256,
				facade_validation_receipt_sha256: validationReceipt.sha256,
			},
			signal,
			lifecycle,
		});
	} catch (error) {
		if (signal?.aborted || error?.name === "AbortError") throw signal?.reason ?? error;
		if (error?.code === "FACADE_PRESENTATION_RENDER_REJECTED" || error?.code === "FACADE_PRESENTATION_REMOTE_ACTIVITY") throw error;
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR renderer failed", error);
	}
	throwIfAborted(signal);
	await safeNoReparsePoints(root);
	await safeNoReparsePoints(glbPath);
	if (sha256(await readFile(glbPath)) !== selectedGlbSha256) {
		fail("FACADE_PRESENTATION_GLB_MUTATED", "selected GLB changed during presentation rendering");
	}
	validateRender(render, selectedGlbSha256);

	const record = {
		schema_version: "arr.elevation3d.facade-final-presentation.v1",
		selected_glb: { path: artifact.path, sha256: selectedGlbSha256 },
		technical_delivery: technicalDelivery,
		render,
		memory_record: { presentation: null },
		receipt,
	};
	const presentation = await writeJsonAtomic(manifestPath, record, root);
	// The content hash cannot be embedded in the bytes it hashes; the returned
	// memory record therefore carries the content address for the durable file.
	record.memory_record.presentation = presentation;
	return record;
}
