import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildEnrichedScene, writeEnrichedGlb } from "../../enrichment.mjs";
import { sha256, stableJson } from "../../core.mjs";
import { facadeCandidateHash } from "../candidate-authority.mjs";
import { assertNoReparsePoints, atomicWrite, prepareSafeDirectory } from "../path-safety.mjs";
import { assertCanonicalFacadeSegmentAuthority } from "../punched-facade.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { readVerifiedFacadeProgramAuthority } from "./contract.mjs";
import { readVerifiedResolvedFacadeAuthority } from "./resolver.mjs";
import { readVerifiedFacadeDesignValidationAuthority, validateResolvedFacadeProgram } from "./validator.mjs";

export class FacadeDesignCompileError extends Error {
	constructor(code, message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignCompileError";
		this.code = code;
	}
}

function fail(code, message, cause) { throw new FacadeDesignCompileError(code, message, cause); }

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}


/**
 * The declared material a grammar names for the mass itself, read off any `wall` terminal.
 *
 * `wall` is the one terminal that draws nothing - it is how a grammar says "leave this part
 * of the building as it is" - so the material on it was never carried anywhere. It is also
 * the only place an author can say what the building is MADE of rather than what is hung on
 * it, and every author who declared a shell material wrote it exactly there.
 *
 * One shell per building, because the mass is one body: the first declared id wins and the
 * rest are the author's own to reconcile. A grammar that names none keeps the palette role
 * it always had, so nothing already rendered moves.
 */
function shellMaterialId(program) {
	const declared = new Set((program?.materials ?? []).map((material) => material?.id).filter(Boolean));
	if (declared.size === 0) return null;
	// The authored program lists its rules; the parsed one keys them by symbol. Accept either,
	// because reading the wrong shape here threw inside the compiler and surfaced only as
	// "facade design compilation failed" with the cause dropped.
	const rules = Array.isArray(program?.rules)
		? program.rules.map((rule) => rule?.alternatives)
		: Object.values(program?.rules ?? {});
	for (const alternatives of rules) {
		for (const alternative of alternatives ?? []) {
			if (alternative?.terminal === "wall" && declared.has(alternative?.material)) return alternative.material;
		}
	}
	return null;
}

export async function compileFacadeDesign({ outputRoot, candidate, context, program, resolved, validation } = {}) {
	let versionDir;
	try {
		const contextAuthority = readVerifiedFacadeDesignContextAuthority(context);
		const programAuthority = readVerifiedFacadeProgramAuthority(program);
		const resolutionAuthority = readVerifiedResolvedFacadeAuthority(resolved);
		const validationAuthority = readVerifiedFacadeDesignValidationAuthority(validation);
		if (!contextAuthority || !programAuthority || !resolutionAuthority || !validationAuthority || !validation.accepted) {
			fail("FACADE_DESIGN_COMPILE_INVALID", "accepted verified facade design capabilities are required");
		}
		if (stableJson(programAuthority) !== stableJson(contextAuthority)
			|| stableJson(resolutionAuthority) !== stableJson({ ...contextAuthority, resolution_sha256: resolved.resolution_sha256 })
			|| stableJson(validationAuthority) !== stableJson({
				...contextAuthority, resolution_sha256: resolved.resolution_sha256,
				validation_sha256: validation.validation_sha256, accepted: true,
			})) fail("FACADE_DESIGN_COMPILE_INVALID", "facade compiler authorities do not share one source");
		if (facadeCandidateHash(candidate) !== contextAuthority.candidate_sha256) {
			fail("FACADE_DESIGN_COMPILE_INVALID", "candidate authority changed after context verification");
		}
		const independentValidation = validateResolvedFacadeProgram({ program, context, resolved });
		if (stableJson(independentValidation) !== stableJson(validation)) {
			fail("FACADE_DESIGN_COMPILE_INVALID", "facade validation does not match independent verification");
		}
		assertCanonicalFacadeSegmentAuthority({ mesh: candidate.mesh, facadeSegmentAuthority: candidate.facade_segment_authority });

		const root = resolve(outputRoot);
		await prepareSafeDirectory(root, root);
		versionDir = join(root, resolved.resolution_sha256);
		try { await mkdir(versionDir); }
		catch (error) {
			if (error?.code === "EEXIST") fail("FACADE_DESIGN_COMPILE_OUTPUT_EXISTS", "compiled facade version already exists");
			throw error;
		}
		await assertNoReparsePoints(versionDir);
		const scene = buildEnrichedScene({
			mesh: candidate.mesh, floorGuides: candidate.floor_guides,
			facadePlanes: candidate.facade_segment_authority,
			typedPrimitives: resolved.primitives,
			// The materials this design declared, so a member made of one gets a glTF material
			// with the substance's own factors instead of dying on a lookup in a fixed table.
			// Narrowed on shape, not on schema version: a v2 program carries a `materials` field
			// of its own with an entirely different meaning, and reading it as declarations threw
			// inside the GLB writer with no hint of where it came from.
			declaredMaterials: (program.materials ?? []).filter((material) => typeof material?.id === "string" && typeof material?.axon_pbr === "string"),
			// What the BUILDING is made of, as opposed to what is applied to it. `wall` emits no
			// geometry, so a material written on one was inert prose - and the mass is the largest
			// surface in every drawing, so every scheme printed the palette's concrete role
			// whatever its author specified. Measured across five buildings with five different
			// declared shells: the same #ddd3c3 covered 32-77% of each front elevation, and a
			// reviewer comparing them with their concepts named it the single most damaging
			// difference in the set - the value structure came out inverted every time, light wall
			// with dark openings where four of the five concepts are dark wall with bright ones.
			shellMaterial: shellMaterialId(program),
		});
		const glb = await writeEnrichedGlb(scene, join(versionDir, "facade.glb"), { approvedRoot: root });
		const manifestBase = {
			schema_version: "arr.elevation3d.compiled-facade.v1",
			source: { ...contextAuthority },
			concept_id: program.concept_id,
			resolution_sha256: resolved.resolution_sha256,
			validation_sha256: validation.validation_sha256,
			authority: {
				mass_sha256: sha256(stableJson({ vertices: candidate.mesh.vertices, triangles: candidate.mesh.triangles })),
				floor_guides_sha256: sha256(stableJson(candidate.floor_guides)),
				facade_segments_sha256: sha256(stableJson(candidate.facade_segment_authority)),
				cameras_sha256: sha256(stableJson(candidate.cameras)),
			},
			output: { path: glb.path, sha256: glb.sha256, detail_primitive_count: glb.detail_primitives.length },
		};
		const manifest = deepFreeze({ ...manifestBase, compilation_sha256: sha256(stableJson(manifestBase)) });
		await atomicWrite(join(versionDir, "compiled-facade.json"), `${stableJson(manifest)}\n`, root);
		return manifest;
	} catch (error) {
		if (error instanceof FacadeDesignCompileError) throw error;
		if (versionDir) await rm(versionDir, { recursive: true, force: true });
		fail("FACADE_DESIGN_COMPILE_INVALID", "facade design compilation failed", error);
	}
}
