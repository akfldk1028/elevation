import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { compileFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/compiler.mjs";
import { reviewFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/critic.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { createFacadeDesignStateStore } from "../plugins/elevation-3d/lib/facade-agent/design/state-store.mjs";
import { validateResolvedFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { createFacadeDesignFixture, createFacadeProgramForContext } from "./helpers/facade-design-fixture.ts";

const VIEWS = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

async function artifactSet(runDir: string) {
	const root = join(runDir, "review-artifacts");
	await mkdir(root);
	const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#8b3f2f" } }).png().toBuffer();
	const make = async (name: string) => {
		const path = join(root, `${name}.png`);
		await writeFile(path, png);
		return { path, sha256: sha256(png), width: 8, height: 8 };
	};
	return {
		technical_views: Object.fromEntries(await Promise.all(VIEWS.map(async (view) => [view, await make(view)]))),
		pbr_contact_sheet: await make("pbr-contact-sheet"),
		perspective_hero: await make("perspective-hero"),
	};
}

async function setup(t: any) {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({
		outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate,
		context: fixture.context, program: fixture.program, resolved, validation,
	});
	const artifacts = await artifactSet(fixture.runDir);
	const reviewSource = {
		source: fixture.context.source,
		compilation_sha256: compiled.compilation_sha256,
		artifacts,
	};
	const criticResult = {
		source_sha256: sha256(stableJson(reviewSource)), accepted: true,
		scores: {
			entrance_legibility: 90, base_middle_top_hierarchy: 88,
			repetition_variation_balance: 82, cross_view_coherence: 96,
			material_hierarchy: 84, technical_perspective_consistency: 94,
		},
		notes: ["Entrance and hierarchy are legible across elevation and perspective."],
	};
	const review = await reviewFacadeDesign({ runDir: fixture.runDir, context: fixture.context, compiled, artifacts, criticResult });
	return { ...fixture, resolved, validation, compiled, artifacts, review };
}

test("state advances atomically and a succeeded resume invokes zero work callbacks", async (t) => {
	const value = await setup(t);
	const store = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	await store.recordProposal({ context: value.context, program: value.program, resolved: value.resolved, validation: value.validation });
	await store.recordCompiled(value.compiled);
	await store.recordRendered(value.artifacts);
	await store.recordReviewed(value.review);
	const succeeded = await store.succeed({ selectedVersion: value.compiled.compilation_sha256 });
	assert.equal(succeeded.stage, "succeeded");

	const resumedStore = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	let calls = 0;
	const resumed = await resumedStore.resume({
		design: async () => { calls += 1; }, compile: async () => { calls += 1; },
		render: async () => { calls += 1; }, review: async () => { calls += 1; },
	});
	assert.equal(resumed.stage, "succeeded");
	assert.equal(calls, 0);
	const persisted: any = JSON.parse(await readFile(join(value.runDir, "facade-design", "state.json"), "utf8"));
	assert.equal(persisted.checkpoints.succeeded.selected_version, value.compiled.compilation_sha256);
});

test("status rejects a tampered perspective hero bound by the critic", async (t) => {
	const value = await setup(t);
	const store = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	await store.recordProposal({ context: value.context, program: value.program, resolved: value.resolved, validation: value.validation });
	await store.recordCompiled(value.compiled);
	await store.recordRendered(value.artifacts);
	await store.recordReviewed(value.review);
	await writeFile(value.artifacts.perspective_hero.path, "tampered");
	await assert.rejects(() => store.status(), (error: any) => error?.code === "FACADE_DESIGN_STATE_INVALID");
});

test("state rejects skipped stages and critic score self-blessing", async (t) => {
	const value = await setup(t);
	const store = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	await assert.rejects(() => store.recordCompiled(value.compiled), (error: any) => error?.code === "FACADE_DESIGN_STATE_INVALID");
	const source = { source: value.context.source, compilation_sha256: value.compiled.compilation_sha256, artifacts: value.artifacts };
	await assert.rejects(() => reviewFacadeDesign({
		runDir: value.runDir, context: value.context, compiled: value.compiled, artifacts: value.artifacts,
		criticResult: {
			source_sha256: sha256(stableJson(source)), accepted: true,
			scores: { entrance_legibility: 10, base_middle_top_hierarchy: 10, repetition_variation_balance: 10, cross_view_coherence: 10, material_hierarchy: 10, technical_perspective_consistency: 10 },
			notes: [],
		},
	}), (error: any) => error?.code === "FACADE_DESIGN_CRITIC_INVALID");
});

test("proposal checkpoint rejects mixed verified program and resolution capabilities", async (t) => {
	const value = await setup(t);
	const otherProgram = createFacadeProgramForContext(value.context, { concept_id: "different-facade-concept" });
	const otherResolved = resolveFacadeProgram(otherProgram, value.context);
	const otherValidation = validateResolvedFacadeProgram({ program: otherProgram, context: value.context, resolved: otherResolved });
	const store = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	await assert.rejects(() => store.recordProposal({
		context: value.context, program: value.program, resolved: otherResolved, validation: otherValidation,
	}), (error: any) => error?.code === "FACADE_DESIGN_STATE_INVALID");
});

test("status rejects a rehashed persisted review that self-blesses low scores", async (t) => {
	const value = await setup(t);
	const store = await createFacadeDesignStateStore({ runDir: value.runDir, source: value.context.source });
	await store.recordProposal({ context: value.context, program: value.program, resolved: value.resolved, validation: value.validation });
	await store.recordCompiled(value.compiled);
	await store.recordRendered(value.artifacts);
	await store.recordReviewed(value.review);
	const statePath = join(value.runDir, "facade-design", "state.json");
	const state: any = JSON.parse(await readFile(statePath, "utf8"));
	state.checkpoints.reviewed.scores.entrance_legibility = 0;
	const { review_sha256: _oldReview, ...reviewBase } = state.checkpoints.reviewed;
	state.checkpoints.reviewed.review_sha256 = sha256(stableJson(reviewBase));
	const { state_sha256: _oldState, ...stateBase } = state;
	state.state_sha256 = sha256(stableJson(stateBase));
	await writeFile(statePath, `${stableJson(state)}\n`);
	await assert.rejects(() => store.status(), (error: any) => error?.code === "FACADE_DESIGN_STATE_INVALID");
});
