/**
 * The lattice: cells PLACED by an evaluated ModelSpec, carried on a terminal.
 *
 * The split grammar divides a scope; it cannot put a cell wherever a basis vector says. A
 * veil, a diagrid, an attractor field - every parametric skin - is a LATTICE over the surface,
 * and the 2026-09-13 attempt to write The Broad as splits per facet, per storey, axis-aligned
 * came out as one column of cells between webs on every facet ("eyes on a tower"). So the
 * cells are evaluated elsewhere (tools/facade-parametric, Python - deterministic, hashed) and
 * arrive here as instances in host metres. This module maps them into a scope and never
 * evaluates a spec itself, which is what keeps the 2D CAD and the 3D on one model hash.
 *
 * Host (0, 0) is the FACET's origin (u = 0, z = the facet's bottom), never the scope's: the
 * resolver insets a punched scope by the fold clearance, and mapping the host to that inset
 * origin shifted every cell 0.3 m along the facet against the SVG/DXF written from the same
 * instances under the same hash (found by review, measured on hash f301da2e: cell r000-c000
 * at host 0.219..0.781, in the GLB at 0.519..1.081). A cell crossing the scope edge is clipped
 * to the scope - a veil stops at the wall's edge, it does not disappear one cell early - and a
 * cell with nothing left inside is dropped. The clipped outline is normalized to the cell's own
 * box, which is the form every downstream link (outline, polygon prism, hole cut) reads.
 */
import { MAX_OUTLINE_POINTS, isSimplePolygon } from "../../polygon-prism.mjs";

// Six decimals is a micron in metres; eight decimals on 32 points in every cell was a third
// of the veil's GLB extras.
const round = (value) => Math.round(value * 1e6) / 1e6;

function intersect(a, b, axis, value) {
	const other = 1 - axis;
	const t = (value - a[axis]) / (b[axis] - a[axis]);
	const point = [0, 0];
	point[axis] = value;
	point[other] = a[other] + t * (b[other] - a[other]);
	return point;
}

/** Sutherland-Hodgman against a rectangle. Returns an open ring (no repeated first point) or []. */
export function clipToRect(points, rect) {
	let ring = points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]
		? points.slice(0, -1) : [...points];
	const edges = [
		[(p) => p[0] >= rect.u_min, (a, b) => intersect(a, b, 0, rect.u_min)],
		[(p) => p[0] <= rect.u_max, (a, b) => intersect(a, b, 0, rect.u_max)],
		[(p) => p[1] >= rect.z_min, (a, b) => intersect(a, b, 1, rect.z_min)],
		[(p) => p[1] <= rect.z_max, (a, b) => intersect(a, b, 1, rect.z_max)],
	];
	for (const [keep, cut] of edges) {
		if (!ring.length) return [];
		const out = [];
		let prev = ring.at(-1);
		for (const point of ring) {
			if (keep(point)) {
				if (!keep(prev)) out.push(cut(prev, point));
				out.push(point);
			} else if (keep(prev)) out.push(cut(prev, point));
			prev = point;
		}
		ring = out;
	}
	return ring;
}

/**
 * Clipping can add a vertex, and the evaluator's 32-point cap was met before clipping: a cell
 * touching an edge came out at 33 and failed the whole facet. Merge the shortest edge until the
 * cap holds - a corner a centimetre long is the clip's, not the shape's.
 */
function fitOutline(points) {
	let out = [...points];
	while (out.length > MAX_OUTLINE_POINTS) {
		// edges by length; the first merge that leaves the ring simple wins (a concave notch
		// narrower than its own shortest edge would fold on that edge, so try the next)
		const order = out.map((p, i) => [Math.hypot(out[(i + 1) % out.length][0] - p[0], out[(i + 1) % out.length][1] - p[1]), i])
			.sort((l, r) => l[0] - r[0]);
		let merged = null;
		for (const [, i] of order) {
			const candidate = out.filter((_, k) => k !== (i + 1) % out.length);
			if (isSimplePolygon(candidate)) { merged = candidate; break; }
		}
		if (!merged) break;
		out = merged;
	}
	return out;
}

/**
 * `count` points where rays from `centre` at equal angles leave the ring (its farthest crossing),
 * counter-clockwise from 0. The evaluator resamples a funnel's mouth and throat this way about
 * one centre so vertex i of one is the partner of vertex i of the other; after a clip at the
 * scope edge changes the mouth's points, both are resampled again here the same way.
 */
export function angleSet(rings, centre, count) {
	// every vertex of the first ring (the mouth's corners), the two farthest of each other ring
	// (a lens's tips), uniform fill up to count - the evaluator's rule, so a clipped cell keeps
	// its corners the way an unclipped one does
	const [cx, cy] = centre;
	const angles = [];
	const gap = (2 * Math.PI) / 180;
	const add = (angle) => {
		const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
		if (angles.every((b) => Math.min(Math.abs(a - b), 2 * Math.PI - Math.abs(a - b)) >= gap)) angles.push(a);
	};
	for (const [x, y] of rings[0]) add(Math.atan2(y - cy, x - cx));
	for (const ring of rings.slice(1)) {
		const far = [...ring].sort((p, q) => ((q[0] - cx) ** 2 + (q[1] - cy) ** 2) - ((p[0] - cx) ** 2 + (p[1] - cy) ** 2)).slice(0, 2);
		for (const [x, y] of far) add(Math.atan2(y - cy, x - cx));
	}
	angles.splice(count);
	for (let k = 0; angles.length < count && k < 4 * count; k++) add((2 * Math.PI * k) / count);
	return angles.sort((l, r) => l - r);
}

export function resampleAt(ring, centre, angles) {
	const [cx, cy] = centre;
	const out = [];
	for (const angle of angles) {
		const dx = Math.cos(angle), dy = Math.sin(angle);
		let best = null;
		for (let i = 0; i < ring.length; i++) {
			const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
			const ex = bx - ax, ey = by - ay;
			const denominator = dx * ey - dy * ex;
			if (Math.abs(denominator) < 1e-12) continue;
			const t = ((ax - cx) * ey - (ay - cy) * ex) / denominator;
			const s = ((ax - cx) * dy - (ay - cy) * dx) / denominator;
			if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = best === null ? t : Math.max(best, t);
		}
		if (best === null) return null;
		out.push([cx + dx * best, cy + dy * best]);
	}
	return out;
}

export function resampleByAngle(ring, centre, count) {
	return resampleAt(ring, centre, Array.from({ length: count }, (_, k) => (2 * Math.PI * k) / count));
}

function dedupe(points) {
	const out = [];
	for (const point of points) {
		const last = out.at(-1);
		if (!last || Math.abs(last[0] - point[0]) > 1e-9 || Math.abs(last[1] - point[1]) > 1e-9) out.push(point);
	}
	if (out.length > 1 && Math.abs(out[0][0] - out.at(-1)[0]) <= 1e-9 && Math.abs(out[0][1] - out.at(-1)[1]) <= 1e-9) out.pop();
	return out;
}

/**
 * Every cell of `lattice` that lands inside `scope`, as { id, attributes, local_bounds, outline }.
 * local_bounds are facet coordinates; outline is normalized to local_bounds.
 */
export function latticeCells(lattice, scope, fail = (message) => { throw new Error(message); }, origin = { u: 0, z: scope.z_min }) {
	const cells = [];
	for (const instance of lattice.instances) {
		const placed = instance.outline_m.map(([x, y]) => [origin.u + x, origin.z + y]);
		let clipped = fitOutline(dedupe(clipToRect(placed, scope)));
		if (clipped.length < 3) continue;
		// A funnel's throat travels with its mouth. A clip that changed the mouth breaks the
		// vertex partnership, so both loops are resampled about the cell's centre; a cell whose
		// centre the scope no longer holds is the wall's, and goes.
		let far = null, tile = null;
		if (instance.outline_far_m) {
			const centre = [origin.u + instance.center_m[0], origin.z + instance.center_m[1]];
			const place = (ring) => dedupe(clipToRect(ring.map(([x, y]) => [origin.u + x, origin.z + y]), scope));
			const throat = place(instance.outline_far_m);
			const footprint = instance.tile_m ? place(instance.tile_m) : null;
			const changed = clipped.length !== dedupe(placed).length || (footprint && footprint.length !== dedupe(instance.tile_m).length);
			if (centre[0] < scope.u_min || centre[0] > scope.u_max || centre[1] < scope.z_min || centre[1] > scope.z_max) continue;
			if (throat.length < 3 || (footprint && footprint.length < 3)) continue;
			const counts = [clipped.length, throat.length, ...(footprint ? [footprint.length] : [])];
			if (changed || new Set(counts).size > 1) {
				const count = Math.min(MAX_OUTLINE_POINTS, Math.max(...counts));
				const angles = angleSet([clipped, throat, ...(footprint ? [footprint] : [])], centre, count);
				const mouth = resampleAt(clipped, centre, angles), inner = resampleAt(throat, centre, angles);
				const outer = footprint ? resampleAt(footprint, centre, angles) : null;
				if (!mouth || !inner || (footprint && !outer)) continue;
				clipped = mouth; far = inner; tile = outer;
			} else { far = throat; tile = footprint; }
		}
		// A module's box is its footprint (the tile); a hole's is its mouth.
		const extent = tile ?? clipped;
		const us = extent.map((p) => p[0]), zs = extent.map((p) => p[1]);
		// Rounded, then held inside the scope: a scope edge at 6.9848120299 (a stepped mass's
		// facet less the fold clearance) rounds a clipped cell UP by half a micron, and the fold
		// rule reads that as a cell 0.3 m minus half a micron from the fold. The clip is exact;
		// the rounding must not undo it.
		const bounds = {
			u_min: Math.max(scope.u_min, round(Math.min(...us))), u_max: Math.min(scope.u_max, round(Math.max(...us))),
			z_min: Math.max(scope.z_min, round(Math.min(...zs))), z_max: Math.min(scope.z_max, round(Math.max(...zs))),
		};
		const width = bounds.u_max - bounds.u_min, height = bounds.z_max - bounds.z_min;
		// A sliver thinner than a centimetre is what is left of a cell the edge has all but
		// removed; it would draw as a line and fail the builder's own minimum, so it goes.
		if (width < 0.01 || height < 0.01) continue;
		const normalize = (points) => points.map(([u, z]) => [
			round(Math.min(1, Math.max(0, (u - bounds.u_min) / width))),
			round(Math.min(1, Math.max(0, (z - bounds.z_min) / height))),
		]);
		// A funnel keeps every vertex (partnership is by index); a plain cell drops repeats.
		const outline = far ? normalize(clipped) : dedupe(normalize(clipped));
		if (outline.length < 3 || outline.length > MAX_OUTLINE_POINTS) {
			fail(`lattice cell ${instance.id} has ${outline.length} outline points after clipping; 3..${MAX_OUTLINE_POINTS} are drawable`);
		}
		if (!isSimplePolygon(outline)) fail(`lattice cell ${instance.id} crosses itself or encloses no area after clipping`);
		const outlineFar = far ? normalize(far) : null;
		if (outlineFar && !isSimplePolygon(outlineFar)) fail(`lattice cell ${instance.id}: its throat crosses itself after clipping`);
		const tileOutline = tile ? normalize(tile) : null;
		if (tileOutline && !isSimplePolygon(tileOutline)) fail(`lattice cell ${instance.id}: its tile crosses itself after clipping`);
		cells.push({ id: instance.id, attributes: instance.attributes ?? {}, local_bounds: bounds, outline,
			...(outlineFar ? { outline_far: outlineFar } : {}), ...(tileOutline ? { tile: tileOutline } : {}),
			...(outlineFar && instance.profile ? { profile: instance.profile } : {}) });
	}
	return cells;
}
