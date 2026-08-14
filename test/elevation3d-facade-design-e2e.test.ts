import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import { sha256 } from "../plugins/elevation-3d/lib/core.mjs";
import { runFacadeDesignWorkflow } from "../plugins/elevation-3d/lib/facade-agent/design/index.mjs";
import { runFacadeDesignAgent } from "../plugins/elevation-3d/lib/facade-agent/design/design-agent.mjs";
import { compileFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/compiler.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { createFacadeDesignStateStore } from "../plugins/elevation-3d/lib/facade-agent/design/state-store.mjs";
import { validateResolvedFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { consumePaidOperationSubmissionCapability, createPaidOperationLedger } from "../plugins/elevation-3d/lib/facade-agent/paid-operation-ledger.mjs";
import { createFacadeDesignFixture } from "./helpers/facade-design-fixture.ts";

const VIEWS = ["front", "back", "left", "right", "plan", "top", "axon", "opposite-axon"];

async function createOfflineArtifacts(runDir: string) {
	const root = join(runDir, "resume-render"); await mkdir(root);
	const technical: any = {};
	for (const [index, view] of VIEWS.entries()) {
		const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 80 + index * 10, g: 70, b: 60 } } }).png().toBuffer();
		const path = join(root, `${view}.png`); await writeFile(path, bytes);
		technical[view] = { path, sha256: sha256(bytes), width: 96, height: 96 };
	}
	const contactBytes = await sharp({ create: { width: 384, height: 192, channels: 3, background: "#fafaf7" } }).png().toBuffer();
	const contactPath = join(root, "contact.png"); await writeFile(contactPath, contactBytes);
	const heroBytes = await sharp({ create: { width: 192, height: 128, channels: 3, background: "#776655" } }).png().toBuffer();
	const heroPath = join(root, "hero.png"); await writeFile(heroPath, heroBytes);
	return {
		technical_views: technical,
		pbr_contact_sheet: { path: contactPath, sha256: sha256(contactBytes), width: 384, height: 192 },
		perspective_hero: { path: heroPath, sha256: sha256(heroBytes), width: 192, height: 128 },
	};
}

test("offline fixture produces one compiled facade, eight elevations, contact sheet, and perspective hero", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const ledgerRoot = join(fixture.root, "e2e-ledger");
	await mkdir(ledgerRoot);
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
	const { source: _source, ...proposal } = structuredClone(fixture.program);
	let modelCalls = 0;
	const provider = {
		id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture",
		preflight() {},
		async extract({ request, submission }: any) {
			modelCalls += 1;
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider: "openai-gpt-5.5", kind: "grammar-extraction",
			}), true);
			return { grammarCandidate: proposal, remoteId: "offline-facade-program", actualUsd: 0 };
		},
	};
	let renderCalls = 0, criticCalls = 0;
	const state: any = await runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		provider, ledger, ceilingUsd: 0.1, estimateUsd: 0.05,
		render: async ({ runDir }: any) => {
			renderCalls += 1;
			const root = join(runDir, "offline-render"); await mkdir(root);
			const technical: any = {};
			for (const [index, view] of VIEWS.entries()) {
				const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 95 + index * 12, g: 55 + index * 5, b: 45 + index * 3 } } }).png().toBuffer();
				const path = join(root, `${view}.png`); await writeFile(path, bytes);
				technical[view] = { path, sha256: sha256(bytes), width: 96, height: 96 };
			}
			const contactBytes = await sharp({ create: { width: 384, height: 192, channels: 3, background: "#fafaf7" } })
				.composite(await Promise.all(VIEWS.map(async (view, index) => ({ input: await readFile(technical[view].path), left: (index % 4) * 96, top: Math.floor(index / 4) * 96 })))).png().toBuffer();
			const contactPath = join(root, "contact-sheet.png"); await writeFile(contactPath, contactBytes);
			const heroBytes = await sharp(await readFile(technical.axon.path)).resize(192, 128, { fit: "fill" }).png().toBuffer();
			const heroPath = join(root, "perspective-hero.png"); await writeFile(heroPath, heroBytes);
			return { artifacts: {
				technical_views: technical,
				pbr_contact_sheet: { path: contactPath, sha256: sha256(contactBytes), width: 384, height: 192 },
				perspective_hero: { path: heroPath, sha256: sha256(heroBytes), width: 192, height: 128 },
			} };
		},
		critic: async ({ sourceSha256 }: any) => {
			criticCalls += 1;
			return {
				source_sha256: sourceSha256, accepted: true,
				scores: { entrance_legibility: 90, base_middle_top_hierarchy: 88, repetition_variation_balance: 84, cross_view_coherence: 96, material_hierarchy: 82, technical_perspective_consistency: 94 },
				notes: ["Offline fixture preserves a clear entrance, hierarchy, and two-family rhythm."],
			};
		},
	});
	assert.equal(state.stage, "succeeded");
	assert.equal(modelCalls, 1); assert.equal(renderCalls, 1); assert.equal(criticCalls, 1);
	assert.equal((await ledger.summary()).costs.total.actual_micros, 0);
	const glbPath = state.checkpoints.compiled.output.path;
	const document = await new NodeIO().read(glbPath);
	const extras = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives()).map((primitive) => primitive.getExtras());
	assert.equal(extras.filter((item) => item.kind === "door" && item.role === "primary_entrance").length, 1);
	assert.deepEqual([...new Set(extras.filter((item) => item.kind === "window").map((item) => item.family_id))].sort(), ["narrow", "wide"]);
	assert.equal(Object.keys(state.checkpoints.rendered.technical_views).length, 8);
});

test("workflow resumes a compiled crash checkpoint with zero model calls", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({ outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate, context: fixture.context, program: fixture.program, resolved, validation });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: fixture.program, resolved, validation });
	await store.recordCompiled(compiled);
	let modelCalls = 0, renderCalls = 0;
	const stop = new Error("stop after proving compiled resume");
	await assert.rejects(() => runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		provider: { id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture", preflight() {}, async extract() { modelCalls += 1; } },
		ledger: {}, ceilingUsd: 0.1, estimateUsd: 0.05,
		render: async () => {
			renderCalls += 1;
			assert.equal((await store.status()).stage, "compiled");
			throw stop;
		}, critic: async () => ({}),
	}), stop);
	assert.equal(modelCalls, 0);
	assert.equal(renderCalls, 1);
});

test("workflow resumes a persisted proposal with zero additional model calls", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const ledgerRoot = join(fixture.root, "proposal-ledger"); await mkdir(ledgerRoot);
	const ledger = createPaidOperationLedger(join(ledgerRoot, "paid.json"), { approvedRoot: ledgerRoot });
	const { source: _source, ...proposal } = structuredClone(fixture.program);
	let modelCalls = 0, renderCalls = 0;
	const provider = {
		id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture", preflight() {},
		async extract({ request, submission }: any) {
			modelCalls += 1;
			assert.equal(consumePaidOperationSubmissionCapability(submission, {
				requestKey: request.fingerprint, provider: "openai-gpt-5.5", kind: "grammar-extraction",
			}), true);
			return { grammarCandidate: proposal, remoteId: "persisted-proposal", actualUsd: 0 };
		},
	};
	const design = await runFacadeDesignAgent({ runDir: fixture.runDir, context: fixture.context, provider, ledger, ceilingUsd: 0.1, estimateUsd: 0.05 });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: design.program, resolved: design.resolved, validation: design.validation });
	const stop = new Error("stop after proving proposal resume");
	await assert.rejects(() => runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		provider, ledger, ceilingUsd: 0.1, estimateUsd: 0.05,
		render: async () => { renderCalls += 1; throw stop; }, critic: async () => ({}),
	}), stop);
	assert.equal(modelCalls, 1);
	assert.equal(renderCalls, 1);
});

test("workflow resumes verified rendered artifacts without rerendering", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({ outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate, context: fixture.context, program: fixture.program, resolved, validation });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: fixture.program, resolved, validation });
	await store.recordCompiled(compiled);
	await store.recordRendered(await createOfflineArtifacts(fixture.runDir));
	let renderCalls = 0, criticCalls = 0;
	const state: any = await runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		render: async () => { renderCalls += 1; throw new Error("render must not replay"); },
		critic: async ({ sourceSha256 }: any) => {
			criticCalls += 1;
			return {
				source_sha256: sourceSha256, accepted: true,
				scores: { entrance_legibility: 90, base_middle_top_hierarchy: 88, repetition_variation_balance: 84, cross_view_coherence: 96, material_hierarchy: 82, technical_perspective_consistency: 94 },
				notes: ["Verified rendered checkpoint resumed without replay."],
			};
		},
	});
	assert.equal(state.stage, "succeeded");
	assert.equal(renderCalls, 0);
	assert.equal(criticCalls, 1);
});

test("workflow reviews with the deterministic critic when no critic is supplied", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({ outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate, context: fixture.context, program: fixture.program, resolved, validation });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: fixture.program, resolved, validation });
	await store.recordCompiled(compiled);
	await store.recordRendered(await createOfflineArtifacts(fixture.runDir));
	const state: any = await runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		render: async () => { throw new Error("render must not replay"); },
	});

	assert.equal(state.stage, "succeeded");
	const review = state.checkpoints.reviewed;
	assert.equal(review.accepted, true);
	assert.equal(review.scores.entrance_legibility, 100);
	assert.equal(review.scores.base_middle_top_hierarchy, 100);
	assert.equal(review.scores.material_hierarchy, 100);
	assert.match(review.notes[0], /^Openings \d+ on \d+\/\d+ segments, \d+ framed\.$/);
});

test("workflow retries the legacy local resume failure from its verified compiled checkpoint", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({ outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate, context: fixture.context, program: fixture.program, resolved, validation });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: fixture.program, resolved, validation });
	await store.recordCompiled(compiled);
	await store.fail({ code: "FACADE_DESIGN_RESUME_REQUIRED" });
	let modelCalls = 0, renderCalls = 0;
	const stop = new Error("stop after proving failed checkpoint recovery");
	await assert.rejects(() => runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		provider: { id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture", preflight() {}, async extract() { modelCalls += 1; } },
		ledger: {}, ceilingUsd: 0.1, estimateUsd: 0.05,
		render: async () => {
			renderCalls += 1;
			assert.equal((await store.status()).stage, "compiled");
			throw stop;
		}, critic: async () => ({}),
	}), stop);
	assert.equal(modelCalls, 0);
	assert.equal(renderCalls, 1);
});

test("workflow retries a local render failure from its verified compiled checkpoint", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	const compiled = await compileFacadeDesign({ outputRoot: join(fixture.runDir, "compiled"), candidate: fixture.candidate, context: fixture.context, program: fixture.program, resolved, validation });
	const store = await createFacadeDesignStateStore({ runDir: fixture.runDir, source: fixture.context.source });
	await store.recordProposal({ context: fixture.context, program: fixture.program, resolved, validation });
	await store.recordCompiled(compiled);
	await store.fail({ code: "FACADE_DESIGN_WORKFLOW_FAILED" });
	let modelCalls = 0, renderCalls = 0;
	const stop = new Error("stop after proving local render retry");
	await assert.rejects(() => runFacadeDesignWorkflow({
		runDir: fixture.runDir, candidate: fixture.candidate, context: fixture.context,
		provider: { id: "openai-gpt-5.5", model: "gpt-5.5", transport: "fixture", preflight() {}, async extract() { modelCalls += 1; } },
		ledger: {}, ceilingUsd: 0.1, estimateUsd: 0.05,
		render: async () => {
			renderCalls += 1;
			assert.equal((await store.status()).stage, "compiled");
			throw stop;
		}, critic: async () => ({}),
	}), stop);
	assert.equal(modelCalls, 0);
	assert.equal(renderCalls, 1);
});
