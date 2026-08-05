import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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

async function pathExists(path) {
	try { await lstat(path); return true; } catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function assertContained(root, path) {
	const traversal = relative(root, path);
	if (traversal.startsWith("..") || isAbsolute(traversal)) fail("EVIDENCE_PATH_UNSAFE", "evidence path escapes its real pack root");
}

async function assertNoLinks(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let current = root;
	for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
		current = join(current, component);
		let stats;
		try { stats = await lstat(current); } catch (error) {
			if (error?.code === "ENOENT") return false;
			throw error;
		}
		if (stats.isSymbolicLink()) fail("EVIDENCE_PATH_UNSAFE", `symbolic link or reparse point is not allowed: ${current}`);
	}
	return true;
}

async function ensureDirectoryTreeSafe(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let current = root;
	for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) fail("EVIDENCE_PATH_UNSAFE", `unsafe output path component: ${current}`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await mkdir(current);
			const stats = await lstat(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) fail("EVIDENCE_PATH_UNSAFE", `unsafe output path component: ${current}`);
		}
	}
	await assertNoLinks(absolute);
	return realpath(absolute);
}

async function secureRead(path, root) {
	const absolute = resolve(path);
	await assertNoLinks(absolute);
	const actual = await realpath(absolute);
	if (root) assertContained(await realpath(root), actual);
	await assertNoLinks(absolute);
	return readFile(actual);
}

async function atomicWrite(root, path, bytes) {
	const rootReal = await realpath(root);
	const parent = dirname(resolve(path));
	await assertNoLinks(parent);
	const parentReal = await realpath(parent);
	assertContained(rootReal, parentReal);
	if (await pathExists(path)) fail("EVIDENCE_PATH_UNSAFE", `refusing to replace an existing staged path: ${path}`);
	const temporary = `${path}.tmp-${process.pid}-${temporarySequence++}`;
	try {
		await assertNoLinks(parent);
		await writeFile(temporary, bytes, { flag: "wx" });
		await assertNoLinks(temporary);
		assertContained(rootReal, await realpath(temporary));
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

async function copyRenderedPng(sourcePath, destinationPath, stagingRoot) {
	const bytes = await secureRead(sourcePath, resolve(sourcePath) === resolve(destinationPath) ? stagingRoot : undefined);
	const metadata = await sharp(bytes).metadata();
	if (metadata.format !== "png" || !metadata.width || !metadata.height) fail("EVIDENCE_RENDER_INVALID", `${sourcePath} is not a valid PNG`);
	if (resolve(sourcePath) !== resolve(destinationPath)) await atomicWrite(stagingRoot, destinationPath, bytes);
	return { bytes, width: metadata.width, height: metadata.height };
}

const BITMAP_GLYPHS = Object.freeze({
	" ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
	C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
	G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
	N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
});

function drawBitmapText(buffer, width, x, y, value, scale) {
	let cursor = x;
	for (const character of value) {
		const glyph = BITMAP_GLYPHS[character];
		if (!glyph) fail("EVIDENCE_LABEL_INVALID", `unsupported contact-sheet glyph: ${character}`);
		for (let row = 0; row < glyph.length; row++) for (let column = 0; column < glyph[row].length; column++) {
			if (glyph[row][column] !== "1") continue;
			for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
				const offset = ((y + row * scale + dy) * width + cursor + column * scale + dx) * 3;
				buffer[offset] = buffer[offset + 1] = buffer[offset + 2] = 32;
			}
		}
		cursor += 6 * scale;
	}
}

function blitRgb(target, targetWidth, source, sourceWidth, sourceHeight, left, top) {
	for (let y = 0; y < sourceHeight; y++) {
		const sourceStart = y * sourceWidth * 3;
		const targetStart = ((top + y) * targetWidth + left) * 3;
		source.copy(target, targetStart, sourceStart, sourceStart + sourceWidth * 3);
	}
}

async function composeContactSheet(artifactPaths, stagingRoot) {
	const tile = 224, imageSize = 192;
	const width = tile * FACADE_EVIDENCE_VIEW_NAMES.length;
	const height = tile * FACADE_EVIDENCE_PASS_NAMES.length;
	const pixels = Buffer.alloc(width * height * 3);
	for (let offset = 0; offset < pixels.length; offset += 3) {
		pixels[offset] = 248; pixels[offset + 1] = 248; pixels[offset + 2] = 246;
	}
	for (let row = 0; row < FACADE_EVIDENCE_PASS_NAMES.length; row++) for (let column = 0; column < FACADE_EVIDENCE_VIEW_NAMES.length; column++) {
		const mode = FACADE_EVIDENCE_PASS_NAMES[row], view = FACADE_EVIDENCE_VIEW_NAMES[column];
		const left = column * tile + 16, top = row * tile + 4;
		const source = await secureRead(artifactPaths[`${mode}:${view}`], stagingRoot);
		const { data: image, info } = await sharp(source).flatten({ background: { r: 248, g: 248, b: 246 } }).resize(imageSize, imageSize, {
			fit: "contain", background: { r: 248, g: 248, b: 246 }, kernel: "nearest",
		}).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		blitRgb(pixels, width, image, info.width, info.height, left, top);
		drawBitmapText(pixels, width, left + 4, top + imageSize + 8, mode.toUpperCase(), 2);
		drawBitmapText(pixels, width, left + 4, top + imageSize + 22, view.toUpperCase(), 1);
	}
	return sharp(pixels, { raw: { width, height, channels: 3 } })
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

async function auditStagingTree(root) {
	const expectedRootNames = [...FACADE_EVIDENCE_PASS_NAMES, "contact-sheet.png", "evidence-manifest.json"].sort();
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.map((entry) => entry.name).sort().join("|") !== expectedRootNames.join("|")) {
		fail("EVIDENCE_PATH_UNSAFE", "staging contains unexpected or missing entries");
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) fail("EVIDENCE_PATH_UNSAFE", `staging contains a symbolic link or reparse point: ${path}`);
		if (FACADE_EVIDENCE_PASS_NAMES.includes(entry.name)) {
			if (!entry.isDirectory()) fail("EVIDENCE_PATH_UNSAFE", `staging pass path is not a directory: ${path}`);
			const files = await readdir(path, { withFileTypes: true });
			const expectedFiles = FACADE_EVIDENCE_VIEW_NAMES.map((view) => `${view}.png`).sort();
			if (files.map((file) => file.name).sort().join("|") !== expectedFiles.join("|")
				|| files.some((file) => file.isSymbolicLink() || !file.isFile())) {
				fail("EVIDENCE_PATH_UNSAFE", `staging pass contains unsafe or unexpected entries: ${entry.name}`);
			}
		} else if (!entry.isFile()) fail("EVIDENCE_PATH_UNSAFE", `staging evidence entry is not a file: ${path}`);
		await assertNoLinks(path);
		assertContained(await realpath(root), await realpath(path));
	}
}

export async function buildFacadeEvidencePack({ input, runDir, renderPasses = renderFacadeEvidencePasses, signal }) {
	throwIfAborted(signal);
	const runRoot = await ensureDirectoryTreeSafe(runDir);
	const evidenceRoot = join(runRoot, "evidence");
	if (await pathExists(evidenceRoot)) {
		await assertNoLinks(evidenceRoot);
		if (await pathExists(join(evidenceRoot, "evidence-manifest.json"))) fail("EVIDENCE_MANIFEST_EXISTS", "refusing to replace an existing evidence manifest");
		fail("EVIDENCE_PATH_UNSAFE", "refusing to publish into an existing evidence directory");
	}
	await assertNoLinks(runRoot);
	const stagingRoot = await mkdtemp(join(runRoot, ".evidence-staging-"));
	let published = false;
	try {
		await assertNoLinks(stagingRoot);
		await Promise.all(FACADE_EVIDENCE_PASS_NAMES.map((mode) => mkdir(join(stagingRoot, mode))));
		const cameras = deriveDeliveryCameras(input);
		const rendered = await renderPasses({ mesh: input.mesh, cameras, outputDir: stagingRoot, modes: [...FACADE_EVIDENCE_PASS_NAMES], signal });
		throwIfAborted(signal);
		const expectedKeys = FACADE_EVIDENCE_PASS_NAMES.flatMap((mode) => FACADE_EVIDENCE_VIEW_NAMES.map((view) => `${mode}:${view}`));
		if (Object.keys(rendered ?? {}).sort().join("|") !== [...expectedKeys].sort().join("|")) fail("EVIDENCE_RENDER_INVALID", "renderer must return all 35 named evidence passes");

		const manifestArtifacts = {};
		const artifactPaths = {};
		for (const mode of FACADE_EVIDENCE_PASS_NAMES) for (const view of FACADE_EVIDENCE_VIEW_NAMES) {
			throwIfAborted(signal);
			const key = `${mode}:${view}`;
			const destination = canonicalArtifactPath(stagingRoot, mode, view);
			const { bytes, width, height } = await copyRenderedPng(rendered[key], destination, stagingRoot);
			manifestArtifacts[key] = { path: `${mode}/${view}.png`, sha256: sha256(bytes), width, height, mode, view };
			artifactPaths[key] = destination;
		}
		const contactSheetBytes = await composeContactSheet(artifactPaths, stagingRoot);
		const stagedContactSheetPath = join(stagingRoot, "contact-sheet.png");
		await atomicWrite(stagingRoot, stagedContactSheetPath, contactSheetBytes);
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
		await atomicWrite(stagingRoot, join(stagingRoot, "evidence-manifest.json"), manifestBytes);
		await assertNoLinks(runRoot);
		await assertNoLinks(stagingRoot);
		assertContained(runRoot, await realpath(stagingRoot));
		await auditStagingTree(stagingRoot);
		if (await pathExists(evidenceRoot)) fail("EVIDENCE_PATH_UNSAFE", "evidence destination appeared before publish");
		await rename(stagingRoot, evidenceRoot);
		published = true;
		const manifestPath = join(evidenceRoot, "evidence-manifest.json");
		const contactSheetPath = join(evidenceRoot, "contact-sheet.png");
		const returnedArtifacts = Object.fromEntries(Object.entries(manifestArtifacts).map(([key, record]) => [key, { ...record, path: join(evidenceRoot, record.path) }]));
		return { manifest, manifestPath, manifestSha256: sha256(manifestBytes), contactSheetPath, artifacts: returnedArtifacts };
	} finally {
		if (!published) await rm(stagingRoot, { recursive: true, force: true });
	}
}

export async function verifyFacadeEvidencePack({ manifestPath: manifestFile, input }) {
	const manifestPath = resolve(manifestFile);
	const root = dirname(manifestPath);
	await assertNoLinks(root);
	const rootReal = await realpath(root);
	const manifestBytes = await secureRead(manifestPath, rootReal);
	let manifest;
	try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("EVIDENCE_MANIFEST_INVALID", "evidence manifest is not valid JSON"); }
	if (!manifestBytes.equals(Buffer.from(`${stableJson(manifest)}\n`))) fail("EVIDENCE_MANIFEST_INVALID", "evidence manifest bytes are not canonical stable JSON");
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
		if (!artifact.absolute_path || sha256(await secureRead(artifact.absolute_path)) !== String(artifact.sha256).toLowerCase()) {
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
		const bytes = await secureRead(path, rootReal);
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
	const contactSheetBytes = await secureRead(contactSheetPath, rootReal);
	if (sha256(contactSheetBytes) !== manifest.contact_sheet.sha256) fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", "contact sheet hash mismatch");
	const contactSheetMetadata = await sharp(contactSheetBytes).metadata();
	if (contactSheetMetadata.format !== "png" || contactSheetMetadata.width !== manifest.contact_sheet.width || contactSheetMetadata.height !== manifest.contact_sheet.height) {
		fail("EVIDENCE_ARTIFACT_HASH_MISMATCH", "contact sheet metadata mismatch");
	}
	return { manifest, manifestPath, manifestSha256: sha256(manifestBytes), contactSheetPath };
}
