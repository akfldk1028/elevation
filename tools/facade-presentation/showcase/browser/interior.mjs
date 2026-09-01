import * as THREE from "three";

/**
 * Interior mapping: rooms behind the glass, with no geometry and no extra memory.
 *
 * Joost van Dongen, "Interior Mapping: A new technique for rendering realistic buildings"
 * (CGI 2008). The idea is that a room is a box, a box is three pairs of parallel planes, and
 * a ray-plane intersection is cheap - so for each pixel of glass you cast a ray from the eye
 * through the pane, hit the nearest of the ceiling, floor and side-wall planes, and shade
 * what you hit. From the abstract: "The number of rooms rendered does not influence the
 * framerate or memory usage... The interiors require very little additional asset creation
 * and no extra memory." Figure 1 of the paper: "The geometry of the buildings consists of
 * simple cubes only."
 *
 * It is here because the glass is the largest single surface in a facade render and it was a
 * flat black sheet with nothing behind it. Benes et al. (Eurographics 2017) asked 52 people
 * what gave a procedural building away: window reflections came third at 35% and things in
 * and around windows fifth at 31%. A dark pane returns neither.
 *
 * Honest about cost, in the paper's own numbers: a diffuse-plus-reflection window material
 * rendered 5,100 frames in five seconds where the same material with interior mapping
 * rendered 999. Roughly five times the pixel cost - free in geometry, not free in shading.
 * It buys back a level of detail automatically, because a distant building covers fewer
 * pixels and the cost is per pixel.
 *
 * The planes are placed off the storey height the building actually has, so the floors
 * behind the glass line up with the spandrels in front of it. Getting that wrong is worse
 * than no interior at all - a room that straddles a floor band reads as a mistake.
 */

const VERTEX_HOOK = "#include <begin_vertex>";
const FRAGMENT_HOOK = "#include <emissivemap_fragment>";

/**
 * @param {THREE.Material} material the glass material to give rooms to
 * @param {{storey: number, depth: number, bay: number, ground: number}} room metres
 */
export function applyInteriorMapping(material, room) {
	const storey = room && room.storey > 0 ? room.storey : 3.3;
	const depth = room && room.depth > 0 ? room.depth : 4.5;
	const bay = room && room.bay > 0 ? room.bay : 4.0;
	const ground = room && Number.isFinite(room.ground) ? room.ground : 0;

	material.onBeforeCompile = function (shader) {
		shader.uniforms.uRoom = { value: new THREE.Vector3(bay, storey, depth) };
		shader.uniforms.uGround = { value: ground };

		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nvarying vec3 vIMWorld;")
			.replace(VERTEX_HOOK, VERTEX_HOOK + "\nvIMWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");

		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", `#include <common>
varying vec3 vIMWorld;
uniform vec3 uRoom;
uniform float uGround;

// Distance along the ray to the next plane of a grid of the given pitch, in one axis.
// The sign of the direction decides which side of the current cell we leave through.
float imPlane(float here, float dir, float pitch, float origin) {
	if (abs(dir) < 1e-5) return 1e9;
	float local = mod(here - origin, pitch);
	float travel = dir > 0.0 ? (pitch - local) : -local;
	return travel / dir;
}

// A stable pseudo-random per room cell, so no two rooms are lit identically. Rooms that
// all match are the same uniformity failure as a wall with one roughness value.
float imCell(vec3 cell) {
	return fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}`)
			.replace(FRAGMENT_HOOK, FRAGMENT_HOOK + `
{
	vec3 dir = normalize(vIMWorld - cameraPosition);
	float tx = imPlane(vIMWorld.x, dir.x, uRoom.x, 0.0);
	float ty = imPlane(vIMWorld.y, dir.y, uRoom.y, uGround);
	float tz = imPlane(vIMWorld.z, dir.z, uRoom.z, 0.0);
	float t = min(tx, min(ty, tz));
	vec3 hit = vIMWorld + dir * t;

	// Which surface the ray met decides the tone: a ceiling is the brightest thing in a
	// room because it takes the daylight, a floor is mid, a side wall is darkest.
	float tone = 0.30;
	if (t == ty) tone = dir.y < 0.0 ? 0.62 : 0.34;
	else if (t == tz) tone = 0.26;
	else tone = 0.22;

	// Rooms differ, and they get darker as the ray travels further in - the cheapest
	// stand-in for the fall-off of daylight from the window.
	vec3 cell = floor(vec3(hit.x / uRoom.x, (hit.y - uGround) / uRoom.y, hit.z / uRoom.z));
	float variation = 0.72 + 0.55 * imCell(cell);
	float falloff = 1.0 / (1.0 + 0.35 * t);
	// Scaled down hard. The first pass added enough emissive that the panes read as frosted
	// panels rather than as dark glass with rooms behind it - the glass axis is a design
	// choice the viewer made and the interior must sit under it, not replace it.
	float lit = tone * variation * falloff * 0.42;

	// Warm, because a room behind glass is lit by what is inside it, not by the sky.
	totalEmissiveRadiance += vec3(lit * 1.00, lit * 0.93, lit * 0.82);
}`);
	};
	material.needsUpdate = true;
	return material;
}
