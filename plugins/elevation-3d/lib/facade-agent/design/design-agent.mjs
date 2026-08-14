import { join, resolve } from "node:path";

import { sha256, stableJson } from "../../core.mjs";
import { atomicWrite, prepareSafeDirectory, safeRead } from "../path-safety.mjs";
import { createFacadeGrammarRequest } from "../providers/grammar/contract.mjs";
import { measureComposition } from "./composition.mjs";
import { parseFacadeDesign } from "./contract.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { buildFacadeDesignPrompt, FACADE_PROGRAM_V2_SCHEMA } from "./prompt.mjs";
import { buildFacadeGrammarPrompt, FACADE_GRAMMAR_V3_SCHEMA } from "./grammar/prompt.mjs";
import { resolveFacadeProgram } from "./resolver.mjs";
import { validateResolvedFacadeProgram } from "./validator.mjs";

const PROVIDERS = Object.freeze({ "openai-gpt-5.5": "gpt-5.5", "byteplus-seed-mini": "seed-2-0-mini-260428" });
const MAX_CORRECTIONS = 2;
const GRAMMAR_SCHEMA_VERSION = "arr.elevation3d.facade-grammar.v3";

export class FacadeDesignAgentError extends Error {
	constructor(code, message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignAgentError";
		this.code = code;
	}
}

function fail(code, message, cause) { throw new FacadeDesignAgentError(code, message, cause); }

function providerResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("FACADE_DESIGN_AGENT_INVALID", "provider result must be a record");
	const fields = Object.getOwnPropertyDescriptors(value);
	for (const key of ["grammarCandidate", "remoteId", "actualUsd"]) {
		const descriptor = fields[key];
		if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) fail("FACADE_DESIGN_AGENT_INVALID", `provider result ${key} is invalid`);
	}
	const remoteId = fields.remoteId.value;
	const actualUsd = fields.actualUsd.value;
	if (typeof remoteId !== "string" || !remoteId || remoteId.length > 4_096 || /[\r\n\0]/.test(remoteId)
		|| !Number.isFinite(actualUsd) || actualUsd < 0) fail("FACADE_DESIGN_AGENT_INVALID", "provider receipt is invalid");
	return { grammarCandidate: fields.grammarCandidate.value, remoteId, actualUsd };
}

function safePlain(value, seen = new Set(), state = { nodes: 0 }, depth = 0) {
	if (depth > 32 || ++state.nodes > 16_384) fail("FACADE_DESIGN_AGENT_INVALID", "provider response exceeds its plain-data boundary");
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
	if (!value || typeof value !== "object" || seen.has(value)) fail("FACADE_DESIGN_AGENT_INVALID", "provider response must be acyclic plain JSON");
	seen.add(value);
	let prototype;
	let descriptors;
	try { prototype = Object.getPrototypeOf(value); descriptors = Object.getOwnPropertyDescriptors(value); }
	catch (error) { fail("FACADE_DESIGN_AGENT_INVALID", "provider response could not be inspected safely", error); }
	if (Array.isArray(value)) {
		const length = descriptors.length?.value;
		const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
		if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0 || keys.length !== length) {
			fail("FACADE_DESIGN_AGENT_INVALID", "provider response array is malformed");
		}
		const output = new Array(length);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
				|| descriptor.get || descriptor.set || !("value" in descriptor)) fail("FACADE_DESIGN_AGENT_INVALID", "provider response array contains unsafe data");
			output[Number(key)] = safePlain(descriptor.value, seen, state, depth + 1);
		}
		seen.delete(value);
		return output;
	}
	if (prototype !== Object.prototype && prototype !== null) fail("FACADE_DESIGN_AGENT_INVALID", "provider response must contain plain objects");
	const output = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key];
		if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)
			|| descriptor.get || descriptor.set || !("value" in descriptor)) fail("FACADE_DESIGN_AGENT_INVALID", "provider response contains unsafe data");
		output[key] = safePlain(descriptor.value, seen, state, depth + 1);
	}
	seen.delete(value);
	return output;
}

function responseBytes(value) {
	if (typeof value === "string") {
		if (!value.trim() || Buffer.byteLength(value) > 1024 * 1024) fail("FACADE_DESIGN_AGENT_INVALID", "provider response is empty or oversized");
		return Buffer.from(value);
	}
	let text;
	try { text = stableJson(safePlain(value)); } catch (error) {
		if (error instanceof FacadeDesignAgentError) throw error;
		fail("FACADE_DESIGN_AGENT_INVALID", "provider response is not safe JSON", error);
	}
	if (Buffer.byteLength(text) > 1024 * 1024) fail("FACADE_DESIGN_AGENT_INVALID", "provider response is oversized");
	return Buffer.from(text);
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export async function runFacadeDesignAgent({ runDir, context, provider, ledger, ceilingUsd, estimateUsd, language = "grammar", signal } = {}) {
	const authority = readVerifiedFacadeDesignContextAuthority(context);
	if (!authority) fail("FACADE_DESIGN_AGENT_INVALID", "a verified facade design context is required");
	if (!provider || PROVIDERS[provider.id] !== provider.model || typeof provider.preflight !== "function" || typeof provider.extract !== "function") {
		fail("FACADE_DESIGN_AGENT_INVALID", "an allowlisted grammar provider is required");
	}
	if (!ledger || typeof ledger.executeOnce !== "function") fail("FACADE_DESIGN_AGENT_INVALID", "a paid operation ledger is required");
	if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0 || !Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > ceilingUsd) {
		fail("FACADE_DESIGN_AGENT_INVALID", "design budgets are invalid");
	}
	const root = resolve(runDir);
	const designRoot = join(root, "facade-design");
	await prepareSafeDirectory(root, designRoot, "facade design output");
	const thumbnail = context.technical_thumbnails.find((item) => item.view === "axon") ?? context.technical_thumbnails[0];
	const imageBytes = await safeRead(root, join(root, thumbnail.path), "facade design thumbnail");
	if (sha256(imageBytes) !== thumbnail.sha256) fail("FACADE_DESIGN_AGENT_INVALID", "facade design thumbnail changed after context verification");
	let correctionCodes = [];
	let previous = null;
	const attempts = [];
	// The first structurally valid answer, kept aside. Composition is a matter of design
	// rather than of buildability, so a flat facade is worth another attempt but is not
	// worth throwing the run away over: a warehouse the user can look at and reject beats
	// no elevation at all. This is the fallback if no attempt ever composes.
	let fallback = null;
	for (let index = 0; index <= MAX_CORRECTIONS; index += 1) {
		const attempt = index + 1;
		const prompt = language === "grammar"
			? buildFacadeGrammarPrompt({ context, correctionCodes, attempt, previous })
			: buildFacadeDesignPrompt({ context, correctionCodes, attempt });
		const request = createFacadeGrammarRequest({
			provider: provider.id, model: provider.model,
			proposalSha256: thumbnail.sha256, evidenceManifestSha256: authority.context_sha256,
			promptRevision: prompt.revision, prompt: prompt.prompt, promptSha256: prompt.sha256,
			imageBytes, imageMimeType: "image/png", schema: JSON.parse(stableJson(language === "grammar" ? FACADE_GRAMMAR_V3_SCHEMA : FACADE_PROGRAM_V2_SCHEMA)),
			ceilingUsd, estimateUsd,
		});
		provider.preflight({ request });
		const attemptDir = join(designRoot, `attempt-${String(attempt).padStart(2, "0")}`);
		await prepareSafeDirectory(root, attemptDir, "facade design attempt");
		const responsePath = join(attemptDir, "response.json");
		const prepared = {
			schema_version: "arr.elevation3d.facade-design-prepared.v1", attempt,
			provider: provider.id, model: provider.model, request_sha256: request.fingerprint,
			prompt_sha256: prompt.sha256, context_sha256: authority.context_sha256,
			thumbnail_sha256: thumbnail.sha256, ceiling_usd: ceilingUsd, estimate_usd: estimateUsd,
		};
		await atomicWrite(join(attemptDir, "prepared.json"), `${stableJson(prepared)}\n`, root);
		const receipt = await ledger.executeOnce({
			requestKey: request.fingerprint, provider: provider.id, kind: "grammar-extraction",
			ceilingUsd, estimateUsd, runCeilingUsd: ceilingUsd * (MAX_CORRECTIONS + 1),
			kindCeilingUsd: ceilingUsd * (MAX_CORRECTIONS + 1), signal,
			operation: async (submission) => {
				const result = providerResult(await provider.extract({ request, submission, signal }));
				const bytes = responseBytes(result.grammarCandidate);
				await atomicWrite(responsePath, bytes, root);
				return { remoteId: result.remoteId, artifactSha256: sha256(bytes), actualUsd: result.actualUsd };
			},
		});
		let bytes;
		try { bytes = await safeRead(root, responsePath, "facade design response"); }
		catch (error) { fail("FACADE_DESIGN_RESULT_UNAVAILABLE", "persisted design response is unavailable without resubmission", error); }
		if (sha256(bytes) !== receipt.artifactSha256) fail("FACADE_DESIGN_AGENT_INVALID", "design response does not match its paid receipt");
		previous = bytes.length <= 64 * 1024 ? bytes.toString("utf8") : null;
		let program;
		let resolved;
		let validation;
		try {
			program = parseFacadeDesign(JSON.parse(bytes.toString("utf8")), { sourceAuthority: authority });
			resolved = resolveFacadeProgram(program, context);
			validation = validateResolvedFacadeProgram({ program, context, resolved });
			correctionCodes = validation.codes;
		} catch (error) {
			// Hand the parse failure back verbatim. A bare PROGRAM_INVALID leaves the
			// model correcting blind, and it repeats the same mistake every attempt.
			const reason = String(error?.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 600);
			correctionCodes = [reason ? `PROGRAM_INVALID: ${reason}` : "PROGRAM_INVALID"];
		}
		let composition = null;
		// Only a v3 grammar is held to composition, and the test is on what was actually
		// authored rather than on what was asked for, because the two can differ. A v2
		// program declares its base/middle/top zones outright and the validator already
		// checks it against them; the guidance these faults cite is written for the
		// grammar prompt and would be advice a v2 author cannot act on.
		if (validation?.accepted && program?.schema_version === GRAMMAR_SCHEMA_VERSION) {
			// Buildable is not the same as designed. The geometry gates above cannot tell a
			// composed elevation from a blank wall with slits in it, so this asks the one
			// question they miss, and asks it only once the answer is structurally sound.
			composition = measureComposition({ context, resolved });
			if (!fallback) fallback = { program, resolved, validation, composition };
			correctionCodes = composition.faults;
		}
		attempts.push({
			attempt, request_sha256: request.fingerprint, response_sha256: receipt.artifactSha256,
			validation_codes: [...correctionCodes],
			...(composition ? { composition: composition.metrics } : {}),
		});
		if (validation?.accepted && !composition?.codes.length) return deepFreeze({
			schema_version: "arr.elevation3d.facade-design-agent-result.v1",
			program, resolved, validation, attempts,
			...(composition ? { composition: composition.metrics } : {}),
		});
	}
	// Every attempt was either invalid or flat. A structurally sound one is still worth
	// returning, carrying the composition faults so the caller can say what is wrong with
	// it rather than the run ending with nothing to show.
	if (fallback) return deepFreeze({
		schema_version: "arr.elevation3d.facade-design-agent-result.v1",
		program: fallback.program, resolved: fallback.resolved, validation: fallback.validation,
		composition: fallback.composition.metrics, composition_faults: fallback.composition.codes, attempts,
	});
	fail("FACADE_DESIGN_CORRECTION_EXHAUSTED", "facade design remained invalid after two correction attempts");
}
