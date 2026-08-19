import { SEMANTIC_ROLE_COLORS, SEMANTIC_ROLES } from "../lib/semantic-role-mask.mjs";
import { viewPresentationPolicy } from "../lib/texturing/render-style.mjs";

const SCALAR_PROPERTIES = ["roughness", "metalness", "envMapIntensity", "opacity", "transparent", "depthWrite"];

function clamp(value, minimum, maximum) {
	return Math.min(maximum, Math.max(minimum, value));
}

function evidenceNumber(value) {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function sanitizedEnvironmentMessage(error) {
	return String(error?.message ?? error ?? "environment initialization failed")
		.replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
		.replace(/\b(token|api[_-]?key|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.slice(0, 300);
}

function materialsFor(record) {
	return record.currentMaterials ?? (Array.isArray(record.object.material) ? record.object.material : [record.object.material]);
}

function markPresentationOnly(node, name) {
	node.name = name;
	node.userData = { ...node.userData, presentationOnly: true };
	return node;
}


// Exported so the vocabulary drift test can read the table itself rather than a parse of
// its text. A kind missing from here does not fail - it falls through to `concrete` - so
// the only thing that catches the omission is a test that can see the real object.
export const KIND_ROLES = Object.freeze({
	// procedural grammar vocabulary
	mullion: "bronze", "window-frame": "bronze", glazing: "glass", "opaque-panel": "opaque",
	"floor-band": "concrete", parapet: "concrete", "exact-mass": "concrete",
	// design grammar vocabulary - without these a facade that draws its own trim has
	// no bronze at all, and a pilaster is never anything but wall
	// A pilaster is a wall pier and reads as wall; the opaque tint is dark enough that
	// mapping a full-height element to it drags the whole facade under the luminance
	// floor. The thin bands carry the opaque role instead.
	door: "glass", window: "glass", reveal: "bronze",
	lintel: "concrete", sill: "opaque", band: "opaque", cornice: "concrete",
	pilaster: "concrete",
	// curtain wall vocabulary. `mullion` is already mapped above with the procedural
	// vocabulary and means the same member there, so the two agree on one entry.
	//
	// A transom is a glazed skin's sill and takes the sill's role. It is thin, and thin
	// members are what carry the darkest tint in this table. It is also the only opaque
	// left on a facade written entirely in curtain-wall words - glass panes, bronze
	// mullions, concrete spandrels - and every elevation must show all four roles or it
	// fails MATERIAL_ROLE_MISSING, which is how the missing bronze was found.
	//
	// The spandrel is the one member of the three that covers a large area, and it is
	// deliberately NOT opaque. A large field on the darkest tint is the measured cause of
	// the PBR luminance floor failing: brick-cladding on opaque put 83% of the building
	// there and took the back view's luminance P50 to 9.9, failing
	// PBR_PRESENTATION_RANGE_INVALID. concrete is the palette's only bright role, so it is
	// the only assignment that leaves a mostly-spandrel facade readable. The known cost is
	// that it shares a role with `exact-mass`, and two surfaces on one role make their
	// depth edge a same-material seam; a spandrel sits between a window head and the sill
	// above, so it is high in the storey and does not cross the 1.2 m plan cut, but a
	// grammar that puts one at grade would be the case to watch.
	transom: "opaque", spandrel: "concrete",
	// typed facade vocabulary. Missing from this table since 61d457f moved the competition
	// views onto resolveSemanticRole, so all five fell through to the `concrete` fallback,
	// nothing was left on `opaque` and the front elevation failed MATERIAL_ROLE_MISSING.
	//
	// The cladding cannot take `concrete`: it runs from grade, its cut face meets the
	// mass's at the 1.2 m plan cut, and two surfaces on one role make that boundary a
	// same-material seam - measured 8 visible segments, longest 135 px, TRIANGULATION_VISIBLE.
	// So it takes `opaque`, which is what the pre-61d457f material-name lookup gave it and
	// what the typed elevations' 0.60 dark-fraction limit was calibrated for. The known PBR
	// cost of a large opaque field - back-view luminance P50 9.9 against a floor of 10 -
	// is carried by the reveal presentation style the typed delivery now renders under,
	// not by this table.
	"brick-cladding": "opaque", "corner-return": "opaque", "window-reveal": "bronze",
	"precast-lintel": "concrete", "precast-sill": "opaque",
});

function namedRole(value) {
	const name = String(value ?? "").toLowerCase();
	return SEMANTIC_ROLES.find((role) => name === role || name.includes(role)) ?? null;
}

function userDataRole(userData) {
	for (const field of ["material", "semantic_role", "semanticRole", "material_role", "materialRole", "role"]) {
		const role = namedRole(userData?.[field]);
		if (role) return { role, field };
	}
	const kind = String(userData?.kind ?? "").toLowerCase();
	return KIND_ROLES[kind] ? { role: KIND_ROLES[kind], field: "kind" } : null;
}

export function resolveSemanticRole({ object, material, primitiveExtras }) {
	const primitiveData = userDataRole(primitiveExtras);
	if (primitiveData) return { role: primitiveData.role, source: `primitive.extras.${primitiveData.field}` };
	const objectData = userDataRole(object?.userData);
	if (objectData) return { role: objectData.role, source: `object.userData.${objectData.field}` };
	const materialData = userDataRole(material?.userData);
	if (materialData) return { role: materialData.role, source: `material.userData.${materialData.field}` };
	const materialName = namedRole(material?.name);
	if (materialName) return { role: materialName, source: "material.name" };
	const objectName = namedRole(object?.name);
	if (objectName) return { role: objectName, source: "object.name" };
	let ancestor = object?.parent;
	while (ancestor) {
		const data = userDataRole(ancestor.userData);
		if (data) return { role: data.role, source: `ancestor.userData.${data.field}` };
		const role = namedRole(ancestor.name);
		if (role) return { role, source: "ancestor.name" };
		ancestor = ancestor.parent;
	}
	return { role: "concrete", source: "fallback.concrete" };
}

export function resolveGltfPrimitiveExtras({ gltf, object }) {
	const association = gltf?.parser?.associations?.get(object);
	if (!Number.isInteger(association?.meshes) || !Number.isInteger(association?.primitives)) return null;
	return gltf.parser.json.meshes?.[association.meshes]?.primitives?.[association.primitives]?.extras ?? null;
}

export function semanticRoleGeometryEvidence(materialRecords) {
	const result = Object.fromEntries(SEMANTIC_ROLES.map((role) => [role, { meshCount: 0, vertexCount: 0, triangleCount: 0, attributionSources: {} }]));
	for (const record of materialRecords) {
		const positionCount = record.object.geometry?.getAttribute?.("position")?.count ?? 0;
		const indexCount = record.object.geometry?.getIndex?.()?.count ?? record.object.geometry?.index?.count ?? positionCount;
		for (const [index, role] of record.roles.entries()) {
			const target = result[role] ?? result.opaque;
			const groups = record.array ? (record.object.geometry?.groups ?? []).filter((group) => group.materialIndex === index) : [];
			const elementCount = groups.length ? groups.reduce((sum, group) => sum + group.count, 0) : indexCount / Math.max(1, record.roles.length);
			target.meshCount++;
			target.vertexCount += positionCount / Math.max(1, record.roles.length);
			target.triangleCount += elementCount / 3;
			const source = record.roleSources?.[index] ?? "unknown";
			target.attributionSources[source] = (target.attributionSources[source] ?? 0) + 1;
		}
	}
	for (const record of Object.values(result)) {
		record.vertexCount = Math.round(record.vertexCount);
		record.triangleCount = Math.round(record.triangleCount);
	}
	return result;
}

export function renderSemanticRoleMask({ THREE, renderer, scene, camera, materialRecords }) {
	const clearColor = renderer.getClearColor(new THREE.Color()).clone();
	const clearAlpha = renderer.getClearAlpha();
	const outputColorSpace = renderer.outputColorSpace;
	const toneMapping = renderer.toneMapping;
	const objectMaterials = materialRecords.map((record) => [record.object, record.object.material]);
	const presentationVisibility = [];
	const diagnosticMaterials = [];
	scene.traverse((node) => {
		if (node.userData?.presentationOnly === true) presentationVisibility.push([node, node.visible]);
	});
	try {
		for (const record of materialRecords) {
			const sourceMaterials = materialsFor(record);
			const replacements = sourceMaterials.map((source, index) => {
				const role = record.roles[index] ?? "opaque";
				const material = new THREE.MeshBasicMaterial({
					color: SEMANTIC_ROLE_COLORS[role] ?? SEMANTIC_ROLE_COLORS.opaque,
					toneMapped: false, transparent: false, opacity: 1,
					side: source.side, clippingPlanes: source.clippingPlanes,
				});
				diagnosticMaterials.push(material);
				return material;
			});
			record.object.material = record.array ? replacements : replacements[0];
		}
		for (const [node] of presentationVisibility) node.visible = false;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.NoToneMapping;
		renderer.setClearColor(0x000000, 1);
		renderer.render(scene, camera);
		return renderer.domElement.toDataURL("image/png");
	} finally {
		for (const [object, material] of objectMaterials) object.material = material;
		for (const [node, visible] of presentationVisibility) node.visible = visible;
		for (const material of diagnosticMaterials) material.dispose();
		renderer.outputColorSpace = outputColorSpace;
		renderer.toneMapping = toneMapping;
		renderer.setClearColor(clearColor, clearAlpha);
	}
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
		clearColor: renderer.getClearColor(new THREE.Color()).clone(),
		clearAlpha: renderer.getClearAlpha(),
	};
	const sceneState = { environment: scene.environment, environmentIntensity: scene.environmentIntensity };
	const materialState = new Map();
	const adjustedMaterials = new Set();
	const ownedRoleMaterials = new Set();
	const recordMaterialState = materialRecords.map((record) => ({ record, objectMaterial: record.object.material, currentMaterials: record.currentMaterials }));
	const meshShadowState = new Map();
	const roleCounts = {};
	let disposed = false;
	let activeView = null;
	let receiver = null;
	let presentationObjectsVisible = true;

	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = style.exposure;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.VSMShadowMap;
	renderer.setClearColor(style.background, 1);

	let roomEnvironment = null;
	let pmrem = null;
	let environmentTarget = null;
	let environmentEvidence;
	try {
		roomEnvironment = new RoomEnvironment();
		pmrem = new THREE.PMREMGenerator(renderer);
		environmentTarget = pmrem.fromScene(roomEnvironment, 0.04);
		scene.environment = environmentTarget.texture;
		scene.environmentIntensity = style.environment.intensity;
		environmentEvidence = { type: style.environment.type, intensity: style.environment.intensity, count: 1, status: "ready" };
	} catch (error) {
		environmentTarget?.dispose?.();
		pmrem?.dispose?.();
		roomEnvironment?.dispose?.();
		environmentTarget = null;
		pmrem = null;
		roomEnvironment = null;
		environmentEvidence = {
			type: style.environment.type, intensity: style.environment.intensity, count: 0,
			status: "failed", code: "PBR_ENVIRONMENT_FAILED", message: sanitizedEnvironmentMessage(error),
		};
	}

	const hemisphere = markPresentationOnly(
		new THREE.HemisphereLight(style.hemisphere.sky, style.hemisphere.ground, style.hemisphere.intensity),
		"competition-daylight-hemisphere",
	);
	const target = [
		(bounds.min.x + bounds.max.x) / 2,
		(bounds.min.y + bounds.max.y) / 2,
		(bounds.min.z + bounds.max.z) / 2,
	];
	function createSun(name) {
		const light = markPresentationOnly(
			new THREE.DirectionalLight(style.sun.color, style.sun.intensity / 2),
			`competition-daylight-sun-${name}`,
		);
		markPresentationOnly(light.target, `competition-daylight-sun-${name}-target`);
		light.target.position.set(...target);
		light.castShadow = true;
		light.shadow.mapSize.set(style.sun.shadowMapSize, style.sun.shadowMapSize);
		light.shadow.intensity = 0.5;
		light.shadow.radius = style.sun.radius;
		light.shadow.bias = clamp(style.sun.bias, -0.001, 0.001);
		light.shadow.normalBias = clamp(style.sun.normalBias, 0, 0.1);
		return light;
	}
	const suns = [createSun("primary"), createSun("soft")];
	const sun = suns[0];
	const receiverWidth = (bounds.max.x - bounds.min.x) * (1 + style.ground.padding * 2);
	const receiverHeight = (bounds.max.y - bounds.min.y) * (1 + style.ground.padding * 2);
	const shadowExtent = Math.hypot(receiverWidth, receiverHeight, bounds.max.z - bounds.min.z) * 0.55;
	const styledSunPosition = [...style.sun.position];
	const mirroredSunPosition = [
		target[0] * 2 - styledSunPosition[0],
		target[1] * 2 - styledSunPosition[1],
		styledSunPosition[2],
	];
	const softSunOffset = Math.PI / 12;
	function softSunPosition(position) {
		const x = position[0] - target[0], y = position[1] - target[1];
		return [
			target[0] + x * Math.cos(softSunOffset) - y * Math.sin(softSunOffset),
			target[1] + x * Math.sin(softSunOffset) + y * Math.cos(softSunOffset),
			position[2],
		];
	}
	function configureSun(viewName) {
		const primaryPosition = viewName === "axon" ? mirroredSunPosition : styledSunPosition;
		for (const [index, light] of suns.entries()) {
			const position = index === 0 ? primaryPosition : softSunPosition(primaryPosition);
			light.position.set(...position);
			const sunDistance = Math.hypot(
				light.position.x - target[0], light.position.y - target[1], light.position.z - target[2],
			);
			Object.assign(light.shadow.camera, {
				left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent,
				near: Math.max(0.1, sunDistance - shadowExtent), far: sunDistance + shadowExtent,
			});
			light.target.updateMatrixWorld();
			light.updateMatrixWorld();
			light.shadow.camera.updateProjectionMatrix();
		}
	}
	configureSun(null);
	scene.add(hemisphere, ...suns.flatMap((light) => [light, light.target]));

	const materialRoles = new Map();
	for (const record of materialRecords) for (const [index, material] of materialsFor(record).entries()) {
		if (!materialRoles.has(material)) materialRoles.set(material, new Set());
		materialRoles.get(material).add(record.roles[index] ?? "opaque");
	}
	const roleClones = new Map();
	for (const record of materialRecords) {
		const originals = materialsFor(record);
		const replacements = originals.map((material, index) => {
			const role = record.roles[index] ?? "opaque";
			if (materialRoles.get(material)?.size <= 1) return material;
			if (!roleClones.has(material)) roleClones.set(material, new Map());
			const byRole = roleClones.get(material);
			if (!byRole.has(role)) {
				const clone = material.clone();
				byRole.set(role, clone);
				ownedRoleMaterials.add(clone);
			}
			return byRole.get(role);
		});
		record.object.material = record.array ? replacements : replacements[0];
		record.currentMaterials = replacements;
	}

	for (const record of materialRecords) {
		const materials = materialsFor(record);
		if (!meshShadowState.has(record.object)) {
			meshShadowState.set(record.object, { castShadow: record.object.castShadow, receiveShadow: record.object.receiveShadow });
		}
		for (const [index, material] of materials.entries()) {
			if (!materialState.has(material)) {
				materialState.set(material, {
					...Object.fromEntries(SCALAR_PROPERTIES.map((property) => [property, material[property]])),
					color: material.color?.clone?.() ?? null,
				});
			}
			const role = record.roles[index] ?? "opaque";
			roleCounts[role] = (roleCounts[role] ?? 0) + 1;
			if (adjustedMaterials.has(material)) continue;
			adjustedMaterials.add(material);
			// Guarded. This read is inside the render page, so a role the style has no entry for
			// does not raise a fault - it throws where nothing is listening and the run dies as a
			// 60 s timeout. Adding the fifth role cost exactly that before the entry existed.
			const response = style.materialResponse[role];
			if (response?.tintMultiplier) material.color?.multiply?.(new THREE.Color(response.tintMultiplier));
			if (role === "concrete" && Number.isFinite(material.roughness)) {
				material.roughness = clamp(material.roughness + style.materialResponse.concrete.maxRoughnessDelta, 0, 1);
			} else if (role === "bronze" && Number.isFinite(material.metalness)) {
				material.metalness = clamp(material.metalness + style.materialResponse.bronze.maxMetalnessDelta, 0, 1);
			} else if (role === "glass") {
				if (Number.isFinite(material.envMapIntensity)) material.envMapIntensity = style.materialResponse.glass.maxEnvIntensity;
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
		const geometry = new THREE.PlaneGeometry(receiverWidth, receiverHeight);
		const material = new THREE.ShadowMaterial({
			color: "#000000",
			opacity: style.ground.opacity,
			transparent: true,
			depthWrite: false,
		});
		const result = markPresentationOnly(new THREE.Mesh(geometry, material), "competition-daylight-shadow-receiver");
		result.visible = presentationObjectsVisible;
		result.position.set(
			(bounds.min.x + bounds.max.x) / 2,
			(bounds.min.y + bounds.max.y) / 2,
			bounds.min.z - 0.01,
		);
		result.receiveShadow = true;
		result.castShadow = false;
		return result;
	}

	function setPresentationObjectsVisible(visible) {
		presentationObjectsVisible = visible === true;
		if (receiver) receiver.visible = presentationObjectsVisible;
	}

	function activateView(viewName) {
		if (disposed || viewName === activeView) return;
		const policy = viewPresentationPolicy(viewName, style);
		removeReceiver();
		activeView = viewName;
		configureSun(viewName);
		if (policy.ground) {
			receiver = createReceiver();
			scene.add(receiver);
		}
	}

	function evidence() {
		const opaqueMeshes = materialRecords.filter((record) => materialsFor(record).every((material) => !material.transparent)).length;
		return {
			style: {
				id: style.id, hash: styleHash,
				materialTints: Object.fromEntries(Object.entries(style.materialResponse).map(([role, response]) => [role, response.tintMultiplier])),
			},
			toneMapping: { mode: style.toneMapping, exposure: style.exposure, outputColorSpace: THREE.SRGBColorSpace },
			environment: environmentEvidence,
			lights: { hemisphere: 1, sun: suns.length },
			shadows: {
				enabled: true, type: renderer.shadowMap.type, casters: opaqueMeshes,
				receivers: opaqueMeshes + (receiver ? 1 : 0), bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
				target: target.map(evidenceNumber),
				camera: Object.fromEntries(["left", "right", "top", "bottom", "near", "far"]
					.map((field) => [field, evidenceNumber(sun.shadow.camera[field])])),
			},
			materialRoles: Object.fromEntries(Object.entries(roleCounts).sort(([left], [right]) => left.localeCompare(right))),
			presentationObjects: { helpers: 5, receivers: receiver ? 1 : 0, total: 5 + (receiver ? 1 : 0) },
			view: activeView,
		};
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		removeReceiver();
		scene.remove(hemisphere);
		for (const light of suns) {
			scene.remove(light);
			scene.remove(light.target);
		}
		for (const [material, values] of materialState) {
			const { color, ...scalars } = values;
			Object.assign(material, scalars);
			if (color) material.color?.copy?.(color);
		}
		for (const { record, objectMaterial, currentMaterials } of recordMaterialState) {
			record.object.material = objectMaterial;
			record.currentMaterials = currentMaterials;
		}
		for (const material of ownedRoleMaterials) material.dispose();
		for (const [mesh, values] of meshShadowState) Object.assign(mesh, values);
		scene.environment = sceneState.environment;
		scene.environmentIntensity = sceneState.environmentIntensity;
		environmentTarget?.dispose?.();
		roomEnvironment?.dispose?.();
		pmrem?.dispose?.();
		renderer.outputColorSpace = rendererState.outputColorSpace;
		renderer.toneMapping = rendererState.toneMapping;
		renderer.toneMappingExposure = rendererState.toneMappingExposure;
		renderer.shadowMap.enabled = rendererState.shadowEnabled;
		renderer.shadowMap.type = rendererState.shadowType;
		renderer.setClearColor(rendererState.clearColor, rendererState.clearAlpha);
	}

	return { activateView, setPresentationObjectsVisible, evidence, dispose };
}
