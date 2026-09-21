/**
 * A BASE MODEL onto one of our masses: the facets of the candidate, chained into one run around
 * the building and unfolded, become the host; the Python evaluator lays the base spec over it
 * with the edits (size, pitch, thickness, web, lean) and hands every cell to its facet; a
 * grammar - a glass box behind, the veil of modules in front - carries the cells through the
 * gates. The result is a spec, an evaluation and a grammar in the candidate's run directory,
 * checked; drawing it is `draw` as for any grammar.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT, runDirFor } from "./config.mjs";
import { checkFacadeGrammar } from "./index.mjs";
import { evaluateLattice, readAuthoredGrammar } from "./lattice.mjs";
import { prepareFacadeContext } from "./prepare.mjs";
import { MAX_LATTICE_CELLS } from "../../plugins/elevation-3d/lib/facade-agent/lattice-budgets.mjs";
import { measureFacadeCoverage } from "./facade-coverage.mjs";
import { registerWallCharts } from './wall-chart.mjs';

// Measured retained cove runs: 1,964*16 points -> 13.6 MB; 2,748*12 -> 15.0 MB.
// Preserve that established quality envelope; a section spends (4+r) vertex blocks,
// as independently checked by measure-module-cost.mjs. Exact scene gates still decide.
const COVE_POINT_BUDGET = 33_000;
const pointBudget = (profile) => COVE_POINT_BUDGET * 7 / (4 + (profile ? (profile.rings ?? 3) : 0));

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const script = join(REPO_ROOT, "tools", "facade-parametric", "cli.py");

/** The facets in order around the building: each facet's end is the next one's start. */
export function chainFacets(segments) {
	const tangent = (n) => { const h = Math.hypot(n[0], n[1]) || 1; return [-n[1] / h, n[0] / h]; };
	const ends = segments.map((s) => {
		const t = tangent(s.outward_normal);
		return { s, start: [s.origin_m[0], s.origin_m[1]], end: [s.origin_m[0] + t[0] * s.length_m, s.origin_m[1] + t[1] * s.length_m] };
	});
	const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3;
	// EVERY facet ends up in the run. The walk used to stop at the first break and drop the rest,
	// which is invisible on a prism (all sixteen facets chain) and ruinous on a mass that steps:
	// the bent bar put 2 of its 37 facets in the run and the cleft block 1 of its 113, so the veil
	// covered a corner of the building and nothing else. A mass whose plan is several loops, or
	// whose facets sit at different heights, is a sequence of RUNS: each is walked to its end,
	// then the next starts at a facet no other facet leads into (a chain head) if there is one.
	const ordered = [];
	const used = new Set();
	const noPredecessor = (k) => !ends.some((e, j) => j !== k && !used.has(j) && near(ends[k].start, e.end));
	while (used.size < ends.length) {
		let head = ends.findIndex((e, k) => !used.has(k) && noPredecessor(k));
		if (head < 0) head = ends.findIndex((e, k) => !used.has(k));
		used.add(head); ordered.push(ends[head]);
		for (;;) {
			const last = ordered.at(-1);
			const next = ends.findIndex((e, k) => !used.has(k) && near(e.start, last.end));
			if (next < 0) break;
			used.add(next); ordered.push(ends[next]);
		}
	}
	return ordered.map((e) => e.s);
}

/** --faces names sheets, not the exclusive dimensioning assignment. The viewer renders
 * the mass double-sided: BOTH normal signs can contribute (cleft/re-entrant courses).
 * Nonzero |n.depth| keeps all potentially projected facets; occluded facets are retained
 * conservatively. This is projected coverage, not a claim of ray-tested visibility. */
export function selectSheetFacets(facets, faces, cameras) {
	if (!faces?.length) return facets;
	const depths = faces.map((face) => {
		const depth = cameras?.views?.[face]?.projection_axes?.depth;
		if (!Array.isArray(depth) || depth.length !== 3 || !depth.every(Number.isFinite)
			|| Math.hypot(...depth) === 0) throw new Error(`missing valid elevation camera: ${face}`);
		return depth;
	});
	return facets.filter((s) => depths.some((depth) => Math.abs(s.outward_normal.reduce((sum, n, k) => sum + n * depth[k], 0)) > 1e-9));
}

/**
 * What a veil has to be on THIS mass, when the caller has not said.
 *
 * A base model is a design at one size; a mass is whatever size it is. Every drawing until now had
 * me pick `--scale` and `--points` per building (1.0 on the star prism, 1.8 on the bent bar, 2.4 on
 * the cleft block), which is per-building tuning by hand - exactly what the rest of this lane
 * refuses to do. Both numbers are derivable from the mass:
 *
 * - allocation is derived from the shared GLB/vertex/index budget. The completed
 *   scene still has to satisfy its exact byte, vertex, index and primitive gates.
 * - the ring points are what the 16 MB GLB budget leaves. Measured on written files (7 rings a
 *   module): 1,964 cells x 16 points wrote 13.6 MB, 2,748 x 12 wrote 15.0, 3,156 x 12 projected
 *   16.15 and was refused - so cells x points at about 33,000 is the budget, and the points fall
 *   out of the cell count. Clamped to the contract's own 8..32.
 *
 * - when that quality envelope cannot fit, a pleated host spends the section
 *   before its cell width: a linear funnel instead of a cove, bounded by the host median.
 * All choices are reported. An unaffordable veil is refused, never enlarged past that bound.
 */
export function veilForMass({ base, host, edits = {} }) {
	const lattice = base?.families?.[0]?.lattice;
	const [ax, ay] = lattice?.basis_a_uv_m ?? [1, 0];
	const [bx, by] = lattice?.basis_b_uv_m ?? [0, 1];
	const footprint = Math.abs(ax * by - ay * bx) || 1;
	const area = (host.width_m ?? 0) * (host.height_m ?? 0);
	const CELL_CAP = MAX_LATTICE_CELLS, CELL_TARGET = 0.9 * CELL_CAP;
	let scale = edits.scale !== undefined ? Number(edits.scale)
		: Math.max(1, Math.round(Math.sqrt(area / (footprint * CELL_TARGET)) * 100) / 100);
	const widths = (host.segments ?? []).map(s => s.length_m).filter(x => x > 0).sort((a,b) => a-b);
	const middle = Math.floor(widths.length / 2);
	const median = widths.length ? (widths.length % 2 ? widths[middle] : (widths[middle-1]+widths[middle])/2) : null;
	const mouth = base?.families?.[0]?.mouth;
	const POINT_BUDGET = pointBudget(edits.profile ?? mouth?.profile);
	const sides = mouth?.sides ?? [[1,0],[0,1]];
	// The projected U width of the parallelogram, not |basis_a| (the pitch).
	const unitWidth = sides.reduce((sum, [i,j]) => sum + Math.abs(i*ax+j*bx), 0) * Number(edits.pitch ?? 1);
	const scaleLimit = median && unitWidth ? median / unitWidth : Infinity;
	let profile;
	// The established 33k point envelope preserves already fitting designs. If its
	// minimum 8 samples cannot fit, spend the cove: 4 vertex blocks rather than 7.
	// Keep the actual cell width <= the host median, rounding DOWN to avoid overshoot.
	if (mouth?.kind === 'parallelogram' && median && edits.scale === undefined
		&& (scale > scaleLimit || area / (footprint*scale*scale) * 8 > POINT_BUDGET)) {
		scale = Math.floor(scaleLimit * 100) / 100;
		if (!(scale > 0)) throw new Error('host pleats are too narrow for a positive cell scale');
		profile = { kind: 'linear', rings: 0 };
	}
	const cells = Math.max(1, Math.round(area / (footprint * scale * scale)));
	const points = edits.points !== undefined ? Number(edits.points)
		: Math.min(24, Math.max(8, Math.floor(pointBudget(profile ?? edits.profile ?? mouth?.profile) / cells)));
	return { scale, points, ...(profile ? {profile} : {}), unit_width_m:unitWidth, cell_width_m: unitWidth*scale,
		median_facet_width_m: median, scale_limit: scaleLimit, estimated_cells: cells, chose: {
		scale: edits.scale === undefined, points: edits.points === undefined } };
}

export async function applyBaseModel({ candidateId, specPath, name, edits = {}, faces }) {
	const { context, runDir, candidate } = await prepareFacadeContext({ candidateId });
	const facets = selectSheetFacets(chainFacets(context.facade_segments), faces, candidate.cameras);
	if (!facets.length) throw new Error("no facets in the run");
	let zMin = Math.min(...facets.map((s) => s.local_z[0])), zMax = Math.max(...facets.map((s) => s.local_z[1]));
	const topStorey = context.storeys?.at(-1)?.storey ?? 1;
	const host = {
		kind: "facet_run", locked: true, candidate: candidateId,
		segments: facets.map((s) => ({ id: s.segment_id, length_m: s.length_m, view: s.face_view })),
		height_m: Number((zMax - zMin).toFixed(6)),
		dimension_provenance: `the candidate's facets, chained and unfolded (${facets.length} facets)`,
	};
	// The veil sizes itself to this mass unless the caller said otherwise.
	const base0 = JSON.parse(await readFile(resolve(specPath), "utf8"));
	const fitted = veilForMass({ base: base0, host: { ...host, width_m: host.segments.reduce((sum, s) => sum + s.length_m, 0) }, edits });
	edits = { ...edits, scale: fitted.scale, points: fitted.points, ...(fitted.profile ? {profile:fitted.profile} : {}) };
    // A cell that cannot fit the pleated host's measured width uses the actual wall
    // polygon and preserves its original opening when cut. Existing fitting models
    // retain their established host, model hash and geometry.
    let chartRegistration=null;
    if(fitted.profile) {
        host.boundary_policy='preserve_pattern';
        if(fitted.chose.scale) edits.auto_boundary_budget=true;
        const all=facets.flatMap(s=>s.wall_patch.rings.flat());
        zMin=Math.min(...all.map(p=>p[1]));zMax=Math.max(...all.map(p=>p[1]));
        host.height_m=zMax-zMin;
        chartRegistration=registerWallCharts(facets);
        const charts=new Map(chartRegistration.segments.map(s=>[s.segment_id,s.affine]));
        host.width_m=chartRegistration.width_m;
        host.segments=facets.map(s=>{
            const us=s.wall_patch.rings.flat().map(p=>p[0]),lo=Math.min(...us),hi=Math.max(...us);
            const [a,b,c]=charts.get(s.segment_id);
            return {id:s.segment_id,view:s.face_view,length_m:hi-lo,u_min_m:lo,
                chart_affine:[a,b,c+b*zMin],
                rings_m:s.wall_patch.rings.map(r=>r.map(([u,z])=>[u,z-zMin]))};
        });
    }

	const dir = join(runDir, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "host.json"), JSON.stringify(host, null, 1));
    if(chartRegistration)await writeFile(join(dir,'chart-registration.json'),JSON.stringify(chartRegistration,null,2));
	const specOut = join(dir, "spec.json");
	// Estimating the cell count from the run's area under-counts it (the lattice covers the run's
	// bounding rectangle with a margin, and a stepped mass keeps only the part of each column its
	// facet spans): the bent bar estimated 2,162 and evaluated 3,527. So the fit is CLOSED on the
	// evaluation - lay it, count what came out, lay it again when the cells are over the contract's
	// cap or the rings are over what the byte budget leaves.
	const CELL_CAP = MAX_LATTICE_CELLS, CELL_TARGET = 0.9 * CELL_CAP;
	let applied = null;
	let converged = false;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const POINT_BUDGET = pointBudget(edits.profile ?? base0.families[0].mouth?.profile);
		await writeFile(join(dir, "edits.json"), JSON.stringify(edits, null, 1));
		let stdout;
		try { ({ stdout } = await exec(python, [script, "apply", resolve(specPath), join(dir, "host.json"), specOut, join(dir, "edits.json")], { maxBuffer: 64 * 1024 * 1024, timeout: 600000 })); }
		catch (error) {
			const refusal = `${error.stdout ?? ""}${error.stderr ?? error.message}`;
			if (!/more than \d+ cells/.test(refusal) || !fitted.chose.scale || attempt === 4) {
				throw new Error(`base model apply failed (${error.code ?? error.signal}): ${refusal}`);
			}
			if (edits.profile) throw new Error(`cell budget cannot fit within the host median ${fitted.median_facet_width_m} m: ${refusal}`);
			edits = { ...edits, scale: Math.round(edits.scale * 1.3 * 100) / 100 };
			continue;
		}
		applied = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
		if (!applied.ok) throw new Error(`base model apply refused: ${applied.error}`);
        if(applied.chosen_scale!==undefined) edits.scale=applied.chosen_scale;
		const cells = applied.instances ?? 0;
		if (cells > CELL_CAP && fitted.chose.scale) {
			if (edits.profile) throw new Error(`evaluated ${cells} facet parts exceed ${CELL_CAP}; refusing to enlarge cells beyond the host pleat`);
			edits = { ...edits, scale: Math.round(edits.scale * Math.sqrt(cells / CELL_TARGET) * 100) / 100 };
			continue;
		}
		if (!edits.profile && fitted.chose.scale && fitted.chose.points && cells * 8 > POINT_BUDGET
			&& Number.isFinite(fitted.scale_limit)) {
			edits = { ...edits, scale: Math.floor(fitted.scale_limit*100)/100, points:8, profile:{kind:'linear',rings:0} };
			continue;
		}
		const points = Math.min(24, Math.max(8, Math.floor(POINT_BUDGET / Math.max(1, cells))));
		if (fitted.chose.points && points < edits.points) { edits = { ...edits, points }; continue; }
		fitted.scale = edits.scale; fitted.points = edits.points; fitted.cells = cells;
		converged = true;
		break;
	}
	if (!applied || !converged) throw new Error("the veil could not be sized to this mass within the evaluation budget; no stale iteration was accepted");
	await writeFile(join(dir, "edits.json"), JSON.stringify(edits, null, 1));
	const evaluated = await evaluateLattice({ specPath: specOut, outDir: join(dir, "lattice") });
	// The grammar: a glass box behind (storey split, slab courses, glass), the veil in front.
	const base = JSON.parse(await readFile(resolve(specPath), "utf8"));
	const family = base.families[0].id;
	const grammar = veilGrammar({ name, base, family, candidateId, facets, edits, evaluated, zMin, topStorey, faces, wallPatch:host.boundary_policy === 'preserve_pattern' });
    if(host.boundary_policy === 'preserve_pattern') {
        const request={segments:host.segments,storeys:context.storeys.map(s=>({storey:s.storey,z_min_m:s.z_min-zMin,z_max_m:s.z_max-zMin})),
            fold_clearance_m:context.exclusions.fold_clearance_m,floor_clearance_m:context.exclusions.floor_band_clearance_m,slab_margin_m:0.2};
        await writeFile(join(dir,'backing-request.json'),JSON.stringify(request));
        const {stdout}=await exec(python,[script,'backing',join(dir,'backing-request.json'),join(dir,'backing-instances.json')],{timeout:600000,maxBuffer:1024*1024});
        const backing=JSON.parse(stdout.trim());
        if(!backing.ok)throw new Error(`wall backing refused: ${backing.error}`);
        // Replace only the rectangular panes. The original slab courses remain
        // behind the veil; changing the aperture domain must not delete them.
        grammar.rules.find(r=>r.name==='GlassBox').alternatives=[{split:{axis:'layer',parts:[
            {size:'~1',symbol:'PolygonBacking'},{size:'~1',symbol:'BackingBands'}]}}];
        grammar.rules.push({name:'PolygonBacking',alternatives:[{terminal:'glass',depth_m:-0.05,material:'box-glazing',
            lattice:{scope:'wall_openings',model_hash:backing.model_hash,family:'wall-backing',instances:'backing-instances.json',z_datum_m:zMin}}]},
            {name:'BackingBands',alternatives:[{split:{axis:'storey',parts:[{size:'~1',symbol:'GlassStorey'}]}}]});
        grammar.rules.find(r=>r.name==='Pane').alternatives=[{terminal:'wall'}];
    }
	const grammarPath = join(dir, "grammar.json");
	await writeFile(grammarPath, JSON.stringify(grammar, null, 1));
	const checked = checkFacadeGrammar({ context, grammar: await readAuthoredGrammar(grammarPath) });
	return { ok: checked.ok, stage: checked.stage, candidate: candidateId, name, dir, facets: facets.length, host,
        ...(chartRegistration?{chart_registration:chartRegistration.diagnostics}:{}),
		geometry_coverage: measureFacadeCoverage(candidate.mesh, context.facade_segments),
		veil: { scale: fitted.scale, points: fitted.points, chose: fitted.chose, estimated_cells: fitted.estimated_cells,
			...(applied.boundary_budget ? {boundary_budget:applied.boundary_budget} : {}),
			...(edits.profile ? {profile:edits.profile} : {}), median_facet_width_m:fitted.median_facet_width_m,
			cell_width_m:fitted.unit_width_m * edits.scale,
			within_median_facet: fitted.median_facet_width_m === null ? null : fitted.unit_width_m * edits.scale <= fitted.median_facet_width_m,
			solid_instances:applied.solid_instances, solid_fraction:applied.solid_instances / applied.instances,
		},
		applied: { instances: applied.instances, model_hash: applied.model_hash, lattice: applied.lattice },
		grammar: grammarPath, primitives: checked.primitives, codes: checked.codes, faults: checked.faults, ...(checked.error ? { error: checked.error } : {}) };
}

/**
 * The grammar a base model is drawn through: a glass box behind, the veil of modules in front,
 * and - where the run was limited to some faces - a crown on the rest.
 *
 * Extracted so the rules can be read and tested without laying a lattice: the one that needed it
 * is the crown, which was written twice wrong before it was right.
 */
export function veilGrammar({ name, base, family, candidateId, facets, edits, evaluated, zMin, topStorey, faces, wallPatch = false }) {
	return {
		schema_version: "arr.elevation3d.facade-grammar.v3",
		concept_id: `${name}`,
		start: "F",
		// A door goes on a facet that can hold it, so it is sized from the WIDEST facet less the fold
		// clearance either side, and never below the 0.8 m the schema allows. Sizing it from the
		// NARROWEST asked every facet to be a possible door: the star prism's 2.2 m facets gave 1.5 m,
		// and the cleft block, whose narrowest facet is a few centimetres, gave a negative number the
		// parser refused. The resolver ranks the segments that fit and says so when none does.
		entrance: { segment_selector: "primary_visible_ground_segment", preferred_bay: "central_or_corner_focus", door_family: "recessed-glazed",
			width_m: Math.max(0.8, Math.min(1.8, Number((Math.max(...facets.map((s) => s.length_m)) - 0.7).toFixed(2)))), height_m: 2.4, recess_m: 0.15, material: "box-glazing" },
		materials: [
			// MID, not pale. A pale veil standing on a pale mass in a bright environment leaves the
			// drawing with no tonal range at all: the cleft block measured a material separation of
			// 10.1 against the 15 the presentation gate asks for on its front, and the roof view came
			// back a flat white field. The veil is the thing in front; it carries the tone.
			{ id: "veil-cast", substance: "cast", lightness: "mid", hue: "warm-neutral", finish: "honed", joint_m: null, reads_as: "The veil's modules: mid-toned cast panels, so the veil reads against the wall it stands on." },
			{ id: "box-glazing", substance: "glazing", lightness: "mid-dark", hue: "warm", finish: "matte", joint_m: null, reads_as: "The glass box behind the veil." },
		],
		design_rationale: [
			`Base model ${base.model_id ?? "?"} applied to ${candidateId} over ${facets.length} facets unfolded; edits ${JSON.stringify(edits)}.`,
			"The veil is a layer of solid modules (tile prism less funnel) standing on a storey-split glass box; the fold clearance does not apply to a construction that turns the corner.",
		],
		rules: [
			{ name: "F", alternatives: [{ split: { axis: "layer", parts: [{ size: "~1", symbol: "GlassBox" }, { size: "~1", symbol: "Veil" }] } }] },
			// A veil laid on SOME faces leaves the others bare, and a bare elevation still has to say
			// where the building stops: the composition gate asks every view for a course inside its
			// top storey, and it is right to - the elevations are drawn and judged one at a time. The
			// veil terminates the face it covers by reaching the top storey itself, so the crown is
			// only wanted where the run was limited; a full run keeps the grammar it always had, byte
			// for byte. The course sits in the last storey and stands down where that storey band is
			// too short to hold it (a stepped mass has facets a few centimetres tall).
			...(faces?.length ? [
				{ name: "GlassBox", alternatives: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "Storey" }] } }] },
				{ name: "Storey", alternatives: [{ split: { axis: "layer", parts: [{ size: "~1", symbol: "GlassStorey" }, { size: "~1", symbol: "Crown" }] } }] },
				// The BUILDING's top storey, by its number, not `storey == last`: `last` is the last
				// storey of the FACET's own scope, so on a mass of stacked courses every facet
				// terminated itself and the wall grew a cornice at 3.3 m. Same class as the old
				// `storeys[0]` hardcode - a question about the building answered by one member.
				{ name: "Crown", alternatives: [
					{ when: `storey == ${topStorey}`, min_z_m: 0.9, split: { axis: "z", parts: [{ size: "~1", symbol: "Bare" }, { size: "0.45", symbol: "Coping" }] } },
					{ terminal: "wall" },
				] },
				{ name: "Bare", alternatives: [{ terminal: "wall" }] },
				{ name: "Coping", alternatives: [{ terminal: "cornice", depth_m: 0.25, material: "veil-cast" }] },
			] : [
				{ name: "GlassBox", alternatives: [{ split: { axis: "storey", parts: [{ size: "~1", symbol: "GlassStorey" }] } }] },
			]),
			// A glazed bay needs room for its two slab courses and a pane that clears the slab lines by
			// more than the floor-band rule asks; `min_z_m` says so, and a storey band with less than
			// that - a stepped mass has facets a few centimetres tall - falls through to the mass's own
			// wall instead. A fixed split with nowhere to stand used to fail the whole derivation, and
			// a fractional one cleared nothing in particular and intruded on the slab lines.
			{ name: "GlassStorey", alternatives: [
				{ min_z_m: 0.9, split: { axis: "z", parts: [{ size: "0.2", symbol: "SlabBand" }, { size: "~1", symbol: "Pane" }, { size: "0.2", symbol: "SlabBand" }] } },
				{ terminal: "wall" },
			] },
			{ name: "SlabBand", alternatives: [{ terminal: "band", depth_m: 0.02, material: "veil-cast" }] },
			{ name: "Pane", alternatives: [{ terminal: "glass", depth_m: -0.05, material: "box-glazing" }] },
			{ name: "Veil", alternatives: [{ terminal: "louvre", depth_m: Number(edits.thickness ?? base.families[0].fields?.depth_m?.value ?? 0.45), standoff_m: 0, material: "veil-cast",
				lattice: { model_hash: evaluated.model_hash, family, ...(wallPatch ? {scope:"wall_patch"} : {}), instances: "lattice/instances.json", z_datum_m: Number(zMin.toFixed(6)) } }] },
		],
	};
}
