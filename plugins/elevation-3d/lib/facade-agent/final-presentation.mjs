import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { sha256, stableJson } from "../core.mjs";
import { deriveDeliveryCameras } from "../final-delivery.mjs";
import { readVerifiedFacadeValidationAuthority } from "../enrichment-validation.mjs";
import { cameraContractHash, deriveExpectedCameraContract, normalizeCameraValue, presentationCameraPresets, technicalCameraAuthorityFromGlb } from "../camera-authority.mjs";
import { loadVerifiedProceduralBaseline, renderEmbeddedPbrViews } from "../texturing/render-validator.mjs";
import { buildFacadeArtifactClosure } from "./artifact-closure.mjs";
import { facadeCandidateHash } from "./candidate-authority.mjs";
import { atomicWrite, assertNoReparsePoints, containedPath, safeRead } from "./path-safety.mjs";

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

async function rollbackOwnedManifest(runDir, path, reference) {
	let bytes;
	try { bytes = await safeRead(runDir, path, "failed presentation wrapper"); }
	catch (error) { if (error?.code === "ENOENT") return; throw error; }
	if (sha256(bytes) !== reference.sha256) {
		fail("FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID", "failed presentation wrapper changed before rollback");
	}
	containedPath(runDir, path, "failed presentation wrapper");
	await assertNoReparsePoints(path);
	await unlink(path);
	await assertNoReparsePoints(path);
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
	return {
		ref: { path: validationReceipt.path, sha256: validationReceipt.sha256, ...(validationReceipt.receipt_sha256 ? { receipt_sha256: validationReceipt.receipt_sha256 } : {}) },
		value: receipt,
	};
}

function normalizedEqual(left, right) {
	return stableJson(normalizeCameraValue(left)) === stableJson(normalizeCameraValue(right));
}

function validateRender(render, { selectedGlbSha256, canonicalSelection, presentationCameras, buildingBounds }) {
	if (render?.schema_version !== "arr.elevation3d.embedded-pbr-render.v2") {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render-v2 authority is required");
	}
	if (render?.validation?.accepted !== true) fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render validation was rejected");
	if (render.provider_calls !== 0 || render.credits_consumed !== 0) fail("FACADE_PRESENTATION_REMOTE_ACTIVITY", "final presentation renderer reported remote activity");
	if (!exactViewNames(render.views)) fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render must contain exactly eight named views");
	if (render.selected_glb?.sha256 !== selectedGlbSha256
		|| VIEW_NAMES.some((name) => viewHash(render.views[name]) !== selectedGlbSha256)) {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render is not bound to the selected GLB");
	}
	if (stableJson(render.canonical_selection) !== stableJson(canonicalSelection)) {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render canonical selection differs from selected authority");
	}
	const cameraSha256 = cameraContractHash(presentationCameras);
	if (render.camera_authority?.sha256 !== cameraSha256 || !normalizedEqual(render.camera_authority?.views, presentationCameras)) {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR render camera authority differs from candidate authority");
	}
	for (const name of VIEW_NAMES) {
		const evidence = render.views[name]?.cameraEvidence;
		let independentExpected;
		try {
			independentExpected = deriveExpectedCameraContract({ name, preset: presentationCameras[name], buildingBounds });
		} catch {
			fail("FACADE_PRESENTATION_RENDER_REJECTED", `embedded-PBR ${name} camera lacks independently derivable building bounds`);
		}
		if (!evidence || !normalizedEqual(evidence.building_bounds, buildingBounds)
			|| !normalizedEqual(evidence.expected, evidence.actual)
			|| !normalizedEqual(evidence.expected, independentExpected)
			|| evidence.expected_hash !== cameraContractHash(evidence.expected)
			|| evidence.actual_hash !== cameraContractHash(evidence.actual)) {
			fail("FACADE_PRESENTATION_RENDER_REJECTED", `embedded-PBR ${name} browser camera differs from its independent expected contract`);
		}
	}
	if (render.material_mode !== "embedded-pbr" || render.render_style?.id !== "competition-daylight-v1"
		|| !["material_count", "base_color_maps", "normal_maps", "metallic_roughness_maps"]
			.every((key) => Number.isFinite(render.pbr_evidence?.[key]) && render.pbr_evidence[key] > 0)) {
		fail("FACADE_PRESENTATION_RENDER_REJECTED", "embedded-PBR material, style, or map evidence is invalid");
	}
}

export async function deliverFacadeFinalPresentation({
	runDir, presentationRoot, candidateId, candidateSha256, provider, selectedVersion, artifact, validation, validationReceipt, technicalDelivery,
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
	const cameras = deriveDeliveryCameras(input);
	let technicalCameraAuthority;
	try { technicalCameraAuthority = await technicalCameraAuthorityFromGlb({ bytes: glbBytes, cameras }); }
	catch (error) { fail("FACADE_PRESENTATION_GLB_INVALID", "selected GLB geometry bounds are unavailable", error); }
	const buildingBounds = technicalCameraAuthority.building_bounds;
	if (validation?.accepted !== true) fail("FACADE_PRESENTATION_VALIDATION_REQUIRED", "accepted facade validation is required");
	const verifiedReceipt = await verifyValidationReceipt(absoluteRunDir, validationReceipt, selectedGlbSha256, validation);
	const inputCandidateId = input?.candidate?.candidate_id ?? input?.candidate_id;
	const effectiveCandidateSha256 = candidateSha256;
	const effectiveProvider = provider;
	if (candidateId !== inputCandidateId || typeof effectiveProvider !== "string" || effectiveProvider.length === 0
		|| !/^[a-f0-9]{64}$/i.test(effectiveCandidateSha256 ?? "")
		|| effectiveCandidateSha256 !== facadeCandidateHash(input)
		|| effectiveProvider !== verifiedReceipt.value.provider
		|| typeof selectedVersion !== "string" || selectedVersion.length === 0
		|| selectedVersion !== verifiedReceipt.value.version_id
		|| (verifiedReceipt.value.validation_authority?.candidateId && verifiedReceipt.value.validation_authority.candidateId !== candidateId)) {
		fail("FACADE_PRESENTATION_AUTHORITY_MISMATCH", "presentation provider or preflight candidate authority does not match");
	}
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
		const authoritativeCameras = presentationCameraPresets(deriveDeliveryCameras(input));
		proceduralBaseline = await loadVerifiedProceduralBaseline({
			runDir: technicalRoot,
			manifestRecord: technicalDelivery.memory_record?.manifest,
			selectedGlbSha256,
			authoritativeCameras,
			expectedTechnicalCameras: technicalCameraAuthority.cameras,
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
	const presentationCameras = presentationCameraPresets(cameras);
	const cameraAuthoritySha256 = cameraContractHash(presentationCameras);
	const canonicalSelection = {
		provider: effectiveProvider,
		candidate_id: candidateId,
		candidate_sha256: effectiveCandidateSha256,
		selected_glb_sha256: selectedGlbSha256,
		facade_validation_receipt_sha256: validationReceipt.sha256,
		camera_authority_sha256: cameraAuthoritySha256,
	};
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
			canonicalSelection,
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
	validateRender(render, { selectedGlbSha256, canonicalSelection, presentationCameras, buildingBounds });

	const record = {
		schema_version: "arr.elevation3d.facade-final-presentation.v1",
		selected_glb: { path: artifact.path, sha256: selectedGlbSha256 },
		technical_delivery: technicalDelivery,
		render,
		memory_record: { presentation: null },
		receipt: verifiedReceipt.ref,
	};
	const presentation = await writeJsonAtomic(manifestPath, record, root);
	let closure;
	try {
		closure = await buildFacadeArtifactClosure({
			runDir: absoluteRunDir, closurePath: join(root, "artifact-closure.json"),
			provider: effectiveProvider, candidateId, candidateSha256: effectiveCandidateSha256, selectedVersion,
			selectedGlb: { path: artifact.path, sha256: selectedGlbSha256 }, validationReceipt,
			cameraAuthority: { sha256: cameraAuthoritySha256 }, technicalDelivery,
			presentationRoot: root, render, presentationManifest: presentation,
		});
	} catch (error) {
		try { await rollbackOwnedManifest(absoluteRunDir, manifestPath, presentation); }
		catch (rollbackError) {
			fail("FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID", "final presentation artifact closure failed and wrapper rollback was not safe", new AggregateError([error, rollbackError]));
		}
		if (error?.code === "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID") throw error;
		fail("FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID", "final presentation artifact closure failed", error);
	}
	// The durable wrapper remains byte-identical to the document that was
	// content-addressed. Publication metadata lives in this distinct envelope.
	return {
		...record,
		memory_record: {
			presentation, artifact_closure: closure.ref,
			selected_glb: { path: artifact.path, sha256: selectedGlbSha256 },
			contact_sheet: closure.closure.presentation.artifacts.contact_sheet,
			views: Object.fromEntries(VIEW_NAMES.map((name) => [name, {
				...closure.closure.presentation.views[name].image, selected_glb_sha256: selectedGlbSha256,
			}])),
		},
	};
}
