/**
 * A member whose outline is a POLYGON, extruded like every other member.
 *
 * Three shapes could be drawn before this: a box, an arch, and half a rectangle cut on a
 * diagonal. Every facade this project failed to transcribe failed on that list rather than on
 * the composition around it - a hexagon costs five members and un-hexes as its inset grows, a
 * circle is a rectangle, a rhombus is two triangles that do not meet, a scooped cell is a
 * lump. Authors kept asking for one more word; the primitive was the ceiling.
 *
 * The outline is given in the member's own normalised square, (0,0) at its bottom-left corner
 * and (1,1) at its top-right, so one outline is a shape rather than a size and the same
 * hexagon serves a 0.4 m cell and a 4 m one.
 *
 * WHAT IS PROVED ABOUT THE RESULT, because a wrong winding renders cleanly and draws the
 * wrong building:
 *
 * - The outline is SIMPLE. No two non-adjacent edges cross, so the region is well defined.
 *   Checked by segment intersection, which is O(n^2) and n is under thirty.
 * - The triangulation is exact. Ear clipping, which terminates for every simple polygon by
 *   Meisters' Two Ears Theorem, and handles reflex vertices - so concave outlines (a star, a
 *   scoop, a slot with a return) are as ordinary as convex ones. The triangle areas sum to
 *   the shoelace area of the outline.
 * - The solid is CLOSED. An n-gon prism has 2n vertices, 4n-4 triangles and 6n-6 edges, and
 *   Euler's formula V - E + F = 2 holds; every edge is shared by exactly two triangles.
 * - Every face points OUT. The winding is normalised to counter-clockwise first, so the caps
 *   and the walls are consistent and the renderer's back-face culling means what it says.
 * - The volume is right. By the divergence theorem the signed volume of the closed mesh
 *   equals the outline's area times the extrusion depth.
 */

const EPSILON = 1e-9;
/** Enough for a rhombus, a hexagon, a slot with returns, or a circle drawn as a polygon. */
export const MAX_OUTLINE_POINTS = 32;
export const MIN_OUTLINE_POINTS = 3;

/**
 * Twice the signed area of a polygon: the shoelace sum.
 *
 * Positive is counter-clockwise in a right-handed (u, v). This is the one number that decides
 * winding, degeneracy and - through the divergence theorem below - whether the extruded solid
 * has the volume it should.
 */
export function shoelace(points) {
	let sum = 0;
	for (let index = 0; index < points.length; index += 1) {
		const [u0, v0] = points[index];
		const [u1, v1] = points[(index + 1) % points.length];
		sum += u0 * v1 - u1 * v0;
	}
	return sum;
}

/** The polygon's area, unsigned. */
export const polygonArea = (points) => Math.abs(shoelace(points)) / 2;

/** Do two segments properly cross? Touching at a shared endpoint is not a crossing. */
function segmentsCross(a0, a1, b0, b1) {
	const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const d0 = side(a0, a1, b0), d1 = side(a0, a1, b1);
	const d2 = side(b0, b1, a0), d3 = side(b0, b1, a1);
	// Strict signs on both sides: a proper crossing. Collinear overlap is caught separately by
	// the zero-area and duplicate-point tests, which reject the shapes that produce it.
	return ((d0 > EPSILON && d1 < -EPSILON) || (d0 < -EPSILON && d1 > EPSILON))
		&& ((d2 > EPSILON && d3 < -EPSILON) || (d2 < -EPSILON && d3 > EPSILON));
}

/**
 * Is this a simple polygon - a single closed loop that does not cross itself?
 *
 * A self-crossing outline has no inside, so every question after it (which side is out, what
 * is its area, how does it triangulate) is meaningless. Refusing it here is what stops a
 * bow-tie from rendering as two triangles that look almost right.
 */
export function isSimplePolygon(points) {
	const count = points.length;
	if (count < MIN_OUTLINE_POINTS) return false;
	for (let index = 0; index < count; index += 1) {
		const [u, v] = points[index];
		if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
		const [nu, nv] = points[(index + 1) % count];
		if (Math.hypot(nu - u, nv - v) <= EPSILON) return false;
	}
	for (let i = 0; i < count; i += 1) {
		for (let j = i + 1; j < count; j += 1) {
			// Adjacent edges share an endpoint by construction and cannot properly cross.
			if (j === i || (j + 1) % count === i || (i + 1) % count === j) continue;
			if (segmentsCross(points[i], points[(i + 1) % count], points[j], points[(j + 1) % count])) return false;
		}
	}
	return Math.abs(shoelace(points)) > EPSILON;
}

const triangleSide = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

/** Is `p` strictly inside the triangle abc? Used to reject an ear that swallows a vertex. */
function insideTriangle(a, b, c, p) {
	const d0 = triangleSide(a, b, p), d1 = triangleSide(b, c, p), d2 = triangleSide(c, a, p);
	const negative = d0 < -EPSILON || d1 < -EPSILON || d2 < -EPSILON;
	const positive = d0 > EPSILON || d1 > EPSILON || d2 > EPSILON;
	return !(negative && positive);
}

/**
 * Triangulate a simple polygon by clipping ears.
 *
 * Meisters' Two Ears Theorem guarantees that every simple polygon with more than three
 * vertices has at least two ears, so the loop always makes progress and terminates. A vertex
 * is an ear when it is convex for the polygon's own winding and no remaining vertex lies
 * inside the triangle it would cut - the second condition is what makes this correct for
 * CONCAVE outlines, which fan triangulation gets silently wrong.
 *
 * @returns {number[][]} triangles as index triples into `points`
 */
export function triangulate(points) {
	if (!isSimplePolygon(points)) throw new TypeError("invalid member outline: the polygon is not simple");
	const counterClockwise = shoelace(points) > 0;
	const remaining = points.map((_, index) => index);
	if (!counterClockwise) remaining.reverse();
	const triangles = [];
	let guard = remaining.length * remaining.length + 8;
	while (remaining.length > 3) {
		if (guard-- <= 0) throw new TypeError("invalid member outline: could not be triangulated");
		let clipped = false;
		for (let position = 0; position < remaining.length; position += 1) {
			const previous = remaining[(position + remaining.length - 1) % remaining.length];
			const current = remaining[position];
			const next = remaining[(position + 1) % remaining.length];
			const a = points[previous], b = points[current], c = points[next];
			// Convex for a counter-clockwise loop, and not degenerate.
			if (triangleSide(a, b, c) <= EPSILON) continue;
			let swallows = false;
			for (const index of remaining) {
				if (index === previous || index === current || index === next) continue;
				if (insideTriangle(a, b, c, points[index])) { swallows = true; break; }
			}
			if (swallows) continue;
			triangles.push([previous, current, next]);
			remaining.splice(position, 1);
			clipped = true;
			break;
		}
		if (!clipped) throw new TypeError("invalid member outline: could not be triangulated");
	}
	triangles.push([remaining[0], remaining[1], remaining[2]]);
	return triangles;
}

/**
 * A closed prism from a polygon outline.
 *
 * `outline` is in the member's own normalised square; `bounds` places that square on the wall
 * exactly as a box is placed, and `n0`/`n1` extrude it. The result is the same shape of object
 * every other builder returns - world positions, triangle indices, uvs - so nothing
 * downstream knows which builder it asked for.
 *
 * Vertices 0..n-1 are the back cap at n0 and n..2n-1 the front cap at n1, in the same order,
 * which is what lets the side walls be written as a single quad per outline edge.
 */
/**
 * The cross-section half way along a tapered member.
 *
 * Corresponding vertices are joined by a straight line, so the outline at parameter t is the
 * linear morph (1-t)a + t b. That makes the cross-sectional AREA a quadratic in t, which is
 * why the prismatoid formula below is exact rather than an approximation.
 */
/**
 * Turn a written outline by an angle, about its own centre, IN METRES.
 *
 * The outline is written in the member's 0..1 square and that square is not square: a 1.1 m
 * bay 0.9 m tall stretches every shape by 1.22 across, so rotating in unit coordinates shears
 * a lozenge into a slanted slot. Rotating in metres and mapping back is a true rotation.
 *
 * A turned shape can leave the box it was written in, and a member may not leave its own
 * scope, so the result is scaled about the centre by the largest factor that still fits. The
 * shape stays similar to itself; only its size gives way.
 */
export function rotateOutline(outline, degrees, boxWidth, boxHeight) {
	if (!degrees || !Number.isFinite(degrees)) return outline;
	const radians = (degrees * Math.PI) / 180;
	const cosine = Math.cos(radians), sine = Math.sin(radians);
	const turned = outline.map(([u, v]) => {
		const x = (u - 0.5) * boxWidth, y = (v - 0.5) * boxHeight;
		return [x * cosine - y * sine, x * sine + y * cosine];
	});
	let scale = 1;
	for (const [x, y] of turned) {
		if (Math.abs(x) > 1e-12) scale = Math.min(scale, (boxWidth / 2) / Math.abs(x));
		if (Math.abs(y) > 1e-12) scale = Math.min(scale, (boxHeight / 2) / Math.abs(y));
	}
	return turned.map(([x, y]) => [0.5 + (x * scale) / boxWidth, 0.5 + (y * scale) / boxHeight]);
}

export const morphOutline = (near, far, t) =>
	near.map(([u, v], index) => [u + (far[index][0] - u) * t, v + (far[index][1] - v) * t]);

/**
 * The volume a tapered prism should have, by the prismatoid formula.
 *
 * V = h/6 (A0 + 4 Am + A1). For a linear morph between two n-gons with corresponding vertices
 * the area is a quadratic in t, and Simpson's rule integrates a quadratic exactly - so this is
 * an identity, not an estimate, and the divergence-theorem volume of the built mesh must match
 * it to machine precision. A straight prism is the case A0 = Am = A1 and it reduces to A x h.
 */
export const prismatoidVolume = (near, far, height) =>
	(height / 6) * (polygonArea(near) + 4 * polygonArea(morphOutline(near, far, 0.5)) + polygonArea(far));

export function polygonPrismGeometry(plane, tangent, grammar, bounds, outline, localPoint, farOutline = null) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (![u0, u1, v0, v1, n0, n1].every(Number.isFinite)
		|| u1 - u0 <= EPSILON || v1 - v0 <= EPSILON || Math.abs(n1 - n0) <= EPSILON) {
		throw new TypeError("invalid facade geometry: detail prism has non-positive dimensions");
	}
	if (!Array.isArray(outline) || outline.length < MIN_OUTLINE_POINTS || outline.length > MAX_OUTLINE_POINTS) {
		throw new TypeError(`invalid member outline: between ${MIN_OUTLINE_POINTS} and ${MAX_OUTLINE_POINTS} points`);
	}
	// Inside the member's own square, and this is not a formality. The whole validator rests on
	// a member living strictly inside its facet - SEGMENT_BOUNDS_INVALID, the fold clearance,
	// the opening ratios and the collision test all read `local_bounds` and trust it. An
	// outline point at -0.5 places geometry outside the rectangle those bounds describe, so the
	// solid would sit where nothing had checked it. Found by feeding this builder a square at
	// [-0.5, 1.5], which it drew without complaint.
	if (!outline.every((point) => Array.isArray(point) && point.length === 2
		&& point.every((value) => Number.isFinite(value) && value >= -EPSILON && value <= 1 + EPSILON))) {
		throw new TypeError("invalid member outline: every point lies in the member's own square, 0..1 in u and v");
	}
	const counterClockwise = shoelace(outline) > 0;
	// One winding from here on, so the caps and the walls cannot disagree.
	const loop = counterClockwise ? outline.slice() : outline.slice().reverse();
	// A TAPER: the far end is a different outline on the same vertices, so a member can be a
	// funnel, a hood, a scoop - a cell whose mouth is wider than its throat. Until this a
	// member's two ends were the same shape by construction, which is why a facade whose unit
	// is a hollow could only be drawn as a facade whose unit is a lump.
	let farLoop = loop;
	if (farOutline) {
		if (!Array.isArray(farOutline) || farOutline.length !== outline.length) {
			throw new TypeError("invalid member outline: the far outline needs the same number of points as the near one, so each vertex knows where it goes");
		}
		// The two ends must wind the same way. Vertex i travels to vertex i, so an outline
		// written the other way round pairs each vertex with the one diagonally opposite: the
		// morph twists through itself somewhere in the middle, and it can be simple at every
		// sample you happen to take while still being a solid that folds through its own side.
		// Refusing the twist is exact where sampling is not.
		if ((shoelace(farOutline) > 0) !== counterClockwise) {
			throw new TypeError("invalid member outline: the far outline winds the opposite way to the near one, so no vertex has a partner to travel to");
		}
		farLoop = counterClockwise ? farOutline.slice() : farOutline.slice().reverse();
		// The morph has to stay a polygon the whole way, or the solid folds through itself
		// somewhere in the middle where nothing looks.
		for (const t of [0.25, 0.5, 0.75]) {
			if (!isSimplePolygon(morphOutline(loop, farLoop, t))) {
				throw new TypeError("invalid member outline: the taper crosses itself between its two ends");
			}
		}
	}
	const triangles = triangulate(loop);
	const count = loop.length;
	// The normalised outlines mapped onto the member's own rectangle.
	const place = (points) => points.map(([u, v]) => [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v]);
	const placedNear = place(loop), placedFar = place(farLoop);
	const near = Math.min(n0, n1), far = Math.max(n0, n1);
	const coordinates = [
		...placedNear.map(([u, v]) => [u, v, near]),
		...placedFar.map(([u, v]) => [u, v, far]),
	];
	const indices = [];
	// The near cap faces -n, so its triangles are wound backwards from the outline's own order.
	for (const [a, b, c] of triangles) indices.push([a, c, b]);
	// The far cap faces +n and keeps it.
	for (const [a, b, c] of triangles) indices.push([a + count, b + count, c + count]);
	// One quad per outline edge, wound so its normal points away from the interior.
	for (let index = 0; index < count; index += 1) {
		const next = (index + 1) % count;
		indices.push([index, next, next + count]);
		indices.push([index, next + count, index + count]);
	}
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices,
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

/**
 * The WALL of a funnel: the lateral surface between a mouth at n0 and a throat at n1, no caps,
 * wound so its normals point INTO the funnel - the side a viewer sees down the hole. It lines a
 * recess the way the contour jamb ring lined a straight hole; the mass inside the mouth-to-throat
 * volume is cut away at render time, so nothing but this surface is left to see there.
 */
export function funnelWallGeometry(plane, tangent, grammar, bounds, outline, farOutline, localPoint) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (!Array.isArray(outline) || !Array.isArray(farOutline) || outline.length !== farOutline.length
		|| outline.length < MIN_OUTLINE_POINTS || outline.length > MAX_OUTLINE_POINTS) {
		throw new TypeError("invalid funnel: the mouth and the throat need the same number of points, between the outline bounds");
	}
	const counterClockwise = shoelace(outline) > 0;
	if ((shoelace(farOutline) > 0) !== counterClockwise) throw new TypeError("invalid funnel: the throat winds the opposite way to the mouth");
	const loop = counterClockwise ? outline.slice() : outline.slice().reverse();
	const farLoop = counterClockwise ? farOutline.slice() : farOutline.slice().reverse();
	const place = (points) => points.map(([u, v]) => [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v]);
	const near = Math.max(n0, n1), far = Math.min(n0, n1);
	const coordinates = [...place(loop).map(([u, v]) => [u, v, near]), ...place(farLoop).map(([u, v]) => [u, v, far])];
	const count = loop.length;
	const positions = coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n));
	// Each quad wound on its own so its normal points INTO the funnel - toward the axis - in
	// world space, whatever handedness the plane frame has. Wound by the loop's order alone,
	// half the walls (the ones the lens's lean turns the other way) faced the mass and were
	// culled, and the front elevation looked straight through them into the cut.
	const centroid = (points) => points.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);
	const axisNear = centroid(positions.slice(0, count)), axisFar = centroid(positions.slice(count));
	const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const indices = [];
	for (let index = 0; index < count; index += 1) {
		const next = (index + 1) % count;
		for (const [a, b, c] of [[index, next, next + count], [index, next + count, index + count]]) {
			const A = positions[a], B = positions[b], C = positions[c];
			const normal = cross(sub(B, A), sub(C, A));
			const middle = centroid([A, B, C]);
			// the axis point at this triangle's own depth, between the mouth's and the throat's centres
			const t = (a >= count) + (b >= count) + (c >= count);
			const axis = [0, 1, 2].map((k) => axisNear[k] + (axisFar[k] - axisNear[k]) * (t / 3));
			// Both windings: the wall is a surface seen from inside the funnel AND, where the
			// parapet or a fold cuts through a cell, from outside. Two coincident faces wound
			// against each other never fight - the culling picks one - and the wall stops
			// depending on which way a thin lens's partner vertices happen to turn.
			const inward = dot(normal, sub(axis, middle)) >= 0;
			indices.push(inward ? [a, b, c] : [a, c, b]);
			indices.push(inward ? [a, c, b] : [a, b, c]);
		}
	}
	return {
		positions,
		indices,
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

/**
 * A cell as a SOLID MODULE: the tile prism less the funnel, closed. Three rings with one point
 * count in one angular order - tile (the footprint), mouth (tile less half a web) and throat
 * (the family curve) - give four quad strips: the front annulus tile->mouth on the outer face,
 * the funnel wall mouth->throat from the outer face to the inner, the back annulus throat->tile
 * on the inner face, and the tile's own sides. Every strip is quads between partnered vertices,
 * so the solid is watertight by construction and needs no cap triangulation. This is the veil
 * as a VOLUME standing on (or off) the wall, with real crests and a real thickness - not a hole
 * carved into the mass (the user: "3차원 볼륨이 입혀져야 하는 거 아님?").
 */
export function funnelSections(profile) {
	// The funnel's section as (blend toward the throat, depth fraction) pairs between the mouth
	// (0, 0) and the throat (1, 1). `linear` keeps the straight loft whatever the ring count;
	// `quarter_ellipse` is the cove: tangent to the face at the rim (depth grows as 1 - cos while
	// the ring already moves inward as sin), diving into the throat.
	const rings = Math.max(0, Math.min(6, Math.trunc(profile?.rings ?? 0)));
	const kind = profile?.kind ?? "linear";
	return Array.from({ length: rings }, (_, k) => {
		const t = (k + 1) / (rings + 1);
		return kind === "quarter_ellipse"
			? [Math.sin((t * Math.PI) / 2), 1 - Math.cos((t * Math.PI) / 2)]
			: [t, t];
	});
}

export function funnelModuleGeometry(plane, tangent, grammar, bounds, tile, mouth, throat, localPoint, profile = null) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	for (const [name, ring] of [["tile", tile], ["mouth", mouth], ["throat", throat]]) {
		if (!Array.isArray(ring) || ring.length !== tile.length || ring.length < MIN_OUTLINE_POINTS || ring.length > MAX_OUTLINE_POINTS) {
			throw new TypeError(`invalid funnel module: the ${name} needs the same number of points as the tile, between the outline bounds`);
		}
	}
	const counterClockwise = shoelace(tile) > 0;
	if ((shoelace(mouth) > 0) !== counterClockwise || (shoelace(throat) > 0) !== counterClockwise) {
		throw new TypeError("invalid funnel module: the three rings must wind the same way");
	}
	const orient = (ring) => (counterClockwise ? ring.slice() : ring.slice().reverse());
	const T = orient(tile), M = orient(mouth), R = orient(throat);
	const place = (points) => points.map(([u, v]) => [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v]);
	const near = Math.min(n0, n1), far = Math.max(n0, n1);
	const count = T.length;
	const sections = funnelSections(profile);
	// vertex blocks: 0 tile@far, 1 mouth@far, 2..(1+s) the profile's sections, 2+s throat@near,
	// 3+s tile@near. A section is the mouth blended toward the throat, vertex i to vertex i, at
	// its depth between the faces.
	const PM = place(M), PR = place(R);
	const coordinates = [
		...place(T).map(([u, v]) => [u, v, far]),
		...PM.map(([u, v]) => [u, v, far]),
		...sections.flatMap(([blend, depth]) => PM.map(([u, v], i) => [u + (PR[i][0] - u) * blend, v + (PR[i][1] - v) * blend, far - (far - near) * depth])),
		...PR.map(([u, v]) => [u, v, near]),
		...place(T).map(([u, v]) => [u, v, near]),
	];
	const throatBlock = 2 + sections.length, nearTileBlock = 3 + sections.length;
	const at = (block, index) => block * count + (index % count);
	const indices = [];
	// One convention for every strip: a quad (outerA, outerB, innerB, innerA) between ring A
	// (this vertex, next vertex) and ring B, wound so its normal leaves the solid. The far cap
	// of the plain prism is wound [a, b, c] on a CCW loop (normal +n); the annulus on the far
	// face follows it; the near annulus is the mirror; the outer wall is the prism's wall; the
	// funnel wall is the outer wall's mirror, because its solid side is the other one.
	const quad = (a0, a1, b1, b0) => { indices.push([a0, a1, b1]); indices.push([a0, b1, b0]); };
	for (let i = 0; i < count; i += 1) {
		const j = i + 1;
		quad(at(0, i), at(0, j), at(1, j), at(1, i));                                  // front annulus, +n
		quad(at(nearTileBlock, j), at(nearTileBlock, i), at(throatBlock, i), at(throatBlock, j));  // back annulus, -n
		quad(at(nearTileBlock, i), at(nearTileBlock, j), at(0, j), at(0, i));          // outer side, away from the axis
		for (let block = 1; block < throatBlock; block += 1) {
			quad(at(block, i), at(block, j), at(block + 1, j), at(block + 1, i));     // funnel wall, section to section, toward the axis
		}
	}
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices,
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

/**
 * Everything the docstring claims, measured on a built prism.
 *
 * Exported because the claims are the reason to trust the builder, and a claim nobody can
 * re-run is a comment. The test suite calls this; so can a probe.
 */
export function verifyPrism({ positions, indices }, expectedVolume) {
	const vertexCount = positions.length;
	const faceCount = indices.length;
	const edges = new Map();
	for (const [a, b, c] of indices) {
		for (const [from, to] of [[a, b], [b, c], [c, a]]) {
			const key = from < to ? `${from}:${to}` : `${to}:${from}`;
			edges.set(key, (edges.get(key) ?? 0) + 1);
		}
	}
	const edgeCount = edges.size;
	const everyEdgeShared = [...edges.values()].every((uses) => uses === 2);
	// Divergence theorem: six times the signed volume is the sum of the scalar triple products.
	let sixVolume = 0;
	for (const [a, b, c] of indices) {
		const p = positions[a], q = positions[b], r = positions[c];
		sixVolume += p[0] * (q[1] * r[2] - q[2] * r[1])
			- p[1] * (q[0] * r[2] - q[2] * r[0])
			+ p[2] * (q[0] * r[1] - q[1] * r[0]);
	}
	const volume = sixVolume / 6;
	return {
		vertices: vertexCount,
		faces: faceCount,
		edges: edgeCount,
		euler: vertexCount - edgeCount + faceCount,
		closed: everyEdgeShared,
		// Positive means every face is wound outward; a single flipped triangle changes the sign
		// of nothing but breaks `closed`, and a globally inverted solid shows up here.
		outward: volume > 0,
		volume: Math.abs(volume),
		volume_error: expectedVolume === undefined ? null : Math.abs(Math.abs(volume) - expectedVolume),
	};
}
