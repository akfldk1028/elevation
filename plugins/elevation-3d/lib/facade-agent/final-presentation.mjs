import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { sha256 } from "../core.mjs";
import { deriveDeliveryCameras } from "../final-delivery.mjs";
import { renderEmbeddedPbrViews } from "../texturing/render-validator.mjs";

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

function containedPath(root, path) {
	const absoluteRoot = resolve(root);
	const absolute = resolve(path);
	const child = relative(absoluteRoot, absolute);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		fail("FACADE_PRESENTATION_PATH_INVALID", "presentation root must remain beneath the run directory");
	}
	return absolute;
}

async function assertNoReparsePoints(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = resolve(current, parts[index]);
		let stats;
		try { stats = await lstat(current); }
		catch (error) { if (error?.code === "ENOENT") return; throw error; }
		if (stats.isSymbolicLink()) fail("FACADE_PRESENTATION_PATH_INVALID", "presentation path contains a symlink or junction");
		if (index < parts.length - 1 && !stats.isDirectory()) fail("FACADE_PRESENTATION_PATH_INVALID", "presentation path parent must be a directory");
	}
}

function exactViewNames(value) {
	return Object.keys(value ?? {}).sort().join("|") === [...VIEW_NAMES].sort().join("|");
}

function viewHash(view) {
	return view?.selectedGlbSha256 ?? view?.selected_glb_sha256;
}

async function writeJsonAtomic(path, value, root) {
	await assertNoReparsePoints(root);
	await mkdir(root, { recursive: true });
	await assertNoReparsePoints(root);
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, bytes, { flag: "wx" });
		await assertNoReparsePoints(temporary);
		await assertNoReparsePoints(path);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
	return { path, sha256: sha256(bytes) };
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
	const root = containedPath(absoluteRunDir, presentationRoot);
	await assertNoReparsePoints(absoluteRunDir);
	await assertNoReparsePoints(root);

	const glbBytes = await readFile(resolve(artifact.path));
	const selectedGlbSha256 = sha256(glbBytes);
	if (selectedGlbSha256 !== artifact.sha256) fail("FACADE_PRESENTATION_GLB_HASH_MISMATCH", "selected GLB hash does not match the artifact authority");
	if (validation?.accepted !== true) fail("FACADE_PRESENTATION_VALIDATION_REQUIRED", "accepted facade validation is required");
	if (technicalDelivery?.manifest?.selected_glb?.sha256 !== selectedGlbSha256) {
		fail("FACADE_PRESENTATION_TECHNICAL_BINDING_MISMATCH", "technical delivery is bound to a different selected GLB");
	}
	const cameras = deriveDeliveryCameras(input);
	throwIfAborted(signal);

	let render;
	try {
		render = await (deps.renderEmbeddedPbrViews ?? renderEmbeddedPbrViews)({
			glbPath: artifact.path,
			runDir: root,
			candidateId,
			cameras,
			baselineRunDir: technicalDelivery.run_dir,
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
	await assertNoReparsePoints(root);
	validateRender(render, selectedGlbSha256);

	const receipt = { path: validationReceipt.path, sha256: validationReceipt.sha256 };
	const record = {
		schema_version: "arr.elevation3d.facade-final-presentation.v1",
		selected_glb: { path: artifact.path, sha256: selectedGlbSha256 },
		technical_delivery: technicalDelivery,
		render,
		memory_record: { presentation: null },
		receipt,
	};
	const manifestPath = join(root, "final-presentation.json");
	const presentation = await writeJsonAtomic(manifestPath, record, root);
	// The content hash cannot be embedded in the bytes it hashes; the returned
	// memory record therefore carries the content address for the durable file.
	record.memory_record.presentation = presentation;
	return record;
}
