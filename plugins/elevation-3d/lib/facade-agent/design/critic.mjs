import { resolve } from "node:path";
import sharp from "sharp";

import { sha256, stableJson } from "../../core.mjs";
import { safeRead } from "../path-safety.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";

const VIEWS = Object.freeze(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]);
const SCORE_LIMITS = Object.freeze({
	entrance_legibility: 70,
	base_middle_top_hierarchy: 70,
	repetition_variation_balance: 60,
	cross_view_coherence: 80,
	material_hierarchy: 60,
	technical_perspective_consistency: 80,
});
const reviewAuthorities = new WeakMap();

export class FacadeDesignCriticError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignCriticError";
		this.code = "FACADE_DESIGN_CRITIC_INVALID";
	}
}

function fail(message, cause) { throw new FacadeDesignCriticError(message, cause); }

function exactKeys(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain record`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length !== keys.length) fail(`${label} fields are invalid`);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) fail(`${label}.${key} is invalid`);
	}
	return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

async function verifiedPng(runDir, value, label) {
	const ref = exactKeys(value, ["path", "sha256", "width", "height"], label);
	if (typeof ref.path !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)
		|| !Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height)
		|| ref.width < 1 || ref.height < 1 || ref.width > 8192 || ref.height > 8192) fail(`${label} reference is invalid`);
	let bytes;
	try { bytes = await safeRead(runDir, ref.path, label); }
	catch (error) { fail(`${label} is unavailable`, error); }
	if (sha256(bytes) !== ref.sha256) fail(`${label} hash changed`);
	let metadata;
	try { metadata = await sharp(bytes).metadata(); } catch (error) { fail(`${label} is not a valid image`, error); }
	if (metadata.format !== "png" || metadata.width !== ref.width || metadata.height !== ref.height) fail(`${label} metadata changed`);
	return Object.freeze({ path: resolve(ref.path), sha256: ref.sha256, width: ref.width, height: ref.height });
}

export async function verifyFacadeDesignArtifacts({ runDir, artifacts } = {}) {
	const fields = exactKeys(artifacts, ["technical_views", "pbr_contact_sheet", "perspective_hero"], "facade review artifacts");
	const views = exactKeys(fields.technical_views, VIEWS, "technical views");
	const technicalViews = {};
	for (const view of VIEWS) technicalViews[view] = await verifiedPng(runDir, views[view], `technical view ${view}`);
	return Object.freeze({
		technical_views: Object.freeze(technicalViews),
		pbr_contact_sheet: await verifiedPng(runDir, fields.pbr_contact_sheet, "PBR contact sheet"),
		perspective_hero: await verifiedPng(runDir, fields.perspective_hero, "perspective hero"),
	});
}

export function readVerifiedFacadeCriticAuthority(value) {
	const authority = value && typeof value === "object" ? reviewAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

export function verifyPersistedFacadeCriticReview({ source, compilationSha256, artifacts, review } = {}) {
	if (!review || review.schema_version !== "arr.elevation3d.facade-design-review.v1") fail("persisted critic review is invalid");
	const { review_sha256: digest, ...base } = review;
	if (digest !== sha256(stableJson(base)) || review.compilation_sha256 !== compilationSha256
		|| stableJson(review.artifacts) !== stableJson(artifacts)
		|| review.source_sha256 !== sha256(stableJson({ source, compilation_sha256: compilationSha256, artifacts }))) {
		fail("persisted critic review authority changed");
	}
	const scoreNames = Object.keys(SCORE_LIMITS);
	if (!review.scores || Object.keys(review.scores).sort().join("|") !== [...scoreNames].sort().join("|")) fail("persisted critic scores are invalid");
	for (const name of scoreNames) if (!Number.isInteger(review.scores[name]) || review.scores[name] < 0 || review.scores[name] > 100) fail("persisted critic scores are invalid");
	const accepted = Object.entries(SCORE_LIMITS).every(([name, minimum]) => review.scores[name] >= minimum);
	if (review.accepted !== accepted || accepted !== true) fail("persisted critic acceptance is invalid");
	return true;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export async function reviewFacadeDesign({ runDir, context, compiled, artifacts, criticResult } = {}) {
	const source = readVerifiedFacadeDesignContextAuthority(context);
	if (!source || stableJson(compiled?.source) !== stableJson(source) || typeof compiled?.compilation_sha256 !== "string") {
		fail("verified context and compiled facade source are required");
	}
	const root = resolve(runDir);
	let glb;
	try { glb = await safeRead(root, compiled.output.path, "compiled facade GLB"); }
	catch (error) { fail("compiled facade GLB is unavailable", error); }
	if (sha256(glb) !== compiled.output.sha256) fail("compiled facade GLB hash changed");
	const verifiedArtifacts = await verifyFacadeDesignArtifacts({ runDir: root, artifacts });
	const reviewSource = { source, compilation_sha256: compiled.compilation_sha256, artifacts: verifiedArtifacts };
	const expectedSourceSha256 = sha256(stableJson(reviewSource));
	const fields = exactKeys(criticResult, ["source_sha256", "accepted", "scores", "notes"], "critic result");
	if (fields.source_sha256 !== expectedSourceSha256 || typeof fields.accepted !== "boolean") fail("critic source authority is invalid");
	const scores = exactKeys(fields.scores, Object.keys(SCORE_LIMITS), "critic scores");
	for (const [name, score] of Object.entries(scores)) if (!Number.isInteger(score) || score < 0 || score > 100) fail(`critic score ${name} is invalid`);
	if (!Array.isArray(fields.notes) || fields.notes.length > 16 || fields.notes.some((note) => typeof note !== "string" || !note.trim() || Buffer.byteLength(note) > 1_024)) {
		fail("critic notes are invalid");
	}
	const accepted = Object.entries(SCORE_LIMITS).every(([name, minimum]) => scores[name] >= minimum);
	if (fields.accepted !== accepted) fail("critic acceptance does not match fixed score gates");
	const base = {
		schema_version: "arr.elevation3d.facade-design-review.v1",
		source_sha256: expectedSourceSha256, compilation_sha256: compiled.compilation_sha256,
		accepted, scores, notes: [...fields.notes], artifacts: verifiedArtifacts,
	};
	const review = deepFreeze({ ...base, review_sha256: sha256(stableJson(base)) });
	reviewAuthorities.set(review, Object.freeze({
		...source, compilation_sha256: compiled.compilation_sha256,
		artifacts_sha256: sha256(stableJson(verifiedArtifacts)), review_sha256: review.review_sha256, accepted,
	}));
	return review;
}
