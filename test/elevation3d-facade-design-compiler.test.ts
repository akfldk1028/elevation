import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { NodeIO } from "@gltf-transform/core";

import { sha256, stableJson } from "../plugins/elevation-3d/lib/core.mjs";
import { compileFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/compiler.mjs";
import { resolveFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import { validateResolvedFacadeProgram } from "../plugins/elevation-3d/lib/facade-agent/design/validator.mjs";
import { createFacadeDesignFixture, createFacadeProgramForContext } from "./helpers/facade-design-fixture.ts";

test("compiler publishes an immutable facade GLB without changing source authority", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	assert.equal(validation.accepted, true);
	const originalPath = join(fixture.runDir, "selected.glb");
	const originalHash = sha256(await readFile(originalPath));

	const compiled = await compileFacadeDesign({
		outputRoot: join(fixture.root, "compiled"), candidate: fixture.candidate,
		context: fixture.context, program: fixture.program, resolved, validation,
	});

	assert.equal(sha256(await readFile(originalPath)), originalHash);
	assert.equal(compiled.schema_version, "arr.elevation3d.compiled-facade.v1");
	assert.equal(compiled.source.selected_glb_sha256, fixture.context.source.selected_glb_sha256);
	assert.equal(compiled.resolution_sha256, resolved.resolution_sha256);
	assert.equal(compiled.validation_sha256, validation.validation_sha256);
	assert.equal(compiled.authority.floor_guides_sha256, sha256(stableJson(fixture.floorGuides)));
	assert.equal(compiled.authority.cameras_sha256, sha256(stableJson(fixture.cameras)));
	assert.equal(compiled.output.sha256, sha256(await readFile(compiled.output.path)));

	const document = await new NodeIO().read(compiled.output.path);
	const exactMass = document.getRoot().listMeshes().find((mesh) => mesh.getName() === "exact-mass");
	assert.ok(exactMass);
	assert.deepEqual(
		Array.from(exactMass!.listPrimitives()[0].getAttribute("POSITION")!.getArray()!),
		Array.from(new Float32Array(fixture.mesh.vertices.flat())),
	);
	const semanticExtras = document.getRoot().listMeshes()
		.flatMap((mesh) => mesh.listPrimitives()).map((primitive) => primitive.getExtras()).filter((extras) => extras.kind);
	const semanticKinds = semanticExtras.map((extras) => extras.kind);
	assert.ok(semanticKinds.includes("door"));
	assert.ok(semanticKinds.includes("window"));
	assert.ok(semanticKinds.includes("window-frame"));
	const framedSources = new Set(semanticExtras.filter((extras) => extras.kind === "window-frame")
		.map((extras) => `${extras.source_kind}:${extras.segment_id}`));
	const expectedFramedSources = new Set(semanticExtras.filter((extras) => extras.kind === "door" || extras.kind === "window")
		.map((extras) => `${extras.kind}:${extras.segment_id}`));
	assert.deepEqual(framedSources, expectedFramedSources);
	assert.equal(semanticKinds.filter((kind) => kind === "window-frame").length, expectedFramedSources.size * 2);
	assert.ok(compiled.output.detail_primitive_count > resolved.primitives.length);
	assert.equal(document.getRoot().listTextures().length, 6);

	await assert.rejects(() => compileFacadeDesign({
		outputRoot: join(fixture.root, "compiled"), candidate: fixture.candidate,
		context: fixture.context, program: fixture.program, resolved, validation,
	}), (error: any) => error?.code === "FACADE_DESIGN_COMPILE_OUTPUT_EXISTS");
});

test("compiler rejects cloned or rejected validation before publishing", async (t) => {
	const fixture = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(fixture.program, fixture.context);
	const validation = validateResolvedFacadeProgram({ program: fixture.program, context: fixture.context, resolved });
	for (const supplied of [{ ...validation }, { ...validation, accepted: false }]) {
		await assert.rejects(() => compileFacadeDesign({
			outputRoot: join(fixture.root, `rejected-${String(supplied.accepted)}`), candidate: fixture.candidate,
			context: fixture.context, program: fixture.program, resolved, validation: supplied,
		}), (error: any) => error?.code === "FACADE_DESIGN_COMPILE_INVALID");
	}
});

test("compiler supports every articulation kind admitted by FacadeProgramV2", async (t) => {
	for (const kind of ["reveal", "lintel", "sill", "pilaster", "band", "cornice"]) {
		const fixture = await createFacadeDesignFixture(t);
		const program = createFacadeProgramForContext(fixture.context, { articulation: [{
			id: `${kind}-feature`, kind, segment_selector: "primary_visible_segment",
			width_m: 0.25, depth_m: 0.12, storeys: [1, 2], material_id: "brick-primary",
		}] });
		const resolved = resolveFacadeProgram(program, fixture.context);
		const validation = validateResolvedFacadeProgram({ program, context: fixture.context, resolved });
		assert.equal(validation.accepted, true, kind);
		const compiled = await compileFacadeDesign({
			outputRoot: join(fixture.root, `compiled-${kind}`), candidate: fixture.candidate,
			context: fixture.context, program, resolved, validation,
		});
		assert.ok(compiled.output.detail_primitive_count >= resolved.primitives.length);
	}
});
