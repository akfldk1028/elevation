import * as THREE from "three";
import { brickMaps, stoneMaps, precastMaps, zincMaps, woodMaps, weatheringMap } from "./textures.mjs";
import { applyInteriorMapping } from "./interior.mjs";

// ---------------- materials ----------------
//
// This module owns BOTH mappings: material by glTF material NAME (the default
// table + materialForMesh) and the kind-based punched heuristic (by
// geometry.userData.kind). The axis appliers MUTATE the table in a fixed,
// load-bearing order - wall, then glass, then frame, then the punched
// heuristic - and the wall branches alias materials.brick = materials.concrete
// (darkpanel also overwrites materials.precast). buildShowcaseMaterials is the
// single assembly-order owner; axes and anisotropy are injected, never ambient.

function defaultMaterials(anisotropy) {
	const brick = brickMaps();
	const stone = stoneMaps("#d2cbbc");
	const precast = precastMaps();
	[brick.color, brick.bump, stone.color, stone.bump, precast.color].forEach(function (t) { t.anisotropy = anisotropy; });
	// Metric, not decorative. The UVs prepareGeometry writes are world metres, so a repeat of
	// 1/0.9 makes the tile span 0.9 m, and brickMaps draws 12 courses of 4 stretchers into it:
	// a 75 mm course and a 225 mm stretcher, which is a standard brick plus a 10 mm joint. It
	// was 83 x 250 mm before - a tenth over, which reads as a slightly oversized building.
	// Getting this right is the cheapest realism there is: "keeping these details in scale
	// with their real-life counterparts will help to sell the material later on".
	const BRICK_TILE_M = 0.9;
	brick.color.repeat.set(1 / BRICK_TILE_M, 1 / BRICK_TILE_M);
	brick.bump.repeat.set(1 / BRICK_TILE_M, 1 / BRICK_TILE_M);
	// Ashlar limestone: the tile carries roughly four courses, so 1.2 m gives a 300 mm bed
	// height - the low end of real ashlar, and small enough that a three-storey wall reads as
	// coursed stone rather than as one poured surface.
	const STONE_TILE_M = 1.2;
	stone.color.repeat.set(1 / STONE_TILE_M, 1 / STONE_TILE_M);
	stone.bump.repeat.set(2 / STONE_TILE_M, 2 / STONE_TILE_M);
	precast.color.repeat.set(0.5, 0.5);

	return {
		concrete: new THREE.MeshStandardMaterial({
			map: stone.color, bumpMap: stone.bump, bumpScale: 0.35,
			roughness: 0.9, metalness: 0, envMapIntensity: 0.35,
		}),
		brick: new THREE.MeshStandardMaterial({
			map: brick.color, bumpMap: brick.bump, bumpScale: 0.5,
			roughness: 0.85, metalness: 0, envMapIntensity: 0.3,
		}),
		precast: new THREE.MeshStandardMaterial({
			map: precast.color, roughness: 0.62, metalness: 0, envMapIntensity: 0.45,
		}),
		"window-frame": new THREE.MeshStandardMaterial({
			color: 0x4a3a26, metalness: 0.88, roughness: 0.38, envMapIntensity: 1.0,
		}),
		glass: new THREE.MeshPhysicalMaterial({
			color: 0xa4c0ca, metalness: 0.95, roughness: 0.05,
			envMapIntensity: 2.4, clearcoat: 1.0, clearcoatRoughness: 0.04,
		}),
	};
}

// wall axis: procedural material of the mass/wall field
function applyWallAxis(materials, wall, anisotropy) {
	if (wall === "brick") {
		// The mass itself is the brick field: running bond over the whole wall,
		// warm red-brown body (~#a06248). Precast bands/sills/lintels stay pale
		// for contrast.
		const field = brickMaps(18, 44, 44, "#c9b8a2");
		field.color.anisotropy = anisotropy; field.bump.anisotropy = anisotropy;
		field.color.repeat.set(1, 1); field.bump.repeat.set(1, 1);
		materials.concrete = new THREE.MeshStandardMaterial({
			map: field.color, bumpMap: field.bump, bumpScale: 0.5,
			roughness: 0.85, metalness: 0, envMapIntensity: 0.3,
		});
		materials.brick = materials.concrete;
	} else if (wall === "limestone") {
		// Pale limestone with visible mottle over the whole mass.
		const lime = stoneMaps("#ddd6c6", 0.22);
		lime.color.anisotropy = anisotropy; lime.bump.anisotropy = anisotropy;
		lime.color.repeat.set(0.25, 0.25); lime.bump.repeat.set(0.5, 0.5);
		materials.concrete = new THREE.MeshStandardMaterial({
			map: lime.color, bumpMap: lime.bump, bumpScale: 0.4,
			roughness: 0.88, metalness: 0, envMapIntensity: 0.4,
		});
		materials.brick = materials.concrete;
	} else if (wall === "precast") {
		// Smooth pale precast panels with recessed joints on a 3 m grid.
		const panel = precastMaps(true);
		panel.color.anisotropy = anisotropy;
		panel.color.repeat.set(1 / 3, 1 / 3);
		materials.concrete = new THREE.MeshStandardMaterial({
			map: panel.color, roughness: 0.68, metalness: 0, envMapIntensity: 0.4,
		});
		materials.brick = materials.concrete;
	} else if (wall === "darkpanel") {
		// Wall surfaces recede into dark neutral spandrel tone, trim included,
		// so the glass skin is what you see.
		materials.concrete = new THREE.MeshStandardMaterial({
			color: 0x3a3f43, roughness: 0.5, metalness: 0.25, envMapIntensity: 0.7,
		});
		materials.brick = materials.concrete;
		materials.precast = new THREE.MeshStandardMaterial({
			color: 0x44494d, roughness: 0.45, metalness: 0.3, envMapIntensity: 0.8,
		});
	} else if (wall === "zinc") {
		// Standing-seam zinc: cool blue-grey metal panels, seam every ~0.43m,
		// soft directional sheen from the metalness/roughness pairing.
		const seam = zincMaps();
		seam.color.anisotropy = anisotropy; seam.bump.anisotropy = anisotropy;
		seam.color.repeat.set(1 / 3, 1 / 3); seam.bump.repeat.set(1 / 3, 1 / 3);
		materials.concrete = new THREE.MeshStandardMaterial({
			map: seam.color, bumpMap: seam.bump, bumpScale: 0.5,
			metalness: 0.6, roughness: 0.45, envMapIntensity: 1.4,
		});
		materials.brick = materials.concrete;
	} else if (wall === "wood") {
		// Vertical timber slats: warm mid-brown boards ~0.09m wide with thin
		// dark gaps; fully dielectric and matte.
		const slats = woodMaps();
		slats.color.anisotropy = anisotropy; slats.bump.anisotropy = anisotropy;
		slats.color.repeat.set(1 / 1.44, 1 / 1.44); slats.bump.repeat.set(1 / 1.44, 1 / 1.44);
		materials.concrete = new THREE.MeshStandardMaterial({
			map: slats.color, bumpMap: slats.bump, bumpScale: 0.3,
			metalness: 0, roughness: 0.7, envMapIntensity: 0.35,
		});
		materials.brick = materials.concrete;
	}
}

// glass axis: independent of the wall
function applyGlassAxis(materials, glass) {
	if (glass === "deep") {
		// Deep-set punched read: dark low-reflectance interior behind the pane.
		materials.glass = new THREE.MeshPhysicalMaterial({
			color: 0x1c2529, metalness: 0.85, roughness: 0.1,
			envMapIntensity: 1.1, clearcoat: 1.0, clearcoatRoughness: 0.08,
		});
	} else if (glass === "clear") {
		// Clear glazing in a visible frame: pale shadow-box interior tone,
		// mild sky reflection, so the frame and reveal stay legible instead
		// of the pane reading as a mirror or a hole.
		materials.glass = new THREE.MeshPhysicalMaterial({
			color: 0x8ba0a6, metalness: 0.35, roughness: 0.16,
			envMapIntensity: 0.9, clearcoat: 0.8, clearcoatRoughness: 0.1,
		});
	} else if (glass === "mirror") {
		// High-reflectance curtain-wall skin; blue-tinted so the mirror read
		// keeps contrast against pale walls and flat overcast skies.
		materials.glass = new THREE.MeshPhysicalMaterial({
			color: 0x86a2b8, metalness: 1.0, roughness: 0.04,
			envMapIntensity: 3.0, clearcoat: 1.0, clearcoatRoughness: 0.03,
		});
	}
}

// frame axis
function applyFrameAxis(materials, frame) {
	if (frame === "bronze") {
		materials["window-frame"] = new THREE.MeshStandardMaterial({
			color: 0x2b2118, metalness: 0.85, roughness: 0.4, envMapIntensity: 0.9,
		});
	} else if (frame === "iron") {
		materials["window-frame"] = new THREE.MeshStandardMaterial({
			color: 0x26292b, metalness: 0.75, roughness: 0.42, envMapIntensity: 0.85,
		});
	} else if (frame === "white") {
		materials["window-frame"] = new THREE.MeshStandardMaterial({
			color: 0xe9e7e2, metalness: 0.1, roughness: 0.45, envMapIntensity: 0.7,
		});
	}
}

// punched-window schemes (windows dominate over curtain-wall skin members)
// read better with deeper, darker glass than a reflective sheer skin does.
// Any explicit axis is a deliberate choice, so this is default-only.
function applyPunchedHeuristic(materials, axes, wrap) {
	if (!axes.wall && !axes.glass && !axes.frame && !axes.mood) {
		let windowCount = 0, skinCount = 0;
		wrap.traverse(function (o) {
			if (!o.isMesh || !o.geometry || !o.geometry.userData) return;
			const kind = o.geometry.userData.kind;
			if (kind === "window") windowCount++;
			else if (kind === "mullion" || kind === "transom") skinCount++;
		});
		if (windowCount > skinCount) {
			materials.glass = new THREE.MeshPhysicalMaterial({
				color: 0x2f3e44, metalness: 0.9, roughness: 0.08,
				envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.06,
			});
		}
	}
}

export function buildShowcaseMaterials(axes, anisotropy, wrap) {
	const materials = defaultMaterials(anisotropy);
	applyWallAxis(materials, axes.wall, anisotropy);
	applyGlassAxis(materials, axes.glass);
	applyFrameAxis(materials, axes.frame);
	applyPunchedHeuristic(materials, axes, wrap);
	weatherOpaqueSurfaces(materials, anisotropy);
	// Rooms behind the glass, last, for the same reason the weathering is last: the glass
	// axis replaces this material outright, so anything earlier would give rooms to a pane
	// that is no longer in the table. 3.3 m is the storey this candidate set uses; when the
	// showcase learns the real storey height it should be passed through here, because a
	// room that straddles a spandrel reads worse than no room at all.
	if (materials.glass) applyInteriorMapping(materials.glass, { storey: 3.3, depth: 4.5, bay: 4.0, ground: 0 });
	return materials;
}

/**
 * Give every opaque surface a roughness that varies, and do it LAST.
 *
 * Until now each wall carried one scalar roughness, so the whole facade returned an
 * identical specular response and read as a single synthetic material however its albedo
 * was textured. This runs after the axis appliers because they overwrite the table - the
 * wall branches alias brick to concrete and darkpanel overwrites precast - so anything
 * earlier would weather a material that is no longer there.
 *
 * The repeat is deliberately coarse and shared by nobody: at 1/9 of the world-metre UVs
 * the pattern spans about nine metres, so it reads as how a building has aged rather than
 * as a tile, and it does not land in step with any colour map. Glass and metal frames are
 * left alone - they are the two surfaces where uniform roughness is the truth.
 */
function weatherOpaqueSurfaces(materials, anisotropy) {
	const seeds = { concrete: 7, brick: 23, precast: 41 };
	for (const name of Object.keys(seeds)) {
		const material = materials[name];
		if (!material || material.roughnessMap) continue;
		const map = weatheringMap(seeds[name], 0.10);
		map.anisotropy = anisotropy;
		map.repeat.set(1 / 3.5, 1 / 3.5);
		material.roughnessMap = map;
		// The map is mid-grey, so it multiplies around the authored value rather than
		// replacing it; the scalar stays the material's identity and the map is variation.
		material.needsUpdate = true;
	}
}

export function materialForMesh(mesh, materials) {
	const name = (mesh.material && mesh.material.name) || "concrete";
	return materials[name] || materials.concrete;
}
