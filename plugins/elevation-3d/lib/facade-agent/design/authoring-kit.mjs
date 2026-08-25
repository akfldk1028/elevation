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
import { composePerspectiveHero, REVEAL_FACADE_PRESENTATION_STYLE } from "../final-presentation.mjs";
import { measureComposition } from "./composition.mjs";
import { locatedCodes } from "./design-agent.mjs";
import { compileFacadeDesign } from "./compiler.mjs";
import { parseFacadeDesign } from "./contract.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { buildFacadeGrammarPrompt, FACADE_GRAMMAR_V3_SCHEMA } from "./grammar/prompt.mjs";
import { resolveFacadeProgram } from "./resolver.mjs";
import { validateResolvedFacadeProgram } from "./validator.mjs";

// Presentation ambient for facades that draw their own trim. The derivation and the
// measurements live with the constant in final-presentation.mjs, which is its home now that
// the typed delivery path renders under it as well; it stays exported from here because
// every runner and the design index import it as part of the authoring kit.
export { REVEAL_FACADE_PRESENTATION_STYLE };

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
	// Following the cause chain, because the outer message is always the same sentence and the
	// one underneath it is the whole diagnosis - "facade program resolution failed" told an
	// author nothing, while its cause names the symbol, the axis and the two lengths.
	const why = (error) => {
		const chain = [];
		for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
			const message = String(current?.message ?? current);
			if (message && !chain.includes(message)) chain.push(message);
		}
		return chain.join(": ").slice(0, 900);
	};
	try { program = parseFacadeDesign(grammar, { sourceAuthority: authority }); }
	catch (error) { return { ok: false, stage: "parse", error: why(error) }; }
	try { resolved = resolveFacadeProgram(program, context); }
	catch (error) { return { ok: false, stage: "resolve", error: why(error) }; }
	const validation = validateResolvedFacadeProgram({ program, context, resolved });
	// Located, not bare. `locatedCodes` names the elevation, the member and by how much it
	// missed; a bare code is the defect this project has fixed twice already in the paid
	// loop, and the library was still handing authors the worse version while the sdd
	// checker beside it handed them the better one.
	if (!validation.accepted) {
		return { ok: false, stage: "validate", codes: validation.codes, faults: locatedCodes(validation, resolved, context) };
	}
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
	// The palette was hardcoded to competition-warm here while render-any.mjs beside it
	// took one from argv, which is why every scheme rendered warm unless someone reached
	// past the library. Four presets exist; the default is unchanged.
	palette = "competition-warm",
	renderStyleOverrides = REVEAL_FACADE_PRESENTATION_STYLE, signal,
} = {}) {
	const checked = checkAuthoredGrammar({ context, grammar });
	if (!checked.ok) {
		const detail = checked.faults?.join("; ") ?? checked.codes?.join(", ") ?? checked.error ?? "";
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
		palette: resolveMaterialPalette(palette),
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
