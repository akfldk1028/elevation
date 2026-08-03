import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const params = new URLSearchParams(location.search);
const config = await fetch("config.json").then((response) => response.json());
const canvas = document.querySelector("canvas");
const competition = params.get("mode") === "competition-elevation" && config.competition_elevation;
const outputSize = competition?.output_size ?? 2048;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(outputSize, outputSize, false);
renderer.setClearColor(competition?.background ?? 0xf7f7f5, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
if (!competition) {
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

function competitionMaterials(root, palette) {
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
		const polygonOffsetFactor = facadeDetail ? -4 : 4;
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

const strategy = params.get("strategy") ?? (config.strategies.hunyuan?.glb ? "hunyuan" : "wan_projection");
let loadedRoot;
if (strategy === "hunyuan" && config.strategies.hunyuan?.glb) {
	const gltf = await new GLTFLoader().loadAsync(config.strategies.hunyuan.glb);
	loadedRoot = gltf.scene;
	if (!competition && config.cameras.views[params.get("view") ?? "axon"]?.rendering?.material_mode === "line-oriented") {
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
if (competition) renderCompetition(loadedRoot, config.cameras.views[viewName]);
else renderer.render(scene, createLegacyCamera(viewName));
document.querySelector("[data-status]").textContent = `${config.candidate_id} · ${strategy} · ${viewName}`;
globalThis.__ELEVATION3D_READY__ = true;
