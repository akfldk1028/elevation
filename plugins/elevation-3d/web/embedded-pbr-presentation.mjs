import { viewPresentationPolicy } from "../lib/texturing/render-style.mjs";

const SCALAR_PROPERTIES = ["roughness", "metalness", "envMapIntensity", "opacity", "transparent", "depthWrite"];

function clamp(value, minimum, maximum) {
	return Math.min(maximum, Math.max(minimum, value));
}

function materialsFor(record) {
	return record.currentMaterials ?? (Array.isArray(record.object.material) ? record.object.material : [record.object.material]);
}

function markPresentationOnly(node, name) {
	node.name = name;
	node.userData = { ...node.userData, presentationOnly: true };
	return node;
}

export function createEmbeddedPbrPresentation({
	THREE, RoomEnvironment, renderer, scene, root, bounds,
	materialRecords, style, styleHash,
}) {
	const rendererState = {
		outputColorSpace: renderer.outputColorSpace,
		toneMapping: renderer.toneMapping,
		toneMappingExposure: renderer.toneMappingExposure,
		shadowEnabled: renderer.shadowMap.enabled,
		shadowType: renderer.shadowMap.type,
		clearColor: renderer.getClearColor().clone(),
		clearAlpha: renderer.getClearAlpha(),
	};
	const sceneState = { environment: scene.environment, environmentIntensity: scene.environmentIntensity };
	const materialState = new Map();
	const adjustedMaterials = new Set();
	const meshShadowState = new Map();
	const roleCounts = {};
	let disposed = false;
	let activeView = null;
	let receiver = null;

	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = style.exposure;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.setClearColor(style.background, 1);

	const roomEnvironment = new RoomEnvironment();
	const pmrem = new THREE.PMREMGenerator(renderer);
	const environmentTarget = pmrem.fromScene(roomEnvironment, 0.04);
	scene.environment = environmentTarget.texture;
	scene.environmentIntensity = style.environment.intensity;

	const hemisphere = markPresentationOnly(
		new THREE.HemisphereLight(style.hemisphere.sky, style.hemisphere.ground, style.hemisphere.intensity),
		"competition-daylight-hemisphere",
	);
	const sun = markPresentationOnly(
		new THREE.DirectionalLight(style.sun.color, style.sun.intensity),
		"competition-daylight-sun",
	);
	markPresentationOnly(sun.target, "competition-daylight-sun-target");
	sun.position.set(...style.sun.position);
	sun.castShadow = true;
	sun.shadow.mapSize.set(style.sun.shadowMapSize, style.sun.shadowMapSize);
	sun.shadow.radius = style.sun.radius;
	sun.shadow.bias = clamp(style.sun.bias, -0.001, 0.001);
	sun.shadow.normalBias = clamp(style.sun.normalBias, 0, 0.1);
	scene.add(hemisphere, sun, sun.target);

	for (const record of materialRecords) {
		const materials = materialsFor(record);
		if (!meshShadowState.has(record.object)) {
			meshShadowState.set(record.object, { castShadow: record.object.castShadow, receiveShadow: record.object.receiveShadow });
		}
		for (const [index, material] of materials.entries()) {
			if (!materialState.has(material)) {
				materialState.set(material, Object.fromEntries(SCALAR_PROPERTIES.map((property) => [property, material[property]])));
			}
			const role = record.roles[index] ?? "opaque";
			roleCounts[role] = (roleCounts[role] ?? 0) + 1;
			if (adjustedMaterials.has(material)) continue;
			adjustedMaterials.add(material);
			if (role === "concrete" && Number.isFinite(material.roughness)) {
				material.roughness = clamp(material.roughness + style.materialResponse.concrete.maxRoughnessDelta, 0, 1);
			} else if (role === "bronze" && Number.isFinite(material.metalness)) {
				material.metalness = clamp(material.metalness + style.materialResponse.bronze.maxMetalnessDelta, 0, 1);
			} else if (role === "glass") {
				if (Number.isFinite(material.envMapIntensity)) material.envMapIntensity = style.materialResponse.glass.maxEnvIntensity;
				if (style.materialResponse.glass.preserveTransparency) {
					material.transparent = true;
					material.depthWrite = false;
				}
			} else if (Number.isFinite(material.roughness)) {
				material.roughness = clamp(material.roughness + style.materialResponse.opaque.maxRoughnessDelta, 0, 1);
			}
		}
	}
	for (const record of materialRecords) {
		const opaque = materialsFor(record).every((material) => !material.transparent);
		record.object.castShadow = opaque;
		record.object.receiveShadow = opaque;
	}

	function removeReceiver() {
		if (!receiver) return;
		receiver.parent?.remove(receiver);
		receiver.geometry.dispose();
		receiver.material.dispose();
		receiver = null;
	}

	function createReceiver() {
		const width = (bounds.max.x - bounds.min.x) * (1 + style.ground.padding * 2);
		const height = (bounds.max.y - bounds.min.y) * (1 + style.ground.padding * 2);
		const geometry = new THREE.PlaneGeometry(width, height);
		const material = new THREE.MeshStandardMaterial({
			color: style.background,
			roughness: 1,
			metalness: 0,
			opacity: style.ground.opacity,
			transparent: style.ground.opacity < 1,
			depthWrite: style.ground.opacity >= 1,
		});
		const result = markPresentationOnly(new THREE.Mesh(geometry, material), "competition-daylight-shadow-receiver");
		result.position.set(
			(bounds.min.x + bounds.max.x) / 2,
			(bounds.min.y + bounds.max.y) / 2,
			bounds.min.z - 0.01,
		);
		result.receiveShadow = true;
		result.castShadow = false;
		return result;
	}

	function activateView(viewName) {
		if (disposed || viewName === activeView) return;
		const policy = viewPresentationPolicy(viewName, style);
		removeReceiver();
		activeView = viewName;
		if (policy.ground) {
			receiver = createReceiver();
			scene.add(receiver);
		}
	}

	function evidence() {
		const opaqueMeshes = materialRecords.filter((record) => materialsFor(record).every((material) => !material.transparent)).length;
		return {
			style: { id: style.id, hash: styleHash },
			toneMapping: { mode: style.toneMapping, exposure: style.exposure, outputColorSpace: THREE.SRGBColorSpace },
			environment: { type: style.environment.type, intensity: style.environment.intensity, count: 1 },
			lights: { hemisphere: 1, sun: 1 },
			shadows: {
				enabled: true, type: THREE.PCFSoftShadowMap, casters: opaqueMeshes,
				receivers: opaqueMeshes + (receiver ? 1 : 0), bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
			},
			materialRoles: Object.fromEntries(Object.entries(roleCounts).sort(([left], [right]) => left.localeCompare(right))),
			presentationObjects: { helpers: 3, receivers: receiver ? 1 : 0, total: 3 + (receiver ? 1 : 0) },
			view: activeView,
		};
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		removeReceiver();
		scene.remove(hemisphere);
		scene.remove(sun);
		scene.remove(sun.target);
		for (const [material, values] of materialState) Object.assign(material, values);
		for (const [mesh, values] of meshShadowState) Object.assign(mesh, values);
		scene.environment = sceneState.environment;
		scene.environmentIntensity = sceneState.environmentIntensity;
		environmentTarget.dispose();
		roomEnvironment.dispose?.();
		pmrem.dispose();
		renderer.outputColorSpace = rendererState.outputColorSpace;
		renderer.toneMapping = rendererState.toneMapping;
		renderer.toneMappingExposure = rendererState.toneMappingExposure;
		renderer.shadowMap.enabled = rendererState.shadowEnabled;
		renderer.shadowMap.type = rendererState.shadowType;
		renderer.setClearColor(rendererState.clearColor, rendererState.clearAlpha);
	}

	return { activateView, evidence, dispose };
}
