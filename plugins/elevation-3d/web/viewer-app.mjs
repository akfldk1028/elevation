import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { resolvePbrRenderStyle } from "../lib/texturing/render-style.mjs";
import { createEmbeddedPbrPresentation } from "./embedded-pbr-presentation.mjs";

const params = new URLSearchParams(location.search);
const config = await fetch("config.json").then((response) => response.json());
const canvas = document.querySelector("canvas");
const competitionElevation = params.get("mode") === "competition-elevation" && config.competition_elevation;
const competitionPlan = params.get("mode") === "competition-plan" && config.competition_plan;
const competitionAxon = params.get("mode") === "competition-axon" && config.competition_axon;
const competition = competitionElevation || competitionPlan || competitionAxon;
const allViews = config.all_views;
const outputSize = competition?.output_size ?? 2048;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(outputSize, outputSize, false);
renderer.setClearColor(competition?.background ?? 0xf7f7f5, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
if (!competition && allViews?.material_mode !== "embedded-pbr") {
	scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));
	const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(10, -10, 20); scene.add(sun);
}

function contentCenter() {
	if (config.mesh?.vertices?.length) {
		const box = new THREE.Box3();
		for (const point of config.mesh.vertices) box.expandByPoint(new THREE.Vector3(...point));
		return box.getCenter(new THREE.Vector3());
	}
	return new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3());
}

function createLegacyCamera(name) {
	const view = config.cameras.views[name] ?? config.cameras.views.axon ?? Object.values(config.cameras.views)[0];
	const bounds = view.projected_bounds_m ?? [[-10, -10], [10, 10]];
	const width = Math.max(bounds[1][0] - bounds[0][0], 1);
	const height = Math.max(bounds[1][1] - bounds[0][1], 1);
	const margin = 1.08;
	const camera = new THREE.OrthographicCamera(-width * margin / 2, width * margin / 2, height * margin / 2, -height * margin / 2, 0.01, 10000);
	const axes = view.projection_axes;
	if (axes) {
		const center = contentCenter();
		const depth = new THREE.Vector3(...axes.depth);
		camera.position.copy(center).sub(depth.multiplyScalar(100));
		camera.up.set(...axes.vertical);
		camera.lookAt(center);
	} else { camera.position.set(0, -100, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0); }
	camera.updateProjectionMatrix();
	return camera;
}

function renderInteractiveAllViews(root) {
	const materialMode = allViews.material_mode ?? "procedural-preview";
	const panel = document.querySelector("[data-all-views-panel]");
	panel.hidden = false;
	document.querySelector("[data-status]").hidden = true;
	renderer.setSize(innerWidth, innerHeight, false);
	renderer.setClearColor(0xfafaf7, 1);
	const bounds = new THREE.Box3().setFromObject(root);
	const center = bounds.getCenter(new THREE.Vector3());
	const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.75, 1);
	const resolvedStyle = materialMode === "embedded-pbr" ? resolvePbrRenderStyle(allViews.render_style) : null;
	let camera, controls;
	const materialRecords = [];
	const embeddedMaps = new Map();
	root.traverse((object) => {
		if (!object.isMesh) return;
		const materials = Array.isArray(object.material) ? object.material : [object.material];
		let ancestor = object;
		let facadeDetail = false;
		while (ancestor) {
			if (String(ancestor.name).toLowerCase() === "facade-details") facadeDetail = true;
			ancestor = ancestor.parent;
		}
		materialRecords.push({
			object,
			roles: materials.map(semanticRole),
			array: Array.isArray(object.material),
			facadeDetail,
			currentMaterials: materials,
		});
		if (materialMode === "embedded-pbr") {
			for (const material of materials) {
				embeddedMaps.set(material, {
					map: material.map, normalMap: material.normalMap,
					roughnessMap: material.roughnessMap, metalnessMap: material.metalnessMap,
				});
				material.depthWrite = !material.transparent;
				material.side = THREE.DoubleSide;
				material.polygonOffset = true;
				material.polygonOffsetFactor = facadeDetail ? -4 : 4;
				material.polygonOffsetUnits = facadeDetail ? -4 : 4;
				material.needsUpdate = true;
			}
			object.renderOrder = materials.some((material) => material.transparent) ? 2 : facadeDetail ? 1 : 0;
		}
	});
	const presentation = materialMode === "embedded-pbr" ? createEmbeddedPbrPresentation({
		THREE, RoomEnvironment, renderer, scene, root, bounds, materialRecords,
		style: resolvedStyle, styleHash: allViews.render_style_sha256,
	}) : null;
	let currentView = "axon", currentPalette = materialMode === "embedded-pbr" ? "embedded-pbr" : "warm", currentClipping = { enabled: false, elevation_m: null, plane_world: null }, fullscreenRequests = 0;
	const glbLoadCount = 1;
	function materialStability() {
		let transparentMaterials = 0;
		let transparentDepthWriters = 0;
		let polygonOffsetFacadeDetails = 0;
		let deterministicRenderOrder = true;
		for (const record of materialRecords) {
			const materials = Array.isArray(record.object.material) ? record.object.material : [record.object.material];
			const transparent = materials.some((material) => material.transparent);
			transparentMaterials += materials.filter((material) => material.transparent).length;
			transparentDepthWriters += materials.filter((material) => material.transparent && material.depthWrite).length;
			if (record.facadeDetail && materials.every((material) => material.polygonOffset && material.polygonOffsetFactor === -4 && material.polygonOffsetUnits === -4)) polygonOffsetFacadeDetails++;
			const expectedRenderOrder = transparent ? 2 : record.facadeDetail ? 1 : 0;
			if (record.object.renderOrder !== expectedRenderOrder) deterministicRenderOrder = false;
		}
		return {
			mesh_count: materialRecords.length,
			facade_detail_meshes: materialRecords.filter((record) => record.facadeDetail).length,
			transparent_materials: transparentMaterials,
			transparent_depth_writers: transparentDepthWriters,
			polygon_offset_facade_details: polygonOffsetFacadeDetails,
			deterministic_render_order: deterministicRenderOrder,
		};
	}
	function state() {
		const presentationState = presentation?.evidence() ?? null;
		globalThis.__ELEVATION3D_VIEWER_STATE__ = {
			view: currentView, palette: currentPalette, material_mode: materialMode, selected_glb_sha256: allViews.selected_glb.sha256,
			render_style_id: presentationState?.style.id ?? null, render_style_sha256: presentationState?.style.hash ?? null,
			glb_load_count: glbLoadCount, fullscreen_supported: typeof document.documentElement.requestFullscreen === "function",
			fullscreen_active: Boolean(document.fullscreenElement), fullscreen_requests: fullscreenRequests,
			camera: { type: camera?.isOrthographicCamera ? "orthographic" : "perspective", position: camera?.position.toArray(), target: controls?.target.toArray(), zoom: camera?.zoom, projection_axes: config.cameras.views[currentView]?.projection_axes, depth: config.cameras.views[currentView]?.depth },
			clipping: currentClipping,
			material_stability: materialStability(),
			presentation: presentationState,
		};
		document.querySelector("[data-current-state]").textContent = `view=${currentView} · palette=${currentPalette} · sha256=${allViews.selected_glb.sha256}`;
	}
	function createPresetCamera(name) {
		const preset = config.cameras.views[name];
		if (preset.type === "orthographic") {
			const frustum = preset.frustum;
			const result = new THREE.OrthographicCamera(frustum.left, frustum.right, frustum.top, frustum.bottom, frustum.near, frustum.far);
			const depth = new THREE.Vector3(...preset.projection_axes.depth).normalize();
			result.position.copy(center).addScaledVector(depth, (name === "plan" || name === "top" ? 1 : -1) * radius * 4);
			result.up.set(...preset.projection_axes.vertical); result.lookAt(center); result.updateProjectionMatrix();
			return result;
		}
		if (preset.type === "perspective") {
			const result = new THREE.PerspectiveCamera(preset.fov_degrees, innerWidth / innerHeight, preset.near, preset.far);
			result.position.set(...preset.position); result.up.set(...preset.up); result.lookAt(new THREE.Vector3(...preset.target)); result.updateProjectionMatrix();
			return result;
		}
		throw new Error(`unsupported all-views camera preset: ${name}`);
	}
	function applyClipping(name) {
		const cut = config.cameras.views[name].cut ?? { enabled: false, elevation_m: null, plane_world: null };
		currentClipping = cut;
		renderer.localClippingEnabled = cut.enabled === true;
		const planes = cut.enabled ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), cut.elevation_m)] : [];
		for (const record of materialRecords) {
			const materials = Array.isArray(record.object.material) ? record.object.material : [record.object.material];
			for (const material of materials) { material.clippingPlanes = planes; material.needsUpdate = true; }
		}
	}
	function activateView(name) {
		controls?.dispose(); camera = createPresetCamera(name); controls = new OrbitControls(camera, canvas);
		controls.enableDamping = true; controls.enablePan = true; controls.enableZoom = true;
		controls.target.copy(config.cameras.views[name].target ? new THREE.Vector3(...config.cameras.views[name].target) : center);
		controls.addEventListener("change", state); controls.update(); currentView = name; applyClipping(name); presentation?.activateView(name);
		document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === name)));
		state();
	}
	function applyPalette(name) {
		if (materialMode === "embedded-pbr") return;
		const palette = allViews.palettes[name];
		const detachedMaterials = new Set();
		for (const record of materialRecords) {
			for (const material of record.currentMaterials) detachedMaterials.add(material);
			const replacements = record.roles.map((role) => {
				const values = palette.roles[role];
				const transparent = values.opacity < 1;
				const polygonOffsetFactor = record.facadeDetail ? -4 : 4;
				const material = new THREE.MeshStandardMaterial({
					color: values.axon_pbr,
					roughness: values.roughness,
					metalness: values.metalness,
					opacity: values.opacity,
					transparent,
					depthWrite: !transparent,
					side: THREE.DoubleSide,
					polygonOffset: true,
					polygonOffsetFactor,
					polygonOffsetUnits: polygonOffsetFactor,
				});
				material.forceSinglePass = transparent;
				return material;
			});
			record.object.material = record.array ? replacements : replacements[0];
			record.object.renderOrder = replacements.some((material) => material.transparent) ? 2 : record.facadeDetail ? 1 : 0;
			record.currentMaterials = replacements;
		}
		for (const material of detachedMaterials) material.dispose();
		currentPalette = name; applyClipping(currentView); state();
	}
	const buttons = document.querySelector("[data-view-buttons]");
	for (const name of Object.keys(config.cameras.views)) {
		const button = document.createElement("button"); button.type = "button"; button.dataset.view = name; button.textContent = name; button.addEventListener("click", () => activateView(name)); buttons.append(button);
	}
	const paletteSelector = document.querySelector("[data-palette]");
	paletteSelector.disabled = materialMode === "embedded-pbr";
	paletteSelector.addEventListener("change", (event) => applyPalette(event.target.value));
	document.querySelector("[data-reset]").addEventListener("click", () => activateView(currentView));
	async function toggleFullscreen() {
		fullscreenRequests++; state();
		try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
		catch {} finally { state(); }
	}
	document.querySelector("[data-fullscreen]").addEventListener("click", toggleFullscreen);
	document.addEventListener("fullscreenchange", state);
	const download = document.querySelector("[data-glb-download]"); download.href = allViews.selected_glb.path;
	const badge = document.querySelector("[data-validation-badge]"); badge.textContent = allViews.validation.accepted ? "Accepted" : "Rejected"; badge.classList.toggle("rejected", !allViews.validation.accepted);
	const links = document.querySelector("[data-artifact-links]");
	for (const artifact of allViews.artifacts ?? []) { const link = document.createElement("a"); link.href = artifact.path; link.textContent = artifact.label; link.target = "_blank"; links.append(link); }
	addEventListener("resize", () => { if (camera.isPerspectiveCamera) camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight, false); });
	globalThis.__ELEVATION3D_TEST_CONTROLS__ = {
		rotateAndZoom() { controls.rotateLeft(0.25); controls.dollyIn(1.2); controls.update(); state(); },
		reset() { activateView(currentView); }, toggleFullscreen, activateView,
		presentationEvidence() { return presentation?.evidence() ?? null; },
		setPresentationObjectsVisible(visible) { presentation?.setPresentationObjectsVisible(visible); },
		async settledPng() {
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			renderer.render(scene, camera);
			return renderer.domElement.toDataURL("image/png");
		},
		setEmbeddedMaps(enabled) {
			for (const [material, maps] of embeddedMaps) {
				for (const field of ["map", "normalMap", "roughnessMap", "metalnessMap"]) material[field] = enabled ? maps[field] : null;
				material.needsUpdate = true;
			}
		},
		embeddedPbrEvidence() {
			return {
				material_count: embeddedMaps.size,
				base_color_maps: [...embeddedMaps.values()].filter((maps) => maps.map).length,
				normal_maps: [...embeddedMaps.values()].filter((maps) => maps.normalMap).length,
				metallic_roughness_maps: [...embeddedMaps.values()].filter((maps) => maps.roughnessMap || maps.metalnessMap).length,
			};
		},
	};
	if (materialMode !== "embedded-pbr") applyPalette("warm");
	activateView("axon");
	renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

function projectedMeshes() {
	const root = new THREE.Group();
	const textureMap = config.strategies.wan_projection?.textures ?? {};
	const views = Object.keys(textureMap);
	if (!views.length) {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(config.mesh.vertices.flat(), 3));
		geometry.setIndex(config.mesh.triangles.flat());
		geometry.computeVertexNormals();
		root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc9c9c5, roughness: 0.9, side: THREE.DoubleSide })));
		return root;
	}
	const loader = new THREE.TextureLoader();
	for (const viewName of views) {
		const view = config.cameras.views[viewName];
		if (!view) continue;
		const horizontal = new THREE.Vector3(...view.projection_axes.horizontal);
		const vertical = new THREE.Vector3(...view.projection_axes.vertical);
		const bounds = view.projected_bounds_m;
		const positions = [], uvs = [];
		for (const triangle of config.mesh.triangles) {
			const a = new THREE.Vector3(...config.mesh.vertices[triangle[0]]), b = new THREE.Vector3(...config.mesh.vertices[triangle[1]]), c = new THREE.Vector3(...config.mesh.vertices[triangle[2]]);
			const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
			const scores = views.map((candidate) => Math.abs(normal.dot(new THREE.Vector3(...config.cameras.views[candidate].projection_axes.depth))));
			if (views[scores.indexOf(Math.max(...scores))] !== viewName) continue;
			for (const point of [a, b, c]) {
				positions.push(point.x, point.y, point.z);
				const x = point.dot(horizontal), y = point.dot(vertical);
				uvs.push((x - bounds[0][0]) / (bounds[1][0] - bounds[0][0]), (y - bounds[0][1]) / (bounds[1][1] - bounds[0][1]));
			}
		}
		const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); geometry.computeVertexNormals();
		const texture = loader.load(textureMap[viewName]); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false;
		root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, side: THREE.DoubleSide })));
	}
	return root;
}

function semanticRole(material) {
	const name = String(material?.name ?? "").toLowerCase();
	return ["concrete", "glass", "bronze", "opaque"].find((role) => name.includes(role)) ?? "concrete";
}

function loadedProjectedBounds(root, axes) {
	root.updateMatrixWorld(true);
	const horizontal = new THREE.Vector3(...axes.horizontal);
	const vertical = new THREE.Vector3(...axes.vertical);
	const depth = new THREE.Vector3(...axes.depth);
	const bounds = { minH: Infinity, maxH: -Infinity, minV: Infinity, maxV: -Infinity, minD: Infinity, maxD: -Infinity };
	const point = new THREE.Vector3();
	root.traverse((object) => {
		if (!object.isMesh) return;
		if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
		const position = object.geometry.getAttribute("position");
		if (!position) return;
		for (let index = 0; index < position.count; index++) {
			point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
			const h = point.dot(horizontal), v = point.dot(vertical), d = point.dot(depth);
			bounds.minH = Math.min(bounds.minH, h); bounds.maxH = Math.max(bounds.maxH, h);
			bounds.minV = Math.min(bounds.minV, v); bounds.maxV = Math.max(bounds.maxV, v);
			bounds.minD = Math.min(bounds.minD, d); bounds.maxD = Math.max(bounds.maxD, d);
		}
	});
	if (!Object.values(bounds).every(Number.isFinite)) throw new Error("loaded GLB has no projected geometry");
	return bounds;
}

function createCompetitionCamera(root, view, size, marginRatio, pixelsPerMetre) {
	if (view?.projection !== "orthographic") throw new Error("competition elevation camera projection must be orthographic");
	const axes = view.projection_axes;
	const bounds = loadedProjectedBounds(root, axes);
	const width = bounds.maxH - bounds.minH;
	const height = bounds.maxV - bounds.minV;
	const usable = 1 - marginRatio * 2;
	const span = pixelsPerMetre == null ? Math.max(width / usable, height / usable) : size / pixelsPerMetre;
	if (!(span >= width && span >= height)) throw new Error("competition elevation common scale clips projected geometry");
	const centerH = (bounds.minH + bounds.maxH) / 2;
	let centerV = (bounds.minV + bounds.maxV) / 2;
	const centerD = (bounds.minD + bounds.maxD) / 2;
	const pxPerM = size / span;
	const projectedBottom = (size + height * pxPerM) / 2;
	// Keep the fixed 5 m scale-bar label clear as well as the dimension lanes.
	const reservedLaneTop = size - 550;
	if (projectedBottom > reservedLaneTop) centerV += (reservedLaneTop - projectedBottom) / pxPerM;
	const horizontal = new THREE.Vector3(...axes.horizontal);
	const vertical = new THREE.Vector3(...axes.vertical);
	const depth = new THREE.Vector3(...axes.depth);
	const center = horizontal.multiplyScalar(centerH).add(vertical.clone().multiplyScalar(centerV)).add(depth.clone().multiplyScalar(centerD));
	const depthSpan = Math.max(bounds.maxD - bounds.minD, 1);
	const distance = depthSpan + 100;
	const camera = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 0.1, distance + depthSpan + 100);
	camera.position.copy(center).sub(depth.multiplyScalar(distance));
	camera.up.copy(vertical);
	camera.lookAt(center);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld(true);
	return {
		camera,
		manifest: {
			type: "orthographic",
			projection_axes: axes,
			center_m: [centerH, centerV, centerD],
			frustum: { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: camera.near, far: camera.far },
			px_per_m_x: pxPerM,
			px_per_m_y: pxPerM,
			margin_ratio: marginRatio,
		},
		bounds,
	};
}

function competitionMaterials(root, palette, options = {}) {
	const meshes = [];
	const counts = { concrete: 0, glass: 0, bronze: 0, opaque: 0 };
	const roleColors = { concrete: 0xff0000, glass: 0x00ff00, bronze: 0x0000ff, opaque: 0xffff00 };
	root.traverse((object) => {
		if (!object.isMesh) return;
		let ancestor = object;
		let facadeDetail = false;
		while (ancestor) {
			if (String(ancestor.name).toLowerCase() === "facade-details") facadeDetail = true;
			ancestor = ancestor.parent;
		}
		const polygonOffsetFactor = facadeDetail ? (options.facadeDetailPolygonOffsetFactor ?? -4) : 4;
		const originals = Array.isArray(object.material) ? object.material : [object.material];
		const roles = originals.map(semanticRole);
		for (const role of roles) counts[role] += object.geometry.getAttribute("position")?.count ?? 0;
		const fills = roles.map((role) => new THREE.MeshBasicMaterial({
			name: role,
			color: palette.roles[role].elevation_fill,
			side: THREE.DoubleSide,
			depthWrite: true,
			transparent: false,
			polygonOffset: true,
			polygonOffsetFactor,
			polygonOffsetUnits: polygonOffsetFactor,
		}));
		const ids = roles.map((role) => new THREE.MeshBasicMaterial({ color: roleColors[role], side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor, polygonOffsetUnits: polygonOffsetFactor }));
		const normals = roles.map(() => new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor, polygonOffsetUnits: polygonOffsetFactor }));
		const depths = roles.map(() => new THREE.ShaderMaterial({
			side: THREE.DoubleSide,
			polygonOffset: true,
			polygonOffsetFactor,
			polygonOffsetUnits: polygonOffsetFactor,
			vertexShader: `void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
			fragmentShader: `void main(){float d=gl_FragCoord.z;vec3 packed=fract(d*vec3(1.,255.,65025.));packed-=packed.yzz*vec3(1./255.,1./255.,0.);gl_FragColor=vec4(packed,1.);}`,
		}));
		meshes.push({ object, originals, roles, fills, ids, normals, depths });
		object.material = Array.isArray(object.material) ? fills : fills[0];
	});
	return { meshes, counts };
}

function applyMaterials(records, key) {
	for (const record of records) record.object.material = Array.isArray(record.object.material) ? record[key] : record[key][0];
}

function renderCompetition(root, view) {
	const settings = config.competition_elevation;
	const fitted = createCompetitionCamera(root, view, outputSize, settings.margin_ratio, settings.pixels_per_metre);
	const semantic = competitionMaterials(root, settings.palette);
	const renderTarget = new THREE.WebGLRenderTarget(outputSize, outputSize, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
	});
	renderTarget.depthTexture = new THREE.DepthTexture(outputSize, outputSize, THREE.UnsignedIntType);
	renderTarget.depthTexture.format = THREE.DepthFormat;
	const postScene = new THREE.Scene();
	const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const postMaterial = new THREE.ShaderMaterial({
		depthTest: false,
		depthWrite: false,
		uniforms: {
			tColor: { value: renderTarget.texture },
			tDepth: { value: renderTarget.depthTexture },
			texel: { value: new THREE.Vector2(1 / outputSize, 1 / outputSize) },
			lineStrength: { value: settings.view === "left" || settings.view === "right" ? 0.42 : 0.72 },
		},
		vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
		fragmentShader: `uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 texel; uniform float lineStrength; varying vec2 vUv;
			void main(){vec3 c=texture2D(tColor,vUv).rgb; float d=texture2D(tDepth,vUv).r;
			float e=0.; e=max(e,abs(d-texture2D(tDepth,vUv+vec2(texel.x,0.)).r)); e=max(e,abs(d-texture2D(tDepth,vUv-vec2(texel.x,0.)).r));
			e=max(e,abs(d-texture2D(tDepth,vUv+vec2(0.,texel.y)).r)); e=max(e,abs(d-texture2D(tDepth,vUv-vec2(0.,texel.y)).r));
			float line=smoothstep(0.00500,0.02000,e); gl_FragColor=vec4(mix(c,vec3(0.16,0.15,0.14),line*lineStrength),1.);}`,
	});
	postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
	function renderMode(mode) {
		renderer.outputColorSpace = mode === "base" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
		if (mode === "material-id") {
			applyMaterials(semantic.meshes, "ids");
			renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.render(scene, fitted.camera);
		} else if (mode === "normal") {
			applyMaterials(semantic.meshes, "normals");
			renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.render(scene, fitted.camera);
		} else if (mode === "depth") {
			applyMaterials(semantic.meshes, "depths");
			renderer.setRenderTarget(null); renderer.setClearColor(0xffffff, 1); renderer.render(scene, fitted.camera);
		} else {
			applyMaterials(semantic.meshes, "fills"); renderer.setClearColor(settings.background, 1);
			renderer.setRenderTarget(renderTarget); renderer.clear(); renderer.render(scene, fitted.camera);
			renderer.setRenderTarget(null); renderer.setClearColor(settings.background, 1); renderer.clear(); renderer.render(postScene, postCamera);
		}
		return renderer.domElement.toDataURL("image/png");
	}

	const widthPx = (fitted.bounds.maxH - fitted.bounds.minH) * fitted.manifest.px_per_m_x;
	const heightPx = (fitted.bounds.maxV - fitted.bounds.minV) * fitted.manifest.px_per_m_y;
	const minX = Math.round((outputSize - widthPx) / 2);
	const maxX = Math.round((outputSize + widthPx) / 2) - 1;
	const minY = Math.round((outputSize - heightPx) / 2);
	const maxY = Math.round((outputSize + heightPx) / 2) - 1;
	globalThis.__ELEVATION3D_ARTIFACT__ = {
		camera: fitted.manifest,
		depth_encoding: { type: "orthographic-linear-rgb24", near_m: fitted.camera.near, far_m: fitted.camera.far },
		projected_bounds_m: { min: [fitted.bounds.minH, fitted.bounds.minV], max: [fitted.bounds.maxH, fitted.bounds.maxV] },
		annotation_lanes: {
			level: { min_x: maxX + 49, max_x: outputSize - 48 },
			overall_height: { min_x: maxX + 73, max_x: outputSize - 48 },
			overall_width: { min_y: maxY + 73, max_y: outputSize - 48 },
		},
		material_roles: Object.keys(semantic.counts),
		role_pixel_counts: semantic.counts,
		projected_content_bounds_px: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
	};
	globalThis.__ELEVATION3D_RENDER_MODE__ = async (mode) => renderMode(mode);
	renderMode("base");
}

function createPlanCamera(root, view, size, marginRatio) {
	if (view?.projection !== "orthographic") throw new Error("competition plan camera projection must be orthographic");
	const axes = view.projection_axes;
	if (Math.abs(axes.depth[2]) < 0.999 || Math.abs(axes.horizontal[2]) > 0.001 || Math.abs(axes.vertical[2]) > 0.001) {
		throw new Error("competition plan camera must be horizontal");
	}
	const bounds = loadedProjectedBounds(root, axes);
	const width = bounds.maxH - bounds.minH;
	const height = bounds.maxV - bounds.minV;
	const span = Math.max(width, height) / (1 - marginRatio * 2);
	const centerH = (bounds.minH + bounds.maxH) / 2;
	const centerV = (bounds.minV + bounds.maxV) / 2;
	const centerD = (bounds.minD + bounds.maxD) / 2;
	const horizontal = new THREE.Vector3(...axes.horizontal);
	const vertical = new THREE.Vector3(...axes.vertical);
	const depth = new THREE.Vector3(...axes.depth);
	const center = horizontal.multiplyScalar(centerH).add(vertical.clone().multiplyScalar(centerV)).add(depth.clone().multiplyScalar(centerD));
	const distance = Math.max(bounds.maxD - bounds.minD, 1) + 100;
	const camera = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 0.1, distance * 2 + 100);
	camera.position.copy(center).add(depth.multiplyScalar(distance));
	camera.up.copy(vertical);
	camera.lookAt(center);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld(true);
	return {
		camera,
		bounds,
		manifest: {
			type: "orthographic",
			projection_axes: axes,
			center_m: [centerH, centerV, centerD],
			frustum: { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: camera.near, far: camera.far },
			px_per_m_x: size / span,
			px_per_m_y: size / span,
			margin_ratio: marginRatio,
		},
	};
}

function trianglePlaneSegments(root, elevation) {
	const segments = [];
	const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
	root.updateMatrixWorld(true);
	root.traverse((object) => {
		if (!object.isMesh) return;
		const position = object.geometry.getAttribute("position");
		if (!position) return;
		const index = object.geometry.index;
		const vertexIndex = (offset) => index ? index.getX(offset) : offset;
		for (let offset = 0; offset + 2 < (index?.count ?? position.count); offset += 3) {
			for (let corner = 0; corner < 3; corner++) points[corner].fromBufferAttribute(position, vertexIndex(offset + corner)).applyMatrix4(object.matrixWorld);
			const intersections = [];
			for (const [leftIndex, rightIndex] of [[0, 1], [1, 2], [2, 0]]) {
				const left = points[leftIndex], right = points[rightIndex];
				const leftDelta = left.z - elevation, rightDelta = right.z - elevation;
				if (leftDelta * rightDelta > 0 || Math.abs(leftDelta - rightDelta) < 1e-9) continue;
				const ratio = leftDelta / (leftDelta - rightDelta);
				if (ratio < 0 || ratio > 1) continue;
				const point = left.clone().lerp(right, ratio);
				if (!intersections.some((candidate) => candidate.distanceToSquared(point) < 1e-10)) intersections.push(point);
			}
			if (intersections.length === 2 && intersections[0].distanceToSquared(intersections[1]) > 1e-8) segments.push(intersections);
		}
	});
	return segments;
}

function cutRibbonMesh(segments, elevation, widthM) {
	const positions = [];
	for (const [start, end] of segments) {
		const direction = end.clone().sub(start);
		const length = Math.hypot(direction.x, direction.y);
		if (length < 1e-6) continue;
		const offset = new THREE.Vector3(-direction.y / length * widthM / 2, direction.x / length * widthM / 2, 0);
		const points = [start.clone().add(offset), start.clone().sub(offset), end.clone().sub(offset), end.clone().add(offset)];
		for (const point of points) point.z = elevation + 0.0005;
		for (const index of [0, 1, 2, 0, 2, 3]) positions.push(points[index].x, points[index].y, points[index].z);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x211f1d, side: THREE.DoubleSide, depthTest: true, depthWrite: true }));
}

function renderCompetitionPlan(root, view) {
	const settings = config.competition_plan;
	const fitted = createPlanCamera(root, view, outputSize, settings.margin_ratio);
	const isPlan = settings.mode === "plan";
	const clippingPlanes = isPlan ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), settings.cut_elevation_m)] : [];
	renderer.localClippingEnabled = isPlan;
	const semantic = competitionMaterials(root, settings.palette, { facadeDetailPolygonOffsetFactor: isPlan ? -4 : 8 });
	for (const record of semantic.meshes) for (const key of ["fills", "ids", "normals", "depths"]) {
		for (const material of record[key]) material.clippingPlanes = clippingPlanes;
	}
	const cutSegments = isPlan ? trianglePlaneSegments(root, settings.cut_elevation_m) : [];
	const cutLineWidthPx = isPlan ? 4 : 0;
	const cutMesh = cutRibbonMesh(cutSegments, settings.cut_elevation_m, cutLineWidthPx / fitted.manifest.px_per_m_x);
	cutMesh.visible = false;
	scene.add(cutMesh);
	const overheadScene = new THREE.Scene();
	if (isPlan) {
		const overheadRoot = root.clone(true);
		overheadRoot.traverse((object) => {
			if (!object.isMesh) return;
			const originals = Array.isArray(object.material) ? object.material : [object.material];
			const materials = originals.map(() => new THREE.MeshBasicMaterial({ color: 0xe7e2d8, side: THREE.DoubleSide }));
			object.material = Array.isArray(object.material) ? materials : materials[0];
		});
		overheadScene.add(overheadRoot);
	}
	const renderTarget = new THREE.WebGLRenderTarget(outputSize, outputSize, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
	renderTarget.depthTexture = new THREE.DepthTexture(outputSize, outputSize, THREE.UnsignedIntType);
	renderTarget.depthTexture.format = THREE.DepthFormat;
	const postScene = new THREE.Scene();
	const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const postMaterial = new THREE.ShaderMaterial({
		depthTest: false, depthWrite: false,
		uniforms: { tColor: { value: renderTarget.texture }, tDepth: { value: renderTarget.depthTexture }, texel: { value: new THREE.Vector2(1 / outputSize, 1 / outputSize) }, lineStrength: { value: isPlan ? 0.72 : 0 } },
		vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
		fragmentShader: `uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 texel; uniform float lineStrength; varying vec2 vUv;
			void main(){vec3 c=texture2D(tColor,vUv).rgb;float d=texture2D(tDepth,vUv).r;float e=0.;
			e=max(e,abs(d-texture2D(tDepth,vUv+vec2(texel.x,0.)).r));e=max(e,abs(d-texture2D(tDepth,vUv-vec2(texel.x,0.)).r));
			e=max(e,abs(d-texture2D(tDepth,vUv+vec2(0.,texel.y)).r));e=max(e,abs(d-texture2D(tDepth,vUv-vec2(0.,texel.y)).r));
			float line=smoothstep(.005,.02,e);gl_FragColor=vec4(mix(c,vec3(.16,.15,.14),line*lineStrength),1.);}`,
	});
	postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
	function renderMode(mode) {
		renderer.outputColorSpace = mode === "base" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
		cutMesh.visible = mode === "base" && isPlan;
		if (mode === "material-id") {
			applyMaterials(semantic.meshes, "ids"); renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.render(scene, fitted.camera);
		} else if (mode === "normal") {
			applyMaterials(semantic.meshes, "normals"); renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.render(scene, fitted.camera);
		} else if (mode === "depth") {
			applyMaterials(semantic.meshes, "depths"); renderer.setRenderTarget(null); renderer.setClearColor(0xffffff, 1); renderer.render(scene, fitted.camera);
		} else {
			applyMaterials(semantic.meshes, "fills"); renderer.setClearColor(settings.background, 1); renderer.setRenderTarget(renderTarget); renderer.clear(); renderer.autoClear = false;
			if (isPlan) { renderer.render(overheadScene, fitted.camera); renderer.clearDepth(); }
			renderer.render(scene, fitted.camera);
			renderer.autoClear = true; renderer.setRenderTarget(null); renderer.setClearColor(settings.background, 1); renderer.clear(); renderer.render(postScene, postCamera);
		}
		return renderer.domElement.toDataURL("image/png");
	}
	globalThis.__ELEVATION3D_ARTIFACT__ = {
		camera: fitted.manifest,
		projected_bounds_m: { min: [fitted.bounds.minH, fitted.bounds.minV], max: [fitted.bounds.maxH, fitted.bounds.maxV] },
		cut: { enabled: isPlan, elevation_m: isPlan ? settings.cut_elevation_m : null, plane_world: isPlan ? [0, 0, 1, -settings.cut_elevation_m] : null },
		cut_line: { segment_count: cutSegments.length, width_px: cutLineWidthPx, source: isPlan ? "selected-glb-triangle-plane-intersections" : null },
		overhead_context: isPlan ? { enabled: true, source: "selected-glb-uncut-projection" } : { enabled: false, source: null },
		depth_priority: { roof_over_facade_details: !isPlan, facade_detail_polygon_offset_factor: isPlan ? -4 : 8, selected_glb_altered: false },
		material_roles: Object.keys(semantic.counts),
	};
	globalThis.__ELEVATION3D_RENDER_MODE__ = async (mode) => renderMode(mode);
	renderMode("base");
}

function proceduralSurfaceTextures(role, parameters) {
	const size = 32;
	const colorBytes = new Uint8Array(size * size * 4);
	const normalBytes = new Uint8Array(size * size * 4);
	const seed = { concrete: 17, glass: 43, bronze: 71, opaque: 101 }[role];
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const offset = (y * size + x) * 4;
		const noise = (((x * 29 + y * 47 + seed) * 17) % 31) / 30 * 2 - 1;
		const value = Math.round(255 * (1 - parameters.texture_intensity * 0.12 + noise * parameters.texture_intensity * 0.08));
		colorBytes[offset] = value; colorBytes[offset + 1] = value; colorBytes[offset + 2] = value; colorBytes[offset + 3] = 255;
		const nx = Math.round(128 + noise * 28), ny = Math.round(128 + ((((x * 13 + y * 11 + seed) % 23) / 22 * 2 - 1)) * 28);
		normalBytes[offset] = nx; normalBytes[offset + 1] = ny; normalBytes[offset + 2] = 250; normalBytes[offset + 3] = 255;
	}
	const configure = (texture) => {
		texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(5, 5); texture.needsUpdate = true;
		return texture;
	};
	const color = configure(new THREE.DataTexture(colorBytes, size, size, THREE.RGBAFormat));
	color.colorSpace = THREE.SRGBColorSpace;
	return { color, normal: configure(new THREE.DataTexture(normalBytes, size, size, THREE.RGBAFormat)) };
}

function competitionAxonMaterials(root, palette) {
	const meshes = [];
	const counts = { concrete: 0, glass: 0, bronze: 0, opaque: 0 };
	const roleColors = { concrete: 0xff0000, glass: 0x00ff00, bronze: 0x0000ff, opaque: 0xffff00 };
	const textures = Object.fromEntries(Object.entries(palette.roles).map(([role, parameters]) => [role, proceduralSurfaceTextures(role, parameters)]));
	root.traverse((object) => {
		if (!object.isMesh) return;
		if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
		if (!object.geometry.getAttribute("uv")) {
			object.geometry.computeBoundingBox();
			const position = object.geometry.getAttribute("position"), bounds = object.geometry.boundingBox;
			const size = bounds.getSize(new THREE.Vector3());
			const uv = [];
			for (let index = 0; index < position.count; index++) {
				const point = new THREE.Vector3().fromBufferAttribute(position, index);
				uv.push((point.x - bounds.min.x) / Math.max(size.x, 1e-6), (point.z - bounds.min.z) / Math.max(size.z, 1e-6));
			}
			object.geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
		}
		const originals = Array.isArray(object.material) ? object.material : [object.material];
		const roles = originals.map(semanticRole);
		for (const role of roles) counts[role] += object.geometry.getAttribute("position")?.count ?? 0;
		const pbrs = roles.map((role) => {
			const parameters = palette.roles[role];
			const color = new THREE.Color(); color.setStyle(parameters.axon_pbr);
			const material = new THREE.MeshStandardMaterial({
				name: role, color, roughness: parameters.roughness, metalness: parameters.metalness,
				opacity: parameters.opacity, transparent: parameters.opacity < 1, depthWrite: parameters.opacity >= 0.85,
				side: THREE.DoubleSide, map: textures[role].color, normalMap: textures[role].normal,
				normalScale: new THREE.Vector2(parameters.normal_intensity, parameters.normal_intensity),
			});
			material.userData = { texture_intensity: parameters.texture_intensity, normal_intensity: parameters.normal_intensity };
			return material;
		});
		const ids = roles.map((role) => new THREE.MeshBasicMaterial({ color: roleColors[role], side: THREE.DoubleSide }));
		meshes.push({ object, originals, roles, pbrs, ids });
		object.material = Array.isArray(object.material) ? pbrs : pbrs[0];
		object.castShadow = true;
		object.receiveShadow = true;
	});
	return { meshes, counts };
}

function boxCorners(box) {
	const corners = [];
	for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
	return corners;
}

function createCompetitionAxonCamera(root, definition, marginRatio) {
	if (definition?.projection !== "perspective") throw new Error("competition axon camera projection must be perspective");
	const box = new THREE.Box3().setFromObject(root);
	if (box.isEmpty()) throw new Error("loaded GLB has no geometry");
	const center = box.getCenter(new THREE.Vector3());
	const forward = new THREE.Vector3(...definition.target).sub(new THREE.Vector3(...definition.position)).normalize();
	const sourceUp = new THREE.Vector3(...definition.up).normalize();
	const right = new THREE.Vector3().crossVectors(forward, sourceUp).normalize();
	if (right.lengthSq() < 0.99) throw new Error("competition axon camera up is parallel to view direction");
	const up = new THREE.Vector3().crossVectors(right, forward).normalize();
	const tanHalf = Math.tan(THREE.MathUtils.degToRad(definition.fov_degrees / 2));
	const usable = 1 - marginRatio * 2;
	let distance = 0;
	for (const corner of boxCorners(box)) {
		const relative = corner.sub(center);
		const depthOffset = relative.dot(forward);
		distance = Math.max(distance, Math.abs(relative.dot(right)) / (tanHalf * usable) - depthOffset, Math.abs(relative.dot(up)) / (tanHalf * usable) - depthOffset);
	}
	const size = box.getSize(new THREE.Vector3());
	const diagonal = size.length();
	distance = Math.max(distance, diagonal);
	const camera = new THREE.PerspectiveCamera(definition.fov_degrees, 1, Math.max(0.05, distance - diagonal * 0.75), distance + diagonal * 0.75);
	camera.position.copy(center).sub(forward.clone().multiplyScalar(distance));
	camera.up.copy(up); camera.lookAt(center); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
	const projected = boxCorners(box).map((corner) => corner.project(camera));
	const clipExtents = {
		min_x: Math.min(...projected.map((point) => point.x)), max_x: Math.max(...projected.map((point) => point.x)),
		min_y: Math.min(...projected.map((point) => point.y)), max_y: Math.max(...projected.map((point) => point.y)),
		min_z: Math.min(...projected.map((point) => point.z)), max_z: Math.max(...projected.map((point) => point.z)),
	};
	const horizontalDepth = camera.position.clone().sub(center); horizontalDepth.z = 0; horizontalDepth.normalize();
	return {
		camera, box, center, size, diagonal, clipExtents,
		manifest: {
			type: "perspective", position: camera.position.toArray(), target: center.toArray(), up: camera.up.toArray(),
			fov_degrees: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect,
			depth: horizontalDepth.toArray(), margin_ratio: marginRatio,
		},
	};
}

function renderCompetitionAxon(root, view) {
	const settings = config.competition_axon;
	const fitted = createCompetitionAxonCamera(root, view, settings.margin_ratio);
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.08;
	const pmrem = new THREE.PMREMGenerator(renderer);
	const environmentTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
	scene.environment = environmentTarget.texture;
	scene.environmentIntensity = settings.lighting.environment.intensity;
	const hemisphere = new THREE.HemisphereLight(settings.lighting.hemisphere.sky, settings.lighting.hemisphere.ground, settings.lighting.hemisphere.intensity);
	scene.add(hemisphere);
	const sunSettings = settings.lighting.sun;
	const sun = new THREE.DirectionalLight(sunSettings.color, sunSettings.intensity);
	sun.position.set(...sunSettings.position).add(fitted.center);
	sun.target.position.copy(fitted.center);
	sun.castShadow = true;
	sun.shadow.mapSize.set(sunSettings.shadow_map_size, sunSettings.shadow_map_size);
	sun.shadow.radius = sunSettings.radius;
	sun.shadow.bias = -0.00015;
	const shadowSpan = fitted.diagonal * 0.75;
	Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: 0.1, far: fitted.diagonal * 5 });
	sun.shadow.camera.updateProjectionMatrix();
	scene.add(sun, sun.target);
	const contextGroup = new THREE.Group();
	contextGroup.name = settings.context.group_identity;
	contextGroup.userData = { authoritative: false };
	const groundSeparation = Math.max(0.02, fitted.diagonal * 0.001);
	const groundZ = fitted.box.min.z - groundSeparation;
	const groundSize = fitted.diagonal * 2.4;
	const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: settings.background, roughness: 1, metalness: 0 }));
	ground.position.set(fitted.center.x, fitted.center.y, groundZ);
	ground.receiveShadow = true;
	contextGroup.add(ground);
	scene.add(contextGroup);
	const semantic = competitionAxonMaterials(root, settings.palette);
	function renderMode(mode) {
		if (mode === "material-id") {
			contextGroup.visible = false; applyMaterials(semantic.meshes, "ids"); renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setClearColor(0x000000, 1);
		} else {
			contextGroup.visible = true; applyMaterials(semantic.meshes, "pbrs"); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setClearColor(settings.background, 1);
		}
		renderer.render(scene, fitted.camera);
		return renderer.domElement.toDataURL("image/png");
	}
	const clipped = fitted.clipExtents.min_x < -1 || fitted.clipExtents.max_x > 1 || fitted.clipExtents.min_y < -1 || fitted.clipExtents.max_y > 1 || fitted.clipExtents.min_z < -1 || fitted.clipExtents.max_z > 1;
	globalThis.__ELEVATION3D_ARTIFACT__ = {
		camera: fitted.manifest,
		loaded_bounds: { min: fitted.box.min.toArray(), max: fitted.box.max.toArray(), size: fitted.size.toArray() },
		clipping: { clipped, ndc_extents: fitted.clipExtents },
		lights: {
			environment: settings.lighting.environment, hemisphere: settings.lighting.hemisphere,
			sun: { ...sunSettings, position: sun.position.toArray(), target: sun.target.position.toArray() },
			contact_shadow: { ...settings.lighting.contact_shadow, plane_size_m: groundSize, ground_z_m: groundZ, shadow_camera_span_m: shadowSpan * 2 },
		},
		context: {
			group_identity: contextGroup.name, authoritative: false, geometry: "separate-ground-plane",
			ground_z_m: groundZ, building_min_z_m: fitted.box.min.z, separation_m: groundSeparation, intersects_building: groundZ >= fitted.box.min.z,
		},
		material_roles: Object.fromEntries(Object.entries(semantic.counts).map(([role, geometry_vertices]) => [role, { geometry_vertices }])),
	};
	globalThis.__ELEVATION3D_RENDER_MODE__ = async (mode) => renderMode(mode);
	renderMode("base");
}

const strategy = params.get("strategy") ?? (config.strategies.hunyuan?.glb ? "hunyuan" : "wan_projection");
let loadedRoot;
if (strategy === "hunyuan" && config.strategies.hunyuan?.glb) {
	const gltf = await new GLTFLoader().loadAsync(config.strategies.hunyuan.glb);
	loadedRoot = gltf.scene;
	if (!competition && !allViews && config.cameras.views[params.get("view") ?? "axon"]?.rendering?.material_mode === "line-oriented") {
		gltf.scene.traverse((object) => {
			if (!object.isMesh) return;
			object.material = new THREE.MeshBasicMaterial({ color: 0xf7f7f5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1 });
			object.add(new THREE.LineSegments(new THREE.EdgesGeometry(object.geometry), new THREE.LineBasicMaterial({ color: 0x202020 })));
		});
	}
	scene.add(gltf.scene);
} else {
	loadedRoot = projectedMeshes();
	scene.add(loadedRoot);
}
const viewName = params.get("view") ?? "axon";
if (allViews) renderInteractiveAllViews(loadedRoot);
else if (competitionElevation) renderCompetition(loadedRoot, config.cameras.views[viewName]);
else if (competitionPlan) renderCompetitionPlan(loadedRoot, config.cameras.views[viewName]);
else if (competitionAxon) renderCompetitionAxon(loadedRoot, config.cameras.views[viewName]);
else renderer.render(scene, createLegacyCamera(viewName));
document.querySelector("[data-status]").textContent = `${config.candidate_id} · ${strategy} · ${viewName}`;
globalThis.__ELEVATION3D_READY__ = true;
