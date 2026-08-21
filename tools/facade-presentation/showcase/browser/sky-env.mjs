import * as THREE from "three";

// ---------------- sky ----------------
//
// No module-mutable state: the mood's sky colors are passed in as an argument
// everywhere. The defaults equal the original hardcoded SKY_UNIFORMS values,
// so no mood means the original sky exactly.

const DEFAULT_SKY_COLORS = {
	zenith: "#2e5c9e",
	horizon: "#eedcbc",
	groundHaze: "#cfc5b4",
	sunColor: "#ffdfae",
};

function makeSkyUniforms(skyColors) {
	const c = skyColors || DEFAULT_SKY_COLORS;
	return {
		zenith: { value: new THREE.Color(c.zenith) },
		horizon: { value: new THREE.Color(c.horizon) },
		groundHaze: { value: new THREE.Color(c.groundHaze) },
		sunColor: { value: new THREE.Color(c.sunColor) },
		sunDirection: { value: new THREE.Vector3(0, 1, 0) },
		intensity: { value: 1.0 },
	};
}

export function skyDome(radius, sunDir, intensity, tonemapped, skyColors) {
	const uniforms = makeSkyUniforms(skyColors);
	uniforms.sunDirection.value.copy(sunDir);
	uniforms.intensity.value = intensity;
	const vertex = [
		"varying vec3 vDir;",
		"void main() {",
		"  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);",
		"  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
		"}",
	].join("\n");
	const fragment = [
		"varying vec3 vDir;",
		"uniform vec3 zenith; uniform vec3 horizon; uniform vec3 groundHaze;",
		"uniform vec3 sunColor; uniform vec3 sunDirection; uniform float intensity;",
		"void main() {",
		"  float h = clamp(vDir.y, -1.0, 1.0);",
		"  vec3 col = h >= 0.0",
		"    ? mix(horizon, zenith, pow(clamp(h * 1.9, 0.0, 1.0), 0.65))",
		"    : mix(horizon, groundHaze, clamp(-h * 4.0, 0.0, 1.0));",
		"  float toSun = max(dot(vDir, sunDirection), 0.0);",
		"  col += sunColor * (pow(toSun, 550.0) * 6.0 + pow(toSun, 7.0) * 0.30);",
		"  gl_FragColor = vec4(col * intensity, 1.0);",
		tonemapped ? "  #include <tonemapping_fragment>\n  #include <colorspace_fragment>" : "",
		"}",
	].join("\n");
	const material = new THREE.ShaderMaterial({
		uniforms: uniforms, vertexShader: vertex, fragmentShader: fragment,
		side: THREE.BackSide, depthWrite: false, fog: false,
	});
	const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
	mesh.frustumCulled = false;
	return mesh;
}

export function buildEnvironmentTexture(renderer, sunDir, skyColors) {
	const scene = new THREE.Scene();
	scene.add(skyDome(500, sunDir, 1.35, false, skyColors));
	const ground = new THREE.Mesh(
		new THREE.CircleGeometry(480, 32),
		new THREE.MeshBasicMaterial({ color: 0x6d665a }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.position.y = -2;
	scene.add(ground);
	const sun = new THREE.Mesh(
		new THREE.SphereGeometry(16, 16, 16),
		new THREE.MeshBasicMaterial({ color: new THREE.Color(16, 13, 9) }),
	);
	sun.position.copy(sunDir).multiplyScalar(430);
	scene.add(sun);
	const pmrem = new THREE.PMREMGenerator(renderer);
	const texture = pmrem.fromScene(scene, 0.04, 0.1, 1500).texture;
	return texture;
}
