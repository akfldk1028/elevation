/**
 * Authoring a facade grammar without the paid director.
 *
 * The only paid operation in this pipeline is asking a provider for a FacadeGrammarV3
 * object. Everything after it - parse, resolve, validate, composition, compile, render - is
 * local deterministic code, so an author reached some other way can be held to exactly the
 * same standard. This module is that path: it hands out the brief the director would have
 * sent, applies the gates the director applies, and renders what clears them.
 *
 * It deliberately does not relabel an answer as one of the allowlisted providers. A grammar
 * authored here never touches the paid-operation ledger, so nothing claims a call was made
 * that was not.
 *
 * What it cannot do is stand in for a live run. An author with this repository open can read
 * `composition.mjs` and hand-compute its coordinates before answering, which is why grammars
 * written this way clear the gates first time; the paid provider sees a prompt and a
 * thumbnail. Clearing these gates says the grammar is good, not that the prompt is.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256, stableJson } from "../../core.mjs";
import { technicalCameraAuthorityFromGlb } from "../../camera-authority.mjs";
import { renderAllViews } from "../../all-views.mjs";
import { deriveDeliveryCameras } from "../../final-delivery.mjs";
import { resolveMaterialPalette } from "../../material-palettes.mjs";
import { renderEmbeddedPbrViews } from "../../texturing/render-validator.mjs";
import { composePerspectiveHero } from "../final-presentation.mjs";
import { measureComposition } from "./composition.mjs";
import { compileFacadeDesign } from "./compiler.mjs";
import { parseFacadeDesign } from "./contract.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { buildFacadeGrammarPrompt, FACADE_GRAMMAR_V3_SCHEMA } from "./grammar/prompt.mjs";
import { resolveFacadeProgram } from "./resolver.mjs";
import { validateResolvedFacadeProgram } from "./validator.mjs";

/**
 * Presentation ambient for facades that draw their own trim.
 *
 * The `competition-daylight-v1` preset was calibrated on facades with almost no jamb
 * reveals. Once a grammar nests every opening the way the guidance asks, the bronze role
 * goes from under 2% of the building to about 13%, and those returns face into the opening
 * where they see the sky and the room environment and almost none of the sun. The building's
 * luminance floor then falls to about 3 against the range gate's `luminanceP05 >= 10`.
 *
 * Ambient alone does not clear it: on the most glazed scheme measured, the top end reached
 * 239 against a 248 ceiling before the shadows reached 10. Ambient up and exposure down
 * together squeeze both ends, and ACES rolls the highlights off so the floor gains more than
 * the ceiling loses. Measured across six schemes: P05 13.3 to 62.6, P95 at most 243.1.
 *
 * This is an override rather than a change to the preset because the preset's values are
 * pinned by `elevation3d-texturing-render-style.test.ts` and by every retained baseline.
 */
export const REVEAL_FACADE_PRESENTATION_STYLE = Object.freeze({
	materialResponse: { glass: { tintMultiplier: "#5f8194" } },
	environment: { intensity: 1.7 },
	hemisphere: { intensity: 2.2 },
	exposure: 0.86,
});

/**
 * Write the brief an author needs: the prompt the director would have sent, the schema the
 * answer has to satisfy, and a readable digest of the geometry it is designing for.
 *
 * @returns {Promise<{prompt: string, promptSha256: string, paths: object}>}
 */
export async function writeGrammarBrief({ runDir, context } = {}) {
	if (!context?.facade_segments || !context?.storeys) throw new TypeError("a verified facade design context is required");
	const built = buildFacadeGrammarPrompt({ context, correctionCodes: [], attempt: 1, previous: null });
	const paths = {
		prompt: join(runDir, "grammar-prompt.txt"),
		schema: join(runDir, "grammar-schema.json"),
		context: join(runDir, "context-summary.json"),
	};
	await writeFile(paths.prompt, built.prompt, "utf8");
	await writeFile(paths.schema, `${JSON.stringify(JSON.parse(stableJson(FACADE_GRAMMAR_V3_SCHEMA)), null, 2)}\n`, "utf8");
	await writeFile(paths.context, `${stableJson({
		storeys: context.storeys,
		facade_segments: context.facade_segments.map((segment) => ({
			segment_id: segment.segment_id, face_view: segment.face_view ?? segment.view,
			length_m: segment.length_m, local_z: segment.local_z,
			ground_access: segment.ground_access, visibility_score: segment.visibility_score,
		})),
		exclusions: context.exclusions,
		existing_openings: context.existing_openings,
	})}\n`, "utf8");
	return { prompt: built.prompt, promptSha256: built.sha256, paths };
}

/**
 * Hold an authored grammar to the director's gates, in the director's order.
 *
 * Returns rather than throws, because the point is to hand an author something it can act
 * on. `stage` names the gate that stopped it and the payload carries that gate's own
 * language: parse and resolve report their message, validate reports its codes, composition
 * reports faults that each carry their measurement.
 *
 * @returns {{ok: boolean, stage: string, ...}}
 */
export function checkAuthoredGrammar({ context, grammar } = {}) {
	const authority = readVerifiedFacadeDesignContextAuthority(context);
	if (!authority) throw new TypeError("a verified facade design context is required");
	let program;
	let resolved;
	try { program = parseFacadeDesign(grammar, { sourceAuthority: authority }); }
	catch (error) { return { ok: false, stage: "parse", error: String(error?.message ?? error).slice(0, 900) }; }
	try { resolved = resolveFacadeProgram(program, context); }
	catch (error) { return { ok: false, stage: "resolve", error: String(error?.message ?? error).slice(0, 900) }; }
	const validation = validateResolvedFacadeProgram({ program, context, resolved });
	if (!validation.accepted) return { ok: false, stage: "validate", codes: validation.codes };
	const composition = measureComposition({ context, resolved });
	const kinds = {};
	for (const primitive of resolved.primitives) kinds[primitive.kind] = (kinds[primitive.kind] ?? 0) + 1;
	return {
		ok: composition.codes.length === 0,
		stage: composition.codes.length ? "composition" : "accepted",
		primitives: resolved.primitives.length, kinds,
		metrics: composition.metrics, faults: composition.faults,
		program, resolved, validation,
	};
}

/**
 * Compile an accepted grammar and render every view from it, hero included.
 *
 * Refuses anything the gates have not cleared, so a caller cannot skip
 * `checkAuthoredGrammar` by coming straight here.
 */
export async function renderAuthoredFacade({
	runDir, candidate, context, grammar, outputSize = 1600,
	renderStyleOverrides = REVEAL_FACADE_PRESENTATION_STYLE, signal,
} = {}) {
	const checked = checkAuthoredGrammar({ context, grammar });
	if (!checked.ok) {
		const detail = checked.codes?.join(", ") ?? checked.faults?.join("; ") ?? checked.error ?? "";
		throw new Error(`grammar was rejected at ${checked.stage}: ${detail}`);
	}
	const { program, resolved, validation } = checked;
	const compiled = await compileFacadeDesign({
		outputRoot: join(runDir, "compiled"), candidate, context, program, resolved, validation,
	});
	const cameras = deriveDeliveryCameras(candidate);
	const technicalRoot = join(runDir, "technical-render");
	const designManifestPath = join(dirname(compiled.output.path), "compiled-facade.json");
	const technical = await renderAllViews({
		runDir: technicalRoot, glbPath: compiled.output.path, sourceMesh: candidate.mesh,
		floorGuides: candidate.floor_guides, facadePlanes: candidate.facade_planes,
		facadeSegmentAuthority: candidate.facade_segment_authority, cameras,
		designFacadeManifest: { path: designManifestPath, sha256: sha256(await readFile(designManifestPath)) },
		palette: resolveMaterialPalette("competition-warm"),
		candidateId: candidate.candidate?.candidate_id ?? candidate.candidate_id, cutElevationM: 1.2, signal,
	});
	const pbrRoot = join(runDir, "pbr-render");
	const technicalCameraAuthority = await technicalCameraAuthorityFromGlb({ bytes: await readFile(compiled.output.path), cameras });
	const pbr = await renderEmbeddedPbrViews({
		glbPath: compiled.output.path, runDir: pbrRoot,
		candidateId: candidate.candidate?.candidate_id ?? candidate.candidate_id, cameras,
		expectedTechnicalCameras: technicalCameraAuthority.cameras,
		baselineRunDir: technicalRoot, baselineManifestRecord: technical.manifest_record,
		outputSize, renderStyleOverrides, signal,
	});
	if (!pbr.validation.accepted) throw new Error(`PBR validation rejected: ${pbr.validation.codes.join(", ")}`);
	const heroPath = join(pbrRoot, "perspective-hero.png");
	const heroBytes = await composePerspectiveHero({ sourceBytes: await readFile(pbr.views.axon.path) });
	await writeFile(heroPath, heroBytes);
	return {
		compiled, technical, pbr,
		hero: { path: heroPath, sha256: sha256(heroBytes) },
		composition: checked.metrics,
	};
}
