import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { sha256, stableJson } from "../core.mjs";
import { atomicWrite, safeRead } from "./path-safety.mjs";

const VIEW_NAMES = Object.freeze(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]);
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const SCHEMA_VERSION = "arr.elevation3d.facade-artifact-authority.v1";

export class FacadeArtifactClosureError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeArtifactClosureError";
		this.code = "FACADE_PRESENTATION_ARTIFACT_CLOSURE_INVALID";
	}
}

function fail(message, cause) {
	throw new FacadeArtifactClosureError(message, cause);
}

function exactViews(value) {
	return Object.keys(value ?? {}).sort().join("|") === [...VIEW_NAMES].sort().join("|");
}

function portable(runDir, path, label) {
	if (typeof path !== "string" || path.length === 0) fail(`${label} path is missing`);
	const absolute = isAbsolute(path) ? resolve(path) : resolve(runDir, path);
	let child;
	try { child = relative(resolve(runDir), absolute); }
	catch (error) { fail(`${label} path is invalid`, error); }
	if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\") || isAbsolute(child)) {
		fail(`${label} must remain beneath the facade run`);
	}
	return child.replaceAll("\\", "/");
}

function claimedRef(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.path !== "string") {
		fail(`${label} reference is missing`);
	}
	if (value.sha256 !== undefined && !HEX_SHA256.test(value.sha256)) fail(`${label} SHA-256 is invalid`);
	return value;
}

async function closeRef(runDir, value, label, expectedSha256) {
	const claimed = claimedRef(value, label);
	const path = portable(runDir, claimed.path, label);
	let bytes;
	try { bytes = await safeRead(runDir, join(runDir, path), label); }
	catch (error) { fail(`${label} is unavailable or unsafe`, error); }
	const digest = sha256(bytes);
	if (claimed.sha256 && claimed.sha256.toLowerCase() !== digest) fail(`${label} SHA-256 does not match its bytes`);
	if (expectedSha256 && expectedSha256.toLowerCase() !== digest) fail(`${label} is not bound to the selected GLB`);
	return { path, sha256: digest };
}

export async function readContentAddressedJson({
	runDir, value, label, expectedSha256, readBytes = safeRead,
}) {
	const claimed = claimedRef(value, label);
	const path = portable(runDir, claimed.path, label);
	let bytes;
	try { bytes = await readBytes(runDir, join(runDir, path), label); }
	catch (error) { fail(`${label} is unavailable or unsafe`, error); }
	const digest = sha256(bytes);
	if (claimed.sha256 && claimed.sha256.toLowerCase() !== digest) {
		fail(`${label} SHA-256 does not match its bytes`);
	}
	if (expectedSha256 && expectedSha256.toLowerCase() !== digest) {
		fail(`${label} is not bound to the selected GLB`);
	}
	let parsed;
	try { parsed = JSON.parse(bytes.toString("utf8")); }
	catch (error) { fail(`${label} is not valid JSON`, error); }
	return { ref: { path, sha256: digest }, value: parsed };
}

async function closeJson(runDir, value, label) {
	return readContentAddressedJson({ runDir, value, label });
}

function technicalRelativeRef(technicalRoot, ref, label) {
	const claimed = claimedRef(ref, label);
	return { ...claimed, path: isAbsolute(claimed.path) ? claimed.path : resolve(technicalRoot, claimed.path) };
}

function screenshotRef(value, label) {
	if (typeof value === "string") return { path: value };
	return claimedRef(value, label);
}

function assertDistinct(records, label, { requireDistinctHashes = true } = {}) {
	const paths = records.map((record) => record.path);
	const hashes = records.map((record) => record.sha256);
	if (new Set(paths).size !== paths.length) fail(`${label} paths must be distinct`);
	if (requireDistinctHashes && new Set(hashes).size !== hashes.length) fail(`${label} content hashes must be distinct`);
}

function validateTechnicalDetail({ name, detail, validation, detailRef, runDir, selectedGlbPath, selectedGlbSha256 }) {
	const expectedSchema = ["axon", "opposite-axon"].includes(name) ? "arr.elevation3d.competition-axon.v1"
		: ["plan", "top"].includes(name) ? "arr.elevation3d.competition-plan-top.v1" : "arr.elevation3d.competition-elevation.v1";
	const identity = detail?.view ?? detail?.mode;
	const detailGlbSha256 = detail?.selected_glb_sha256 ?? detail?.selected_glb?.sha256;
	if (detail?.schema_version !== expectedSchema || identity !== name || detailGlbSha256 !== selectedGlbSha256
		|| validation?.accepted !== true || !Array.isArray(validation.codes)) {
		fail(`technical ${name} detailed manifest or validation authority is invalid`);
	}
	if (detail.selected_glb?.path !== undefined) {
		const manifestPath = resolve(runDir, detailRef.path);
		const claimedPath = isAbsolute(detail.selected_glb.path)
			? resolve(detail.selected_glb.path) : resolve(dirname(manifestPath), detail.selected_glb.path);
		if (claimedPath !== selectedGlbPath) fail(`technical ${name} detailed manifest points outside the contained selected GLB`);
	}
}

async function closeTechnical({ runDir, technicalDelivery, selectedGlbSha256 }) {
	if (typeof technicalDelivery?.run_dir !== "string") fail("technical delivery root is missing");
	const technicalRoot = resolve(technicalDelivery.run_dir);
	portable(runDir, technicalRoot, "technical delivery root");
	const memory = technicalDelivery.memory_record;
	const manifestResult = await closeJson(runDir, claimedRef(memory?.manifest, "technical manifest"), "technical manifest");
	const manifest = manifestResult.value;
	if (manifest?.schema_version !== "arr.elevation3d.all-views.v1" || manifest.validation?.accepted !== true
		|| manifest.selected_glb?.sha256 !== selectedGlbSha256 || !exactViews(manifest.views)) {
		fail("technical manifest is not an accepted eight-view selected-GLB authority");
	}
	const selectedGlb = await closeRef(runDir, {
		path: resolve(technicalRoot, manifest.selected_glb.path), sha256: manifest.selected_glb.sha256,
	}, "technical browser-loaded GLB", selectedGlbSha256);
	const selectedGlbPath = resolve(runDir, selectedGlb.path);
	const validation = await closeRef(runDir, claimedRef(memory?.validation, "technical validation"), "technical validation");

	const viewerEvidence = manifest.verified_evidence?.viewer;
	const viewer = {};
	for (const key of ["html", "app", "config"]) {
		viewer[key] = await closeRef(runDir, technicalRelativeRef(technicalRoot, viewerEvidence?.[key], `technical viewer ${key}`), `technical viewer ${key}`);
	}

	const browserResult = await closeJson(runDir, claimedRef(memory?.browser_verification, "technical browser report"), "technical browser report");
	const browser = { report: browserResult.ref, screenshots: {} };
	for (const key of ["initial", "interacted"]) {
		const source = browserResult.value?.screenshot_artifacts?.[key] ?? browserResult.value?.screenshots?.[key];
		browser.screenshots[key] = await closeRef(runDir, screenshotRef(source, `technical browser ${key} screenshot`), `technical browser ${key} screenshot`);
	}

	const views = {};
	for (const name of VIEW_NAMES) {
		const source = manifest.views[name];
		if (source?.selected_glb_sha256 !== selectedGlbSha256 || source?.validation?.accepted !== true) {
			fail(`technical ${name} view is not accepted and bound to the selected GLB`);
		}
		const detail = await closeJson(runDir, technicalRelativeRef(technicalRoot, source.manifest, `technical ${name} manifest`), `technical ${name} manifest`);
		const detailValidation = await closeJson(runDir, technicalRelativeRef(technicalRoot, source.validation_report, `technical ${name} validation`), `technical ${name} validation`);
		validateTechnicalDetail({
			name, detail: detail.value, validation: detailValidation.value, detailRef: detail.ref,
			runDir, selectedGlbPath, selectedGlbSha256,
		});
		views[name] = {
			image: await closeRef(runDir, technicalRelativeRef(technicalRoot, source, `technical ${name} PNG`), `technical ${name} PNG`),
			manifest: detail.ref,
			validation: detailValidation.ref,
		};
	}
	assertDistinct(Object.values(views).map((value) => value.image), "technical view PNG");
	return { selected_glb: selectedGlb, manifest: manifestResult.ref, validation, viewer, browser, views };
}

async function closePresentation({ runDir, presentationRoot, render, presentationManifest, selectedGlbSha256 }) {
	const root = resolve(presentationRoot);
	portable(runDir, root, "presentation root");
	if (render?.schema_version !== "arr.elevation3d.embedded-pbr-render.v2" || !exactViews(render.views)) {
		fail("presentation render-v2 with exactly eight views is required");
	}
	const browserLoadedGlb = await closeRef(runDir, claimedRef(render.browser_loaded_glb, "presentation browser-loaded GLB"), "presentation browser-loaded GLB", selectedGlbSha256);
	const reportResult = await closeJson(runDir, { path: join(root, "render-validation.json") }, "presentation render report");
	if (stableJson(reportResult.value) !== stableJson(render)) fail("durable presentation report differs from the returned render authority");

	const viewer = {};
	for (const key of ["html", "app", "config"]) {
		viewer[key] = await closeRef(runDir, claimedRef(render.viewer?.[key], `presentation viewer ${key}`), `presentation viewer ${key}`);
	}
	const requiredArtifacts = ["render_style", "presentation_evidence", "semantic_role_evidence", "baseline_comparison", "contact_sheet"];
	const artifacts = {};
	for (const key of requiredArtifacts) {
		artifacts[key] = await closeRef(runDir, claimedRef(render.artifacts?.[key], `presentation ${key}`), `presentation ${key}`);
	}
	const views = {};
	for (const name of VIEW_NAMES) {
		const source = render.views[name];
		const image = render.artifacts?.[`view_${name}`] ?? { path: source?.path, sha256: source?.sha256 };
		const mask = render.artifacts?.[`semantic_role_mask_${name}`] ?? { path: source?.semanticRoleMaskPath, sha256: source?.semanticRoleMaskSha256 };
		if ((source?.selectedGlbSha256 ?? source?.selected_glb_sha256) !== selectedGlbSha256) fail(`presentation ${name} is not bound to the selected GLB`);
		views[name] = {
			image: await closeRef(runDir, claimedRef(image, `presentation ${name} PNG`), `presentation ${name} PNG`),
			semantic_role_mask: await closeRef(runDir, claimedRef(mask, `presentation ${name} semantic-role mask`), `presentation ${name} semantic-role mask`),
		};
	}
	assertDistinct(Object.values(views).map((value) => value.image), "presentation view PNG");
	assertDistinct(Object.values(views).map((value) => value.semantic_role_mask), "presentation semantic-role mask", { requireDistinctHashes: false });
	return {
		manifest: await closeRef(runDir, claimedRef(presentationManifest, "presentation wrapper"), "presentation wrapper"),
		browser_loaded_glb: browserLoadedGlb, report: reportResult.ref, viewer, artifacts, views,
	};
}

export async function buildFacadeArtifactClosure({
	runDir, closurePath, provider, candidateId, candidateSha256, selectedVersion = null,
	selectedGlb, validationReceipt, cameraAuthority, technicalDelivery, presentationRoot, render, presentationManifest,
} = {}) {
	if (typeof provider !== "string" || provider.length === 0 || typeof candidateId !== "string" || candidateId.length === 0
		|| !HEX_SHA256.test(candidateSha256 ?? "") || !HEX_SHA256.test(selectedGlb?.sha256 ?? "")
		|| !HEX_SHA256.test(validationReceipt?.sha256 ?? "") || !HEX_SHA256.test(cameraAuthority?.sha256 ?? "")) {
		fail("artifact closure authority is incomplete");
	}
	const selected = await closeRef(runDir, selectedGlb, "authoritative selected GLB", selectedGlb.sha256);
	const validation = await closeRef(runDir, validationReceipt, "facade validation receipt");
	const technical = await closeTechnical({ runDir, technicalDelivery, selectedGlbSha256: selected.sha256 });
	const presentation = await closePresentation({ runDir, presentationRoot, render, presentationManifest, selectedGlbSha256: selected.sha256 });
	const closure = {
		schema_version: SCHEMA_VERSION,
		authority: {
			provider, candidate_id: candidateId, candidate_sha256: candidateSha256,
			selected_version: selectedVersion, selected_glb_sha256: selected.sha256,
			validation_receipt_sha256: validation.sha256, camera_authority_sha256: cameraAuthority.sha256,
		},
		selected_glb: selected, validation_receipt: validation, technical, presentation,
	};
	const bytes = Buffer.from(`${JSON.stringify(closure, null, 2)}\n`);
	await atomicWrite(closurePath, bytes, runDir);
	return { closure, ref: { path: portable(runDir, closurePath, "artifact closure"), sha256: sha256(bytes) } };
}

function allClosureRefs(closure) {
	return [
		closure.selected_glb, closure.validation_receipt,
		closure.technical?.selected_glb, closure.technical?.manifest, closure.technical?.validation,
		...Object.values(closure.technical?.viewer ?? {}), closure.technical?.browser?.report,
		...Object.values(closure.technical?.browser?.screenshots ?? {}),
		...Object.values(closure.technical?.views ?? {}).flatMap((value) => [value.image, value.manifest, value.validation]),
		closure.presentation?.manifest, closure.presentation?.browser_loaded_glb, closure.presentation?.report,
		...Object.values(closure.presentation?.viewer ?? {}), ...Object.values(closure.presentation?.artifacts ?? {}),
		...Object.values(closure.presentation?.views ?? {}).flatMap((value) => [value.image, value.semantic_role_mask]),
	].filter(Boolean);
}

export async function verifyFacadeArtifactClosure({ runDir, reference, expected = {} } = {}) {
	const result = await closeJson(runDir, reference, "facade artifact closure");
	const closure = result.value;
	if (closure?.schema_version !== SCHEMA_VERSION || !exactViews(closure.technical?.views) || !exactViews(closure.presentation?.views)) {
		fail("facade artifact closure schema or view set is invalid");
	}
	for (const [key, value] of Object.entries(expected)) {
		if (value !== undefined && closure.authority?.[key] !== value) fail(`facade artifact closure ${key} binding mismatch`);
	}
	if (closure.authority?.selected_glb_sha256 !== closure.selected_glb?.sha256
		|| closure.technical?.selected_glb?.sha256 !== closure.selected_glb?.sha256
		|| closure.presentation?.browser_loaded_glb?.sha256 !== closure.selected_glb?.sha256
		|| closure.authority?.validation_receipt_sha256 !== closure.validation_receipt?.sha256) {
		fail("facade artifact closure selected-GLB or validation binding is invalid");
	}
	let technicalResult, wrapperResult, reportResult;
	for (const ref of allClosureRefs(closure)) {
		if (ref === closure.technical.manifest) technicalResult = await closeJson(runDir, ref, "closed technical manifest");
		else if (ref === closure.presentation.manifest) wrapperResult = await closeJson(runDir, ref, "closed presentation wrapper");
		else if (ref === closure.presentation.report) reportResult = await closeJson(runDir, ref, "closed presentation report");
		else await closeRef(runDir, ref, "closed facade artifact");
	}
	assertDistinct(Object.values(closure.technical.views).map((value) => value.image), "technical view PNG");
	assertDistinct(Object.values(closure.presentation.views).map((value) => value.image), "presentation view PNG");
	assertDistinct(Object.values(closure.presentation.views).map((value) => value.semantic_role_mask), "presentation semantic-role mask", { requireDistinctHashes: false });
	const technical = technicalResult?.value;
	const wrapper = wrapperResult?.value;
	const report = reportResult?.value;
	const authority = closure.authority;
	if (technical?.schema_version !== "arr.elevation3d.all-views.v1" || technical.validation?.accepted !== true
		|| technical.selected_glb?.sha256 !== authority.selected_glb_sha256 || !exactViews(technical.views)) {
		fail("closed technical manifest semantic authority is invalid");
	}
	if (wrapper?.schema_version !== "arr.elevation3d.facade-final-presentation.v1"
		|| wrapper.selected_glb?.sha256 !== authority.selected_glb_sha256
		|| wrapper.memory_record?.presentation !== null || stableJson(wrapper.render) !== stableJson(report)) {
		fail("closed presentation wrapper semantic authority is invalid");
	}
	const canonical = {
		provider: authority.provider, candidate_id: authority.candidate_id, candidate_sha256: authority.candidate_sha256,
		selected_glb_sha256: authority.selected_glb_sha256,
		facade_validation_receipt_sha256: authority.validation_receipt_sha256,
		camera_authority_sha256: authority.camera_authority_sha256,
	};
	if (report?.schema_version !== "arr.elevation3d.embedded-pbr-render.v2" || report.validation?.accepted !== true
		|| report.provider_calls !== 0 || report.credits_consumed !== 0
		|| report.selected_glb?.sha256 !== authority.selected_glb_sha256
		|| report.browser_loaded_glb?.sha256 !== authority.selected_glb_sha256
		|| stableJson(report.canonical_selection) !== stableJson(canonical)
		|| report.camera_authority?.sha256 !== authority.camera_authority_sha256
		|| report.material_mode !== "embedded-pbr" || report.render_style?.id !== "competition-daylight-v1"
		|| !["material_count", "base_color_maps", "normal_maps", "metallic_roughness_maps"]
			.every((key) => Number.isFinite(report.pbr_evidence?.[key]) && report.pbr_evidence[key] > 0)
		|| !exactViews(report.views)) {
		fail("closed presentation report semantic authority is invalid");
	}
	for (const name of VIEW_NAMES) {
		const view = report.views[name];
		if ((view?.selectedGlbSha256 ?? view?.selected_glb_sha256) !== authority.selected_glb_sha256
			|| view.sha256 !== closure.presentation.views[name].image.sha256
			|| view.semanticRoleMaskSha256 !== closure.presentation.views[name].semantic_role_mask.sha256) {
			fail(`closed presentation ${name} binding is invalid`);
		}
	}
	return { closure, ref: result.ref };
}
