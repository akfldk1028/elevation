import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const params = new URLSearchParams(location.search);
const config = await fetch("config.json").then((response) => response.json());
const canvas = document.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(2048, 2048, false);
renderer.setClearColor(0xf7f7f5, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(10, -10, 20); scene.add(sun);

function contentCenter() {
	if (config.mesh?.vertices?.length) {
		const box = new THREE.Box3();
		for (const point of config.mesh.vertices) box.expandByPoint(new THREE.Vector3(...point));
		return box.getCenter(new THREE.Vector3());
	}
	return new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3());
}

function createCamera(name) {
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
		const depth = new THREE.Vector3(...view.projection_axes.depth);
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

const strategy = params.get("strategy") ?? (config.strategies.hunyuan?.glb ? "hunyuan" : "wan_projection");
if (strategy === "hunyuan" && config.strategies.hunyuan?.glb) {
	const gltf = await new GLTFLoader().loadAsync(config.strategies.hunyuan.glb);
	if (config.cameras.views[params.get("view") ?? "axon"]?.rendering?.material_mode === "line-oriented") {
		gltf.scene.traverse((object) => {
			if (!object.isMesh) return;
			object.material = new THREE.MeshBasicMaterial({ color: 0xf7f7f5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1 });
			object.add(new THREE.LineSegments(
				new THREE.EdgesGeometry(object.geometry),
				new THREE.LineBasicMaterial({ color: 0x202020 }),
			));
		});
	}
	scene.add(gltf.scene);
} else scene.add(projectedMeshes());
const viewName = params.get("view") ?? "axon";
const camera = createCamera(viewName);
renderer.render(scene, camera);
document.querySelector("[data-status]").textContent = `${config.candidate_id} · ${strategy} · ${viewName}`;
window.__ELEVATION3D_READY__ = true;
