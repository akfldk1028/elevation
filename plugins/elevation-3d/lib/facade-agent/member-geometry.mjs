/**
 * The shapes a facade member can be, in the plane's own (u, v, n) coordinates.
 *
 * Three builders with one signature, because a member is one of three things: a box, an
 * arch, or half a rectangle cut on a diagonal. They were grown one at a time inside
 * `punched-facade.mjs` and pulled out here once the third arrived - the family is the unit
 * that changes together, and each of the three is a place where a wrong winding or a wrong
 * corner produces a drawing that renders cleanly and shows the wrong building.
 *
 * Every builder returns positions already in world space, triangle indices, and uvs in the
 * grammar's brick module, so the caller does not know which shape it asked for.
 */

const EPSILON = 1e-9;

/**
 * The in-plane climb vector: the direction that gains one metre of true height while
 * staying on the facade plane. Vertical planes climb straight up, [0, 0, 1], which keeps
 * every prism byte-identical. A battered plane leans the climb into the surface so a
 * detail placed at (u, z) lies ON the wall instead of poking through it; z stays TRUE
 * height everywhere because storeys, floor bands and ground access are all in z. The cost
 * is that one metre of z buys 1/cos(batter) metres of surface, 1.5% at ten degrees.
 *
 * It lives here rather than beside its caller in `punched-facade.mjs` because all three
 * builders below place their points through `localPoint`, so the climb is part of the same
 * family: extracting the builders and leaving it behind was a ReferenceError on every
 * render, which `check` never reaches and so never reported.
 */
export function climbVector(normal) {
	const horizontal = normal[0] * normal[0] + normal[1] * normal[1];
	if (!(horizontal > 0)) throw new TypeError("invalid facade geometry: facade plane is horizontal");
	const lean = -normal[2] / horizontal;
	return [lean * normal[0], lean * normal[1], 1];
}

export function localPoint(plane, tangent, u, v, n) {
	const climb = climbVector(plane.normal);
	return [
		plane.origin[0] + tangent[0] * u + plane.normal[0] * n + climb[0] * v,
		plane.origin[1] + tangent[1] * u + plane.normal[1] * n + climb[1] * v,
		plane.origin[2] + v,
	];
}

const BOX_INDICES = Object.freeze([
	[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
	[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
	[2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
]);

export function boxGeometry(plane, tangent, grammar, bounds) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (![u0, u1, v0, v1, n0, n1].every(Number.isFinite)
		|| u1 - u0 <= EPSILON || v1 - v0 <= EPSILON || Math.abs(n1 - n0) <= EPSILON) {
		throw new TypeError("invalid facade geometry: detail prism has non-positive dimensions");
	}
	const coordinates = [
		[u0, v0, n0], [u1, v0, n0], [u1, v1, n0], [u0, v1, n0],
		[u0, v0, n1], [u1, v0, n1], [u1, v1, n1], [u0, v1, n1],
	];
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices: BOX_INDICES.map((triangle) => [...triangle]),
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

// The arch band's resolution. 24 segments keeps the crown smooth at elevation scale
// (a 2 m arch draws ~8 px per chord at 79.6 px/m) without inflating the GLB.
const ARCH_SEGMENTS = 24;

/**
 * The one detail that is not a box: a curved band filling its bounding rectangle. The
 * outer half-ellipse touches all three free edges (springings at the bottom corners,
 * crown at the top), the inner one is inset by a constant band thickness, and the ring
 * is extruded from n0 to n1 like every other detail. Same contract as boxGeometry.
 */
export function archGeometry(plane, tangent, grammar, bounds) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (![u0, u1, v0, v1, n0, n1].every(Number.isFinite)
		|| u1 - u0 <= EPSILON || v1 - v0 <= EPSILON || Math.abs(n1 - n0) <= EPSILON) {
		throw new TypeError("invalid facade geometry: arch has non-positive dimensions");
	}
	const a = (u1 - u0) / 2;
	const b = v1 - v0;
	const cu = (u0 + u1) / 2;
	const thickness = Math.min(a, b) * 0.35;
	const inner = { a: a - thickness, b: b - thickness };
	const ring = Array.from({ length: ARCH_SEGMENTS + 1 }, (_, k) => Math.PI - (k * Math.PI) / ARCH_SEGMENTS);
	const coordinates = [];
	for (const n of [n0, n1]) {
		for (const theta of ring) coordinates.push([cu + a * Math.cos(theta), v0 + b * Math.sin(theta), n]);
		for (const theta of ring) coordinates.push([cu + inner.a * Math.cos(theta), v0 + inner.b * Math.sin(theta), n]);
	}
	const count = ring.length;
	const [outer0, inner0, outer1, inner1] = [0, count, 2 * count, 3 * count];
	const indices = [];
	for (let k = 0; k < ARCH_SEGMENTS; k += 1) {
		indices.push([outer0 + k, outer0 + k + 1, inner0 + k + 1], [outer0 + k, inner0 + k + 1, inner0 + k]);
		indices.push([outer1 + k, inner1 + k + 1, outer1 + k + 1], [outer1 + k, inner1 + k, inner1 + k + 1]);
		indices.push([outer0 + k, outer1 + k, outer1 + k + 1], [outer0 + k, outer1 + k + 1, outer0 + k + 1]);
		indices.push([inner0 + k, inner1 + k + 1, inner1 + k], [inner0 + k, inner0 + k + 1, inner1 + k + 1]);
	}
	indices.push([outer0, inner0, inner1], [outer0, inner1, outer1]);
	indices.push([outer0 + ARCH_SEGMENTS, inner1 + ARCH_SEGMENTS, inner0 + ARCH_SEGMENTS], [outer0 + ARCH_SEGMENTS, outer1 + ARCH_SEGMENTS, inner1 + ARCH_SEGMENTS]);
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices,
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}

/**
 * A member's rectangle cut in half on a diagonal, extruded to its own depth.
 *
 * Every primitive in this language was a box, so a facade of triangles could not be drawn -
 * an author transcribing a diagrid had to write one rectangle per facet and said so: "the
 * alternation happens ACROSS the diagonal; the diagonal is the building's entire signature."
 *
 * Four halves: a member and its OWN complement tile the scope and share only the cut -
 * `rising` with `rising_upper`, `falling` with `falling_upper`. `rising` and `falling` do
 * NOT tile: both keep the bottom edge, so they overlap below and leave the top bare.
 */
export function diagonalGeometry(plane, tangent, grammar, bounds, diagonal) {
	const { u0, u1, v0, v1, n0, n1 } = bounds;
	if (![u0, u1, v0, v1, n0, n1].every(Number.isFinite)
		|| u1 - u0 <= EPSILON || v1 - v0 <= EPSILON || Math.abs(n1 - n0) <= EPSILON) {
		throw new TypeError("invalid facade geometry: a diagonal member has non-positive dimensions");
	}
	const corners = {
		rising: [[u0, v0], [u1, v0], [u1, v1]],        // below BL->TR
		rising_upper: [[u0, v0], [u1, v1], [u0, v1]],  // above BL->TR
		falling: [[u0, v0], [u1, v0], [u0, v1]],       // below TL->BR
		falling_upper: [[u1, v0], [u1, v1], [u0, v1]], // above TL->BR
	}[diagonal];
	if (!corners) throw new TypeError(`invalid facade geometry: unknown diagonal ${diagonal}`);
	const coordinates = [];
	for (const n of [n0, n1]) for (const [u, v] of corners) coordinates.push([u, v, n]);
	// 0,1,2 at n0 and 3,4,5 at n1; the two caps wind opposite ways so the solid is closed.
	const indices = [[0, 2, 1], [3, 4, 5]];
	for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) indices.push([a, b, b + 3], [a, b + 3, a + 3]);
	return {
		positions: coordinates.map(([u, v, n]) => localPoint(plane, tangent, u, v, n)),
		indices,
		uvs: coordinates.map(([u, v]) => [u / grammar.brick_module_m[0], (plane.origin[2] + v) / grammar.brick_module_m[1]]),
	};
}
