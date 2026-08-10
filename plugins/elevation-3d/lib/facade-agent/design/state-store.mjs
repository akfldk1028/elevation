import { resolve, join } from "node:path";

import { sha256, stableJson } from "../../core.mjs";
import { atomicWrite, prepareSafeDirectory, safeRead } from "../path-safety.mjs";
import { readVerifiedFacadeProgramAuthority } from "./contract.mjs";
import { readVerifiedFacadeDesignContextAuthority } from "./context.mjs";
import { readVerifiedResolvedFacadeAuthority } from "./resolver.mjs";
import { readVerifiedFacadeDesignValidationAuthority, validateResolvedFacadeProgram } from "./validator.mjs";
import { readVerifiedFacadeCriticAuthority, verifyFacadeDesignArtifacts, verifyPersistedFacadeCriticReview } from "./critic.mjs";

const STAGES = Object.freeze(["initial", "proposal", "compiled", "rendered", "reviewed", "succeeded", "failed"]);

export class FacadeDesignStateError extends Error {
	constructor(message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = "FacadeDesignStateError";
		this.code = "FACADE_DESIGN_STATE_INVALID";
	}
}

function fail(message, cause) { throw new FacadeDesignStateError(message, cause); }

function stateEnvelope(source, stage = "initial", checkpoints = {}) {
	const base = { schema_version: "arr.elevation3d.facade-design-state.v1", source, stage, checkpoints };
	return { ...base, state_sha256: sha256(stableJson(base)) };
}

function verifyEnvelope(value, source) {
	if (!value || value.schema_version !== "arr.elevation3d.facade-design-state.v1" || !STAGES.includes(value.stage)
		|| stableJson(value.source) !== stableJson(source) || !value.checkpoints || typeof value.checkpoints !== "object") fail("persisted facade design state is invalid");
	const { state_sha256: digest, ...base } = value;
	if (digest !== sha256(stableJson(base))) fail("persisted facade design state hash changed");
	return value;
}

async function verifyCompiled(root, compiled, source) {
	if (!compiled || stableJson(compiled.source) !== stableJson(source)
		|| compiled.schema_version !== "arr.elevation3d.compiled-facade.v1"
		|| !/^[a-f0-9]{64}$/.test(compiled.compilation_sha256 ?? "")) fail("compiled checkpoint authority is invalid");
	let bytes;
	try { bytes = await safeRead(root, compiled.output.path, "compiled facade GLB"); }
	catch (error) { fail("compiled checkpoint GLB is unavailable", error); }
	if (sha256(bytes) !== compiled.output.sha256) fail("compiled checkpoint GLB hash changed");
}

export async function createFacadeDesignStateStore({ runDir, source } = {}) {
	if (!source || typeof source !== "object") fail("facade design source authority is required");
	const root = resolve(runDir);
	const stateRoot = join(root, "facade-design");
	const statePath = join(stateRoot, "state.json");
	await prepareSafeDirectory(root, stateRoot, "facade design state");
	let pending = Promise.resolve();
	const serial = (operation) => {
		const result = pending.then(operation, operation);
		pending = result.then(() => undefined, () => undefined);
		return result;
	};
	const load = async () => {
		try { return verifyEnvelope(JSON.parse((await safeRead(root, statePath, "facade design state")).toString("utf8")), source); }
		catch (error) {
			if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return stateEnvelope(source);
			if (error instanceof FacadeDesignStateError) throw error;
			fail("persisted facade design state could not be read", error);
		}
	};
	const persist = async (stage, checkpoints) => {
		const next = stateEnvelope(source, stage, checkpoints);
		await atomicWrite(statePath, `${stableJson(next)}\n`, root);
		return next;
	};
	const verifyArtifacts = async (artifacts) => {
		try { return await verifyFacadeDesignArtifacts({ runDir: root, artifacts }); }
		catch (error) { fail("rendered checkpoint artifacts are invalid", error); }
	};
	const requireStage = (state, expected) => { if (state.stage !== expected) fail(`facade design stage must be ${expected}`); };

	const api = {
		recordProposal({ context, program, resolved, validation } = {}) {
			return serial(async () => {
				const state = await load(); requireStage(state, "initial");
				const contextAuthority = readVerifiedFacadeDesignContextAuthority(context);
				const programAuthority = readVerifiedFacadeProgramAuthority(program);
				const resolvedAuthority = readVerifiedResolvedFacadeAuthority(resolved);
				const validationAuthority = readVerifiedFacadeDesignValidationAuthority(validation);
				if (!contextAuthority || !programAuthority || !resolvedAuthority || !validationAuthority || !validation.accepted
					|| stableJson(programAuthority) !== stableJson(source)) fail("proposal checkpoint authority is invalid");
				let independent;
				try { independent = validateResolvedFacadeProgram({ program, context, resolved }); }
				catch (error) { fail("proposal checkpoint capabilities do not form one verified design", error); }
				if (stableJson(independent) !== stableJson(validation)) fail("proposal checkpoint validation changed");
				return persist("proposal", { proposal: {
					program_sha256: sha256(stableJson(program)), resolution_sha256: resolved.resolution_sha256,
					validation_sha256: validation.validation_sha256,
				} });
			});
		},
		recordCompiled(compiled) {
			return serial(async () => {
				const state = await load(); requireStage(state, "proposal");
				await verifyCompiled(root, compiled, source);
				return persist("compiled", { ...state.checkpoints, compiled });
			});
		},
		recordRendered(artifacts) {
			return serial(async () => {
				const state = await load(); requireStage(state, "compiled");
				const verified = await verifyArtifacts(artifacts);
				return persist("rendered", { ...state.checkpoints, rendered: verified });
			});
		},
		recordReviewed(review) {
			return serial(async () => {
				const state = await load(); requireStage(state, "rendered");
				const authority = readVerifiedFacadeCriticAuthority(review);
				if (!authority || !authority.accepted
					|| authority.compilation_sha256 !== state.checkpoints.compiled.compilation_sha256
					|| authority.artifacts_sha256 !== sha256(stableJson(state.checkpoints.rendered))) fail("review checkpoint authority is invalid");
				return persist("reviewed", { ...state.checkpoints, reviewed: review });
			});
		},
		succeed({ selectedVersion } = {}) {
			return serial(async () => {
				const state = await load(); requireStage(state, "reviewed");
				if (selectedVersion !== state.checkpoints.compiled.compilation_sha256) fail("selected facade version is not the reviewed compilation");
				return persist("succeeded", { ...state.checkpoints, succeeded: { selected_version: selectedVersion } });
			});
		},
		status() {
			return serial(async () => {
				const state = await load();
				if (["compiled", "rendered", "reviewed", "succeeded"].includes(state.stage)) await verifyCompiled(root, state.checkpoints.compiled, source);
				if (["rendered", "reviewed", "succeeded"].includes(state.stage)) {
					const verified = await verifyArtifacts(state.checkpoints.rendered);
					if (sha256(stableJson(verified)) !== sha256(stableJson(state.checkpoints.rendered))) fail("rendered checkpoint artifacts changed");
				}
				if (["reviewed", "succeeded"].includes(state.stage)) {
					const review = state.checkpoints.reviewed;
					try { verifyPersistedFacadeCriticReview({
						source, compilationSha256: state.checkpoints.compiled.compilation_sha256,
						artifacts: state.checkpoints.rendered, review,
					}); } catch (error) { fail("reviewed checkpoint changed", error); }
				}
				if (state.stage === "succeeded"
					&& state.checkpoints.succeeded?.selected_version !== state.checkpoints.compiled.compilation_sha256) {
					fail("selected facade version changed");
				}
				return state;
			});
		},
		async resume(handlers = {}) {
			const state = await api.status();
			if (state.stage === "succeeded" || state.stage === "failed") return state;
			const callback = { initial: handlers.design, proposal: handlers.compile, compiled: handlers.render, rendered: handlers.review }[state.stage];
			if (typeof callback !== "function") return state;
			return callback(state);
		},
	};
	return Object.freeze(api);
}
