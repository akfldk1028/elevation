import { resolve } from "node:path";

import { sha256, stableJson } from "../../core.mjs";
import { compileFacadeDesign } from "./compiler.mjs";
import { reviewFacadeDesign, verifyFacadeDesignArtifacts } from "./critic.mjs";
import { runFacadeDesignAgent } from "./design-agent.mjs";
import { createFacadeDesignCritic } from "./scoring.mjs";
import { createFacadeDesignStateStore, isRetryableCompiledFailure } from "./state-store.mjs";

const ACTIONS = Object.freeze(["prepare", "design", "compile", "review", "status", "resume"]);
const deterministicCritic = createFacadeDesignCritic();

export function facadeDesignAgentToolSchema() {
	return {
		type: "object", additionalProperties: false,
		properties: {
			action: { type: "string", enum: [...ACTIONS], default: "prepare" },
			run_dir: { type: "string", minLength: 1, maxLength: 1024 },
			confirm_live: { type: "boolean", default: false },
			provider: { type: "string", enum: ["byteplus-seed-mini", "openai-gpt-5.6"] },
			ceiling_usd: { type: "number", minimum: 0, maximum: 1 },
			estimate_usd: { type: "number", minimum: 0, maximum: 1 },
		},
		required: ["action", "run_dir"],
	};
}

function toolError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

export async function runFacadeDesignWorkflow({ runDir, candidate, context, provider, ledger, ceilingUsd, estimateUsd, render, critic = deterministicCritic, signal } = {}) {
	const root = resolve(runDir);
	const store = await createFacadeDesignStateStore({ runDir: root, source: context.source });
	const current = await store.status();
	if (current.stage === "succeeded") return current;
	try {
		if (current.stage === "reviewed") {
			return store.succeed({ selectedVersion: current.checkpoints.compiled.compilation_sha256 });
		}
		let compiled, artifacts;
		if (current.stage === "rendered") {
			compiled = current.checkpoints.compiled;
			artifacts = current.checkpoints.rendered;
		} else if (current.stage === "initial" || current.stage === "proposal") {
			const design = await runFacadeDesignAgent({ runDir: root, context, provider, ledger, ceilingUsd, estimateUsd, signal });
			if (current.stage === "initial") {
				await store.recordProposal({ context, program: design.program, resolved: design.resolved, validation: design.validation });
			} else {
				const proposal = current.checkpoints.proposal;
				if (proposal?.program_sha256 !== sha256(stableJson(design.program))
					|| proposal.resolution_sha256 !== design.resolved.resolution_sha256
					|| proposal.validation_sha256 !== design.validation.validation_sha256) {
					throw toolError("FACADE_DESIGN_PROPOSAL_MISMATCH", "persisted facade proposal does not match its paid-operation ledger response");
				}
			}
			compiled = await compileFacadeDesign({
				outputRoot: resolve(root, "compiled"), candidate, context,
				program: design.program, resolved: design.resolved, validation: design.validation,
			});
			await store.recordCompiled(compiled);
		} else if (current.stage === "compiled"
			|| (current.stage === "failed"
				&& isRetryableCompiledFailure(current.checkpoints.failed?.code)
				&& current.checkpoints.compiled)) {
			if (current.stage === "failed") await store.retryCompiled();
			compiled = current.checkpoints.compiled;
		} else {
			throw toolError("FACADE_DESIGN_RESUME_REQUIRED", "an incomplete facade design must resume from its persisted checkpoint");
		}
		if (!artifacts) {
			if (typeof render !== "function") throw toolError("FACADE_DESIGN_RENDER_REQUIRED", "a local facade render dependency is required");
			const rendered = await render({ runDir: root, candidate, context, compiled, signal });
			artifacts = await verifyFacadeDesignArtifacts({ runDir: root, artifacts: rendered.artifacts });
			await store.recordRendered(artifacts);
		}
		if (typeof critic !== "function") throw toolError("FACADE_DESIGN_CRITIC_REQUIRED", "a facade critic dependency is required");
		const criticSourceSha256 = sha256(stableJson({ source: context.source, compilation_sha256: compiled.compilation_sha256, artifacts }));
		const criticResult = await critic({
			runDir: root, context, compiled, artifacts, sourceSha256: criticSourceSha256,
			technicalViews: artifacts.technical_views, pbrContactSheet: artifacts.pbr_contact_sheet,
			perspectiveHero: artifacts.perspective_hero, signal,
		});
		const review = await reviewFacadeDesign({ runDir: root, context, compiled, artifacts, criticResult });
		await store.recordReviewed(review);
		return store.succeed({ selectedVersion: compiled.compilation_sha256 });
	} catch (error) {
		await store.fail({ code: typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : "FACADE_DESIGN_WORKFLOW_FAILED" }).catch(() => {});
		throw error;
	}
}

export async function runFacadeDesignAgentTool(args = {}, signal, defaults = {}, dependencyFactory) {
	signal?.throwIfAborted();
	const action = args.action ?? "prepare";
	if (!ACTIONS.includes(action)) throw toolError("FACADE_DESIGN_ACTION_INVALID", "facade design action is not supported");
	if (typeof args.run_dir !== "string" || !args.run_dir || /\0/.test(args.run_dir)) throw toolError("FACADE_DESIGN_PATH_INVALID", "a bounded run directory is required");
	if (typeof dependencyFactory !== "function") {
		if (action !== "prepare") throw toolError("FACADE_DESIGN_DEPENDENCIES_REQUIRED", "active facade design operations require configured dependencies");
		return {
			schema_version: "arr.elevation3d.facade-design-tool.v1", stage: "preflight",
			action, run_dir: args.run_dir, live_calls: 0,
			next: ["design", "compile", "review", "status", "resume"],
			message: "Offline preflight only. Live design requires explicit provider, cost ceiling, and confirmation.",
		};
	}
	const dependencies = await dependencyFactory({ args, signal, defaults });
	const operation = dependencies?.[action] ?? dependencies?.execute;
	if (typeof operation !== "function") throw toolError("FACADE_DESIGN_DEPENDENCIES_REQUIRED", `facade design ${action} dependency is missing`);
	if (action === "design" && dependencies.provider?.transport !== "fixture" && args.confirm_live !== true) {
		throw toolError("LIVE_CONFIRMATION_REQUIRED", "live facade design requires explicit confirmation");
	}
	return operation({ ...args, action }, signal);
}

export { buildFacadeDesignContext } from "./context.mjs";
export { parseFacadeProgram } from "./contract.mjs";
export { resolveFacadeProgram } from "./resolver.mjs";
export { validateResolvedFacadeProgram } from "./validator.mjs";
export { compileFacadeDesign } from "./compiler.mjs";
export { runFacadeDesignAgent } from "./design-agent.mjs";
export { reviewFacadeDesign } from "./critic.mjs";
export { createFacadeDesignCritic, scoreFacadeDesign } from "./scoring.mjs";
export { createFacadeDesignStateStore } from "./state-store.mjs";
