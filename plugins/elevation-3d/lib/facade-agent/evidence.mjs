import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";

import { sha256, stableJson } from "../core.mjs";
import { deriveDeliveryCameras } from "../final-delivery.mjs";
import {
	FACADE_EVIDENCE_PASS_NAMES,
	FACADE_EVIDENCE_VIEW_NAMES,
	renderFacadeEvidencePasses,
} from "./evidence-renderer.mjs";

let temporarySequence = 0;

export class FacadeEvidenceError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "FacadeEvidenceError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new FacadeEvidenceError(code, message);
}

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function exists(path) {
	try { await access(path); return true; } catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function atomicWrite(path, bytes) {
	const temporary = `${path}.tmp-${process.pid}-${temporarySequence++}`;
	try {
		await writeFile(temporary, bytes, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function sourceArtifacts(input) {
	if (!Array.isArray(input?.artifacts) || !input.artifacts.length) fail("EVIDENCE_INPUT_INVALID", "source artifact evidence is required");
	return input.artifacts.map(({ name, path, sha256: digest }) => ({ name, path, sha256: String(digest).toLowerCase() }));
}

function canonicalArtifactPath(root, mode, view) {
	return join(root, mode, `${view}.png`);
}

async function copyRenderedPng(sourcePath, destinationPath) {
	const bytes = await readFile(sourcePath);
	const metadata = await sharp(bytes).metadata();
	if (metadata.format !== "png" || !metadata.width || !metadata.height) fail("EVIDENCE_RENDER_INVALID", `${sourcePath} is not a valid PNG`);
	if (resolve(sourcePath) !== resolve(destinationPath)) await atomicWrite(destinationPath, bytes);
	return { bytes, width: metadata.width, height: metadata.height };
}

async function composeContactSheet(artifactPaths) {
	const tile = 224, imageSize = 192, labelHeight = 32;
	const width = tile * FACADE_EVIDENCE_VIEW_NAMES.length;
	const height = tile * FACADE_EVIDENCE_PASS_NAMES.length;
	const composites = [];
	for (let row = 0; row < FACADE_EVIDENCE_PASS_NAMES.length; row++) for (let column = 0; column < FACADE_EVIDENCE_VIEW_NAMES.length; column++) {
		const mode = FACADE_EVIDENCE_PASS_NAMES[row], view = FACADE_EVIDENCE_VIEW_NAMES[column];
		const left = column * tile + 16, top = row * tile + 4;
		const image = await sharp(artifactPaths[`${mode}:${view}`]).resize(imageSize, imageSize, {
			fit: "contain", background: { r: 248, g: 248, b: 246 }, kernel: "nearest",
		}).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
		const label = Buffer.from(`<svg width="${imageSize}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f8f8f6"/><text x="4" y="20" font-family="monospace" font-size="12" fill="#202020">${mode.toUpperCase()} / ${view.toUpperCase()}</text></svg>`);
		composites.push({ input: image, left, top }, { input: label, left, top: top + imageSize });
	}
	return sharp({ create: { width, height, channels: 3, background: { r: 248, g: 248, b: 246 } } })
		.composite(composites)
		.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
		.toBuffer();
}

function safeManifestFile(root, path, code) {
	if (typeof path !== "string" || !path || isAbsolute(path)) fail(code, "evidence paths must be relative");
	const absolute = resolve(root, path);
	const traversal = relative(root, absolute);
	if (traversal.startsWith("..") || isAbsolute(traversal)) fail(code, "evidence path escapes its pack");
	return absolute;
}

export async function buildFacadeEvidencePack({ input, runDir, renderPasses = renderFacadeEvidencePasses, signal }) {
	throwIfAborted(signal);
	const evidenceRoot = join(resolve(runDir), "evidence");
	const manifestPath = join(evidenceRoot, "evidence-manifest.json");
	if (await exists(manifestPath)) fail("EVIDENCE_MANIFEST_EXISTS", "refusing to replace an existing evidence manifest");
	await Promise.all(FACADE_EVIDENCE_PASS_NAMES.map((mode) => mkdir(join(evidenceRoot, mode), { recursive: true })));
	const cameras = deriveDeliveryCameras(input);
	const rendered = await renderPasses({ mesh: input.mesh, cameras, outputDir: evidenceRoot, modes: [...FACADE_EVIDENCE_PASS_NAMES], signal });
	throwIfAborted(signal);
	const expectedKeys = FACADE_EVIDENCE_PASS_NAMES.flatMap((mode) => FACADE_EVIDENCE_VIEW_NAMES.map((view) => `${mode}:${view}`));
	if (Object.keys(rendered ?? {}).sort().join("|") !== [...expectedKeys].sort().join("|")) fail("EVIDENCE_RENDER_INVALID", "renderer must return all 35 named evidence passes");

	const manifestArtifacts = {};
	const returnedArtifacts = {};
	const artifactPaths = {};
	for (const mode of FACADE_EVIDENCE_PASS_NAMES) for (const view of FACADE_EVIDENCE_VIEW_NAMES) {
		throwIfAborted(signal);
		const key = `${mode}:${view}`;
		const destination = canonicalArtifactPath(evidenceRoot, mode, view);
		const { bytes, width, height } = await copyRenderedPng(rendered[key], destination);
		const record = { path: `${mode}/${view}.png`, sha256: sha256(bytes), width, height, mode, view };
		manifestArtifacts[key] = record;
		returnedArtifacts[key] = { ...record, path: destination };
		artifactPaths[key] = destination;
	}
	const contactSheetBytes = await composeContactSheet(artifactPaths);
	const contactSheetPath = join(evidenceRoot, "contact-sheet.png");
	await atomicWrite(contactSheetPath, contactSheetBytes);
	const contactSheetMetadata = await sharp(contactSheetBytes).metadata();
	const manifest = {
		schema_version: "arr.elevation3d.facade-evidence.v1",
		candidate_id: input.candidate.candidate_id,
		geometry_hash: input.identity.geometry_hash,
		floor_guides_m: [...input.floor_guides.floor_guides_m],
		facade_planes_sha256: sha256(stableJson(input.facade_planes)),
		cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: sourceArtifacts(input),
		artifacts: manifestArtifacts,
		contact_sheet: {
			path: "contact-sheet.png", sha256: sha256(contactSheetBytes),
			width: contactSheetMetadata.width, height: contactSheetMetadata.height,
		},
	};
	const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`);
	await atomicWrite(manifestPath, manifestBytes);
	return { manifest, manifestPath, manifestSha256: sha256(manifestBytes), contactSheetPath, artifacts: returnedArtifacts };
}

export async function verifyFacadeEvidencePack({ manifestPath: manifestFile, input }) {
	const manifestPath = resolve(manifestFile);
	const root = dirname(manifestPath);
	const manifestBytes = await readFile(manifestPath);
	let manifest;
	try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("EVIDENCE_MANIFEST_INVALID", "evidence manifest is not valid JSON"); }
	const expectedAuthority = {
		schema_version: "arr.elevation3d.facade-evidence.v1",
		candidate_id: input.candidate.candidate_id,
		geometry_hash: input.identity.geometry_hash,
		floor_guides_m: [...input.floor_guides.floor_guides_m],
		facade_planes_sha256: sha256(stableJson(input.facade_planes)),
		cameras_sha256: sha256(stableJson(input.cameras)),
		source_artifacts: sourceArtifacts(input),
	};
	for (const [field, expected] of Object.entries(expectedAuthority)) {
		if (stableJson(manifest[field]) !== stableJson(expected)) fail("EVIDENCE_INPUT_HASH_MISMATCH", `evidence authority mismatch: ${field}`);
	}
	for (const artifact of input.artifacts) {
		if (!artifact.absolute_path || sha256(await readFile(artifact.absolute_path)) !== String(artifact.sha256).toLowerCase()) {
			fail("EVIDENCE_INPUT_HASH_MISMATCH", `source artifact hash mismatch: ${artifact.path}`);
		}
	}
	const expectedKeys = FACADE_EVIDENCE_PASS_NAMES.flatMap((mode) => FACADE_EVIDENCE_VIEW_NAMES.map((view) => `${mode}:${view}`));
	if (Object.keys(manifest.artifacts ?? {}).sort().join("|") !== [...expectedKeys].sort().join("|")) fail("EVIDENCE_MANIFEST_INVALID", "manifest must contain exactly 35 evidence artifacts");
	for (const key of expectedKeys) {
		const [mode, view] = key.split(":");
		const record = manifest.artifacts[key];
		if (record?.path !== `${mode}/${view}.png` || record?.mode !== mode || record?.view !== view
			|| !Number.isInteger(record?.width) || record.width <= 0 || !Number.isInteger(record?.height) || record.height <= 0) {
			fail("EVIDENCE_MANIFEST_INVALID", `invalid evidence artifact authority: ${key}`);
		}
		const path = safeManifestFile(root, record?.path, "EVIDENCE_MANIFEST_INVALID");
		const bytes = await readFile(path);
		if (sha256(bytes) !== record.sha256) fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", `evidence artifact hash mismatch: ${key}`);
		const metadata = await sharp(bytes).metadata();
		if (metadata.format !== "png" || metadata.width !== record.width || metadata.height !== record.height) {
			fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", `evidence artifact metadata mismatch: ${key}`);
		}
	}
	if (manifest.contact_sheet?.path !== "contact-sheet.png" || !Number.isInteger(manifest.contact_sheet?.width)
		|| manifest.contact_sheet.width <= 0 || !Number.isInteger(manifest.contact_sheet?.height) || manifest.contact_sheet.height <= 0) {
		fail("EVIDENCE_MANIFEST_INVALID", "invalid contact sheet authority");
	}
	const contactSheetPath = safeManifestFile(root, manifest.contact_sheet?.path, "EVIDENCE_MANIFEST_INVALID");
	const contactSheetBytes = await readFile(contactSheetPath);
	if (sha256(contactSheetBytes) !== manifest.contact_sheet.sha256) fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", "contact sheet hash mismatch");
	const contactSheetMetadata = await sharp(contactSheetBytes).metadata();
	if (contactSheetMetadata.format !== "png" || contactSheetMetadata.width !== manifest.contact_sheet.width || contactSheetMetadata.height !== manifest.contact_sheet.height) {
		fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", "contact sheet metadata mismatch");
	}
	return { manifest, manifestPath, manifestSha256: sha256(manifestBytes), contactSheetPath };
}
