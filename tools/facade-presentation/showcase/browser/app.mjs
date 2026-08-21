import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { MOOD_PRESETS, styleValue } from "./moods.mjs";
import { canvasTexture, groundMaps } from "./textures.mjs";
import { skyDome, buildEnvironmentTexture } from "./sky-env.mjs";
import { prepareGeometry } from "./geometry.mjs";
import { buildShowcaseMaterials, materialForMesh } from "./materials.mjs";
import { deriveBaseAzimuth, setupCamera } from "./camera.mjs";

// Injected by esbuild define. AXES: { wall, glass, frame, mood }, "" for unset
// axes. FACE: "front" | "back" | "left" | "right" | "auto". This is the only
// module that reads them; everything else takes explicit arguments.
const AXES = __SHOWCASE_AXES__;
const FACE = __SHOWCASE_FACE__;

const PRESET = MOOD_PRESETS[AXES.mood] || null;
const SKY_COLORS = PRESET ? PRESET.sky : null;

function preset(key, fallback) {
	return styleValue(PRESET, key, fallback);
}

// ---------------- main ----------------

async function main() {
	const W = window.innerWidth, H = window.innerHeight;
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setSize(W, H);
	renderer.setPixelRatio(1);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = preset("exposure", 1.05);
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	document.body.appendChild(renderer.domElement);
	const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(new THREE.Color(preset("fog", "#e9e1d2")), 60, 800);

	// ---- load model ----
	const gltf = await new Promise(function (resolveLoad, rejectLoad) {
		new GLTFLoader().load("../model.glb", resolveLoad, undefined, rejectLoad);
	});
	const wrap = new THREE.Group();
	wrap.rotation.x = -Math.PI / 2; // GLB is z-up
	wrap.add(gltf.scene);
	scene.add(wrap);
	wrap.updateMatrixWorld(true);

	// ---- sun & sky (direction fixed after camera azimuth is known) ----
	// One bounds value-object shared by ground decal, sun shadow, fill and camera.
	const box = new THREE.Box3().setFromObject(wrap);
	const center = box.getCenter(new THREE.Vector3());
	const sizes = box.getSize(new THREE.Vector3());
	const bounds = { box: box, center: center, sizes: sizes };

	const baseAz = deriveBaseAzimuth(wrap, center, FACE);
	const camAz = baseAz + THREE.MathUtils.degToRad(52);
	const sunAz = baseAz + THREE.MathUtils.degToRad(preset("sunAzDeg", -38));
	const sunAlt = THREE.MathUtils.degToRad(preset("sunAltDeg", 26));
	const sunDir = new THREE.Vector3(
		Math.sin(sunAz) * Math.cos(sunAlt), Math.sin(sunAlt), Math.cos(sunAz) * Math.cos(sunAlt),
	).normalize();

	scene.add(skyDome(1200, sunDir, 1.0, true, SKY_COLORS));
	scene.environment = buildEnvironmentTexture(renderer, sunDir, SKY_COLORS);
	scene.environmentIntensity = preset("envIntensity", 0.6);

	// ---- materials (default table -> wall -> glass -> frame -> punched
	// heuristic, in that order; materials.mjs owns the order) ----
	const materials = buildShowcaseMaterials(AXES, anisotropy, wrap);

	wrap.traverse(function (o) {
		if (!o.isMesh) return;
		prepareGeometry(o);
		o.material = materialForMesh(o, materials);
		o.castShadow = true;
		o.receiveShadow = true;
	});

	// ---- ground ----
	const ground = groundMaps();
	ground.color.anisotropy = anisotropy;
	ground.color.repeat.set(1 / 7, 1 / 7);
	const groundMesh = new THREE.Mesh(
		new THREE.CircleGeometry(900, 64),
		new THREE.MeshStandardMaterial({
			map: ground.color, roughness: 0.94, metalness: 0, envMapIntensity: 0.3,
		}),
	);
	groundMesh.rotation.x = -Math.PI / 2;
	groundMesh.position.y = -0.01;
	groundMesh.receiveShadow = true;
	scene.add(groundMesh);

	// baked radial contact darkening on the ground under the building footprint,
	// so the building sits into the site instead of on top of a clean plane
	const contactTex = canvasTexture(512, function (ctx, size) {
		ctx.clearRect(0, 0, size, size);
		const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		grad.addColorStop(0, "rgba(20,16,12,0.42)");
		grad.addColorStop(0.7, "rgba(20,16,12,0.30)");
		grad.addColorStop(1, "rgba(20,16,12,0)");
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, size, size);
	}, false);
	contactTex.wrapS = contactTex.wrapT = THREE.ClampToEdgeWrapping;
	const contactMesh = new THREE.Mesh(
		new THREE.PlaneGeometry(sizes.x * 1.3, sizes.z * 1.3),
		new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false }),
	);
	contactMesh.rotation.x = -Math.PI / 2;
	contactMesh.position.set(center.x, -0.005, center.z);
	scene.add(contactMesh);

	// ---- lights ----
	const sun = new THREE.DirectionalLight(preset("sunColor", 0xffd8ae), preset("sunIntensity", 4.6));
	sun.position.copy(center).addScaledVector(sunDir, 80);
	sun.target.position.copy(center);
	sun.castShadow = true;
	sun.shadow.mapSize.set(4096, 4096);
	const shadowRadius = Math.max(sizes.x, sizes.z) * 1.15;
	sun.shadow.camera.left = -shadowRadius;
	sun.shadow.camera.right = shadowRadius;
	sun.shadow.camera.top = shadowRadius;
	sun.shadow.camera.bottom = -shadowRadius;
	sun.shadow.camera.near = 5;
	sun.shadow.camera.far = 220;
	sun.shadow.bias = -0.00015;
	sun.shadow.normalBias = 0.03;
	scene.add(sun);
	scene.add(sun.target);

	scene.add(new THREE.HemisphereLight(
		preset("hemiSky", 0xbcd2e8), preset("hemiGround", 0xa3937a), preset("hemiIntensity", 0.75),
	));
	const fill = new THREE.DirectionalLight(preset("fillColor", 0xa9c2dd), preset("fillIntensity", 0.45));
	fill.position.copy(center).add(new THREE.Vector3(-sunDir.x, 0.5, -sunDir.z).multiplyScalar(60));
	fill.target.position.copy(center);
	scene.add(fill);
	scene.add(fill.target);

	// ---- camera ----
	const camera = setupCamera(W, H, bounds, camAz, preset("camHeight", 1.7));

	// ---- render ----
	for (let i = 0; i < 3; i++) renderer.render(scene, camera);
	window.__SHOWCASE_READY__ = true;
}

main().catch(function (error) {
	window.__SHOWCASE_ERROR__ = String((error && error.stack) || error);
});
