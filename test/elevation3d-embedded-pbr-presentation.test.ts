import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmbeddedPbrPresentation } from "../plugins/elevation-3d/web/embedded-pbr-presentation.mjs";
import { renderStyleHash, resolvePbrRenderStyle } from "../plugins/elevation-3d/lib/texturing/render-style.mjs";

class Vector3 {
	x = 0; y = 0; z = 0;
	set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
	copy(other: Vector3) { return this.set(other.x, other.y, other.z); }
	add(other: Vector3) { this.x += other.x; this.y += other.y; this.z += other.z; return this; }
}

class Color {
	value: unknown;
	constructor(value?: unknown) { this.value = value; }
	copy(source: Color | unknown) { this.value = source instanceof Color ? source.value : source; return this; }
	clone() { return new Color(this.value); }
}

class Node {
	children: Node[] = [];
	parent: Node | null = null;
	visible = true;
	matrixWorldUpdates = 0;
	position = new Vector3();
	userData: Record<string, unknown> = {};
	name = "";
	add(...nodes: Node[]) { for (const node of nodes) { node.parent?.remove(node); node.parent = this; this.children.push(node); } }
	remove(node: Node) { this.children = this.children.filter((child) => child !== node); if (node.parent === this) node.parent = null; }
	traverse(visitor: (node: Node) => void) { visitor(this); for (const child of this.children) child.traverse(visitor); }
	updateMatrixWorld() { this.matrixWorldUpdates++; }
}

class Scene extends Node { environment: unknown = "old-environment"; environmentIntensity = 0.25; }
class Group extends Node {}
class PlaneGeometry { disposed = false; width: number; height: number; constructor(width: number, height: number) { this.width = width; this.height = height; } dispose() { this.disposed = true; } }
class MeshStandardMaterial {
	color: unknown; roughness: number; metalness: number; opacity: number; transparent: boolean; depthWrite: boolean;
	disposed = false;
	constructor(values: Record<string, any>) { Object.assign(this, values); this.color = values.color; this.roughness = values.roughness; this.metalness = values.metalness; this.opacity = values.opacity; this.transparent = values.transparent; this.depthWrite = values.depthWrite; }
	dispose() { this.disposed = true; }
}
class ShadowMaterial extends MeshStandardMaterial {}
class Mesh extends Node {
	isMesh = true; castShadow = false; receiveShadow = false;
	geometry: PlaneGeometry | null; material: MeshStandardMaterial | MeshStandardMaterial[];
	constructor(geometry: PlaneGeometry | null, material: MeshStandardMaterial | MeshStandardMaterial[]) { super(); this.geometry = geometry; this.material = material; }
}
class HemisphereLight extends Node { sky: string; ground: string; intensity: number; constructor(sky: string, ground: string, intensity: number) { super(); this.sky = sky; this.ground = ground; this.intensity = intensity; } }
class DirectionalLight extends Node {
	target = new Node(); castShadow = false;
	shadow = {
		mapSize: { width: 0, height: 0, set: (width: number, height: number) => { this.shadow.mapSize.width = width; this.shadow.mapSize.height = height; } },
		radius: 0, bias: 0, normalBias: 0,
		camera: { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 500, projectionUpdates: 0, updateProjectionMatrix() { this.projectionUpdates++; } },
	};
	color: string; intensity: number; constructor(color: string, intensity: number) { super(); this.color = color; this.intensity = intensity; }
}
class RoomEnvironment { disposed = false; dispose() { this.disposed = true; } }
class PMREMGenerator {
	static instances: PMREMGenerator[] = [];
	disposed = false; environments: RoomEnvironment[] = [];
	target = { texture: { id: "pmrem-room" }, disposed: false, dispose() { this.disposed = true; } };
	renderer: unknown; constructor(renderer: unknown) { this.renderer = renderer; PMREMGenerator.instances.push(this); }
	fromScene(environment: RoomEnvironment) { this.environments.push(environment); return this.target; }
	dispose() { this.disposed = true; }
}

const THREE = {
	SRGBColorSpace: "srgb", ACESFilmicToneMapping: "aces", PCFSoftShadowMap: "pcf-soft",
	Color, Vector3, Group, PlaneGeometry, MeshStandardMaterial, ShadowMaterial, Mesh, HemisphereLight, DirectionalLight, PMREMGenerator,
};

function fixture() {
	PMREMGenerator.instances.length = 0;
	const renderer = {
		outputColorSpace: "linear", toneMapping: "none", toneMappingExposure: 0.7,
		shadowMap: { enabled: false, type: "basic" }, clearColor: "#123456", clearAlpha: 0.4,
		setClearColor(color: unknown, alpha: number) { this.clearColor = color instanceof Color ? color.value as string : color as string; this.clearAlpha = alpha; },
		getClearColor(target: Color) { return target.copy(this.clearColor); }, getClearAlpha() { return this.clearAlpha; },
	};
	const scene = new Scene();
	const root = new Group();
	const maps = { map: {}, normalMap: {}, roughnessMap: {}, metalnessMap: {} };
	const concrete = Object.assign(new MeshStandardMaterial({ roughness: 0.72, metalness: 0.05, opacity: 1, transparent: false, depthWrite: true }), maps);
	const glass = Object.assign(new MeshStandardMaterial({ roughness: 0.18, metalness: 0, opacity: 0.42, transparent: true, depthWrite: false }), { envMapIntensity: 0.8, map: {}, normalMap: {}, roughnessMap: {}, metalnessMap: {} });
	const bronze = Object.assign(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.7, opacity: 1, transparent: false, depthWrite: true }), { envMapIntensity: 0.9 });
	const concreteMesh = new Mesh(null, concrete); const glassMesh = new Mesh(null, glass); const bronzeMesh = new Mesh(null, bronze);
	root.add(concreteMesh, glassMesh, bronzeMesh);
	const materialRecords = [
		{ object: concreteMesh, roles: ["concrete"], array: false, facadeDetail: false, currentMaterials: [concrete] },
		{ object: glassMesh, roles: ["glass"], array: false, facadeDetail: false, currentMaterials: [glass] },
		{ object: bronzeMesh, roles: ["bronze"], array: false, facadeDetail: false, currentMaterials: [bronze] },
	];
	const bounds = { min: new Vector3().set(-5, -3, 2), max: new Vector3().set(7, 9, 12) };
	const style = resolvePbrRenderStyle();
	return { renderer, scene, root, bounds, materialRecords, style, styleHash: renderStyleHash(style), concrete, glass, bronze, concreteMesh, glassMesh, bronzeMesh };
}

test("configures one competition daylight rig while preserving embedded materials and shadow safety", () => {
	const values = fixture();
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	assert.equal(values.renderer.outputColorSpace, "srgb");
	assert.equal(values.renderer.toneMapping, "aces");
	assert.equal(values.renderer.toneMappingExposure, 0.94);
	assert.deepEqual(values.renderer.shadowMap, { enabled: true, type: "pcf-soft" });
	assert.equal(values.renderer.clearColor, "#fafaf7");
	assert.equal(PMREMGenerator.instances.length, 1);
	assert.equal(PMREMGenerator.instances[0].environments.length, 1);
	assert.equal(values.scene.environment, PMREMGenerator.instances[0].target.texture);
	assert.equal(values.scene.environmentIntensity, 0.45);
	assert.equal(values.scene.children.filter((node) => node instanceof HemisphereLight).length, 1);
	assert.equal(values.scene.children.filter((node) => node instanceof DirectionalLight).length, 1);
	const sun = values.scene.children.find((node) => node instanceof DirectionalLight) as DirectionalLight;
	assert.deepEqual(sun.target.position, new Vector3().set(1, 3, 7));
	assert.equal(sun.target.matrixWorldUpdates, 1);
	assert.equal(sun.shadow.camera.projectionUpdates, 1);
	assert.ok(sun.shadow.camera.left < -11 && sun.shadow.camera.right > 11);
	assert.ok(sun.shadow.camera.bottom < -11 && sun.shadow.camera.top > 11);
	assert.ok(sun.shadow.camera.near > 0 && sun.shadow.camera.far > 50);
	assert.equal(values.concreteMesh.castShadow, true); assert.equal(values.concreteMesh.receiveShadow, true);
	assert.equal(values.bronzeMesh.castShadow, true); assert.equal(values.bronzeMesh.receiveShadow, true);
	assert.equal(values.glassMesh.castShadow, false); assert.equal(values.glassMesh.receiveShadow, false);
	assert.equal(values.glass.transparent, true); assert.equal(values.glass.depthWrite, false); assert.equal(values.glass.opacity, 0.42);
	assert.equal(values.concrete.roughness, 0.64); assert.ok(Math.abs(values.bronze.metalness - 0.78) < 1e-12); assert.equal(values.glass.envMapIntensity, 1.35);
	for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap"] as const) assert.ok(values.concrete[slot]);
	presentation.activateView("axon"); presentation.activateView("axon");
	assert.equal(PMREMGenerator.instances.length, 1);
	assert.equal(values.scene.children.filter((node) => node.userData.presentationOnly === true).length, 4);
});

test("manages an authoritative-bounds receiver only for axon views", () => {
	const values = fixture();
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	for (const view of ["front", "back", "left", "right", "plan", "top"]) {
		presentation.activateView(view);
		assert.equal(values.scene.children.some((node) => node.name === "competition-daylight-shadow-receiver"), false);
	}
	presentation.activateView("axon");
	const first = values.scene.children.find((node) => node.name === "competition-daylight-shadow-receiver") as Mesh;
	assert.ok(first); assert.equal(first.userData.presentationOnly, true);
	assert.equal(first.material instanceof ShadowMaterial, true, "receiver must render shadows without a visible material fill");
	assert.deepEqual(first.position, new Vector3().set(1, 3, 1.99));
	assert.equal((first.geometry as PlaneGeometry).width, 15.84); assert.equal((first.geometry as PlaneGeometry).height, 15.84);
	presentation.activateView("axon");
	assert.equal(values.scene.children.find((node) => node.name === "competition-daylight-shadow-receiver"), first);
	presentation.activateView("opposite-axon");
	const second = values.scene.children.find((node) => node.name === "competition-daylight-shadow-receiver") as Mesh;
	assert.notEqual(second, first); assert.equal(first.parent, null);
	assert.equal((first.geometry as PlaneGeometry).disposed, true); assert.equal((first.material as MeshStandardMaterial).disposed, true);
	presentation.activateView("plan");
	assert.equal(second.parent, null); assert.equal(values.scene.children.some((node) => node.name === "competition-daylight-shadow-receiver"), false);
});

test("can exclude presentation-only pixels from geometry evidence without removing the saved-view receiver", () => {
	const values = fixture();
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	presentation.activateView("axon");
	const receiver = values.scene.children.find((node) => node.name === "competition-daylight-shadow-receiver") as Mesh;
	assert.equal(receiver.visible, true);
	presentation.setPresentationObjectsVisible(false);
	assert.equal(receiver.visible, false);
	presentation.setPresentationObjectsVisible(true);
	assert.equal(receiver.visible, true);
});

test("applies a bounded semantic response only once when a material is shared by multiple meshes", () => {
	const values = fixture();
	const sharedMesh = new Mesh(null, values.concrete);
	values.root.add(sharedMesh);
	values.materialRecords.push({
		object: sharedMesh, roles: ["concrete"], array: false, facadeDetail: false, currentMaterials: [values.concrete],
	});
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	assert.equal(values.concrete.roughness, 0.64);
	assert.equal(values.concreteMesh.castShadow, true);
	assert.equal(sharedMesh.castShadow, true);
	assert.equal(presentation.evidence().materialRoles.concrete, 2);
	presentation.dispose();
	assert.equal(values.concrete.roughness, 0.72);
});

test("computes shadow eligibility after an initially opaque glass-role material becomes transparent", () => {
	const values = fixture();
	values.glass.transparent = false;
	values.glass.depthWrite = true;
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	assert.equal(values.glass.transparent, true);
	assert.equal(values.glass.depthWrite, false);
	assert.equal(values.glassMesh.castShadow, false);
	assert.equal(values.glassMesh.receiveShadow, false);
	assert.equal(presentation.evidence().shadows.casters, 2);
	assert.equal(presentation.evidence().shadows.receivers, 2);
});

test("emits serializable lifecycle evidence and restores every owned resource exactly once", () => {
	const values = fixture();
	const originals = {
		concreteRoughness: values.concrete.roughness, bronzeMetalness: values.bronze.metalness,
		glassEnv: values.glass.envMapIntensity, environment: values.scene.environment, environmentIntensity: values.scene.environmentIntensity,
	};
	const presentation = createEmbeddedPbrPresentation({ THREE, RoomEnvironment, ...values });
	presentation.activateView("axon");
	const receiver = values.scene.children.find((node) => node.name === "competition-daylight-shadow-receiver") as Mesh;
	const evidence = presentation.evidence();
	assert.doesNotThrow(() => JSON.stringify(evidence));
	assert.deepEqual(evidence, {
		style: { id: "competition-daylight-v1", hash: values.styleHash },
		toneMapping: { mode: "aces-filmic", exposure: 0.94, outputColorSpace: "srgb" },
		environment: { type: "room-pmrem", intensity: 0.45, count: 1 },
		lights: { hemisphere: 1, sun: 1 },
		shadows: {
			enabled: true, type: "pcf-soft", casters: 2, receivers: 3, bias: -0.0002, normalBias: 0.02,
			target: [1, 3, 7],
			camera: { left: -13.492512, right: 13.492512, top: 13.492512, bottom: -13.492512, near: 41.743346, far: 68.72837 },
		},
		materialRoles: { bronze: 1, concrete: 1, glass: 1 },
		presentationObjects: { helpers: 3, receivers: 1, total: 4 },
		view: "axon",
	});
	presentation.dispose(); presentation.dispose();
	assert.equal(values.renderer.outputColorSpace, "linear"); assert.equal(values.renderer.toneMapping, "none");
	assert.equal(values.renderer.toneMappingExposure, 0.7); assert.deepEqual(values.renderer.shadowMap, { enabled: false, type: "basic" });
	assert.equal(values.renderer.clearColor, "#123456"); assert.equal(values.renderer.clearAlpha, 0.4);
	assert.equal(values.scene.environment, originals.environment); assert.equal(values.scene.environmentIntensity, originals.environmentIntensity);
	assert.equal(values.concrete.roughness, originals.concreteRoughness); assert.equal(values.bronze.metalness, originals.bronzeMetalness);
	assert.equal(values.glass.envMapIntensity, originals.glassEnv); assert.equal(values.glass.transparent, true); assert.equal(values.glass.depthWrite, false);
	assert.equal(values.concreteMesh.castShadow, false); assert.equal(values.concreteMesh.receiveShadow, false);
	assert.equal(values.bronzeMesh.castShadow, false); assert.equal(values.bronzeMesh.receiveShadow, false);
	assert.equal(values.glassMesh.castShadow, false); assert.equal(values.glassMesh.receiveShadow, false);
	assert.equal(PMREMGenerator.instances[0].disposed, true); assert.equal(PMREMGenerator.instances[0].target.disposed, true);
	assert.equal(PMREMGenerator.instances[0].environments[0].disposed, true);
	assert.equal((receiver.geometry as PlaneGeometry).disposed, true); assert.equal((receiver.material as MeshStandardMaterial).disposed, true);
	assert.equal(values.scene.children.length, 0);
});
