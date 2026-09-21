import assert from "node:assert/strict";
import test from "node:test";
import { parseFacadeDesign } from "../plugins/elevation-3d/lib/facade-agent/design/contract.mjs";

import {
	FacadeDesignResolverError,
	readVerifiedResolvedFacadeAuthority,
	resolveFacadeProgram,
} from "../plugins/elevation-3d/lib/facade-agent/design/resolver.mjs";
import {
	createFacadeDesignFixture,
	createFacadeProgramForContext,
} from "./helpers/facade-design-fixture.ts";

function typedRejection(error: unknown) {
	return error instanceof FacadeDesignResolverError && error.code === "FACADE_DESIGN_RESOLUTION_INVALID";
}

test("a source transcription retains authored ground doors beside the primary entrance", async t=>{
	const {context,program:base}=await createFacadeDesignFixture(t);
	const program=parseFacadeDesign({schema_version:"arr.elevation3d.facade-grammar.v3",concept_id:"paired-entry",source_photograph:"concept.png",start:"F",entrance:base.entrance,
		rules:{F:[{split:{axis:"z",parts:[{size:"2.4",symbol:"D"},{size:"~1",symbol:"W"}]}}],
			D:[{terminal:"door",depth_m:-0.15,inset_m:0}],W:[{terminal:"wall"}]}},{sourceAuthority:context.source});
	const resolved=resolveFacadeProgram(program,context);
	const doors=resolved.primitives.filter(p=>p.kind==="door");
	assert.ok(doors.length>1,"authored entrance panels must survive resolution");
	assert.equal(doors.filter(p=>p.role==="primary_entrance").length,1);
	for(const door of doors) {assert.equal(door.local_bounds.z_min,0);assert.ok(door.depth_m<0);}
});

test("a photographed entrance can select an actual ground facet and local position without moving the mass",async t=>{
	const {context,program:base}=await createFacadeDesignFixture(t);
	const target=context.facade_segments.find(s=>s.face_view==="back") ?? context.facade_segments.at(-1);
	const raw={schema_version:"arr.elevation3d.facade-grammar.v3",concept_id:"source-entry",source_photograph:"concept.png",start:"W",
		entrance:{...base.entrance,segment_id:target.segment_id,u_min_m:0.4},rules:{W:[{terminal:"wall"}]}};
	const resolve=(value)=>resolveFacadeProgram(parseFacadeDesign(value,{sourceAuthority:context.source}),context);
	const door=resolve(raw).primitives[0];
	assert.equal(door.segment_id,target.segment_id);assert.equal(door.local_bounds.u_min,0.4);
	assert.throws(()=>resolve({...raw,entrance:{...raw.entrance,segment_id:"nonexistent"}}));
	assert.throws(()=>resolve({...raw,entrance:{...raw.entrance,u_min_m:target.length_m}}));
});

test("source entrance trim inside the primary door survives automatic entrance exclusion",async t=>{
	const {context,program:base}=await createFacadeDesignFixture(t);
	const segment=context.facade_segments.find(s=>s.length_m===8);
	const raw={schema_version:"arr.elevation3d.facade-grammar.v3",concept_id:"entry-trim",source_photograph:"concept.png",start:"F",
		entrance:{...base.entrance,segment_id:segment.segment_id,u_min_m:0.3},
		rules:{F:[{split:{axis:"z",parts:[{size:"2.4",symbol:"B"},{size:"~1",symbol:"W"}]}}],
			B:[{split:{axis:"u",parts:[{size:"0.1",symbol:"T"},{size:"~1",symbol:"W"}]}}],
			T:[{terminal:"reveal",depth_m:-0.12,inset_m:0}],W:[{terminal:"wall"}]}};
	const resolved=resolveFacadeProgram(parseFacadeDesign(raw,{sourceAuthority:context.source}),context);
	assert.ok(resolved.primitives.some(p=>p.segment_id===segment.segment_id&&p.kind==="reveal"&&p.local_bounds.z_min===0));
});

test("resolves one ground-floor entrance onto the highest-ranked eligible segment", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	const door = resolved.primitives.find((primitive: any) => primitive.kind === "door");
	const segment = context.facade_segments.find((item: any) => item.segment_id === door.segment_id);

	assert.equal(door.family_id, "recessed_glazed_portal");
	assert.equal(door.local_bounds.z_min, 0);
	assert.equal(door.local_bounds.z_max, 2.4);
	assert.deepEqual([door.local_bounds.u_min, door.local_bounds.u_max], [3.1, 4.9]);
	assert.equal(segment.visibility_score, Math.max(...context.facade_segments.map((item: any) => item.visibility_score)));
	assert.equal(door.local_bounds.u_min >= context.exclusions.edge_clearance_m, true);
	assert.equal(door.local_bounds.u_max <= segment.length_m - context.exclusions.edge_clearance_m, true);
	// `recess_m` is a magnitude and `depth_m` is signed with positive OUT of the wall, so the
	// door's depth is the negated recess. Passed straight through, every placed entrance stood
	// proud of the facade by its own recess and drew as a flat pale slab in front of the wall -
	// named by two independent reviewers on three buildings. Negative is what makes it a hole.
	assert.equal(door.depth_m, -program.entrance.recess_m);
	assert.ok(program.entrance.recess_m > 0 && door.depth_m < 0, "a recessed entrance is set INTO the wall");
	assert.ok(Math.abs(door.depth_m) <= context.exclusions.max_recess_m);
});

test("emits deterministic window families and articulation without crossing segment bounds", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const first = resolveFacadeProgram(program, context);
	const second = resolveFacadeProgram(program, context);

	assert.deepEqual(second, first);
	assert.equal(Object.isFrozen(first), true);
	assert.match(first.resolution_sha256, /^[a-f0-9]{64}$/);
	assert.equal(first.primitives.some((primitive: any) => primitive.kind === "window" && primitive.family_id === "wide"), true);
	assert.equal(first.primitives.some((primitive: any) => primitive.kind === "pilaster"), true);
	for (const primitive of first.primitives as any[]) {
		const segment = context.facade_segments.find((item: any) => item.segment_id === primitive.segment_id);
		assert.ok(segment);
		assert.equal(primitive.local_bounds.u_min >= 0, true);
		assert.equal(primitive.local_bounds.u_max <= segment.length_m, true);
		assert.equal(primitive.local_bounds.u_min < primitive.local_bounds.u_max, true);
		if (primitive.kind === "door" || primitive.kind === "window") {
			assert.equal(primitive.local_bounds.u_min >= context.exclusions.edge_clearance_m, true);
			assert.equal(primitive.local_bounds.u_max <= segment.length_m - context.exclusions.edge_clearance_m, true);
		}
	}
});

test("repeats the bay unit across the full usable width of each segment", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	const fold = context.exclusions.fold_clearance_m;
	const longest = context.facade_segments.reduce((left: any, right: any) => (right.length_m > left.length_m ? right : left));
	const windows = resolved.primitives
		.filter((primitive: any) => primitive.kind === "window" && primitive.segment_id === longest.segment_id)
		.sort((left: any, right: any) => left.local_bounds.u_min - right.local_bounds.u_min);

	assert.equal(windows.length, (program as any).bay_rules[0].pattern.length * 2);
	assert.equal(windows[0].local_bounds.u_min, fold);
	assert.equal(windows[windows.length - 1].local_bounds.u_max, longest.length_m - fold);
});

test("clears the primary entrance of overlapping ground-storey windows", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		bay_rules: [
			{ id: "middle-aba", zone_id: "middle", pattern: ["narrow", "wide", "narrow"], repeat: 1 },
			{ id: "base-dense", zone_id: "base", pattern: ["narrow"], repeat: 1 },
		],
	});
	const resolved = resolveFacadeProgram(program, context);
	const gap = context.exclusions.edge_clearance_m;
	const door = resolved.primitives.find((primitive: any) => primitive.kind === "door");
	const entranceSegment = context.facade_segments.find((segment: any) => segment.segment_id === door.segment_id);
	const twin = context.facade_segments.find((segment: any) => segment.segment_id !== door.segment_id
		&& segment.length_m === entranceSegment.length_m);
	const groundWindows = (segmentId: string) => resolved.primitives
		.filter((primitive: any) => primitive.kind === "window" && primitive.storey === 1 && primitive.segment_id === segmentId);

	assert.equal(groundWindows(door.segment_id).length < groundWindows(twin.segment_id).length, true);
	for (const window of groundWindows(door.segment_id) as any[]) {
		assert.equal(
			window.local_bounds.u_max <= door.local_bounds.u_min - gap + 1e-8
				|| window.local_bounds.u_min >= door.local_bounds.u_max + gap - 1e-8,
			true,
		);
	}
});

test("gives each elevation its own rhythm when bay rules select views", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		bay_rules: [
			{ id: "front-aba", zone_id: "middle", pattern: ["narrow", "wide", "narrow"], repeat: 1, views: ["front"] },
			{ id: "side-n", zone_id: "middle", pattern: ["narrow"], repeat: 1, views: ["left", "right"] },
		],
	});
	const resolved = resolveFacadeProgram(program, context);
	const viewOf = (segmentId: string) => context.facade_segments
		.find((segment: any) => segment.segment_id === segmentId).face_view;
	const byRule = (ruleId: string) => new Set(resolved.primitives
		.filter((primitive: any) => primitive.rule_id === ruleId)
		.map((primitive: any) => viewOf(primitive.segment_id)));

	assert.deepEqual([...byRule("front-aba")], ["front"]);
	assert.deepEqual([...byRule("side-n")].sort(), ["left", "right"]);
	assert.equal(resolved.primitives.some((primitive: any) => primitive.kind === "window" && viewOf(primitive.segment_id) === "back"), false);
});

test("rejects a bay rule whose selected elevations cannot hold it", async (t) => {
	const { context } = await createFacadeDesignFixture(t);
	const program = createFacadeProgramForContext(context, {
		window_families: [
			{ id: "narrow", width_m: 0.8, height_m: 1.6, sill_m: 0.8 },
			{ id: "vast", width_m: 5.5, height_m: 1.6, sill_m: 0.8 },
		],
		bay_rules: [{ id: "side-vast", zone_id: "middle", pattern: ["vast"], repeat: 1, views: ["left"] }],
	});

	assert.throws(() => resolveFacadeProgram(program, context), typedRejection);
});

test("uses stable segment ID as the final tie-breaker", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t, { width: 4, depth: 4 });
	const resolved = resolveFacadeProgram(program, context);
	const door = resolved.primitives.find((primitive: any) => primitive.kind === "door");
	const eligible = context.facade_segments
		.filter((segment: any) => segment.ground_access && segment.visibility_score === Math.max(...context.facade_segments.map((item: any) => item.visibility_score)))
		.sort((left: any, right: any) => left.segment_id.localeCompare(right.segment_id));
	assert.equal(door.segment_id, eligible[0].segment_id);
});

test("rejects cloned program or context capabilities", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	assert.throws(() => resolveFacadeProgram(structuredClone(program), context), typedRejection);
	assert.throws(() => resolveFacadeProgram(program, structuredClone(context)), typedRejection);
});

test("exposes resolution authority only for the exact resolver output", async (t) => {
	const { context, program } = await createFacadeDesignFixture(t);
	const resolved = resolveFacadeProgram(program, context);
	assert.deepEqual(readVerifiedResolvedFacadeAuthority(resolved), {
		...resolved.source,
		resolution_sha256: resolved.resolution_sha256,
	});
	assert.equal(readVerifiedResolvedFacadeAuthority(structuredClone(resolved)), null);
});

// The resolver builds the placed entrance, not the grammar, so it was the one opening an
// author could put no declared material on: every window declared bronze-grey glazing and
// the door rendered in the legacy blue-tinted `glass`. A reviewer holding the perspective
// beside the axon called it a different door. `entrance.material` travels resolver ->
// typed builder (which reads `material` off any primitive) -> GLB, like a terminal's does.
test("the placed entrance takes a declared glazing through entrance.material", async t => {
	const { context, program: base } = await createFacadeDesignFixture(t);
	const raw = (material: string | null) => ({ schema_version: "arr.elevation3d.facade-grammar.v3", concept_id: "glazed-entry",
		source_photograph: "concept.png", start: "W", entrance: { ...base.entrance, material },
		materials: [{ id: "amber-glazing", substance: "glazing", lightness: "mid-dark", hue: "warm", finish: "satin", joint_m: null, reads_as: null }],
		rules: { W: [{ terminal: "wall" }] } });
	const resolve = (value: object) => resolveFacadeProgram(parseFacadeDesign(value, { sourceAuthority: context.source }), context);
	const door = resolve(raw("amber-glazing")).primitives.find((p: any) => p.role === "primary_entrance");
	assert.equal(door.material, "amber-glazing");
	assert.equal(resolve(raw(null)).primitives.find((p: any) => p.role === "primary_entrance").material, undefined, "null keeps the legacy word");
	assert.throws(() => resolve(raw("undeclared")), /entrance.material/);
});
