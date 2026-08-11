import { NodeIO } from "@gltf-transform/core";
import { relative, resolve } from "node:path";
import sharp from "sharp";

import { sha256, stableJson } from "../../core.mjs";
import { facadeCandidateHash } from "../candidate-authority.mjs";
import { readVerifiedFacadeEvidenceAuthority } from "../evidence.mjs";
import { containedPath, safeRead } from "../path-safety.mjs";
import { assertCanonicalFacadeSegmentAuthority } from "../punched-facade.mjs";
import { deriveFacadeFaces } from "./geometry/faces.mjs";

export class FacadeDesignContextError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignContextError";
		this.code = "FACADE_DESIGN_CONTEXT_INVALID";
	}
}

const HASH = /^[a-f0-9]{64}$/;
const VIEWS = new Set(["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"]);
const REF_KEYS = new Set(["path", "sha256"]);
const THUMBNAIL_KEYS = new Set(["view", "path", "sha256", "width", "height"]);
const OPENING_KINDS = new Set(["door", "window", "glass"]);
const LOCAL_BOUND_KEYS = ["u0", "u1", "v0", "v1", "n0", "n1"];
const verifiedContextAuthorities = new WeakMap();

export function readVerifiedFacadeDesignContextAuthority(value) {
	const authority = value && typeof value === "object" ? verifiedContextAuthorities.get(value) : null;
	return authority ? { ...authority } : null;
}

function fail(message, cause) {
	throw new FacadeDesignContextError(message, cause);
}

function record(value, label, allowed) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain data object`);
	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch (error) {
		fail(`${label} could not be inspected safely`, error);
	}
	if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain data object`);
	const output = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !allowed.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) {
			fail(`${label} contains an unauthorized field or accessor`);
		}
		output[key] = descriptor.value;
	}
	return output;
}

function hash(value, label) {
	if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256 hash`);
	return value;
}

function finite(value, label) {
	if (!Number.isFinite(value)) fail(`${label} must be finite`);
	return value;
}

function plainArray(value, label, minimum, maximum) {
	let prototype;
	let descriptors;
	try {
		if (!Array.isArray(value)) fail(`${label} must be an array`);
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch (error) {
		if (error instanceof FacadeDesignContextError) throw error;
		fail(`${label} could not be inspected safely`, error);
	}
	const length = descriptors.length?.value;
	const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
	if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < minimum || length > maximum || keys.length !== length) {
		fail(`${label} has an invalid size or shape`);
	}
	const output = new Array(length);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
			|| descriptor.get || descriptor.set || !("value" in descriptor)) fail(`${label} contains unsafe data`);
		output[Number(key)] = descriptor.value;
	}
	return output;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function portable(root, path) {
	const absolute = containedPath(root, path, "facade design artifact");
	return relative(resolve(root), absolute).replaceAll("\\", "/");
}

async function verifiedRef(runDir, value, label) {
	const ref = record(value, label, REF_KEYS);
	if (typeof ref.path !== "string" || !ref.path) fail(`${label}.path is required`);
	const expected = hash(ref.sha256, `${label}.sha256`);
	const absolute = resolve(runDir, ref.path);
	let bytes;
	try { bytes = await safeRead(runDir, absolute, label); }
	catch (error) { fail(`${label} is unavailable or unsafe`, error); }
	if (sha256(bytes) !== expected) fail(`${label} hash does not match its bytes`);
	return { ref: { path: portable(runDir, absolute), sha256: expected }, bytes };
}

function visibilityScore(normal, depth) {
	const score = normal.reduce((sum, value, index) => sum + value * depth[index], 0);
	return Number(Math.max(0, score).toFixed(8));
}

function existingOpenings(document, segmentIds) {
	const openings = [];
	for (const node of document.getRoot().listNodes()) {
		const extras = node.getExtras();
		if (!extras || typeof extras !== "object" || (!extras.segment_id && !extras.local_bounds)) continue;
		if (openings.length >= 512) fail("selected GLB contains too many editable openings");
		const kind = extras.kind ?? extras.semantic_role;
		if (!OPENING_KINDS.has(kind) || typeof extras.segment_id !== "string" || !segmentIds.has(extras.segment_id)) {
			fail("selected GLB contains an opening without valid semantic segment authority");
		}
		const bounds = record(extras.local_bounds, `opening ${node.getName()} local_bounds`, new Set(LOCAL_BOUND_KEYS));
		const normalized = Object.fromEntries(LOCAL_BOUND_KEYS.map((key) => [key, finite(bounds[key], `opening ${node.getName()}.${key}`)]));
		if (!(normalized.u0 < normalized.u1 && normalized.v0 < normalized.v1 && normalized.n0 <= normalized.n1)) {
			fail("selected GLB opening bounds are invalid");
		}
		openings.push({ kind, segment_id: extras.segment_id, local_bounds: normalized });
	}
	return openings.sort((left, right) => left.segment_id.localeCompare(right.segment_id)
		|| left.local_bounds.v0 - right.local_bounds.v0 || left.local_bounds.u0 - right.local_bounds.u0);
}

async function verifiedThumbnails(runDir, value) {
	const thumbnails = plainArray(value, "technicalThumbnails", 1, 4);
	const views = new Set();
	const output = [];
	for (let index = 0; index < thumbnails.length; index += 1) {
		const item = record(thumbnails[index], `technicalThumbnails[${index}]`, THUMBNAIL_KEYS);
		if (!VIEWS.has(item.view) || views.has(item.view)) fail("technical thumbnails must use distinct supported views");
		views.add(item.view);
		if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)
			|| item.width < 1 || item.height < 1 || item.width > 4096 || item.height > 4096) {
			fail("technical thumbnail dimensions are invalid");
		}
		const verified = await verifiedRef(runDir, { path: item.path, sha256: item.sha256 }, `technical thumbnail ${item.view}`);
		let metadata;
		try { metadata = await sharp(verified.bytes).metadata(); }
		catch (error) { fail(`technical thumbnail ${item.view} is not a valid image`, error); }
		if (metadata.format !== "png" || metadata.width !== item.width || metadata.height !== item.height) {
			fail(`technical thumbnail ${item.view} metadata does not match its authority`);
		}
		output.push({ view: item.view, ...verified.ref, width: item.width, height: item.height });
	}
	return output;
}

export async function buildFacadeDesignContext(input) {
	try {
		if (!input || typeof input !== "object") fail("facade design context input is required");
		const runDir = resolve(input.runDir);
		const candidate = input.candidate;
		const evidenceAuthority = readVerifiedFacadeEvidenceAuthority(input.evidence);
		if (!evidenceAuthority?.facadeSegmentAuthority) fail("verified facade segment evidence authority is required");
		if (candidate?.candidate?.candidate_id !== evidenceAuthority.candidateId
			|| candidate?.identity?.geometry_hash !== evidenceAuthority.geometryHash) fail("candidate identity does not match verified evidence");
		const candidateSha256 = facadeCandidateHash(candidate);
		if (!candidate.facade_segment_authority) fail("candidate facade segment authority is required");
		let canonicalSegments;
		try {
			canonicalSegments = assertCanonicalFacadeSegmentAuthority({ mesh: candidate.mesh, facadeSegmentAuthority: candidate.facade_segment_authority });
		} catch (error) { fail("candidate facade segment authority is not canonical MASS geometry", error); }
		if (canonicalSegments.sha256 !== evidenceAuthority.facadeSegmentAuthority.sha256
			|| stableJson(canonicalSegments.facade_planes.map((segment) => segment.segment_id))
				!== stableJson(evidenceAuthority.facadeSegmentAuthority.segmentIds)) {
			fail("candidate facade segments do not match verified evidence");
		}
		const floors = plainArray(candidate?.floor_guides?.floor_guides_m, "floor guides", 2, 129)
			.map((value, index) => finite(value, `floor guides[${index}]`));
		if (floors.some((value, index) => index > 0 && value <= floors[index - 1]) || stableJson(floors) !== stableJson(evidenceAuthority.floorGuides)) {
			fail("floor guides do not match verified evidence");
		}
		const depth = plainArray(candidate?.cameras?.views?.axon?.projection_axes?.depth, "axon camera depth", 3, 3)
			.map((value, index) => finite(value, `axon camera depth[${index}]`));
		const selected = await verifiedRef(runDir, input.selectedGlb, "selected GLB");
		let document;
		try { document = await new NodeIO().readBinary(new Uint8Array(selected.bytes)); }
		catch (error) { fail("selected GLB is invalid", error); }
		const segmentIds = new Set(canonicalSegments.facade_planes.map((segment) => segment.segment_id));
		const elevationDepths = Object.fromEntries(["front", "back", "left", "right"].map((view) => [
			view,
			plainArray(candidate?.cameras?.views?.[view]?.projection_axes?.depth, `${view} camera depth`, 3, 3)
				.map((value, index) => finite(value, `${view} camera depth[${index}]`)),
		]));
		let faceAuthority;
		try { faceAuthority = deriveFacadeFaces(canonicalSegments.facade_planes, elevationDepths); }
		catch (error) { fail("candidate facade faces could not be derived", error); }
		const facadeSegments = canonicalSegments.facade_planes.map((segment) => ({
			segment_id: segment.segment_id,
			view: segment.view,
			local_u: [0, segment.extent_m[0]],
			local_z: [segment.origin[2], segment.origin[2] + segment.extent_m[1]],
			outward_normal: [...segment.normal],
			length_m: segment.extent_m[0],
			visibility_score: visibilityScore(segment.normal, depth),
			ground_access: Math.abs(segment.origin[2] - floors[0]) <= 1e-7,
			...faceAuthority.bySegment[segment.segment_id],
		}));
		const storeys = floors.slice(0, -1).map((zMin, index) => ({ storey: index + 1, z_min: zMin, z_max: floors[index + 1] }));
		const technicalThumbnails = await verifiedThumbnails(runDir, input.technicalThumbnails);
		const base = {
			schema_version: "arr.elevation3d.facade-design-context.v1",
			facade_segments: facadeSegments,
			facade_faces: faceAuthority.faces.map((face) => ({ ...face, axis: [...face.axis], segment_ids: [...face.segment_ids] })),
			storeys,
			existing_openings: existingOpenings(document, segmentIds),
			exclusions: { edge_clearance_m: 0.3, fold_clearance_m: 0.3, floor_band_clearance_m: 0.15, max_projection_m: 0.5, max_recess_m: 0.5 },
			technical_thumbnails: technicalThumbnails,
			evidence: { manifest_sha256: evidenceAuthority.manifestSha256, contact_sheet_sha256: evidenceAuthority.contactSheetSha256 },
		};
		if (facadeCandidateHash(candidate) !== candidateSha256) fail("candidate changed while its design context was being verified");
		const sourceAuthority = {
			candidate_id: evidenceAuthority.candidateId,
			candidate_sha256: candidateSha256,
			selected_glb_sha256: selected.ref.sha256,
		};
		const source = { ...sourceAuthority, context_sha256: sha256(stableJson({ ...base, source: sourceAuthority })) };
		const context = deepFreeze({ ...base, source });
		verifiedContextAuthorities.set(context, Object.freeze({ ...source }));
		return context;
	} catch (error) {
		if (error instanceof FacadeDesignContextError) throw error;
		fail("facade design context could not be verified", error);
	}
}

export async function withVerifiedFacadeDesignContext(input, handoff) {
	if (typeof handoff !== "function") fail("facade design handoff callback is required");
	return handoff(await buildFacadeDesignContext(input));
}
